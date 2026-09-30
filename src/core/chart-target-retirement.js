import { createHash } from 'node:crypto';
import WebSocket from 'ws';

import { resolveCloakManagerBaseUrl } from './cloak.js';
import { resolveManagerCdpUrl } from './manager-cdp.js';
import { resolveExactRunningProfile } from './chart-target-open.js';
import { ACCOUNT_LAYOUT_PROBE, savedChartLayoutMarker } from './saved-chart-authority.js';

const CHART_PAGE = /^https:\/\/www\.tradingview\.com\/chart\//u;
const CHART_ORIGIN = 'https://www.tradingview.com';
const AUTHORITY_SCHEMA_VERSION = 'v5-capture-slot-authority-v3';
const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;
const MAX_RETIREMENT_READ_BYTES = 128 * 1024;
const MAX_CDP_TARGET_ID_CHARS = 256;
const MAX_CDP_TARGET_URL_CHARS = 4_096;

/** Close only one exact saved-chart target; the durable saved chart is not deleted. */
export async function retireSavedChartTarget(input = {}, dependencies = {}) {
  const requested = normalizeInput(input);
  const reviewedInput = dependencies.reviewedAuthority ?? readReviewedAuthority();
  const expected = normalizeInput(reviewedInput);
  if (!sameAuthority(requested, expected)) {
    throw new Error('Retirement request differs from the per-worker reviewed capture-slot authority.');
  }
  const timeoutMs = boundedPositiveInteger(dependencies.timeoutMs, DEFAULT_TIMEOUT_MS);
  const now = dependencies.now || (() => performance.now());
  const deadline = { at: now() + timeoutMs, now, timeoutMs };
  const fetchImpl = dependencies.fetch || fetch;
  const requestJson = (url) => fetchJson(url, fetchImpl, deadline);
  const managerBaseUrl = dependencies.managerBaseUrl
    || await withDeadline(() => resolveCloakManagerBaseUrl({ fetchJson: requestJson }), deadline);
  if (!managerBaseUrl) throw new Error('CloakBrowser Manager is required for saved-chart retirement.');
  const resolveProfile = dependencies.resolveExactRunningProfile || resolveExactRunningProfile;
  const profile = await resolveProfile(expected.profileName, { ...dependencies, managerBaseUrl });
  const profileId = requireText(profile.profileId, 'current profile ID');
  const cdpUrl = resolveManagerCdpUrl(managerBaseUrl, profileId, profile.cdpUrl);
  const version = await requestJson(new URL('json/version', `${cdpUrl}/`).toString());
  const browserWebSocketUrl = requireProfileBrowserWebSocketUrl(
    version?.webSocketDebuggerUrl,
    cdpUrl,
    profileId,
  );
  const connectBrowser = dependencies.connectBrowser || connectBoundedBrowser;
  const browser = await withDeadline(
    () => connectBrowser(browserWebSocketUrl, {
      maxPayload: MAX_RETIREMENT_READ_BYTES,
      handshakeTimeoutMs: Math.max(1, Math.floor(remainingMs(deadline) - POLL_INTERVAL_MS)),
    }),
    deadline,
  );
  try {
    return await retireFromProfile({
      expected,
      dependencies,
      deadline,
      browser,
      requestJson,
      cdpUrl,
    });
  } finally {
    try { await browser.close?.(); } catch { /* preserve retirement outcome */ }
  }
}

function connectBoundedBrowser(url, { maxPayload, handshakeTimeoutMs }) {
  if (maxPayload !== MAX_RETIREMENT_READ_BYTES || !Number.isSafeInteger(handshakeTimeoutMs)
    || handshakeTimeoutMs <= 0) {
    throw new Error('Browser CDP transport bounds are invalid.');
  }
  const socket = new WebSocket(url, {
    maxPayload,
    handshakeTimeout: handshakeTimeoutMs,
    perMessageDeflate: false,
  });
  const pending = new Map();
  let nextId = 1;
  let opened = false;
  let rejectOpen;
  const connected = new Promise((resolve, reject) => {
    rejectOpen = reject;
    socket.once('open', () => {
      opened = true;
      resolve();
    });
  });
  const failPending = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  socket.on('error', (error) => {
    if (!opened) rejectOpen(handshakeError(error, handshakeTimeoutMs));
    failPending(transportError(error));
  });
  socket.on('close', () => {
    const error = new Error('Browser CDP WebSocket closed.');
    if (!opened) rejectOpen(error);
    failPending(error);
  });
  socket.on('message', (data) => {
    const bytes = Buffer.isBuffer(data) ? data.byteLength : Buffer.byteLength(String(data));
    if (bytes > maxPayload) {
      socket.terminate();
      failPending(new Error(`Browser CDP frame exceeds bounded ${maxPayload}-byte transport limit.`));
      return;
    }
    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      socket.terminate();
      failPending(new Error('Browser CDP returned malformed JSON.'));
      return;
    }
    if (!Number.isSafeInteger(message?.id)) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`Browser CDP command failed: ${String(message.error.message || 'unknown error')}`));
    else request.resolve(message.result || {});
  });

  const send = (method, params = {}, sessionId) => {
    if (socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Browser CDP WebSocket is not open.'));
    }
    const id = nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify(message), (error) => {
        if (!error) return;
        pending.delete(id);
        reject(transportError(error));
      });
    });
  };
  const browser = {
    Target: {
      attachToTarget: (params) => send('Target.attachToTarget', params),
      detachFromTarget: (params) => send('Target.detachFromTarget', params),
      closeTarget: (params) => send('Target.closeTarget', params),
    },
    send,
    close: () => {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    },
  };
  return connected.then(() => browser, (error) => {
    socket.terminate();
    throw error;
  });
}

function handshakeError(error, timeoutMs) {
  if (/handshake.*timed out/iu.test(String(error?.message || ''))) {
    return new Error(`Browser CDP WebSocket handshake exceeded bounded ${timeoutMs}ms deadline.`);
  }
  return error;
}

function transportError(error) {
  if (/max payload size exceeded/iu.test(String(error?.message || ''))) {
    return new Error(`Browser CDP frame exceeds bounded ${MAX_RETIREMENT_READ_BYTES}-byte transport limit.`);
  }
  return error;
}

async function retireFromProfile({ expected, dependencies, deadline, browser, requestJson, cdpUrl }) {
  const targetListUrl = new URL('json/list', `${cdpUrl}/`).toString();
  const before = pageTargets(await requestJson(targetListUrl));
  const beforeCharts = chartTargets(before);
  const beforeViews = await inspectChartTargets(beforeCharts, expected, browser, dependencies, deadline);
  assertNoConflictingSavedLayoutTarget(beforeViews, expected);
  const exact = beforeViews.filter((view) => isExactSavedLayout(view, expected));
  if (exact.length > 1) throw new Error('Exact saved-layout is open in multiple targets; refusing retirement.');
  if (exact.length === 0) {
    return result(expected, null, 'already-closed', beforeCharts.length, false,
      beforeViews[0]?.accountSubjectSha256 ?? null);
  }
  const beforeIdentity = exact[0];
  const target = beforeIdentity.target;
  if (before.length <= 1) throw new Error('Cannot retire the last browser page in the exact profile.');
  const preClose = pageTargets(await requestJson(targetListUrl));
  const preCloseCharts = chartTargets(preClose);
  const preCloseViews = await inspectChartTargets(preCloseCharts, expected, browser, dependencies, deadline);
  assertNoConflictingSavedLayoutTarget(preCloseViews, expected);
  const currentExact = preCloseViews.filter((view) => isExactSavedLayout(view, expected));
  if (currentExact.length !== 1 || currentExact[0].target.id !== target.id
    || !samePageInventory(before, preClose)
    || !sameChartViews(beforeViews, preCloseViews)) {
    throw new Error('TradingView page inventory changed before exact saved-layout retirement.');
  }
  const closeResult = await withDeadline(
    () => browser.Target.closeTarget({ targetId: target.id }),
    deadline,
  );
  if (closeResult?.success !== true) throw new Error('Exact saved-chart target close was not acknowledged.');

  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let after = before;
  let afterViews = beforeViews;
  while (remainingMs(deadline) > 0) {
    after = pageTargets(await requestJson(targetListUrl));
    afterViews = await inspectChartTargets(chartTargets(after), expected, browser, dependencies, deadline);
    if (!after.some((entry) => entry.id === target.id)
      && !afterViews.some((view) => isExactSavedLayout(view, expected))) break;
    await withDeadline(
      () => sleep(Math.min(POLL_INTERVAL_MS, remainingMs(deadline))),
      deadline,
    );
  }
  if (after.some((entry) => entry.id === target.id)
    || afterViews.some((view) => isExactSavedLayout(view, expected))) {
    throw new Error('Exact saved-layout target remained open after bounded close.');
  }
  const preservedBefore = beforeViews.filter((view) => view.target.id !== target.id);
  if (!samePageInventory(before, after, target.id)
    || !sameChartViews(preservedBefore, afterViews)) {
    throw new Error('Saved-layout retirement changed another TradingView chart target.');
  }
  return result(expected, target.id, 'closed', chartTargets(after).length, true,
    beforeIdentity.accountSubjectSha256);
}

function normalizeInput(input) {
  const profileName = requirePattern(input.profile_name, 'profile_name', /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,159}$/u);
  const captureSlotId = requirePattern(input.capture_slot_id, 'capture_slot_id', /^v5-capture-slot-[ab]$/u);
  const layoutCode = requirePattern(input.layout_code, 'layout_code', /^s$/u);
  const authorityId = requirePattern(input.authority_id, 'authority_id', /^v5-capture-slot:[0-9a-f]{64}$/u);
  const authorityHash = requirePattern(input.authority_hash, 'authority_hash', /^[0-9a-f]{64}$/u);
  if (authorityId !== `v5-capture-slot:${authorityHash}`) {
    throw new Error('authority_id does not match authority_hash.');
  }
  const savedLayoutId = requirePattern(input.saved_layout_id, 'saved_layout_id', /^[A-Za-z0-9_-]{1,160}$/u);
  const reconciliationKey = requirePattern(input.reconciliation_key, 'reconciliation_key', /^[0-9a-f]{64}$/u);
  const allowedOrigins = Array.isArray(input.allowed_origins) ? input.allowed_origins : [];
  if (allowedOrigins.length !== 1 || allowedOrigins[0] !== CHART_ORIGIN) {
    throw new Error('allowed_origins must equal the reviewed TradingView chart origin.');
  }
  const marker = savedChartLayoutMarker(captureSlotId, reconciliationKey);
  const computedHash = captureSlotAuthorityHash({
    captureSlotId,
    profileName,
    savedLayoutId,
    layoutCode,
    allowedOrigins,
  });
  if (authorityHash !== computedHash || authorityId !== `v5-capture-slot:${computedHash}`) {
    throw new Error('Capture-slot authority hash does not bind the stable profile and saved layout.');
  }
  return Object.freeze({
    profileName,
    captureSlotId,
    layoutCode,
    authorityId,
    authorityHash,
    savedLayoutId,
    reconciliationKey,
    marker,
    allowedOrigins: Object.freeze([...allowedOrigins]),
  });
}

function result(expected, targetId, action, remainingChartTargets, mutationsPerformed, accountSubjectSha256) {
  return Object.freeze({
    success: true,
    retirement_version: 'saved-layout-retirement-v1',
    authority_id: expected.authorityId,
    authority_hash: expected.authorityHash,
    profile_name: expected.profileName,
    saved_layout_id: expected.savedLayoutId,
    account_subject_sha256: accountSubjectSha256,
    chart_target_id: targetId,
    action,
    remaining_chart_targets: remainingChartTargets,
    mutations_performed: mutationsPerformed,
  });
}

function pageTargets(value) {
  if (!Array.isArray(value)) throw new Error('CDP target listing is malformed.');
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('CDP target listing contains a malformed entry.');
    }
    if (entry.type !== 'page') return [];
    if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > MAX_CDP_TARGET_ID_CHARS
      || /[\u0000-\u001f\u007f]/u.test(entry.id)
      || typeof entry.url !== 'string' || entry.url.length === 0 || entry.url.length > MAX_CDP_TARGET_URL_CHARS) {
      throw new Error('CDP page target identity is malformed.');
    }
    return [entry];
  });
}

function chartTargets(targets) {
  return targets.filter((target) => CHART_PAGE.test(target.url));
}

async function readTargetIdentity(browser, target, deadline) {
  const attached = await withDeadline(
    () => browser.Target.attachToTarget({ targetId: target.id, flatten: true }),
    deadline,
    () => browser.close?.(),
  );
  const sessionId = requireText(attached?.sessionId, 'exact target CDP session ID');
  try {
    const response = await withDeadline(() => browser.send('Runtime.evaluate', {
      expression: ACCOUNT_LAYOUT_PROBE,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId), deadline, () => browser.close?.());
    if (response?.exceptionDetails || response?.result?.type !== 'object'
      || !response.result.value || typeof response.result.value !== 'object') {
      throw new Error('TradingView saved-layout identity readback failed.');
    }
    let encoded;
    try { encoded = JSON.stringify(response.result.value); } catch { encoded = null; }
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > MAX_RETIREMENT_READ_BYTES) {
      throw new Error('TradingView saved-layout identity readback is malformed or exceeds its bounded read limit.');
    }
    const value = response.result.value;
    return {
      href: value.current_url,
      account_subject_sha256: value.account_subject_sha256,
      saved_layout_id: value.active_saved_layout_id,
      saved_layout_name: value.active_saved_layout_name,
      layouts: Array.isArray(value.layouts)
        ? value.layouts.map(({ layout_id: layoutId, name }) => ({ layout_id: layoutId, name }))
        : value.layouts,
    };
  } finally {
    try {
      await withDeadline(() => browser.Target.detachFromTarget({ sessionId }), deadline, () => browser.close?.());
    } catch { /* closing the exact-profile browser connection releases the session */ }
  }
}

async function inspectChartTargets(targets, expected, browser, dependencies, deadline) {
  if (targets.length === 0) return Object.freeze([]);
  const inspect = dependencies.readTargetIdentity || ((target) => readTargetIdentity(browser, target, deadline));
  const views = [];
  for (const target of targets) {
    const raw = await withDeadline(() => inspect(target), deadline);
    views.push(normalizeTargetIdentity(raw, target, expected));
  }
  views.sort((left, right) => left.target.id.localeCompare(right.target.id));
  const accountHashes = new Set(views.map((view) => view.accountSubjectSha256));
  const inventoryHashes = new Set(views.map((view) => view.layoutInventorySha256));
  if (accountHashes.size !== 1 || inventoryHashes.size !== 1) {
    throw new Error('TradingView account or saved-layout inventory changed across exact profile targets.');
  }
  return Object.freeze(views);
}

function normalizeTargetIdentity(value, target, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.href !== target.url
    || typeof value.account_subject_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.account_subject_sha256)
    || typeof value.saved_layout_id !== 'string'
    || !/^[A-Za-z0-9_-]{1,160}$/u.test(value.saved_layout_id)
    || typeof value.saved_layout_name !== 'string'
    || value.saved_layout_name.length < 1 || value.saved_layout_name.length > 160
    || !Array.isArray(value.layouts)) {
    throw new Error('TradingView page did not prove authenticated active saved-layout metadata.');
  }
  const layouts = value.layouts.map((layout, index) => {
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)
      || typeof layout.layout_id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/u.test(layout.layout_id)
      || typeof layout.name !== 'string' || layout.name.length === 0 || layout.name.length > 160) {
      throw new Error(`TradingView saved-layout inventory entry ${index} is malformed.`);
    }
    return { layout_id: layout.layout_id, name: layout.name };
  }).sort((left, right) => left.layout_id.localeCompare(right.layout_id) || left.name.localeCompare(right.name));
  const exactMarker = layouts.filter((layout) => layout.name === expected.marker);
  if (exactMarker.length !== 1 || exactMarker[0].layout_id !== expected.savedLayoutId) {
    throw new Error('Exact saved-layout marker and server ID are missing or ambiguous in current account.');
  }
  const activeSavedLayoutId = requirePattern(value.saved_layout_id, 'active saved-layout ID', /^[A-Za-z0-9_-]{1,160}$/u);
  const activeSavedLayoutName = requireText(value.saved_layout_name, 'active saved-layout name');
  const layoutInventorySha256 = createHash('sha256').update(JSON.stringify(layouts), 'utf8').digest('hex');
  return Object.freeze({
    target,
    activeSavedLayoutId,
    activeSavedLayoutName,
    accountSubjectSha256: value.account_subject_sha256,
    layoutInventorySha256,
  });
}

function isExactSavedLayout(view, expected) {
  return view.activeSavedLayoutId === expected.savedLayoutId
    && view.activeSavedLayoutName === expected.marker;
}

function assertNoConflictingSavedLayoutTarget(views, expected) {
  if (views.some((view) => (view.activeSavedLayoutId === expected.savedLayoutId
    || view.activeSavedLayoutName === expected.marker) && !isExactSavedLayout(view, expected))) {
    throw new Error('Active TradingView page conflicts with exact saved-layout authority identity.');
  }
}

function sameChartViews(left, right) {
  const identity = (views) => views.map((view) => ({
    target: targetIdentity(view.target),
    activeSavedLayoutId: view.activeSavedLayoutId,
    activeSavedLayoutName: view.activeSavedLayoutName,
    accountSubjectSha256: view.accountSubjectSha256,
    layoutInventorySha256: view.layoutInventorySha256,
  })).sort((a, b) => a.target.id.localeCompare(b.target.id));
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right));
}

function samePageInventory(left, right, excludedTargetId = null) {
  const identity = (targets) => targets.filter((target) => target.id !== excludedTargetId)
    .map(targetIdentity).sort(compareIdentity);
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right));
}

function targetIdentity(target) {
  return { id: target.id, type: target.type, url: target.url };
}

function requireProfileBrowserWebSocketUrl(value, cdpUrl, profileId) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Browser CDP WebSocket endpoint is unavailable.');
  }
  let endpoint;
  let profileEndpoint;
  try {
    endpoint = new URL(value);
    profileEndpoint = new URL(cdpUrl);
  } catch {
    throw new Error('Browser CDP WebSocket endpoint is malformed.');
  }
  if (!isExactProfileCdpPath(profileEndpoint.pathname, profileId)
    || profileEndpoint.username || profileEndpoint.password || profileEndpoint.search || profileEndpoint.hash) {
    throw new Error('Manager CDP endpoint is outside exact Manager profile authority.');
  }
  const expectedProtocol = profileEndpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  const expectedPath = profileEndpoint.pathname.replace(/\/+$/u, '') || '/';
  if (endpoint.protocol !== expectedProtocol || endpoint.host !== profileEndpoint.host
    || endpoint.pathname.replace(/\/+$/u, '') !== expectedPath
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Browser CDP WebSocket endpoint is outside exact Manager profile authority.');
  }
  return endpoint.toString();
}

function isExactProfileCdpPath(pathname, profileId) {
  let segments;
  try {
    segments = pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    return false;
  }
  const profilesIndex = segments.lastIndexOf('profiles');
  return profilesIndex >= 0
    && segments[profilesIndex + 1] === profileId
    && segments[profilesIndex + 2] === 'cdp'
    && profilesIndex + 3 === segments.length;
}

function compareIdentity(left, right) {
  return left.id.localeCompare(right.id) || left.url.localeCompare(right.url);
}

async function fetchJson(url, fetchImpl, deadline) {
  const controller = new AbortController();
  return withDeadline(async () => {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response?.ok) {
      throw new Error(`request failed: ${response?.status || 'unknown'} ${response?.statusText || ''}`.trim());
    }
    const text = await readBoundedResponseText(response, controller);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Manager/CDP response is not valid bounded JSON.');
    }
  }, deadline, () => controller.abort());
}

async function readBoundedResponseText(response, controller) {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_RETIREMENT_READ_BYTES) {
    controller.abort();
    throw new Error(`Manager/CDP response exceeds bounded ${MAX_RETIREMENT_READ_BYTES}-byte read limit.`);
  }
  if (response.body === null) return '';
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('Manager/CDP response body stream is unavailable.');

  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      totalBytes += item.value.byteLength;
      if (totalBytes > MAX_RETIREMENT_READ_BYTES) {
        controller.abort();
        await reader.cancel().catch(() => {});
        throw new Error(`Manager/CDP response exceeds bounded ${MAX_RETIREMENT_READ_BYTES}-byte read limit.`);
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function remainingMs(deadline) {
  return deadline.at - deadline.now();
}

function withDeadline(operation, deadline, onTimeout = () => {}) {
  const remaining = remainingMs(deadline);
  if (remaining <= 0) return Promise.reject(deadlineError(deadline.timeoutMs));
  let timer;
  const work = Promise.resolve().then(operation);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout(); } catch { /* preserve timeout */ }
      reject(deadlineError(deadline.timeoutMs));
    }, remaining);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function deadlineError(timeoutMs) {
  return new Error(`Saved-chart retirement exceeded bounded ${timeoutMs}ms deadline.`);
}

function readReviewedAuthority() {
  const raw = String(process.env.V5_CAPTURE_SLOT_AUTHORITY_JSON || '');
  if (!raw) throw new Error('Per-worker reviewed capture-slot authority is required for retirement.');
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error('Per-worker reviewed capture-slot authority is malformed.');
  }
}

function sameAuthority(left, right) {
  return left.profileName === right.profileName
    && left.captureSlotId === right.captureSlotId
    && left.layoutCode === right.layoutCode
    && left.authorityId === right.authorityId
    && left.authorityHash === right.authorityHash
    && left.savedLayoutId === right.savedLayoutId
    && left.reconciliationKey === right.reconciliationKey
    && left.marker === right.marker
    && JSON.stringify(left.allowedOrigins) === JSON.stringify(right.allowedOrigins);
}

function captureSlotAuthorityHash({ captureSlotId, profileName, savedLayoutId, layoutCode, allowedOrigins }) {
  const canonical = JSON.stringify({
    allowedOrigins,
    captureSlotId,
    layoutCode,
    profileId: profileName,
    savedLayoutId,
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function requireText(value, name) {
  const text = String(value || '').trim();
  if (!text || text !== value || /[\u0000-\u001f\u007f]/u.test(text)) throw new Error(`${name} is invalid.`);
  return text;
}

function requirePattern(value, name, pattern) {
  const text = requireText(value, name);
  if (!pattern.test(text)) throw new Error(`${name} is invalid.`);
  return text;
}

function boundedPositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 30_000) {
    throw new Error('Retirement timeout must be a positive integer no greater than 30000ms.');
  }
  return value;
}
