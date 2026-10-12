import { createHash } from 'node:crypto';
import WebSocket from 'ws';

import { resolveCloakManagerBaseUrl } from './cloak.js';
import { resolveManagerCdpUrl } from './manager-cdp.js';
import { assertExactProfileBrowserWebSocket, resolveExactRunningProfile } from './chart-target-open.js';
import {
  ACCOUNT_LAYOUT_PROBE,
  savedChartLayoutMarker,
  verifySavedLayoutTargetCreationReceipt,
} from './saved-chart-authority.js';

const CHART_ROUTE = /^https:\/\/www\.tradingview\.com\/chart\/([A-Za-z0-9_-]{1,160})\/$/u;
const CHART_ORIGIN = 'https://www.tradingview.com';
const AUTHORITY_SCHEMA_VERSION = 'v5-capture-slot-authority-v3';
const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;
const MAX_READ_BYTES = 128 * 1024;

/** Close only target named by V5's verified creation receipt. */
export async function retireOwnedSavedLayoutTarget(input = {}, dependencies = {}) {
  const expected = normalizeAuthority(input);
  const reviewed = normalizeAuthority(dependencies.reviewedAuthority ?? readReviewedAuthority());
  if (!sameAuthority(expected, reviewed)) throw new Error('Retirement request differs from reviewed capture-slot authority.');

  const targetId = requirePattern(input.target_id, 'target_id', /^[A-Za-z0-9_-]{1,256}$/u);
  const accountSubjectSha256 = requirePattern(
    input.expected_account_subject_sha256, 'expected_account_subject_sha256', /^[0-9a-f]{64}$/u,
  );
  const receipt = input.ownership_receipt;
  if (!verifySavedLayoutTargetCreationReceipt(receipt, {
    profileName: expected.profileName,
    captureSlotId: expected.captureSlotId,
    reconciliationKey: expected.reconciliationKey,
    savedLayoutId: expected.savedLayoutId,
    targetId,
    accountSubjectSha256,
  })) throw new Error('Owned saved-layout target receipt is invalid or belongs to another authority.');

  const timeoutMs = boundedTimeout(dependencies.timeoutMs);
  const deadline = { at: Date.now() + timeoutMs, timeoutMs };
  const fetchImpl = dependencies.fetch ?? fetch;
  const managerBaseUrl = dependencies.managerBaseUrl
    ?? await resolveCloakManagerBaseUrl({ fetchJson: (url) => fetchJson(url, fetchImpl, deadline) });
  if (!managerBaseUrl) throw new Error('CloakBrowser Manager is required for owned target cleanup.');
  const profile = await (dependencies.resolveExactRunningProfile ?? resolveExactRunningProfile)(
    expected.profileName, { ...dependencies, managerBaseUrl },
  );
  const profileId = requireText(profile.profileId, 'current profile ID');
  if (profileId !== receipt.profile_id) throw new Error('Current profile differs from owned target receipt.');
  const cdpUrl = resolveManagerCdpUrl(managerBaseUrl, profileId, profile.cdpUrl);
  const version = await fetchJson(new URL('json/version', `${cdpUrl}/`).toString(), fetchImpl, deadline);
  assertExactProfileBrowserWebSocket(version?.webSocketDebuggerUrl, cdpUrl, profileId);
  const browser = await withDeadline(
    () => (dependencies.connectBrowser ?? connectBoundedBrowser)(version.webSocketDebuggerUrl, deadline),
    deadline,
  );

  try {
    if (!await readTargetIdentity(browser, targetId, expected, accountSubjectSha256, deadline, dependencies)) {
      return result(expected, targetId, accountSubjectSha256, 'already-closed', false);
    }

    try {
      await withDeadline(() => browser.Target.closeTarget({ targetId }), deadline);
    } catch { /* Exact target readback below decides whether close completed. */ }
    await waitForTargetClose(browser, targetId, deadline, dependencies);
    return result(expected, targetId, accountSubjectSha256, 'closed', true);
  } finally {
    try { await browser.close?.(); } catch { /* Preserve target-close result. */ }
  }
}

function result(expected, targetId, accountSubjectSha256, action, mutationsPerformed) {
  return Object.freeze({
    success: true,
    retirement_version: 'owned-saved-layout-retirement-v1',
    authority_id: expected.authorityId,
    authority_hash: expected.authorityHash,
    profile_name: expected.profileName,
    saved_layout_id: expected.savedLayoutId,
    account_subject_sha256: accountSubjectSha256,
    target_id: targetId,
    action,
    mutations_performed: mutationsPerformed,
  });
}

async function readTargetIdentity(browser, targetId, expected, accountSubjectSha256, deadline, dependencies) {
  let targetInfo;
  try {
    const response = await withDeadline(() => browser.Target.getTargetInfo({ targetId }), deadline);
    targetInfo = response?.targetInfo;
  } catch (error) {
    if (/No target with given id found/iu.test(String(error?.message ?? error))) return false;
    throw error;
  }
  if (targetInfo?.targetId !== targetId || targetInfo.type !== 'page' || !CHART_ROUTE.test(targetInfo.url)) {
    throw new Error('Receipt target no longer identifies a TradingView chart page.');
  }

  const attached = await withDeadline(
    () => browser.Target.attachToTarget({ targetId, flatten: true }), deadline,
  );
  const sessionId = requireText(attached?.sessionId, 'target session ID');
  try {
    const response = await withDeadline(() => browser.send('Runtime.evaluate', {
      expression: ACCOUNT_LAYOUT_PROBE,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId), deadline);
    const value = response?.result?.value;
    if (!value || typeof value !== 'object' || response?.exceptionDetails) {
      throw new Error('Owned target did not return saved-layout identity.');
    }
    const route = CHART_ROUTE.exec(targetInfo.url);
    const layouts = Array.isArray(value.layouts) ? value.layouts : [];
    const idMatches = layouts.filter((layout) => layout?.layout_id === expected.savedLayoutId);
    const markerMatches = layouts.filter((layout) => layout?.name === expected.marker);
    if (value.authenticated !== true || value.account_subject_sha256 !== accountSubjectSha256
      || value.current_url !== targetInfo.url || value.chart_uid !== route?.[1]
      || value.active_saved_layout_id !== expected.savedLayoutId
      || value.active_saved_layout_name !== expected.marker || idMatches.length !== 1
      || markerMatches.length !== 1 || idMatches[0]?.name !== expected.marker
      || markerMatches[0]?.layout_id !== expected.savedLayoutId) {
      throw new Error('Receipt target no longer matches its account and saved-layout identity.');
    }
    return true;
  } finally {
    try { await withDeadline(() => browser.Target.detachFromTarget({ sessionId }), deadline); }
    catch { /* Closing the profile-scoped connection releases the session. */ }
  }
}

async function waitForTargetClose(browser, targetId, deadline, dependencies) {
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  while (Date.now() < deadline.at) {
    try {
      const response = await withDeadline(() => browser.Target.getTargetInfo({ targetId }), deadline);
      if (response?.targetInfo?.targetId !== targetId) throw new Error('Target readback is invalid.');
    } catch (error) {
      if (/No target with given id found/iu.test(String(error?.message ?? error))) return;
      throw error;
    }
    await withDeadline(() => sleep(Math.min(POLL_INTERVAL_MS, deadline.at - Date.now())), deadline);
  }
  throw new Error('Owned TradingView target remained open after bounded close.');
}

function connectBoundedBrowser(url, deadline) {
  const socket = new WebSocket(url, {
    maxPayload: MAX_READ_BYTES,
    handshakeTimeout: Math.max(1, deadline.at - Date.now()),
    perMessageDeflate: false,
  });
  const pending = new Map();
  let nextId = 1;
  const connected = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const failPending = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  socket.on('error', failPending);
  socket.on('close', () => failPending(new Error('Browser CDP WebSocket closed.')));
  socket.on('message', (data) => {
    if (Buffer.byteLength(data) > MAX_READ_BYTES) {
      socket.terminate();
      failPending(new Error('Browser CDP frame exceeds bounded read limit.'));
      return;
    }
    let message;
    try { message = JSON.parse(data.toString('utf8')); }
    catch {
      socket.terminate();
      failPending(new Error('Browser CDP returned malformed JSON.'));
      return;
    }
    if (!Number.isSafeInteger(message?.id)) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(String(message.error.message || 'Browser CDP command failed.')));
    else request.resolve(message.result ?? {});
  });

  const send = (method, params = {}, sessionId) => {
    if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Browser CDP WebSocket is not open.'));
    const id = nextId++;
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify(message), (error) => {
        if (!error) return;
        pending.delete(id);
        reject(error);
      });
    });
  };
  const browser = {
    Target: {
      getTargetInfo: (params) => send('Target.getTargetInfo', params),
      attachToTarget: (params) => send('Target.attachToTarget', params),
      detachFromTarget: (params) => send('Target.detachFromTarget', params),
      closeTarget: (params) => send('Target.closeTarget', params),
    },
    send,
    close: () => { if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); },
  };
  return connected.then(() => browser, (error) => {
    socket.terminate();
    throw error;
  });
}

function normalizeAuthority(input) {
  const profileName = requirePattern(input.profile_name ?? input.profileName, 'profile_name', /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,159}$/u);
  const captureSlotId = requirePattern(input.capture_slot_id ?? input.captureSlotId, 'capture_slot_id', /^v5-capture-slot-[ab]$/u);
  const layoutCode = requirePattern(input.layout_code ?? input.layoutCode, 'layout_code', /^s$/u);
  const savedLayoutId = requirePattern(input.saved_layout_id ?? input.savedLayoutId, 'saved_layout_id', /^[A-Za-z0-9_-]{1,160}$/u);
  const reconciliationKey = requirePattern(input.reconciliation_key ?? input.reconciliationKey, 'reconciliation_key', /^[0-9a-f]{64}$/u);
  const allowedOrigins = input.allowed_origins ?? input.allowedOrigins;
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length !== 1 || allowedOrigins[0] !== CHART_ORIGIN) {
    throw new Error('allowed_origins must equal the reviewed TradingView chart origin.');
  }
  const authorityHash = captureSlotAuthorityHash({ captureSlotId, profileName, savedLayoutId, layoutCode, allowedOrigins });
  const authorityId = `v5-capture-slot:${authorityHash}`;
  if ((input.authority_hash ?? input.authorityHash) !== authorityHash
    || (input.authority_id ?? input.authorityId) !== authorityId) {
    throw new Error('Capture-slot authority hash does not bind the reviewed profile and saved layout.');
  }
  return Object.freeze({
    profileName, captureSlotId, layoutCode, savedLayoutId, reconciliationKey,
    allowedOrigins: Object.freeze([...allowedOrigins]), authorityHash, authorityId,
    marker: savedChartLayoutMarker(captureSlotId, reconciliationKey),
  });
}

function captureSlotAuthorityHash({ captureSlotId, profileName, savedLayoutId, layoutCode, allowedOrigins }) {
  return createHash('sha256').update(JSON.stringify({
    allowedOrigins, captureSlotId, layoutCode, profileId: profileName, savedLayoutId,
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
  }), 'utf8').digest('hex');
}

function readReviewedAuthority() {
  try {
    const value = JSON.parse(String(process.env.V5_CAPTURE_SLOT_AUTHORITY_JSON || ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error('Per-worker reviewed capture-slot authority is missing or malformed.');
  }
}

function sameAuthority(left, right) {
  return left.profileName === right.profileName && left.captureSlotId === right.captureSlotId
    && left.layoutCode === right.layoutCode && left.savedLayoutId === right.savedLayoutId
    && left.reconciliationKey === right.reconciliationKey && left.authorityHash === right.authorityHash;
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}

function requirePattern(value, name, pattern) {
  const text = requireText(value, name);
  if (!pattern.test(text)) throw new Error(`${name} is invalid.`);
  return text;
}

function boundedTimeout(value) {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) {
    throw new Error('Retirement timeout must be between 1ms and 30000ms.');
  }
  return timeout;
}

async function fetchJson(url, fetchImpl, deadline) {
  const controller = new AbortController();
  return await withDeadline(async () => {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response?.ok) throw new Error(`Manager/CDP request failed (${response?.status ?? 'unknown'}).`);
    return await readBoundedJson(response);
  }, deadline, () => controller.abort());
}

async function readBoundedJson(response) {
  const declaredBytes = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_READ_BYTES) {
    throw new Error('Manager/CDP response exceeds bounded read limit.');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_READ_BYTES) throw new Error('Manager/CDP response exceeds bounded read limit.');
    return parseJson(text);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_READ_BYTES) {
        try { await reader.cancel(); } catch { /* Preserve size failure. */ }
        throw new Error('Manager/CDP response exceeds bounded read limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return parseJson(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { throw new Error('Manager/CDP response is malformed JSON.'); }
}

function withDeadline(operation, deadline, onTimeout = () => {}) {
  const remaining = deadline.at - Date.now();
  if (remaining <= 0) return Promise.reject(new Error(`Owned-target cleanup exceeded ${deadline.timeoutMs}ms.`));
  let timer;
  const work = Promise.resolve().then(operation);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout(); } catch { /* Preserve timeout. */ }
      reject(new Error(`Owned-target cleanup exceeded ${deadline.timeoutMs}ms.`));
    }, remaining);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
