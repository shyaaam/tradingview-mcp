import CDP from 'chrome-remote-interface';

import { withExactRawTarget } from './chart-runtime-readiness.js';

const DEFAULT_DURATION_MS = 35_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_DURATION_MS = 40_000;
export const RUNTIME_STATE_EXPRESSION = `(() => {
  function boundedText(value, limit) {
    return String(value || '').replace(/\\s+/gu, ' ').trim().slice(0, limit);
  }
  const selectChromeErrorCode = ${selectChromeErrorCode.toString()};
  function readStructuredErrorCode() {
    const sources = [];
    try {
      const loadTimeData = window.loadTimeData;
      if (loadTimeData && typeof loadTimeData.getString === 'function') {
        for (const key of ['errorCode', 'error_code']) {
          try { sources.push(loadTimeData.getString(key)); } catch (error) { /* unavailable */ }
        }
      }
      const data = loadTimeData && loadTimeData.data;
      if (data && typeof data === 'object') sources.push(data.errorCode, data.error_code);
    } catch (error) { /* unavailable */ }
    try {
      const controller = window.errorPageController;
      if (controller && typeof controller === 'object') sources.push(controller.errorCode, controller.error_code);
    } catch (error) { /* unavailable */ }
    return sources.find((value) => typeof value === 'string' && value.trim()) || '';
  }
  function readSelectorText(selectors) {
    try {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        const text = boundedText(element && (element.innerText || element.textContent), 512);
        if (text) return text;
      }
    } catch (error) { /* unavailable */ }
    return '';
  }
  function readNavigationTiming() {
    try {
      const entry = performance.getEntriesByType('navigation')[0];
      if (!entry) return { available: false, type: null, duration_ms: null, response_end_ms: null, dom_content_loaded_ms: null, load_event_end_ms: null, redirect_count: null };
      const number = (value) => Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
      return {
        available: true,
        type: boundedText(entry.type, 32) || null,
        duration_ms: number(entry.duration),
        response_end_ms: number(entry.responseEnd),
        dom_content_loaded_ms: number(entry.domContentLoadedEventEnd),
        load_event_end_ms: number(entry.loadEventEnd),
        redirect_count: Number.isSafeInteger(entry.redirectCount) ? entry.redirectCount : null,
      };
    } catch (error) {
      return { available: false, type: null, duration_ms: null, response_end_ms: null, dom_content_loaded_ms: null, load_event_end_ms: null, redirect_count: null };
    }
  }
  const currentUrl = String(window.location && window.location.href || '');
  let runtimeScheme = '';
  try { runtimeScheme = String(new URL(currentUrl).protocol || '').replace(/:$/u, ''); } catch (error) { /* unavailable */ }
  const chromeErrorPage = runtimeScheme === 'chrome-error'
    || document.documentElement?.id === 'error-page'
    || Boolean(document.querySelector('#main-frame-error'));
  const bodyText = boundedText(document.body && (document.body.innerText || document.body.textContent), 4096);
  const structuredCode = readStructuredErrorCode();
  const selectorCode = readSelectorText(['.error-code', '#error-code']);
  const errorCode = chromeErrorPage
    ? selectChromeErrorCode({ structuredCode, selectorCode, bodyText })
    : { code: null, source: null };
  return {
    current_url: currentUrl,
    document_ready_state: String(document.readyState || 'unavailable'),
    document_title: boundedText(document.title, 256),
    runtime_scheme: runtimeScheme,
    chrome_error_page: chromeErrorPage,
    chrome_error_code: errorCode.code,
    chrome_error_code_source: errorCode.source,
    error_heading_summary: chromeErrorPage
      ? readSelectorText(['#main-message h1', '#main-message', 'h1']) || errorCode.code
      : null,
    navigator_online: typeof navigator?.onLine === 'boolean' ? navigator.onLine : null,
    navigation_timing: readNavigationTiming(),
  };
})()`;

export async function chartRuntimeTargetLifecycleTrace(input = {}, dependencies = {}) {
  const expected = normalizeInput(input);
  const runRaw = dependencies.withExactRawTarget
    || ((targetInput, operation) => withExactRawTarget(targetInput, operation, dependencies));
  return runRaw(input, async ({ cdpUrl, client, evaluate }) => {
    const browserClient = await connectBrowserClient(cdpUrl, dependencies);
    const now = dependencies.now || (() => Date.now());
    const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const startedAt = now();
    const samples = [];
    try {
      while (true) {
        const elapsedMs = Math.max(0, now() - startedAt);
        samples.push(await captureSample(expected, cdpUrl, browserClient, client, evaluate, dependencies, elapsedMs));
        const nextElapsedMs = Math.max(0, now() - startedAt);
        if (nextElapsedMs >= expected.durationMs) break;
        await sleep(Math.min(expected.pollIntervalMs, expected.durationMs - nextElapsedMs));
      }
      return {
        success: true,
        trace_version: 'chart-runtime-target-lifecycle-trace-v1',
        status: 'COMPLETED',
        profile_id: expected.profileId,
        target_id: expected.targetId,
        target_url: expected.targetUrl,
        duration_ms: Math.max(0, now() - startedAt),
        requested_duration_ms: expected.durationMs,
        poll_interval_ms: expected.pollIntervalMs,
        trace_classification: classifyTrace(samples),
        samples,
        auto_adoption_performed: false,
        mutations_performed: false,
      };
    } finally {
      try { await browserClient?.close?.(); } catch { /* preserve trace evidence */ }
    }
  });
}

async function captureSample(expected, cdpUrl, browserClient, client, evaluate, dependencies, elapsedMs) {
  const managerView = await readManagerTargets(cdpUrl, dependencies, expected);
  const browserView = await readBrowserTargets(browserClient, expected);
  const runtimeView = await readRuntime(evaluate, client, expected.targetUrl);
  return {
    elapsed_ms: elapsedMs,
    manager_view: managerView,
    browser_view: browserView,
    runtime_view: runtimeView,
    classification: classifySample(expected, managerView, browserView, runtimeView),
  };
}

async function readManagerTargets(cdpUrl, dependencies, expected) {
  try {
    const payload = await fetchJson(new URL('json/list', `${cdpUrl}/`).toString(), dependencies);
    const targets = normalizeTargets(payload);
    return targetView(targets, expected.targetId, expected.targetUrl);
  } catch (error) {
    return targetView([], expected.targetId, expected.targetUrl, safeError(error));
  }
}

async function readBrowserTargets(browserClient, expected) {
  if (!browserClient?.Target?.getTargets) {
    return targetView([], expected.targetId, expected.targetUrl, 'Target.getTargets unavailable');
  }
  let targets;
  try {
    const result = await browserClient.Target.getTargets();
    targets = normalizeTargets(result?.targetInfos || result);
  } catch (error) {
    return targetView([], expected.targetId, expected.targetUrl, safeError(error));
  }
  const view = targetView(targets, expected.targetId, expected.targetUrl);
  let targetInfo;
  try {
    if (!browserClient.Target.getTargetInfo) throw new Error('Target.getTargetInfo unavailable');
    const result = await browserClient.Target.getTargetInfo({ targetId: expected.targetId });
    const normalized = normalizeTarget(result?.targetInfo || result);
    if (!normalized) throw new Error('Target.getTargetInfo returned no target.');
    targetInfo = {
      success: true,
      target_id: normalized.id,
      type: normalized.type,
      url: normalized.url || null,
      title: normalized.title,
      attached: typeof (result?.targetInfo || result)?.attached === 'boolean'
        ? (result?.targetInfo || result).attached
        : null,
      error: null,
    };
  } catch (error) {
    targetInfo = {
      success: false,
      target_id: expected.targetId,
      type: null,
      url: null,
      title: null,
      attached: null,
      error: safeError(error),
    };
  }
  return { ...view, target_info: targetInfo };
}

async function readRuntime(evaluate, client, expectedUrl) {
  try {
    const result = await evaluate(RUNTIME_STATE_EXPRESSION, { awaitPromise: false });
    const runtimeView = {
      success: true,
      current_url: typeof result?.current_url === 'string' ? result.current_url : '',
      document_ready_state: normalizeReadyState(result?.document_ready_state),
      document_title: boundedText(result?.document_title, 256),
      runtime_scheme: boundedText(result?.runtime_scheme, 32),
      chrome_error_page: result?.chrome_error_page === true,
      chrome_error_code: nullableBoundedText(result?.chrome_error_code, 96),
      chrome_error_code_source: normalizeChromeErrorCodeSource(result?.chrome_error_code_source),
      error_heading_summary: nullableBoundedText(result?.error_heading_summary, 256),
      navigator_online: typeof result?.navigator_online === 'boolean' ? result.navigator_online : null,
      navigation_timing: normalizeNavigationTiming(result?.navigation_timing),
      navigation_disposition: deriveNavigationDisposition(result, expectedUrl),
      error: null,
    };
    runtimeView.navigation_history = await readNavigationHistory(client, expectedUrl);
    return runtimeView;
  } catch (error) {
    return {
      success: false,
      current_url: '',
      document_ready_state: 'unavailable',
      document_title: '',
      runtime_scheme: '',
      chrome_error_page: false,
      chrome_error_code: null,
      chrome_error_code_source: null,
      error_heading_summary: null,
      navigator_online: null,
      navigation_timing: emptyNavigationTiming(),
      navigation_disposition: 'RUNTIME_UNAVAILABLE',
      navigation_history: await readNavigationHistory(client, expectedUrl),
      error: safeError(error),
    };
  }
}

async function readNavigationHistory(client, expectedUrl) {
  const unavailable = (error) => ({
    available: false,
    entry_count: null,
    current_index: null,
    current_entry_url_matches_expected: null,
    current_entry_scheme: null,
    current_entry_title: null,
    current_entry_transition_type: null,
    error: error ? safeError(error) : 'Page.getNavigationHistory unavailable',
  });
  if (!client?.Page?.getNavigationHistory) return unavailable();
  try {
    const result = await client.Page.getNavigationHistory();
    const entries = Array.isArray(result?.entries) ? result.entries : [];
    const currentIndex = Number.isSafeInteger(result?.currentIndex) ? result.currentIndex : null;
    const current = currentIndex !== null && currentIndex >= 0 ? entries[currentIndex] : null;
    const currentUrl = typeof current?.url === 'string' ? current.url : '';
    return {
      available: true,
      entry_count: entries.length,
      current_index: currentIndex,
      current_entry_url_matches_expected: current ? currentUrl === expectedUrl : null,
      current_entry_scheme: schemeOf(currentUrl),
      current_entry_title: nullableBoundedText(current?.title, 256),
      current_entry_transition_type: nullableBoundedText(current?.transitionType, 64),
      error: null,
    };
  } catch (error) {
    return unavailable(error);
  }
}

export function selectChromeErrorCode({ structuredCode = '', selectorCode = '', bodyText = '' } = {}) {
  for (const [source, value] of [
    ['structured', structuredCode],
    ['selector', selectorCode],
    ['body_regex', bodyText],
  ]) {
    const match = String(value || '').match(/\b(?:ERR|DNS_PROBE)(?:[_-][A-Z0-9*]+)+\b/iu);
    if (match) return { code: match[0].toUpperCase().replace(/-/gu, '_'), source };
  }
  return { code: null, source: null };
}

export function deriveNavigationDisposition(result, expectedUrl) {
  if (!result || typeof result !== 'object') return 'RUNTIME_UNAVAILABLE';
  if (typeof result.current_url !== 'string') return 'RUNTIME_UNAVAILABLE';
  if (result.chrome_error_page === true || schemeOf(result.current_url) === 'chrome-error') return 'CHROME_NETWORK_ERROR';
  if (result.current_url === 'about:blank') return 'DOCUMENT_ABOUT_BLANK';
  if (result.current_url === expectedUrl) return 'DOCUMENT_EXACT';
  return 'DOCUMENT_OTHER_URL';
}

function targetView(targets, targetId, targetUrl, error = null) {
  const normalizedTargets = targets.map(normalizeTarget).filter(Boolean);
  const exactTargetIds = normalizedTargets
    .filter((target) => target.url === targetUrl)
    .map((target) => target.id);
  return {
    success: error === null,
    targets: normalizedTargets,
    exact_target_ids: exactTargetIds,
    target_present: normalizedTargets.some((target) => target.id === targetId),
    exact_target_present: exactTargetIds.includes(targetId),
    error,
  };
}

function classifySample(expected, manager, browser, runtime) {
  if (manager.exact_target_ids.length > 1 || browser.exact_target_ids.length > 1) return 'MULTIPLE_EXACT_TARGETS';
  if (manager.exact_target_ids.some((id) => id !== expected.targetId)
    || browser.exact_target_ids.some((id) => id !== expected.targetId)) return 'TARGET_REPLACED';
  if (manager.target_present && browser.target_present && manager.exact_target_present !== browser.exact_target_present) {
    return 'MANAGER_BROWSER_DISAGREEMENT';
  }
  const managerTarget = manager.targets.find((target) => target.id === expected.targetId);
  const browserTarget = browser.targets.find((target) => target.id === expected.targetId);
  if (managerTarget?.url === 'about:blank' && browserTarget?.url === 'about:blank') return 'SAME_TARGET_BECAME_BLANK';
  if (manager.target_present && !browser.target_present && browser.success) return 'MANAGER_BROWSER_DISAGREEMENT';
  if (runtime.success && runtime.current_url !== expected.targetUrl) return 'RUNTIME_URL_MISMATCH';
  if (!manager.success) return 'MANAGER_VIEW_UNAVAILABLE';
  if (!browser.success) return 'BROWSER_TARGET_VIEW_UNAVAILABLE';
  if (!runtime.success) return 'RUNTIME_VIEW_UNAVAILABLE';
  return 'STABLE_EXACT_TARGET';
}

function classifyTrace(samples) {
  const classifications = new Set(samples.map((sample) => sample.classification));
  const priority = [
    'MULTIPLE_EXACT_TARGETS',
    'TARGET_REPLACED',
    'MANAGER_BROWSER_DISAGREEMENT',
    'SAME_TARGET_BECAME_BLANK',
    'RUNTIME_URL_MISMATCH',
    'MANAGER_VIEW_UNAVAILABLE',
    'BROWSER_TARGET_VIEW_UNAVAILABLE',
    'RUNTIME_VIEW_UNAVAILABLE',
  ];
  return priority.find((value) => classifications.has(value)) || 'STABLE_EXACT_TARGET';
}

async function connectBrowserClient(cdpUrl, dependencies) {
  const version = await fetchJson(new URL('json/version', `${cdpUrl}/`).toString(), dependencies);
  const webSocketDebuggerUrl = typeof version?.webSocketDebuggerUrl === 'string'
    ? version.webSocketDebuggerUrl
    : '';
  if (!webSocketDebuggerUrl) throw new Error('Browser CDP WebSocket endpoint is unavailable.');
  const connect = dependencies.connectBrowser || ((target) => CDP({ target, local: true }));
  return connect(webSocketDebuggerUrl);
}

async function fetchJson(url, { fetch: fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url);
  if (!response?.ok) throw new Error(`request failed: ${response?.status || 'unknown'}`);
  return response.json();
}

function normalizeTargets(value) {
  const targets = Array.isArray(value) ? value : [];
  return targets.map(normalizeTarget).filter(Boolean);
}

function normalizeTarget(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id : typeof value.targetId === 'string' ? value.targetId : '';
  if (!id) return null;
  return {
    id,
    type: typeof value.type === 'string' ? value.type : null,
    url: typeof value.url === 'string' ? value.url : '',
    title: typeof value.title === 'string' ? value.title : null,
  };
}

function normalizeInput(input) {
  const durationMs = bounded(input.duration_ms, DEFAULT_DURATION_MS, 1, MAX_DURATION_MS);
  const pollIntervalMs = bounded(input.poll_interval_ms, DEFAULT_POLL_INTERVAL_MS, 1, 5_000);
  const profileId = text(input.profile_id);
  const targetId = text(input.target_id);
  const targetUrl = text(input.target_url);
  if (!profileId || !targetId || !targetUrl) throw new Error('Lifecycle trace requires exact profile, target, and URL.');
  try { new URL(targetUrl); } catch { throw new Error('Lifecycle trace target URL is invalid.'); }
  return { profileId, targetId, targetUrl, durationMs, pollIntervalMs };
}

function bounded(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function text(value) { return typeof value === 'string' ? value.trim() : String(value || '').trim(); }
function normalizeReadyState(value) { return ['loading', 'interactive', 'complete'].includes(value) ? value : 'unavailable'; }
function boundedText(value, limit) { return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, limit) : ''; }
function nullableBoundedText(value, limit) { const text = boundedText(value, limit); return text || null; }
function normalizeChromeErrorCodeSource(value) { return ['structured', 'selector', 'body_regex'].includes(value) ? value : null; }
function schemeOf(value) { try { return new URL(value).protocol.replace(/:$/u, '') || null; } catch { return null; } }
function emptyNavigationTiming() { return { available: false, type: null, duration_ms: null, response_end_ms: null, dom_content_loaded_ms: null, load_event_end_ms: null, redirect_count: null }; }
function normalizeNavigationTiming(value) {
  if (!value || typeof value !== 'object') return emptyNavigationTiming();
  const number = (candidate) => Number.isFinite(candidate) ? Math.max(0, Math.round(candidate)) : null;
  return {
    available: value.available === true,
    type: nullableBoundedText(value.type, 32),
    duration_ms: number(value.duration_ms),
    response_end_ms: number(value.response_end_ms),
    dom_content_loaded_ms: number(value.dom_content_loaded_ms),
    load_event_end_ms: number(value.load_event_end_ms),
    redirect_count: Number.isSafeInteger(value.redirect_count) ? value.redirect_count : null,
  };
}
function safeError(error) { return String(error?.message || error || 'unknown error').slice(0, 512); }
