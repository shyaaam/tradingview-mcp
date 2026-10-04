import { getObserverSession } from './observer-session.js';
import { invalidateObserverSession } from '../connection.js';
import { resolveCloakManagerBaseUrl } from './cloak.js';
import { resolveManagerCdpUrl } from './manager-cdp.js';
import { verifyBootstrapTargetProof } from './bootstrap-target-proof.js';
import {
  closeExactPageTargetAndReconcile,
  connectBoundedBrowser,
  fetchBoundedJson,
  normalizeTargetInventory,
  normalizePageTargets,
  requireProfileBrowserWebSocketUrl,
  remainingMs,
  withDeadline,
} from './exact-target-close.js';

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TARGET_ID_CHARS = 256;
const MAX_PROFILE_ID_CHARS = 160;
const MAX_PROFILE_NAME_CHARS = 160;
const GENERIC_CHART_URL = 'https://www.tradingview.com/chart/';

/** Retire only the exact unsaved page proven by one successful bootstrap result. */
export async function retireOwnedDiagnosticTarget(input = {}, dependencies = {}) {
  const requested = normalizeInput(input);
  const resolveProfile = dependencies.resolveExactRunningProfile;
  if (typeof resolveProfile !== 'function') {
    throw new Error('Exact running profile resolver is required for diagnostic target retirement.');
  }
  const timeoutMs = boundedPositiveInteger(dependencies.timeoutMs, DEFAULT_TIMEOUT_MS);
  const now = dependencies.now || (() => performance.now());
  const deadline = { at: now() + timeoutMs, now, timeoutMs };
  const profile = await withDeadline(
    () => resolveProfile(requested.profileName, dependencies),
    deadline,
  );
  const profileId = requireBoundedText(profile?.profileId, 'current profile ID', MAX_PROFILE_ID_CHARS);
  if (profileId !== requested.bootstrapResult.profileId) {
    throw new Error('Bootstrap receipt belongs to a different current profile identity.');
  }
  const managerBaseUrl = profile.managerBaseUrl
    || dependencies.managerBaseUrl
    || await withDeadline(() => resolveCloakManagerBaseUrl(), deadline);
  if (!managerBaseUrl) throw new Error('CloakBrowser Manager is required for diagnostic target retirement.');
  const cdpUrl = resolveManagerCdpUrl(managerBaseUrl, profileId, profile.cdpUrl);
  const fetchImpl = dependencies.fetch || fetch;
  const requestJson = (url) => fetchBoundedJson(url, fetchImpl, deadline);
  const version = await requestJson(new URL('json/version', `${cdpUrl}/`).toString());
  const browserWebSocketUrl = requireProfileBrowserWebSocketUrl(
    version?.webSocketDebuggerUrl,
    cdpUrl,
    profileId,
  );
  const connectBrowser = dependencies.connectBrowser || connectBoundedBrowser;
  const browser = await withDeadline(
    () => connectBrowser(browserWebSocketUrl, {
      maxPayload: 128 * 1024,
      handshakeTimeoutMs: Math.max(1, Math.floor(remainingMs(deadline) - 100)),
    }),
    deadline,
  );
  try {
    const targetListUrl = new URL('json/list', `${cdpUrl}/`).toString();
    const inventory = normalizeTargetInventory(await requestJson(targetListUrl));
    const matches = inventory.filter((target) => target.id === requested.targetId);
    if (matches.length > 1) throw new Error('Owned diagnostic target ID is ambiguous in current profile inventory.');
    if (matches.length === 1 && matches[0].type !== 'page') {
      throw new Error('Owned diagnostic target is no longer a page; refusing retirement.');
    }
    if (matches.length === 1 && !isTradingViewDiagnosticPage(matches[0].url)) {
      throw new Error('Owned diagnostic target left the approved TradingView chart/login routes.');
    }
    const expectedOtherPageTargets = normalizePageTargets(inventory)
      .filter((target) => target.id !== requested.targetId);
    const session = (dependencies.getObserverSession || getObserverSession)();
    if (session?.profileId === profileId && session?.chartTargetId === requested.targetId) {
      await (dependencies.invalidateObserverSession || invalidateObserverSession)();
    }
    const closure = await closeExactPageTargetAndReconcile({
      targetId: requested.targetId,
      expectedOtherPageTargets,
      readTargets: () => requestJson(targetListUrl),
      browser,
      timeoutMs: Math.max(1, Math.floor(remainingMs(deadline))),
      now,
      sleep: dependencies.sleep,
    });
    return Object.freeze({
      success: true,
      retirement_version: 'owned-diagnostic-target-retirement-v1',
      profile_name: requested.profileName,
      diagnostic_target_id: requested.targetId,
      action: closure.action,
      remaining_page_targets: closure.remaining_page_targets,
      mutations_performed: closure.mutations_performed,
    });
  } finally {
    try { await browser.close?.(); } catch { /* preserve retirement outcome */ }
  }
}

function normalizeInput(input) {
  const profileName = requirePattern(input.profile_name, 'profile_name', /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,159}$/u);
  const targetId = requireTargetId(input.target_id);
  const bootstrapResult = normalizeBootstrapResult(input.bootstrap_result);
  if (bootstrapResult.profileName !== profileName || bootstrapResult.targetId !== targetId) {
    throw new Error('Diagnostic retirement request does not match its bootstrap result.');
  }
  return Object.freeze({ profileName, targetId, bootstrapResult });
}

function normalizeBootstrapResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.success !== true
    || value.open_version !== 'bootstrap-chart-target-v1'
    || value.target_created !== true
    || value.navigation_performed !== true
    || value.mutations_performed !== true
    || !['generic_chart', 'login_route'].includes(value.page_state)) {
    throw new Error('A successful fresh-target bootstrap result is required for diagnostic retirement.');
  }
  const profileName = requirePattern(value.profile_name, 'bootstrap profile_name', /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,159}$/u);
  const profileId = requireBoundedText(value.profile_id, 'bootstrap profile_id', MAX_PROFILE_ID_CHARS);
  const targetId = requireTargetId(value.target_id);
  const targetUrl = requireBoundedText(value.target_url, 'bootstrap target_url', 4_096);
  if (!verifyBootstrapTargetProof(profileName, profileId, targetId, value.ownership_proof)) {
    throw new Error('Bootstrap ownership proof is invalid for this provider process and exact target.');
  }
  if (value.page_state === 'generic_chart' && !isGenericChartUrl(targetUrl)) {
    throw new Error('Generic-chart bootstrap result has an unexpected target URL.');
  }
  if (value.page_state === 'login_route' && !isTradingViewLoginUrl(targetUrl)) {
    throw new Error('Login bootstrap result has an unexpected target URL.');
  }
  return Object.freeze({ profileName, profileId, targetId, targetUrl, pageState: value.page_state });
}

function isTradingViewDiagnosticPage(value) {
  return isTradingViewChartUrl(value) || isTradingViewLoginUrl(value);
}

function isGenericChartUrl(value) {
  try {
    const url = new URL(value);
    return url.href === GENERIC_CHART_URL;
  } catch {
    return false;
  }
}

function isTradingViewChartUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://www.tradingview.com'
      && (url.pathname === '/chart/' || /^\/chart\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname));
  } catch {
    return false;
  }
}

function isTradingViewLoginUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://www.tradingview.com'
      && /^\/(?:accounts\/(?:signin|login)|signin|login)(?:\/|$)/iu.test(url.pathname);
  } catch {
    return false;
  }
}

function requireTargetId(value) {
  return requireBoundedText(value, 'target_id', MAX_TARGET_ID_CHARS);
}

function requirePattern(value, name, pattern) {
  const text = requireBoundedText(value, name, MAX_PROFILE_NAME_CHARS);
  if (!pattern.test(text)) throw new Error(`${name} is invalid.`);
  return text;
}

function requireBoundedText(value, name, maxLength) {
  if (typeof value !== 'string' || !value || value.length > maxLength
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function boundedPositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 30_000) {
    throw new Error('Retirement timeout must be a positive integer no greater than 30000ms.');
  }
  return value;
}
