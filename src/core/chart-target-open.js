import CDP from 'chrome-remote-interface';

import { bindObserverSession, invalidateObserverSession } from '../connection.js';
import { resolveCloakManagerBaseUrl } from './cloak.js';
import { resolveManagerCdpUrl } from './manager-cdp.js';

const GENERIC_CHART_URL = 'https://www.tradingview.com/chart/';
const PROFILE_POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 250;
const PROFILE_REQUEST_TIMEOUT_MS = 2_000;

/** Start one exact profile selected by stable name; never expose its Manager UUID. */
export async function startExactProfileByName(profileNameValue, dependencies = {}) {
  const profileName = requireText(profileNameValue, 'profile_name');
  const deps = dependencies;
  const managerBaseUrl = deps.managerBaseUrl || await (deps.resolveManagerBaseUrl || resolveCloakManagerBaseUrl)();
  if (!managerBaseUrl) throw codedError('CLOAK_MANAGER_UNAVAILABLE', 'CloakBrowser Manager is unavailable.');

  const profile = await loadExactProfile(managerBaseUrl, profileName, deps);
  const initialStatus = String(profile.status).toLowerCase();
  const initiallyRunning = ['running', 'active'].includes(initialStatus);
  const initiallyStopped = ['stopped', 'inactive', 'terminated'].includes(initialStatus);
  const initiallyStarting = ['starting', 'launching', 'pending', 'restarting'].includes(initialStatus);
  if (!initiallyRunning && !initiallyStopped && !initiallyStarting) {
    throw codedError('PROFILE_STATE_UNSUPPORTED', 'Exact CloakBrowser profile state is not safe to start.');
  }
  let launchPerformed = false;
  let launchOutcomeUnknown = false;
  if (initiallyStopped) {
    try {
      await fetchJsonWithDeadline(new URL(`profiles/${encodeURIComponent(profile.profile_id)}/launch`, `${managerBaseUrl}/`).toString(),
        deps, { method: 'POST' });
      launchPerformed = true;
    } catch {
      // The Manager may have started the profile before its response was lost.
      // Re-read the exact stable-name authority below; never replay the launch here.
      launchOutcomeUnknown = true;
    }
  }

  let current = null;
  for (let attempt = 0; attempt < PROFILE_POLL_ATTEMPTS; attempt += 1) {
    current = await loadExactProfile(managerBaseUrl, profileName, deps);
    const status = String(current.status).toLowerCase();
    if (['running', 'active'].includes(status)) break;
    if (!['stopped', 'inactive', 'terminated', 'starting', 'launching', 'pending', 'restarting'].includes(status)) {
      throw codedError('PROFILE_STATE_UNSUPPORTED', 'Exact CloakBrowser profile entered an unsupported state.');
    }
    current = null;
    await (deps.sleep || sleep)(POLL_INTERVAL_MS);
  }
  if (current === null) {
    throw launchOutcomeUnknown
      ? codedError('PROFILE_LAUNCH_FAILED', 'CloakBrowser Manager launch outcome remained unconfirmed; exact profile is not running.')
      : codedError('PROFILE_LAUNCH_NOT_CONFIRMED', 'Exact CloakBrowser profile did not reach running state.');
  }

  const cdpUrl = resolveManagerCdpUrl(managerBaseUrl, current.profile_id, current.cdp_url);
  assertExactProfileCdpPath(cdpUrl, current.profile_id);
  let version = null;
  for (let attempt = 0; attempt < PROFILE_POLL_ATTEMPTS; attempt += 1) {
    try {
      version = await fetchJsonWithDeadline(new URL('json/version', `${cdpUrl}/`).toString(), deps);
      break;
    } catch (error) {
      if (isRequestDeadlineError(error)) {
        throw codedError('PROFILE_CDP_NOT_READY', 'Exact profile CDP did not respond before its bounded request deadline.');
      }
      await (deps.sleep || sleep)(POLL_INTERVAL_MS);
    }
  }
  if (version === null) {
    throw codedError('PROFILE_CDP_NOT_READY', 'Exact CloakBrowser profile CDP did not become ready.');
  }
  try {
    assertExactProfileBrowserWebSocket(version.webSocketDebuggerUrl, cdpUrl, current.profile_id);
  } catch {
    throw codedError('PROFILE_CDP_AUTHORITY_MISMATCH', 'Profile CDP endpoint did not match exact profile authority.');
  }
  return Object.freeze({
    success: true,
    profile_name: profileName,
    status: 'running',
    launch_performed: launchPerformed,
    cdp_ready: true,
  });
}

/** Open one fresh generic chart target in an explicitly named, already-running profile. */
export async function openBootstrapChartTarget(input = {}, dependencies = {}) {
  const profileName = requireText(input.profile_name, 'profile_name');
  const deps = dependencies;
  await (deps.invalidateObserverSession || invalidateObserverSession)();

  const { managerBaseUrl, profileId, cdpUrl } = await resolveExactRunningProfile(profileName, deps);
  const version = await fetchJson(new URL('json/version', `${cdpUrl}/`).toString(), deps);
  assertExactProfileBrowserWebSocket(version?.webSocketDebuggerUrl, cdpUrl, profileId);
  const before = await listTargets(cdpUrl, deps);
  const pageTargets = before.filter((target) => target?.type === 'page');
  const blankTargets = pageTargets.filter((target) => isBlankUrl(target.url));
  if (blankTargets.length > 0) {
    if (pageTargets.length !== 1 || blankTargets.length !== 1
      || before.some((target) => isTradingViewChartTarget(target) || isTradingViewLoginTarget(target))) {
      throw new Error('A blank page target exists with competing page targets; refusing ambiguous adoption or creation.');
    }
    return navigateExistingBlankTarget({
      managerBaseUrl,
      profileName,
      profileId,
      cdpUrl,
      targetId: blankTargets[0].id,
      deps,
    });
  }

  const chartTargets = before.filter(isTradingViewChartTarget);
  const genericTargets = chartTargets.filter((target) => isGenericChartUrl(target.url));
  if (genericTargets.length > 1) {
    throw new Error('Multiple generic TradingView chart targets already exist; refusing to select or create another.');
  }
  if (genericTargets.length === 1) {
    return bindAndReturn({
      managerBaseUrl,
      profileName,
      profileId,
      cdpUrl,
      target: genericTargets[0],
      targetCreated: false,
      navigationPerformed: false,
      pageState: 'generic_chart',
      deps,
    });
  }

  if (before.some(isTradingViewLoginTarget)) {
    throw new Error('A TradingView login target already exists; refusing to create another chart target.');
  }
  if (before.filter(isTradingViewHomeTarget).length > 1) {
    throw new Error('Multiple TradingView home targets exist; chart creation would be ambiguous.');
  }

  const browserWebSocketUrl = typeof version?.webSocketDebuggerUrl === 'string'
    ? version.webSocketDebuggerUrl
    : '';
  if (!browserWebSocketUrl) throw new Error('Exact profile CDP browser endpoint is unavailable.');

  const browser = await (deps.connectBrowser || ((url) => CDP({ target: url, local: true })))(browserWebSocketUrl);
  let created;
  try {
    created = await browser.Target.createTarget({ url: 'about:blank' });
  } finally {
    try { await browser.close?.(); } catch { /* preserve create result */ }
  }

  const targetId = requireText(created?.targetId || created?.id, 'created target id');
  if (before.some((target) => target?.id === targetId)) {
    throw new Error('New target ID already existed in the exact profile; refusing navigation.');
  }
  const target = await waitForTarget(cdpUrl, targetId, deps);
  if (!target || target.type !== 'page' || !isBlankUrl(target.url)) {
    throw new Error('New blank target was not read back exactly; no navigation was attempted.');
  }
  if (typeof target.webSocketDebuggerUrl !== 'string' || !target.webSocketDebuggerUrl) {
    throw new Error('New target has no exact CDP websocket; no navigation was attempted.');
  }

  const page = await (deps.connectTarget || ((url) => CDP({ target: url, local: true })))(target.webSocketDebuggerUrl);
  let navigateResult;
  try {
    await page.Page.enable();
    navigateResult = await page.Page.navigate({ url: GENERIC_CHART_URL });
  } finally {
    try { await page.close?.(); } catch { /* preserve navigation result */ }
  }
  if (navigateResult?.errorText) {
    throw new Error('TradingView generic chart navigation failed.');
  }

  const finalTarget = await waitForBootstrapLanding(cdpUrl, targetId, deps);
  if (!finalTarget) {
    throw new Error('New target did not reach the exact generic chart or login route after navigation.');
  }
  return bindAndReturn({
    managerBaseUrl,
    profileName,
    profileId,
    cdpUrl,
    target: finalTarget,
    targetCreated: true,
    navigationPerformed: true,
    pageState: classifyPage(finalTarget.url),
    deps,
  });
}

async function navigateExistingBlankTarget({ managerBaseUrl, profileName, profileId, cdpUrl, targetId, deps }) {
  const currentTargets = await listTargets(cdpUrl, deps);
  const currentPages = currentTargets.filter((target) => target?.type === 'page');
  const target = currentPages.find((entry) => entry.id === targetId);
  if (currentPages.length !== 1 || !target || !isBlankUrl(target.url)
    || currentTargets.some((entry) => isTradingViewChartTarget(entry) || isTradingViewLoginTarget(entry))) {
    throw new Error('Exact sole blank target changed before navigation; refusing target-ID drift or ambiguity.');
  }
  if (typeof target.webSocketDebuggerUrl !== 'string' || !target.webSocketDebuggerUrl) {
    throw new Error('Exact existing blank target has no CDP websocket; no navigation was attempted.');
  }

  const page = await (deps.connectTarget || ((url) => CDP({ target: url, local: true })))(target.webSocketDebuggerUrl);
  let navigateResult;
  try {
    await page.Page.enable();
    navigateResult = await page.Page.navigate({ url: GENERIC_CHART_URL });
  } finally {
    try { await page.close?.(); } catch { /* preserve navigation result */ }
  }
  if (navigateResult?.errorText) {
    throw new Error('TradingView generic chart navigation failed.');
  }

  const landing = await waitForBootstrapLanding(cdpUrl, targetId, deps);
  if (!landing) {
    throw new Error('Existing blank target did not reach the exact generic chart or login route after navigation.');
  }
  const finalTargets = await listTargets(cdpUrl, deps);
  const finalPages = finalTargets.filter((entry) => entry?.type === 'page');
  const finalTarget = finalPages.find((entry) => entry.id === targetId);
  if (finalPages.length !== 1 || !finalTarget
    || !(isGenericChartUrl(finalTarget.url) || isTradingViewLoginTarget(finalTarget))) {
    throw new Error('Existing blank target landing became ambiguous; refusing to bind the target.');
  }

  return bindAndReturn({
    managerBaseUrl,
    profileName,
    profileId,
    cdpUrl,
    target: finalTarget,
    targetCreated: false,
    navigationPerformed: true,
    pageState: classifyPage(finalTarget.url),
    deps,
  });
}

/** Resolve the current Manager UUID from one exact profile name on every call. */
export async function resolveExactRunningProfile(profileNameValue, dependencies = {}) {
  const profileName = requireText(profileNameValue, 'profile_name');
  const deps = dependencies;
  const managerBaseUrl = deps.managerBaseUrl || await (deps.resolveManagerBaseUrl || resolveCloakManagerBaseUrl)();
  if (!managerBaseUrl) throw new Error('CloakBrowser Manager is required to resolve an exact profile name.');
  const profile = await loadExactProfile(managerBaseUrl, profileName, deps);
  const profileId = requireText(profile.profile_id || profile.id || profile.profileId, 'current profile id');
  if (!['running', 'active'].includes(String(profile.status || profile.state || '').toLowerCase())) {
    throw new Error('Exact CloakBrowser profile must already be running; this operation never launches or restarts it.');
  }
  const cdpUrl = resolveManagerCdpUrl(
    managerBaseUrl,
    profileId,
    profile.cdp_url || profile.cdp_endpoint || profile.cdpUrl,
  );
  assertExactProfileCdpPath(cdpUrl, profileId);
  return Object.freeze({ managerBaseUrl, profileName, profileId, cdpUrl, status: String(profile.status || profile.state) });
}

async function bindAndReturn({ managerBaseUrl, profileName, profileId, cdpUrl, target, targetCreated, navigationPerformed, pageState, deps }) {
  await (deps.bindObserverSession || bindObserverSession)({
    managerBaseUrl,
    profileId,
    cdpUrl,
    chartTargetId: target.id,
    chartTargetUrl: target.url,
  });
  return {
    success: true,
    open_version: 'bootstrap-chart-target-v1',
    profile_name: profileName,
    profile_id: profileId,
    target_id: target.id,
    target_url: safeTargetUrl(target.url),
    target_created: targetCreated,
    navigation_performed: navigationPerformed,
    page_state: pageState,
    mutations_performed: targetCreated || navigationPerformed,
  };
}

async function loadExactProfile(managerBaseUrl, profileName, deps) {
  let payload;
  try {
    payload = await fetchJsonWithDeadline(new URL('profiles', `${managerBaseUrl}/`).toString(), deps);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw codedError('PROFILE_INVENTORY_INVALID', 'CloakBrowser profile inventory response is not valid JSON.');
    }
    throw codedError('PROFILE_INVENTORY_UNAVAILABLE', 'CloakBrowser profile inventory request failed or timed out.');
  }
  const profiles = Array.isArray(payload) ? payload : payload?.profiles;
  if (!Array.isArray(profiles)) {
    throw codedError('PROFILE_INVENTORY_INVALID', 'CloakBrowser profile inventory is malformed.');
  }
  let normalized;
  try {
    normalized = profiles.map((entry, index) => normalizeProfileEntry(entry, index));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CloakBrowser profile inventory is malformed.';
    throw codedError('PROFILE_INVENTORY_INVALID', message);
  }
  const matches = normalized.filter((entry) => entry.profileName === profileName);
  if (matches.length !== 1) {
    throw codedError('PROFILE_NAME_MISSING_OR_AMBIGUOUS', 'Exact CloakBrowser profile name is missing or ambiguous.');
  }
  const match = matches[0];
  return {
    name: match.profileName,
    profile_id: match.profileId,
    status: match.status,
    cdp_url: match.cdpUrl,
  };
}

async function listTargets(cdpUrl, deps) {
  const targets = await fetchJson(new URL('json/list', `${cdpUrl}/`).toString(), deps);
  if (!Array.isArray(targets)) throw new Error('Exact profile CDP target inventory is malformed.');
  return targets.map((target, index) => normalizeTargetEntry(target, index));
}

function normalizeProfileEntry(entry, index) {
  if (!isRecord(entry)) throw new Error(`CloakBrowser profile inventory entry ${index} is malformed.`);
  const profileName = consistentTextAliases(entry, ['name', 'profile_name', 'profileName'],
    `CloakBrowser profile inventory entry ${index} name`, true);
  const profileId = consistentTextAliases(entry, ['profile_id', 'id', 'profileId'],
    `CloakBrowser profile inventory entry ${index} id`, true);
  const status = consistentTextAliases(entry, ['status', 'state'],
    `CloakBrowser profile inventory entry ${index} status`, true, (value) => {
      const normalized = value.toLowerCase();
      return normalized === 'running' || normalized === 'active' ? 'active' : normalized;
    });
  const cdpUrl = optionalTextAliases(entry, ['cdp_url', 'cdp_endpoint', 'cdpUrl'],
    `CloakBrowser profile inventory entry ${index} CDP endpoint`);
  return { profileName, profileId, status, cdpUrl };
}

function normalizeTargetEntry(target, index) {
  if (!isRecord(target)) throw new Error(`Exact profile CDP target inventory entry ${index} is malformed.`);
  const id = consistentTextAliases(target, ['id', 'targetId', 'target_id'],
    `Exact profile CDP target inventory entry ${index} id`, true);
  const type = requiredInventoryText(target.type,
    `Exact profile CDP target inventory entry ${index} type`);
  if (typeof target.url !== 'string' || target.url.trim() !== target.url) {
    throw new Error(`Exact profile CDP target inventory entry ${index} URL is malformed.`);
  }
  if (target.webSocketDebuggerUrl !== undefined && target.webSocketDebuggerUrl !== null
    && (typeof target.webSocketDebuggerUrl !== 'string' || target.webSocketDebuggerUrl.trim() !== target.webSocketDebuggerUrl)) {
    throw new Error(`Exact profile CDP target inventory entry ${index} websocket is malformed.`);
  }
  return { ...target, id, type, url: target.url };
}

function consistentTextAliases(record, keys, label, required, normalize = (value) => value) {
  const present = keys.filter((key) => Object.hasOwn(record, key));
  if (present.length === 0) {
    if (required) throw new Error(`${label} is missing.`);
    return undefined;
  }
  const values = present.map((key) => requiredInventoryText(record[key], label));
  if (new Set(values.map(normalize)).size !== 1) throw new Error(`${label} aliases conflict.`);
  return values[0];
}

function optionalTextAliases(record, keys, label) {
  const present = keys.filter((key) => Object.hasOwn(record, key));
  if (present.length === 0) return undefined;

  const rawValues = present.map((key) => record[key]);
  const isEmpty = (value) => value === undefined || value === null || value === '';
  const emptyCount = rawValues.filter(isEmpty).length;
  if (emptyCount > 0 && emptyCount < rawValues.length) {
    throw new Error(`${label} aliases conflict.`);
  }
  if (emptyCount === rawValues.length) return undefined;

  const values = rawValues.map((value) => requiredInventoryText(value, label));
  if (new Set(values).size !== 1) throw new Error(`${label} aliases conflict.`);
  return values[0];
}

function requiredInventoryText(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 4096) {
    throw new Error(`${label} is malformed.`);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function waitForTarget(cdpUrl, targetId, deps) {
  for (let attempt = 0; attempt < PROFILE_POLL_ATTEMPTS; attempt += 1) {
    const target = (await listTargets(cdpUrl, deps)).find((entry) => entry?.id === targetId);
    if (target) return target;
    await (deps.sleep || sleep)(POLL_INTERVAL_MS);
  }
  return null;
}

async function waitForBootstrapLanding(cdpUrl, targetId, deps) {
  for (let attempt = 0; attempt < PROFILE_POLL_ATTEMPTS; attempt += 1) {
    const target = (await listTargets(cdpUrl, deps)).find((entry) => entry?.id === targetId);
    if (target && (isGenericChartUrl(target.url) || isTradingViewLoginTarget(target))) return target;
    await (deps.sleep || sleep)(POLL_INTERVAL_MS);
  }
  return null;
}

async function fetchJson(url, deps, init = {}) {
  const response = await (deps.fetch || fetch)(url, init);
  if (!response.ok) throw new Error(`CloakBrowser request failed: ${response.status}.`);
  return response.json();
}

async function fetchJsonWithDeadline(url, deps, init = {}) {
  const controller = new AbortController();
  let timer;
  const request = Promise.resolve().then(() => fetchJson(url, deps, {
    ...init,
    signal: controller.signal,
  }));
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('CloakBrowser request exceeded its bounded deadline.');
      error.name = 'TimeoutError';
      reject(error);
    }, PROFILE_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function isRequestDeadlineError(error) {
  return error !== null && typeof error === 'object'
    && 'name' in error && ['AbortError', 'TimeoutError'].includes(String(error.name));
}

function codedError(code, message) {
  const error = new Error(message);
  error.failureCode = code;
  return error;
}

function isTradingViewChartTarget(target) {
  if (target?.type !== 'page') return false;
  try {
    const url = new URL(String(target.url || ''));
    return url.protocol === 'https:' && url.hostname === 'www.tradingview.com'
      && (url.pathname === '/chart/' || /^\/chart\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname));
  } catch {
    return false;
  }
}

function isGenericChartUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'www.tradingview.com'
      && url.pathname === '/chart/' && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

function isTradingViewLoginTarget(target) {
  if (target?.type !== 'page') return false;
  try {
    const url = new URL(String(target.url || ''));
    return url.origin === 'https://www.tradingview.com'
      && /^\/(?:accounts\/(?:signin|login)|signin|login)(?:\/|$)/iu.test(url.pathname);
  } catch {
    return false;
  }
}

function isTradingViewHomeTarget(target) {
  if (target?.type !== 'page') return false;
  try {
    const url = new URL(String(target.url || ''));
    return url.origin === 'https://www.tradingview.com' && url.pathname === '/';
  } catch {
    return false;
  }
}

function isBlankUrl(value) {
  return String(value || '').trim() === 'about:blank';
}

export function assertExactProfileCdpPath(value, profileId) {
  let endpoint;
  try { endpoint = new URL(value); } catch { throw new Error('Manager CDP endpoint is malformed.'); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !isExactProfileCdpPath(endpoint.pathname, profileId)) {
    throw new Error('Manager CDP endpoint is outside exact Manager profile authority.');
  }
}

export function assertExactProfileBrowserWebSocket(value, cdpUrl, profileId) {
  let endpoint;
  let profileEndpoint;
  try {
    endpoint = new URL(String(value || ''));
    profileEndpoint = new URL(cdpUrl);
  } catch {
    throw new Error('Browser CDP WebSocket endpoint is malformed.');
  }
  const expectedProtocol = profileEndpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  if (endpoint.protocol !== expectedProtocol || endpoint.host !== profileEndpoint.host
    || endpoint.pathname.replace(/\/+$/u, '') !== profileEndpoint.pathname.replace(/\/+$/u, '')
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !isExactProfileCdpPath(profileEndpoint.pathname, profileId)) {
    throw new Error('Browser CDP WebSocket endpoint is outside exact Manager profile authority.');
  }
}

function isExactProfileCdpPath(pathname, profileId) {
  let segments;
  try { segments = pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment)); }
  catch { return false; }
  const profilesIndex = segments.lastIndexOf('profiles');
  return profilesIndex >= 0
    && segments[profilesIndex + 1] === profileId
    && segments[profilesIndex + 2] === 'cdp'
    && profilesIndex + 3 === segments.length;
}

function classifyPage(value) {
  const url = new URL(value);
  if (/^\/(?:accounts\/(?:signin|login)|signin|login)(?:\/|$)/iu.test(url.pathname)) return 'login_route';
  if (url.pathname === '/chart/' && !url.search && !url.hash) return 'generic_chart';
  if (/^\/chart\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname)) return 'chart_id_route';
  return 'other_tradingview_route';
}

function safeTargetUrl(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

function requireText(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
