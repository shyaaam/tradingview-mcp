import CDP from 'chrome-remote-interface';

import { resolveCloakManagerBaseUrl } from './cloak.js';
import { resolveManagerCdpUrl } from './manager-cdp.js';
import { normalizeChartUrl } from './chart-target-hydration.js';

const DEFAULT_VERIFICATION_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;
const SAVED_CHART_PATH = /^\/chart\/([A-Za-z0-9_-]+)\/?$/u;

export const CHART_RUNTIME_HYDRATION_V2_EXPRESSION = `
(() => {
  const text = (value, limit = 256) => String(value || '').replace(/\\s+/gu, ' ').trim().slice(0, limit);
  const currentUrl = String(window.location && window.location.href || '');
  const path = String(window.location && window.location.pathname || '');
  const body = text(document.body && (document.body.innerText || document.body.textContent), 2048).toLowerCase();
  const scheme = (() => { try { return new URL(currentUrl).protocol.replace(/:$/u, ''); } catch { return ''; } })();
  const chromeErrorPage = scheme === 'chrome-error'
    || document.documentElement?.id === 'error-page'
    || Boolean(document.querySelector('#main-frame-error'));
  const login = /\\/(?:accounts\\/(?:signin|login)|signin|login)(?:\\/|$)/iu.test(path)
    || /\\b(?:sign[ -]?in|log[ -]?in|create account|join for free|authentication required)\\b/iu.test(body);
  const challenge = /\\b(?:captcha|challenge|verify you are human|security check|access denied)\\b/iu.test(body);
  return {
    runtime_url: currentUrl,
    document_ready_state: ['loading', 'interactive', 'complete'].includes(document.readyState) ? document.readyState : 'unavailable',
    document_title: text(document.title),
    chrome_error_page,
    login_state: login ? 'present' : 'absent',
    challenge_state: challenge ? 'present' : 'absent',
  };
})()`;

export async function hydrateChartTargetV2(input = {}, dependencies = {}) {
  const deps = { ...input._deps, ...dependencies };
  const expected = normalizeInput(input);
  const managerBaseUrl = deps.managerBaseUrl || await resolveCloakManagerBaseUrl();
  if (!managerBaseUrl) throw new Error('CloakBrowser Manager is required for chart target hydration v2.');
  const profile = await loadExactProfile(managerBaseUrl, expected.profileId, deps);
  if (!['running', 'active'].includes(String(profile.status || profile.state || '').toLowerCase())) {
    return blocked(expected, { state: 'blocked-target-missing' });
  }
  const cdpUrl = resolveManagerCdpUrl(managerBaseUrl, expected.profileId, profile.cdp_url || profile.cdp_endpoint || profile.cdpUrl);
  const version = await fetchJson(new URL('json/version', `${cdpUrl}/`).toString(), deps);
  const before = await listTargets(cdpUrl, deps);
  const exact = exactTargets(before, expected.chartUrl, expected.savedChartId);
  if (exact.length > 1) return blocked(expected, { state: 'blocked-target-ambiguous', targetMetadataUrl: null });

  if (exact.length === 1) {
    const target = exact[0];
    const renderer = await inspectExistingRenderer(target, expected, deps);
    if (renderer.state !== 'existing-renderer-verified') {
      return blocked(expected, {
        state: renderer.state,
        targetId: target.id,
        targetMetadataUrl: target.url,
        renderer,
      });
    }
    return successResult(expected, {
      state: 'existing-renderer-verified',
      targetId: target.id,
      targetMetadataUrl: target.url,
      renderer,
      navigationPerformed: false,
      targetCreated: false,
    });
  }

  const browserWebSocketUrl = typeof version?.webSocketDebuggerUrl === 'string' ? version.webSocketDebuggerUrl : '';
  if (!browserWebSocketUrl) return blocked(expected, { state: 'blocked-target-missing' });
  const browserClient = await (deps.connectBrowser || ((target) => CDP({ target, local: true })))(browserWebSocketUrl);
  let created;
  try {
    created = await (deps.createTarget || createBlankTarget)(browserClient);
  } finally {
    try { await browserClient?.close?.(); } catch { /* preserve creation evidence */ }
  }
  const targetId = text(created?.targetId || created?.id);
  if (!targetId) return blocked(expected, { state: 'blocked-target-missing', targetCreated: true });
  const target = await waitForCreatedTarget(cdpUrl, targetId, deps);
  if (!target || target.url !== 'about:blank') {
    return blocked(expected, {
      state: target ? 'blocked-runtime-url-mismatch' : 'blocked-target-missing',
      targetId,
      targetMetadataUrl: target?.url || null,
      targetCreated: true,
    });
  }

  const connect = deps.connect || ((webSocketDebuggerUrl) => CDP({ target: webSocketDebuggerUrl, local: true }));
  const client = await connect(target.webSocketDebuggerUrl);
  try {
    return await navigateAndVerify({
      client,
      cdpUrl,
      expected,
      targetId,
      deps,
    });
  } finally {
    try { await client?.close?.(); } catch { /* preserve hydration evidence */ }
  }
}

async function navigateAndVerify({ client, cdpUrl, expected, targetId, deps }) {
  const network = { events: new Map(), mainRequest: null, mainRequestId: null, response: null, failure: null };
  if (client?.Page?.enable) await client.Page.enable();
  if (client?.Network?.enable) await client.Network.enable();
  subscribe(client?.Network?.requestWillBeSent, (event) => bufferNetworkEvent(network, 'request', event));
  subscribe(client?.Network?.responseReceived, (event) => bufferNetworkEvent(network, 'response', event));
  subscribe(client?.Network?.loadingFailed, (event) => bufferNetworkEvent(network, 'failure', event));

  let pageNavigate;
  try {
    if (!client?.Page?.navigate) throw new Error('Page.navigate unavailable.');
    pageNavigate = sanitizeNavigate(await client.Page.navigate({ url: expected.chartUrl }));
  } catch (error) {
    pageNavigate = sanitizeNavigateError(error);
  }
  network.pageNavigate = pageNavigate;

  const verification = await waitForRenderer(cdpUrl, targetId, expected, network, client, deps);
  const networkEvidence = summarizeNetwork(network);
  const common = {
    targetId,
    targetMetadataUrl: verification.targetMetadataUrl,
    runtime: verification.runtime,
    pageNavigate,
    network: networkEvidence,
    navigationPerformed: true,
    targetCreated: true,
  };
  if (pageNavigate.error_text) return blocked(expected, { ...common, state: 'blocked-page-navigate-error' });
  if (network.failure) return blocked(expected, { ...common, state: 'blocked-main-document-network-failure' });
  if (verification.state === 'blocked-login-required') return blocked(expected, { ...common, state: verification.state });
  if (verification.state === 'blocked-chrome-error-document') return blocked(expected, { ...common, state: verification.state });
  if (verification.state === 'blocked-runtime-url-mismatch') return blocked(expected, { ...common, state: verification.state });
  if (verification.state === 'blocked-target-missing') return blocked(expected, { ...common, state: verification.state });
  if (verification.state === 'renderer-verified') {
    if (verification.targetMetadataUrl !== expected.chartUrl) {
      return blocked(expected, { ...common, state: 'blocked-runtime-url-mismatch' });
    }
    return successResult(expected, {
      state: 'renderer-verified',
      targetId,
      targetMetadataUrl: verification.targetMetadataUrl,
      renderer: verification,
      pageNavigate,
      network: networkEvidence,
      navigationPerformed: true,
      targetCreated: true,
    });
  }
  return blocked(expected, { ...common, state: 'blocked-timeout' });
}

async function inspectExistingRenderer(target, expected, deps) {
  if (!target.webSocketDebuggerUrl) return { state: 'blocked-runtime-url-mismatch', runtime: emptyRuntime() };
  const connect = deps.connect || ((webSocketDebuggerUrl) => CDP({ target: webSocketDebuggerUrl, local: true }));
  const client = await connect(target.webSocketDebuggerUrl);
  try {
    if (client?.Runtime?.enable) await client.Runtime.enable();
    const evaluation = await client.Runtime.evaluate({ expression: CHART_RUNTIME_HYDRATION_V2_EXPRESSION, returnByValue: true });
    const runtime = normalizeRuntime(evaluation?.result?.value);
    if (runtime.chrome_error_page) return { state: 'blocked-chrome-error-document', runtime };
    if (runtime.login_state === 'present' || runtime.challenge_state === 'present') return { state: 'blocked-login-required', runtime };
    if (runtime.runtime_url !== expected.chartUrl) return { state: 'blocked-runtime-url-mismatch', runtime };
    if (!['interactive', 'complete'].includes(runtime.document_ready_state)) return { state: 'blocked-timeout', runtime };
    return { state: 'existing-renderer-verified', runtime };
  } catch {
    return { state: 'blocked-runtime-url-mismatch', runtime: emptyRuntime() };
  } finally {
    try { await client?.close?.(); } catch { /* preserve renderer evidence */ }
  }
}

async function waitForRenderer(cdpUrl, targetId, expected, network, client, deps) {
  const started = (deps.now || Date.now)();
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let latest = { state: 'blocked-timeout', targetMetadataUrl: null, runtime: emptyRuntime() };
  while ((deps.now || Date.now)() - started <= DEFAULT_VERIFICATION_TIMEOUT_MS) {
    let targets;
    try {
      targets = await listTargets(cdpUrl, deps);
    } catch {
      return { state: 'blocked-target-missing', targetMetadataUrl: null, runtime: latest.runtime };
    }
    const target = targets.find((entry) => entry.id === targetId);
    if (!target) return { state: 'blocked-target-missing', targetMetadataUrl: null, runtime: latest.runtime };
    if (target.url !== 'about:blank' && target.url !== expected.chartUrl) {
      return { state: 'blocked-runtime-url-mismatch', targetMetadataUrl: target.url, runtime: latest.runtime };
    }
    let runtime = latest.runtime;
    try {
      runtime = await evaluateCurrentRuntime(deps, target, client);
    } catch { /* renderer can remain unavailable during bounded wait */ }
    resolveMainDocument(network);
    if (network.failure) return { state: 'blocked-main-document-network-failure', targetMetadataUrl: target.url, runtime };
    latest = { state: classifyRenderer(runtime, expected.chartUrl), targetMetadataUrl: target.url, runtime };
    if (latest.state === 'renderer-verified' && target.url === expected.chartUrl) return latest;
    if (latest.state === 'renderer-verified' && target.url !== 'about:blank') {
      return { ...latest, state: 'blocked-runtime-url-mismatch' };
    }
    if (latest.state === 'blocked-login-required' || latest.state === 'blocked-chrome-error-document' || latest.state === 'blocked-runtime-url-mismatch') return latest;
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, DEFAULT_VERIFICATION_TIMEOUT_MS - ((deps.now || Date.now)() - started))));
  }
  return latest;
}

async function evaluateCurrentRuntime(deps, target, attachedClient) {
  if (typeof deps.evaluateRuntime === 'function') return normalizeRuntime(await deps.evaluateRuntime(target));
  if (attachedClient?.Runtime?.evaluate) {
    const evaluation = await attachedClient.Runtime.evaluate({ expression: CHART_RUNTIME_HYDRATION_V2_EXPRESSION, returnByValue: true });
    return normalizeRuntime(evaluation?.result?.value);
  }
  if (!target.webSocketDebuggerUrl) return emptyRuntime();
  const connect = deps.verifyConnect || deps.connect || ((webSocketDebuggerUrl) => CDP({ target: webSocketDebuggerUrl, local: true }));
  const client = await connect(target.webSocketDebuggerUrl);
  try {
    if (client?.Runtime?.enable) await client.Runtime.enable();
    const evaluation = await client.Runtime.evaluate({ expression: CHART_RUNTIME_HYDRATION_V2_EXPRESSION, returnByValue: true });
    return normalizeRuntime(evaluation?.result?.value);
  } finally {
    try { await client?.close?.(); } catch { /* preserve verification evidence */ }
  }
}

function classifyRenderer(runtime, expectedUrl) {
  if (runtime.chrome_error_page) return 'blocked-chrome-error-document';
  if (runtime.login_state === 'present' || runtime.challenge_state === 'present') return 'blocked-login-required';
  if (!runtime.runtime_url || runtime.runtime_url === 'about:blank') return 'pending';
  if (runtime.runtime_url !== expectedUrl) return 'blocked-runtime-url-mismatch';
  return ['interactive', 'complete'].includes(runtime.document_ready_state) ? 'renderer-verified' : 'blocked-timeout';
}

function successResult(expected, details) {
  return {
    success: true,
    hydration_version: 'chart-target-hydration-v2',
    authority_id: expected.authorityId,
    authority_hash: expected.authorityHash,
    profile_id: expected.profileId,
    target_id: details.targetId,
    requested_url: expected.chartUrl,
    target_metadata_url: details.targetMetadataUrl || expected.chartUrl,
    runtime_url: details.renderer?.runtime?.runtime_url || expected.chartUrl,
    document_ready_state: details.renderer?.runtime?.document_ready_state || 'complete',
    saved_chart_id: expected.savedChartId,
    navigation_performed: details.navigationPerformed,
    target_created: details.targetCreated,
    renderer_verified: true,
    page_navigate: details.pageNavigate || emptyNavigate(),
    main_document_network: details.network || emptyNetwork(),
    chrome_error_page: false,
    state: details.state,
    mutations_performed: details.navigationPerformed || details.targetCreated,
  };
}

function blocked(expected, details) {
  const runtime = details.renderer?.runtime || details.runtime || emptyRuntime();
  return {
    success: true,
    hydration_version: 'chart-target-hydration-v2',
    authority_id: expected.authorityId,
    authority_hash: expected.authorityHash,
    profile_id: expected.profileId,
    target_id: details.targetId || null,
    requested_url: expected.chartUrl,
    target_metadata_url: details.targetMetadataUrl || null,
    runtime_url: runtime.runtime_url,
    document_ready_state: runtime.document_ready_state,
    saved_chart_id: expected.savedChartId,
    navigation_performed: details.navigationPerformed === true,
    target_created: details.targetCreated === true,
    renderer_verified: false,
    page_navigate: details.pageNavigate || emptyNavigate(),
    main_document_network: details.network || emptyNetwork(),
    chrome_error_page: runtime.chrome_error_page,
    state: details.state,
    mutations_performed: details.navigationPerformed === true || details.targetCreated === true,
  };
}

async function createBlankTarget(browserClient) {
  return browserClient.Target.createTarget({ url: 'about:blank' });
}

async function waitForCreatedTarget(cdpUrl, targetId, deps, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    const target = (await listTargets(cdpUrl, deps)).find((entry) => entry.id === targetId);
    if (target?.type === 'page' && target.webSocketDebuggerUrl) return target;
    await (deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(250);
  }
  return null;
}

async function loadExactProfile(base, profileId, deps) {
  const profiles = await fetchJson(new URL('profiles', `${base}/`).toString(), deps);
  const entries = Array.isArray(profiles) ? profiles : profiles?.profiles;
  const matches = Array.isArray(entries) ? entries.filter((entry) => profileIdFromEntry(entry) === profileId) : [];
  if (matches.length !== 1) throw new Error('Exact Manager profile binding is missing or ambiguous.');
  return matches[0];
}

async function listTargets(cdpUrl, deps) {
  const payload = await fetchJson(new URL('json/list', `${cdpUrl}/`).toString(), deps);
  return (Array.isArray(payload) ? payload : []).filter((entry) => entry?.type === 'page').map(normalizeTarget).filter(Boolean);
}

function exactTargets(targets, chartUrl, savedChartId) {
  return targets.filter((target) => {
    try {
      const parsed = new URL(target.url);
      return parsed.toString() === chartUrl && parsed.pathname.match(SAVED_CHART_PATH)?.[1] === savedChartId;
    } catch { return false; }
  });
}

function normalizeInput(input) {
  const profileId = requireText(input.profile_id, 'profile_id');
  const authorityId = requireIdentity(input.authority_id, 'authority_id');
  const authorityHash = requireHash(input.authority_hash, 'authority_hash');
  const savedChartId = requireText(input.saved_chart_id, 'saved_chart_id');
  return {
    profileId,
    authorityId,
    authorityHash,
    savedChartId,
    chartUrl: normalizeChartUrl(input.chart_url, input.allowed_origins, savedChartId),
  };
}

function normalizeTarget(value) {
  if (!value || typeof value !== 'object') return null;
  const id = text(value.id || value.targetId);
  return id ? { id, type: text(value.type), url: text(value.url), webSocketDebuggerUrl: text(value.webSocketDebuggerUrl) } : null;
}

function normalizeRuntime(value) {
  const runtime = value && typeof value === 'object' ? value : {};
  return {
    runtime_url: text(runtime.runtime_url),
    document_ready_state: ['loading', 'interactive', 'complete'].includes(runtime.document_ready_state) ? runtime.document_ready_state : 'unavailable',
    document_title: text(runtime.document_title).slice(0, 256),
    chrome_error_page: runtime.chrome_error_page === true,
    login_state: runtime.login_state === 'present' ? 'present' : 'absent',
    challenge_state: runtime.challenge_state === 'present' ? 'present' : 'absent',
  };
}

function emptyRuntime() { return normalizeRuntime({}); }
function emptyNavigate() { return { frame_id: null, loader_id: null, error_text: null, is_download: null }; }
function emptyNetwork() { return { request_id: null, frame_id: null, loader_id: null, error_text: null, canceled: null, blocked_reason: null, cors_error_status: null, response: null }; }
function summarizeNetwork(network) {
  const request = network.mainRequest || {};
  const failure = network.failure || {};
  return {
    request_id: failure.request_id || request.request_id || null,
    frame_id: failure.frame_id || request.frame_id || null,
    loader_id: failure.loader_id || request.loader_id || null,
    error_text: failure.error_text || null,
    canceled: failure.canceled ?? null,
    blocked_reason: failure.blocked_reason || null,
    cors_error_status: failure.cors_error_status || null,
    response: network.response || null,
  };
}
function sanitizeNavigate(value) { return { frame_id: text(value?.frameId) || null, loader_id: text(value?.loaderId) || null, error_text: text(value?.errorText).slice(0, 256) || null, is_download: typeof value?.isDownload === 'boolean' ? value.isDownload : null }; }
function sanitizeNavigateError(error) { return { ...emptyNavigate(), error_text: text(error?.message || error).slice(0, 256) || 'Page.navigate failed' }; }
function bufferNetworkEvent(network, kind, event) {
  const requestId = text(event?.requestId);
  if (!requestId) return;
  const entry = network.events.get(requestId) || {};
  entry[kind] = event;
  network.events.set(requestId, entry);
}
function resolveMainDocument(network) {
  if (network.mainRequestId) return;
  const navigate = network.pageNavigate;
  if (!navigate?.frame_id) return;
  for (const [requestId, entry] of network.events) {
    const request = entry.request;
    if (!request || request.type !== 'Document' || text(request.frameId) !== navigate.frame_id) continue;
    if (navigate.loader_id && text(request.loaderId) !== navigate.loader_id) continue;
    network.mainRequestId = requestId;
    network.mainRequest = sanitizeRequest(request);
    network.response = entry.response ? sanitizeResponse(entry.response) : null;
    network.failure = entry.failure ? sanitizeFailure(entry.failure) : null;
    return;
  }
}
function sanitizeRequest(event) { return { request_id: text(event?.requestId) || null, frame_id: text(event?.frameId) || null, loader_id: text(event?.loaderId) || null }; }
function sanitizeResponse(event) { return { status: Number.isFinite(event?.response?.status) ? event.response.status : null, mime_type: text(event?.response?.mimeType) || null, protocol: text(event?.response?.protocol) || null }; }
function sanitizeFailure(event) { return { request_id: text(event?.requestId) || null, frame_id: text(event?.frameId) || null, loader_id: text(event?.loaderId) || null, error_text: text(event?.errorText).slice(0, 256) || null, canceled: typeof event?.canceled === 'boolean' ? event.canceled : null, blocked_reason: text(event?.blockedReason).slice(0, 128) || null, cors_error_status: sanitizeCorsStatus(event?.corsErrorStatus) }; }
function sanitizeCorsStatus(value) { return value && typeof value === 'object' ? { corsError: text(value.corsError).slice(0, 128) || null, failedParameter: text(value.failedParameter).slice(0, 128) || null } : null; }
function subscribe(method, handler) { if (typeof method === 'function') method(handler); }
async function fetchJson(url, deps) { const response = await (deps.fetch || fetch)(url); if (!response?.ok) throw new Error(`request failed: ${response?.status || 'unknown'}`); return response.json(); }
function profileIdFromEntry(entry) { return text(entry?.profile_id || entry?.id || entry?.profileId); }
function text(value) { return typeof value === 'string' ? value.trim() : String(value || '').trim(); }
function requireText(value, name) { const result = text(value); if (!result) throw new Error(`${name} is required.`); return result; }
function requireHash(value, name) { const result = requireText(value, name); if (!/^[0-9a-f]{64}$/u.test(result)) throw new Error(`${name} must be lowercase SHA-256.`); return result; }
function requireIdentity(value, name) { const result = requireText(value, name); if (!/^[a-z0-9-]+:[0-9a-f]{64}$/u.test(result)) throw new Error(`${name} is invalid.`); return result; }
