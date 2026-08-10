import CDP from 'chrome-remote-interface';

import { LEGACY_LAYOUT_IDENTITY_HELPER } from './layout-identity.js';
import { resolveManagerCdpUrl } from './manager-cdp.js';

const DEFAULT_MANAGER_BASE_URLS = [
  'http://127.0.0.1:8080/api',
  'http://localhost:8080/api',
];

const PROFILE_READY_STATES = new Set(['running', 'active']);

export const CHART_RUNTIME_READINESS_EXPRESSION = `
(() => {
  function readValue(value) {
    try {
      if (typeof value === 'function') value = value();
      if (value && typeof value.value === 'function') value = value.value();
      else if (value && Object.prototype.hasOwnProperty.call(value, 'value')) value = value.value;
      return value;
    } catch (e) { return undefined; }
  }
  function textValue(value) {
    const resolved = readValue(value);
    return typeof resolved === 'string' || typeof resolved === 'number' ? String(resolved) : '';
  }
  function typeOf(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    return typeof value;
  }
  function visible(element) {
    if (!element) return false;
    const style = window.getComputedStyle ? window.getComputedStyle(element) : null;
    return style ? style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 : true;
  }
  function accountCandidate(value) {
    const resolved = readValue(value);
    if (typeof resolved === 'string' || typeof resolved === 'number') return String(resolved);
    if (!resolved || typeof resolved !== 'object') return '';
    return textValue(resolved.id || resolved.user_id || resolved.userId || resolved.subject || resolved.username || resolved.name);
  }

  ${LEGACY_LAYOUT_IDENTITY_HELPER}

  const api = window.TradingViewApi;
  const collection = api && api._chartWidgetCollection;
  const activeWrapper = api && api._activeChartWidgetWV;
  const activeValueCallable = Boolean(activeWrapper && typeof activeWrapper.value === 'function');
  let active = null;
  let activeValueError = false;
  if (activeValueCallable) {
    try { active = activeWrapper.value(); } catch (e) { activeValueError = true; }
  } else if (activeWrapper && Object.prototype.hasOwnProperty.call(activeWrapper, 'value')) {
    active = activeWrapper.value;
  } else {
    active = activeWrapper || null;
  }

  const collectionLayout = textValue(collection && (collection._layoutId || collection.layoutId || collection.layout || (collection._layout && collection._layout.id)));
  const activeLayout = textValue(active && (active.layoutId || active._layoutId));
  const layoutValues = [];
  for (const value of [collectionLayout, activeLayout]) {
    if (value && !layoutValues.includes(value)) layoutValues.push(value);
  }
  const layoutStatus = !api || !collection || (!active && !activeValueError)
    ? (!collection ? 'unavailable' : layoutValues.length === 0 ? 'missing' : layoutValues.length > 1 ? 'ambiguous' : 'ready')
    : layoutValues.length === 0 ? 'missing' : layoutValues.length > 1 ? 'ambiguous' : 'ready';
  const layout = deriveLegacyLayoutId(api);

  const rawMetaInfo = collection && collection.metaInfo;
  const metaInfoType = typeOf(rawMetaInfo);
  let metaInfo = null;
  let metaInfoError = false;
  if (rawMetaInfo !== undefined && rawMetaInfo !== null) {
    try { metaInfo = readValue(rawMetaInfo); } catch (e) { metaInfoError = true; }
  }
  const savedLayoutUid = textValue(metaInfo && metaInfo.uid);
  const savedLayoutMetaInfoStatus = !collection
    ? 'unavailable'
    : metaInfoError
      ? 'ambiguous'
      : rawMetaInfo === undefined || rawMetaInfo === null
        ? 'missing'
        : savedLayoutUid
          ? 'ready'
          : 'missing';

  const accountCandidates = [];
  const accountSources = [
    api && api._user,
    api && api.user,
    window.TradingView && window.TradingView.user,
    metaInfo && (metaInfo.user || metaInfo.account),
    metaInfo && (metaInfo.username || metaInfo.user_id),
  ];
  for (const source of accountSources) {
    const candidate = accountCandidate(source);
    if (candidate && !accountCandidates.includes(candidate)) accountCandidates.push(candidate);
  }

  const bodyText = String(document.body && (document.body.innerText || document.body.textContent) || '').toLowerCase();
  const path = String(window.location && window.location.pathname || '');
  const loginMarkers = [
    /\\/(?:accounts\\/(?:signin|login)|signin|login)(?:\\/|$)/iu.test(path),
    /\\b(?:sign[ -]?in|log[ -]?in|create account|join for free|authentication required)\\b/iu.test(bodyText),
  ].filter(Boolean).length;
  const loginState = loginMarkers > 0 ? 'present' : 'absent';

  const visibleElements = Array.from(document.querySelectorAll ? document.querySelectorAll('body *') : []).filter(visible);
  const disconnectPopupCount = visibleElements.filter((element) => /session disconnected|another device|connection lost|browser session disconnected/iu.test(String(element.innerText || element.textContent || ''))).length;
  const exactConnectCount = visibleElements.filter((element) => /^(?:connect|reconnect)$/iu.test(String(element.innerText || element.textContent || '').trim()) && /^(?:BUTTON|A|INPUT)$/u.test(element.tagName || '')).length;
  const disconnectedState = disconnectPopupCount > 0 ? 'present' : 'absent';

  return {
    document_ready_state: document.readyState || 'unavailable',
    current_url: String(window.location && window.location.href || ''),
    current_path: path,
    tradingview_api_present: Boolean(api),
    tradingview_api_type: typeOf(api),
    chart_widget_collection_present: Boolean(collection),
    chart_widget_collection_type: typeOf(collection),
    active_widget_wrapper_present: Boolean(activeWrapper),
    active_widget_wrapper_type: typeOf(activeWrapper),
    active_widget_value_callable: activeValueCallable,
    active_widget_non_null: Boolean(active) && !activeValueError,
    workspace_layout_status: layoutStatus,
    workspace_layout_id: layout.layout_id || (layoutStatus === 'ready' && layoutValues.length === 1 ? layoutValues[0] : null),
    saved_layout_meta_info_status: savedLayoutMetaInfoStatus,
    saved_layout_meta_info_type: metaInfoType,
    saved_layout_uid: savedLayoutUid || null,
    saved_layout_uid_ready: Boolean(savedLayoutUid),
    account_subject_candidate_count: accountCandidates.length,
    account_subject_state: accountCandidates.length === 1 ? 'ready' : accountCandidates.length > 1 ? 'ambiguous' : 'missing',
    disconnected_session_state: disconnectedState,
    disconnected_popup_count: disconnectPopupCount,
    exact_connect_count: exactConnectCount,
    login_state: loginState,
    login_marker_count: loginMarkers,
    mutations_performed: false,
  };
})()
`;

const INPUT_LIMITS = { timeoutMs: 30_000, pollIntervalMs: 5_000 };

export async function probeChartRuntimeReadiness(input = {}, dependencies = {}) {
  const profileId = requireText(input.profile_id, 'profile_id');
  const targetId = requireText(input.target_id, 'target_id');
  const targetUrl = requireText(input.target_url, 'target_url');
  const base = await resolveManagerBaseUrl(dependencies);
  const unavailable = (overrides = {}) => readinessResult({
    profileId,
    targetId,
    targetUrl,
    ...overrides,
  });

  if (!base) return unavailable({ profileState: 'unavailable', targetState: 'unavailable', probeError: 'CloakBrowser Manager is unavailable.' });

  try {
    const profiles = parseList(await fetchJson(new URL('profiles', `${base}/`).toString(), dependencies));
    const matches = profiles.filter((entry) => profileIdFromEntry(entry) === profileId);
    if (matches.length === 0) return unavailable({ profileState: 'missing', targetState: 'missing' });
    if (matches.length !== 1) return unavailable({ profileState: 'ambiguous', targetState: 'ambiguous' });
    const profile = matches[0];
    const status = String(profile.status || profile.state || '').toLowerCase();
    if (!PROFILE_READY_STATES.has(status)) return unavailable({ profileState: 'not-running', targetState: 'unavailable' });
    const cdpUrl = cdpUrlFromProfile(base, profileId, profile);
    if (!cdpUrl) return unavailable({ profileState: 'ready', targetState: 'unavailable', probeError: 'Profile CDP endpoint is unavailable.' });

    const targets = parseTargets(await fetchJson(new URL('json/list', `${cdpUrl}/`).toString(), dependencies));
    const target = targets.find((entry) => String(entry?.id || '') === targetId);
    if (!target) return unavailable({ profileState: 'ready', targetState: 'missing' });
    if (String(target.url || '') !== targetUrl || target.type !== 'page') {
      return unavailable({ profileState: 'ready', targetState: 'changed', currentUrl: String(target.url || '') });
    }
    if (!target.webSocketDebuggerUrl) return unavailable({ profileState: 'ready', targetState: 'unavailable', probeError: 'Exact target WebSocket endpoint is unavailable.' });

    const connect = dependencies.connect || ((webSocketDebuggerUrl) => CDP({ target: webSocketDebuggerUrl, local: true }));
    const client = await connect(target.webSocketDebuggerUrl);
    try {
      if (client?.Runtime?.enable) await client.Runtime.enable();
      const evaluation = await client.Runtime.evaluate({ expression: CHART_RUNTIME_READINESS_EXPRESSION, returnByValue: true });
      const snapshot = evaluation?.result?.value;
      if (!snapshot || typeof snapshot !== 'object') {
        return unavailable({ profileState: 'ready', targetState: 'exact', probeError: 'Raw chart-runtime readiness evaluation returned no object.' });
      }
      const result = readinessResult({ profileId, targetId, targetUrl, profileState: 'ready', targetState: 'exact', snapshot });
      if (result.current_url && result.current_url !== targetUrl) {
        result.target_state = 'changed';
        result.ready = false;
      }
      return result;
    } finally {
      try { await client.close?.(); } catch { /* readiness evidence remains primary */ }
    }
  } catch (error) {
    return unavailable({ profileState: 'unavailable', targetState: 'unavailable', probeError: truncate(error?.message || String(error)) });
  }
}

/**
 * Execute one operation on one exact existing target without observer-session
 * recovery. Caller owns read-only policy for evaluated expressions.
 */
export async function withExactRawTarget(input = {}, operation, dependencies = {}) {
  if (typeof operation !== 'function') throw new Error('Raw exact-target operation is required.');
  const binding = await resolveExactTargetBinding(input, dependencies);
  const connect = dependencies.connect || ((webSocketDebuggerUrl) => CDP({ target: webSocketDebuggerUrl, local: true }));
  const client = await connect(binding.target.webSocketDebuggerUrl);
  try {
    if (client?.Runtime?.enable) await client.Runtime.enable();
    const rawEvaluate = async (expression, options = {}) => {
      const evaluation = await client.Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: options.awaitPromise ?? false,
        ...options,
      });
      if (evaluation?.exceptionDetails) throw new Error('Raw exact-target evaluation failed.');
      return evaluation?.result?.value;
    };
    return await operation({ ...binding, client, evaluate: rawEvaluate });
  } finally {
    try { await client.close?.(); } catch { /* preserve raw operation result */ }
  }
}

export async function waitForChartRuntimeReady(input = {}, dependencies = {}) {
  const timeoutMs = boundedNumber(input.timeout_ms, 5_000, 1, INPUT_LIMITS.timeoutMs);
  const pollIntervalMs = boundedNumber(input.poll_interval_ms, 250, 1, INPUT_LIMITS.pollIntervalMs);
  const started = dependencies.now || Date.now;
  const startTime = started();
  const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs) + 2;
  let attempts = 0;
  let latest = null;
  const probe = dependencies.probe || ((probeInput) => probeChartRuntimeReadiness(probeInput, dependencies));
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  while (attempts < maxAttempts) {
    attempts += 1;
    latest = await probe(input);
    const terminal = classifyReadinessOutcome(latest);
    if (terminal) return waitResult(terminal, latest, attempts, started() - startTime);
    if (latest.ready) return waitResult('READY', latest, attempts, started() - startTime);
    if (started() - startTime >= timeoutMs || attempts >= maxAttempts) break;
    await sleep(pollIntervalMs);
  }
  return waitResult('TIMEOUT_NOT_READY', latest, attempts, Math.max(timeoutMs, started() - startTime));
}

export function classifyReadinessOutcome(probe) {
  if (!probe || probe.mutations_performed !== false) return 'TIMEOUT_NOT_READY';
  if (probe.target_state === 'missing' || probe.target_state === 'changed' || probe.target_state === 'ambiguous') return 'TARGET_CHANGED';
  if (probe.disconnected_session_state === 'present') return 'DISCONNECTED_SESSION_PRESENT';
  if (probe.login_state === 'present') return 'LOGIN_REQUIRED';
  if (probe.workspace_layout_status === 'ambiguous'
    || probe.saved_layout_meta_info_status === 'ambiguous'
    || probe.account_subject_state === 'ambiguous'
    || probe.disconnected_session_state === 'ambiguous'
    || probe.login_state === 'ambiguous') return 'IDENTITY_AMBIGUOUS';
  return null;
}

export function runtimeReadinessIsReady(result) {
  return result?.profile_state === 'ready'
    && result.target_state === 'exact'
    && result.target_url === result.current_url
    && ['interactive', 'complete'].includes(result.document_ready_state)
    && result.tradingview_api_present
    && result.chart_widget_collection_present
    && result.active_widget_wrapper_present
    && result.active_widget_value_callable
    && result.active_widget_non_null
    && result.workspace_layout_status === 'ready'
    && result.saved_layout_meta_info_status === 'ready'
    && result.saved_layout_uid_ready
    && result.account_subject_state === 'ready'
    && result.disconnected_session_state === 'absent'
    && result.login_state === 'absent'
    && result.mutations_performed === false;
}

function readinessResult({ profileId, targetId, targetUrl, profileState = 'unavailable', targetState = 'unavailable', currentUrl = '', probeError = null, snapshot = {} }) {
  const result = {
    success: true,
    probe_version: 'chart-runtime-readiness-probe-v1',
    profile_id: profileId,
    target_id: targetId,
    target_url: targetUrl,
    profile_state: profileState,
    target_state: targetState,
    document_ready_state: enumValue(snapshot.document_ready_state, ['loading', 'interactive', 'complete'], 'unavailable'),
    current_url: currentUrl || stringValue(snapshot.current_url),
    current_path: stringValue(snapshot.current_path),
    tradingview_api_present: Boolean(snapshot.tradingview_api_present),
    tradingview_api_type: stringValue(snapshot.tradingview_api_type, 'unavailable'),
    chart_widget_collection_present: Boolean(snapshot.chart_widget_collection_present),
    chart_widget_collection_type: stringValue(snapshot.chart_widget_collection_type, 'unavailable'),
    active_widget_wrapper_present: Boolean(snapshot.active_widget_wrapper_present),
    active_widget_wrapper_type: stringValue(snapshot.active_widget_wrapper_type, 'unavailable'),
    active_widget_value_callable: Boolean(snapshot.active_widget_value_callable),
    active_widget_non_null: Boolean(snapshot.active_widget_non_null),
    workspace_layout_status: enumValue(snapshot.workspace_layout_status, ['ready', 'missing', 'ambiguous'], 'unavailable'),
    workspace_layout_id: nullableString(snapshot.workspace_layout_id),
    saved_layout_meta_info_status: enumValue(snapshot.saved_layout_meta_info_status, ['ready', 'missing', 'ambiguous'], 'unavailable'),
    saved_layout_meta_info_type: stringValue(snapshot.saved_layout_meta_info_type, 'unavailable'),
    saved_layout_uid: nullableString(snapshot.saved_layout_uid),
    saved_layout_uid_ready: Boolean(snapshot.saved_layout_uid_ready),
    account_subject_candidate_count: nonnegativeInteger(snapshot.account_subject_candidate_count),
    account_subject_state: enumValue(snapshot.account_subject_state, ['ready', 'missing', 'ambiguous'], 'unavailable'),
    disconnected_session_state: enumValue(snapshot.disconnected_session_state, ['present', 'absent', 'ambiguous'], 'unavailable'),
    disconnected_popup_count: nonnegativeInteger(snapshot.disconnected_popup_count),
    exact_connect_count: nonnegativeInteger(snapshot.exact_connect_count),
    login_state: enumValue(snapshot.login_state, ['present', 'absent', 'ambiguous'], 'unavailable'),
    login_marker_count: nonnegativeInteger(snapshot.login_marker_count),
    mutations_performed: false,
    probe_error: probeError ? truncate(probeError) : null,
  };
  result.ready = runtimeReadinessIsReady(result);
  return result;
}

function waitResult(status, probe, attempts, elapsedMs) {
  return {
    success: true,
    wait_version: 'chart-runtime-wait-ready-v1',
    status,
    attempts,
    elapsed_ms: Math.max(0, Math.round(elapsedMs)),
    probe,
    mutations_performed: false,
  };
}

async function resolveManagerBaseUrl(dependencies) {
  if (dependencies.managerBaseUrl) return cleanBaseUrl(dependencies.managerBaseUrl);
  const explicit = cleanBaseUrl(process.env.CLOAK_BROWSER_BASE_URL);
  if (explicit) return explicit;
  const fetchImpl = dependencies.fetch || fetch;
  for (const candidate of DEFAULT_MANAGER_BASE_URLS) {
    try {
      await fetchJson(new URL('profiles', `${candidate}/`).toString(), { fetch: fetchImpl });
      return candidate;
    } catch { /* try next loopback Manager endpoint */ }
  }
  return null;
}

async function resolveExactTargetBinding(input, dependencies) {
  const profileId = requireText(input.profile_id, 'profile_id');
  const targetId = requireText(input.target_id, 'target_id');
  const targetUrl = requireText(input.target_url, 'target_url');
  const base = await resolveManagerBaseUrl(dependencies);
  if (!base) throw new Error('CloakBrowser Manager is unavailable.');
  const profiles = parseList(await fetchJson(new URL('profiles', `${base}/`).toString(), dependencies));
  const matches = profiles.filter((entry) => profileIdFromEntry(entry) === profileId);
  if (matches.length !== 1) throw new Error('Exact Manager profile binding is missing or ambiguous.');
  const profile = matches[0];
  if (!PROFILE_READY_STATES.has(String(profile.status || profile.state || '').toLowerCase())) {
    throw new Error('Exact Manager profile is not running.');
  }
  const cdpUrl = cdpUrlFromProfile(base, profileId, profile);
  if (!cdpUrl) throw new Error('Exact Manager profile CDP endpoint is unavailable.');
  const targets = parseTargets(await fetchJson(new URL('json/list', `${cdpUrl}/`).toString(), dependencies));
  const target = targets.find((entry) => String(entry?.id || '') === targetId);
  if (!target || target.type !== 'page' || String(target.url || '') !== targetUrl) {
    throw new Error('Exact target or URL changed or is unavailable.');
  }
  if (!target.webSocketDebuggerUrl) throw new Error('Exact target WebSocket endpoint is unavailable.');
  return { profileId, targetId, targetUrl, managerBaseUrl: base, cdpUrl, target };
}

async function fetchJson(url, { fetch: fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url);
  if (!response?.ok) throw new Error(`request failed: ${response?.status || 'unknown'} ${response?.statusText || ''}`.trim());
  return response.json();
}

function parseList(payload) {
  return Array.isArray(payload) ? payload : Array.isArray(payload?.profiles) ? payload.profiles : [];
}

function parseTargets(payload) {
  return Array.isArray(payload) ? payload.filter((entry) => entry && typeof entry === 'object') : [];
}

function profileIdFromEntry(entry) {
  return String(entry?.profile_id || entry?.id || entry?.profileId || '');
}

function cdpUrlFromProfile(base, profileId, profile) {
  const value = profile?.cdp_url || profile?.cdp_endpoint || profile?.cdpUrl;
  return resolveManagerCdpUrl(base, profileId, value);
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function enumValue(value, allowed, fallback) { return allowed.includes(value) ? value : fallback; }
function stringValue(value, fallback = '') { return typeof value === 'string' ? value : fallback; }
function nullableString(value) { return typeof value === 'string' && value.length > 0 ? value : null; }
function nonnegativeInteger(value) { return Number.isInteger(value) && value >= 0 ? value : 0; }
function cleanBaseUrl(value) { return String(value || '').trim().replace(/\/+$/u, ''); }
function requireText(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}
function truncate(value) { return String(value).slice(0, 512); }
