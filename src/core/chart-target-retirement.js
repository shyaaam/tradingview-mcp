import { createHash } from 'node:crypto';

import { resolveCloakManagerBaseUrl } from './cloak.js';
import { normalizeChartUrl } from './chart-target-hydration.js';
import { resolveManagerCdpUrl } from './manager-cdp.js';

const CHART_PAGE = /^https:\/\/www\.tradingview\.com\/chart\//u;
const CHART_ORIGIN = 'https://www.tradingview.com';
const AUTHORITY_SCHEMA_VERSION = 'v5-capture-slot-authority-v2';
const DEFAULT_TIMEOUT_MS = 5_000;
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
  const profilePayload = await requestJson(new URL('profiles', `${managerBaseUrl}/`).toString());
  const profiles = Array.isArray(profilePayload) ? profilePayload : profilePayload?.profiles;
  const matches = Array.isArray(profiles)
    ? profiles.filter((profile) => profileIdFromEntry(profile) === expected.profileId)
    : [];
  if (matches.length !== 1) throw new Error('Exact Manager profile binding is missing or ambiguous.');
  const profile = matches[0];
  if (!['running', 'active'].includes(String(profile.status || profile.state || '').toLowerCase())) {
    throw new Error('Exact Manager profile is not running.');
  }
  const cdpUrl = resolveManagerCdpUrl(
    managerBaseUrl,
    expected.profileId,
    profile.cdp_url || profile.cdp_endpoint || profile.cdpUrl,
  );
  const before = pageTargets(await requestJson(new URL('json/list', `${cdpUrl}/`).toString()));
  const beforeCharts = chartTargets(before);
  if (beforeCharts.length === 0) throw new Error('No TradingView chart target is available for safe retirement.');
  const exact = before.filter((target) => target.url === expected.chartUrl);
  const sameSavedChart = before.filter((target) => targetHasSavedChartId(target, expected.savedChartId));
  if (sameSavedChart.length !== exact.length) {
    throw new Error('Saved-chart target URL differs from exact authority; refusing retirement.');
  }
  if (exact.length > 1) throw new Error('Saved-chart target is ambiguous; refusing retirement.');
  if (exact.length === 0) {
    return result(expected, null, 'already-closed', beforeCharts.length, false);
  }
  const target = exact[0];
  if (beforeCharts.length <= 1) throw new Error('Cannot retire the last TradingView chart target.');
  const preClose = pageTargets(await requestJson(new URL('json/list', `${cdpUrl}/`).toString()));
  const currentExact = preClose.filter((entry) => entry.url === expected.chartUrl);
  const currentSameSavedChart = preClose.filter((entry) => targetHasSavedChartId(entry, expected.savedChartId));
  if (currentExact.length !== 1 || currentExact[0].id !== target.id
    || currentSameSavedChart.length !== 1
    || !sameChartInventory(beforeCharts, chartTargets(preClose))) {
    throw new Error('TradingView chart inventory changed before exact saved-chart retirement.');
  }
  const version = await requestJson(new URL('json/version', `${cdpUrl}/`).toString());
  const browserWebSocketUrl = requireProfileBrowserWebSocketUrl(
    version?.webSocketDebuggerUrl,
    cdpUrl,
    expected.profileId,
  );
  const closeResult = await sendBrowserCdpCommand(
    browserWebSocketUrl,
    { targetId: target.id },
    deadline,
    dependencies.createWebSocket,
  );
  if (closeResult?.success !== true) throw new Error('Exact saved-chart target close was not acknowledged.');

  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let after = before;
  let afterTargets = before;
  while (remainingMs(deadline) > 0) {
    afterTargets = await requestJson(new URL('json/list', `${cdpUrl}/`).toString());
    after = pageTargets(afterTargets);
    const exactTargetRemains = afterTargets.some((entry) => entry?.id === target.id);
    const savedChartRemains = after.some((entry) => targetHasSavedChartId(entry, expected.savedChartId));
    if (!exactTargetRemains && !savedChartRemains) break;
    await withDeadline(
      () => sleep(Math.min(POLL_INTERVAL_MS, remainingMs(deadline))),
      deadline,
    );
  }
  if (afterTargets.some((entry) => entry?.id === target.id)
    || after.some((entry) => targetHasSavedChartId(entry, expected.savedChartId))) {
    throw new Error('Exact saved-chart target remained open after bounded close.');
  }
  const preservedBefore = beforeCharts.filter((entry) => entry.id !== target.id).map(targetIdentity).sort(compareIdentity);
  const preservedAfter = chartTargets(after).map(targetIdentity).sort(compareIdentity);
  if (JSON.stringify(preservedAfter) !== JSON.stringify(preservedBefore)) {
    throw new Error('Saved-chart retirement changed another TradingView chart target.');
  }
  return result(expected, target.id, 'closed', preservedAfter.length, true);
}

function normalizeInput(input) {
  const profileId = requireText(input.profile_id, 'profile_id');
  const captureSlotId = requirePattern(input.capture_slot_id, 'capture_slot_id', /^v5-capture-slot-[ab]$/u);
  const layoutCode = requirePattern(input.layout_code, 'layout_code', /^s$/u);
  const authorityId = requirePattern(input.authority_id, 'authority_id', /^v5-capture-slot:[0-9a-f]{64}$/u);
  const authorityHash = requirePattern(input.authority_hash, 'authority_hash', /^[0-9a-f]{64}$/u);
  if (authorityId !== `v5-capture-slot:${authorityHash}`) {
    throw new Error('authority_id does not match authority_hash.');
  }
  const savedChartId = requirePattern(input.saved_chart_id, 'saved_chart_id', /^[A-Za-z0-9_-]{1,160}$/u);
  const allowedOrigins = Array.isArray(input.allowed_origins) ? input.allowed_origins : [];
  if (allowedOrigins.length !== 1 || allowedOrigins[0] !== CHART_ORIGIN) {
    throw new Error('allowed_origins must equal the reviewed TradingView chart origin.');
  }
  const suppliedChartUrl = requireText(input.chart_url, 'chart_url');
  if (suppliedChartUrl.includes('?')) {
    throw new Error('chart_url query parameters are not allowed for saved-chart retirement.');
  }
  const chartUrl = normalizeChartUrl(suppliedChartUrl, allowedOrigins, savedChartId);
  if (chartUrl !== suppliedChartUrl) throw new Error('chart_url must use exact canonical saved-chart URL.');
  if (!CHART_PAGE.test(chartUrl)) throw new Error('Saved-chart authority must use the canonical TradingView chart origin.');
  const computedHash = captureSlotAuthorityHash({
    captureSlotId,
    profileId,
    savedChartId,
    layoutCode,
    chartUrl,
    allowedOrigins,
  });
  if (authorityHash !== computedHash || authorityId !== `v5-capture-slot:${computedHash}`) {
    throw new Error('Capture-slot authority hash does not bind the exact profile and saved chart.');
  }
  return Object.freeze({
    profileId,
    captureSlotId,
    layoutCode,
    authorityId,
    authorityHash,
    savedChartId,
    chartUrl,
    allowedOrigins: Object.freeze([...allowedOrigins]),
  });
}

function result(expected, targetId, action, remainingChartTargets, mutationsPerformed) {
  return Object.freeze({
    success: true,
    retirement_version: 'saved-chart-retirement-v1',
    authority_id: expected.authorityId,
    authority_hash: expected.authorityHash,
    profile_id: expected.profileId,
    saved_chart_id: expected.savedChartId,
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

function targetIdentity(target) {
  return { id: target.id, url: target.url };
}

function targetHasSavedChartId(target, savedChartId) {
  try {
    const url = new URL(target.url);
    return url.origin === 'https://www.tradingview.com'
      && url.pathname.match(/^\/chart\/([A-Za-z0-9_-]+)\/?$/u)?.[1] === savedChartId;
  } catch { return false; }
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

async function sendBrowserCdpCommand(url, params, deadline, createWebSocket) {
  const WebSocketImpl = globalThis.WebSocket;
  if (typeof createWebSocket !== 'function' && typeof WebSocketImpl !== 'function') {
    throw new Error('Browser CDP WebSocket is unavailable.');
  }
  let socket;
  let settled = false;
  const response = new Promise((resolve, reject) => {
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    try {
      socket = createWebSocket ? createWebSocket(url) : new WebSocketImpl(url);
    } catch {
      fail(new Error('Browser CDP WebSocket could not be opened.'));
      return;
    }
    socket.addEventListener('open', () => {
      if (remainingMs(deadline) <= 0) {
        fail(deadlineError(deadline.timeoutMs));
        return;
      }
      try {
        socket.send(JSON.stringify({ id: 1, method: 'Target.closeTarget', params }));
      } catch {
        fail(new Error('Browser CDP close command could not be sent.'));
      }
    }, { once: true });
    socket.addEventListener('message', (event) => {
      if (settled) return;
      if (typeof event?.data !== 'string'
        || Buffer.byteLength(event.data, 'utf8') > MAX_RETIREMENT_READ_BYTES) {
        fail(new Error('Browser CDP response is malformed or exceeds the bounded read limit.'));
        return;
      }
      let message;
      try { message = JSON.parse(event.data); } catch {
        fail(new Error('Browser CDP response is not valid JSON.'));
        return;
      }
      if (message?.id !== 1) return;
      if (message.error) {
        fail(new Error('Browser CDP close command failed.'));
        return;
      }
      settled = true;
      resolve(message.result);
    });
    socket.addEventListener('error', () => fail(new Error('Browser CDP WebSocket failed.')), { once: true });
    socket.addEventListener('close', () => {
      fail(new Error('Browser CDP WebSocket closed before close acknowledgement.'));
    }, { once: true });
  });
  try {
    return await withDeadline(() => response, deadline, () => closeWebSocket(socket));
  } finally {
    closeWebSocket(socket);
  }
}

function closeWebSocket(socket) {
  try { socket?.close?.(); } catch { /* preserve retirement result */ }
}

function compareIdentity(left, right) {
  return left.id.localeCompare(right.id) || left.url.localeCompare(right.url);
}

function profileIdFromEntry(profile) {
  return String(profile?.profile_id || profile?.id || profile?.profileId || '');
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
  return left.profileId === right.profileId
    && left.captureSlotId === right.captureSlotId
    && left.layoutCode === right.layoutCode
    && left.authorityId === right.authorityId
    && left.authorityHash === right.authorityHash
    && left.savedChartId === right.savedChartId
    && left.chartUrl === right.chartUrl
    && JSON.stringify(left.allowedOrigins) === JSON.stringify(right.allowedOrigins);
}

function sameChartInventory(left, right) {
  const identities = (targets) => targets.map(targetIdentity).sort(compareIdentity);
  return JSON.stringify(identities(left)) === JSON.stringify(identities(right));
}

function captureSlotAuthorityHash({ captureSlotId, profileId, savedChartId, layoutCode, chartUrl, allowedOrigins }) {
  const canonical = JSON.stringify({
    allowedOrigins,
    captureSlotId,
    chartId: savedChartId,
    chartUrl,
    layoutCode,
    profileId,
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
