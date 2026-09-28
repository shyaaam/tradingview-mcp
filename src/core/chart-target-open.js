import CDP from 'chrome-remote-interface';

import { bindObserverSession, invalidateObserverSession } from '../connection.js';
import { resolveCloakManagerBaseUrl } from './cloak.js';
import { resolveManagerCdpUrl } from './manager-cdp.js';

const GENERIC_CHART_URL = 'https://www.tradingview.com/chart/';
const PROFILE_POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 250;

/** Open one fresh generic chart target in an explicitly named, already-running profile. */
export async function openBootstrapChartTarget(input = {}, dependencies = {}) {
  const profileName = requireText(input.profile_name, 'profile_name');
  const deps = dependencies;
  await (deps.invalidateObserverSession || invalidateObserverSession)();

  const { managerBaseUrl, profileId, cdpUrl } = await resolveExactRunningProfile(profileName, deps);
  const version = await fetchJson(new URL('json/version', `${cdpUrl}/`).toString(), deps);
  assertExactProfileBrowserWebSocket(version?.webSocketDebuggerUrl, cdpUrl, profileId);
  const before = await listTargets(cdpUrl, deps);
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

  if (before.some((target) => target?.type === 'page' && isBlankUrl(target.url))) {
    throw new Error('A blank page target exists; create outcome may be ambiguous, so no additional target was opened.');
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
  const payload = await fetchJson(new URL('profiles', `${managerBaseUrl}/`).toString(), deps);
  const profiles = Array.isArray(payload) ? payload : payload?.profiles;
  if (!Array.isArray(profiles)) throw new Error('CloakBrowser profile inventory is malformed.');
  const normalized = profiles.map((entry, index) => normalizeProfileEntry(entry, index));
  const matches = normalized.filter((entry) => entry.profileName === profileName);
  if (matches.length !== 1) throw new Error('Exact CloakBrowser profile name is missing or ambiguous.');
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

async function fetchJson(url, deps) {
  const response = await (deps.fetch || fetch)(url);
  if (!response.ok) throw new Error(`CloakBrowser request failed: ${response.status}.`);
  return response.json();
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
