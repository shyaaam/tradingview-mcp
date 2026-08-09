import CDP from 'chrome-remote-interface';

import { withExactRawTarget } from './chart-runtime-readiness.js';

const DEFAULT_DURATION_MS = 35_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_DURATION_MS = 40_000;
const RUNTIME_STATE_EXPRESSION = `(() => ({
  current_url: String(window.location && window.location.href || ''),
  document_ready_state: String(document.readyState || 'unavailable'),
}))()`;

export async function chartRuntimeTargetLifecycleTrace(input = {}, dependencies = {}) {
  const expected = normalizeInput(input);
  const runRaw = dependencies.withExactRawTarget
    || ((targetInput, operation) => withExactRawTarget(targetInput, operation, dependencies));
  return runRaw(input, async ({ cdpUrl, evaluate }) => {
    const browserClient = await connectBrowserClient(cdpUrl, dependencies);
    const now = dependencies.now || (() => Date.now());
    const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const startedAt = now();
    const samples = [];
    try {
      while (true) {
        const elapsedMs = Math.max(0, now() - startedAt);
        samples.push(await captureSample(expected, cdpUrl, browserClient, evaluate, dependencies, elapsedMs));
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

async function captureSample(expected, cdpUrl, browserClient, evaluate, dependencies, elapsedMs) {
  const managerView = await readManagerTargets(cdpUrl, dependencies, expected);
  const browserView = await readBrowserTargets(browserClient, expected);
  const runtimeView = await readRuntime(evaluate);
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

async function readRuntime(evaluate) {
  try {
    const result = await evaluate(RUNTIME_STATE_EXPRESSION, { awaitPromise: false });
    return {
      success: true,
      current_url: typeof result?.current_url === 'string' ? result.current_url : '',
      document_ready_state: normalizeReadyState(result?.document_ready_state),
      error: null,
    };
  } catch (error) {
    return {
      success: false,
      current_url: '',
      document_ready_state: 'unavailable',
      error: safeError(error),
    };
  }
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
function safeError(error) { return String(error?.message || error || 'unknown error').slice(0, 512); }
