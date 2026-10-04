import WebSocket from 'ws';

const MAX_TARGET_INVENTORY_BYTES = 128 * 1024;
const MAX_TARGET_ID_CHARS = 256;
const MAX_TARGET_URL_CHARS = 4_096;
const DEFAULT_CLOSE_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 100;

export async function closeExactPageTargetAndReconcile({
  targetId: targetIdValue,
  expectedOtherPageTargets,
  readTargets,
  browser,
  timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const targetId = requireTargetId(targetIdValue);
  if (typeof readTargets !== 'function' || typeof browser?.Target?.closeTarget !== 'function') {
    throw new Error('Exact target retirement dependencies are incomplete.');
  }
  const expectedOthers = normalizePageTargets(expectedOtherPageTargets);
  if (expectedOthers.some((target) => target.id === targetId)) {
    throw new Error('Exact target ownership conflicts with the preserved page inventory.');
  }
  const timeout = boundedPositiveInteger(timeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
  const deadline = { at: now() + timeout, now, timeoutMs: timeout };
  const readInventory = async () => normalizeTargetInventory(
    await withDeadline(() => readTargets(), deadline),
  );
  const inspect = (inventory) => {
    const matches = inventory.filter((target) => target.id === targetId);
    if (matches.length > 1) throw new Error('Exact target ID is ambiguous in the current profile inventory.');
    if (matches.length === 1 && matches[0].type !== 'page') {
      throw new Error('Exact owned target is no longer a page; refusing retirement.');
    }
    const pages = inventory.filter((target) => target.type === 'page');
    const others = pages.filter((target) => target.id !== targetId);
    if (!samePageInventory(others, expectedOthers)) {
      throw new Error('Profile page inventory changed; refusing exact target retirement.');
    }
    return { pages, target: matches[0] || null };
  };

  const before = inspect(await readInventory());
  if (!before.target) {
    return Object.freeze({
      action: 'already-closed',
      remaining_page_targets: before.pages.length,
      mutations_performed: false,
    });
  }
  if (before.pages.length <= 1) throw new Error('Cannot retire the last browser page in the exact profile.');

  const preClose = inspect(await readInventory());
  if (!preClose.target) {
    return Object.freeze({
      action: 'already-closed',
      remaining_page_targets: preClose.pages.length,
      mutations_performed: false,
    });
  }
  if (!sameTargetIdentity(before.target, preClose.target)) {
    throw new Error('Exact target identity changed before retirement.');
  }
  if (preClose.pages.length <= 1) throw new Error('Cannot retire the last browser page in the exact profile.');

  const acknowledgementMs = Math.min(1_000, Math.max(1, Math.floor(remainingMs(deadline) / 2)));
  const acknowledgementDeadline = { at: now() + acknowledgementMs, now, timeoutMs: acknowledgementMs };
  try {
    await withDeadline(
      () => browser.Target.closeTarget({ targetId }),
      acknowledgementDeadline,
      () => browser.close?.(),
    );
  } catch {
    // Fresh inventory is authoritative when CDP loses or delays its close receipt.
  }

  while (remainingMs(deadline) > 0) {
    const after = inspect(await readInventory());
    if (!after.target) {
      return Object.freeze({
        action: 'closed',
        remaining_page_targets: after.pages.length,
        mutations_performed: true,
      });
    }
    if (!sameTargetIdentity(preClose.target, after.target)) {
      throw new Error('Exact target identity changed during bounded retirement.');
    }
    try {
      await withDeadline(
        () => sleep(Math.min(POLL_INTERVAL_MS, remainingMs(deadline))),
        deadline,
      );
    } catch (error) {
      if (remainingMs(deadline) <= 0) break;
      throw error;
    }
  }
  throw new Error('Exact target remained open after bounded retirement.');
}

export function normalizeTargetInventory(value) {
  if (!Array.isArray(value)) throw new Error('CDP target inventory is malformed.');
  const targets = value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`CDP target inventory entry ${index} is malformed.`);
    }
    const id = typeof entry.id === 'string' ? entry.id : '';
    const type = typeof entry.type === 'string' ? entry.type : '';
    if (!id || id.length > MAX_TARGET_ID_CHARS || /[\u0000-\u001f\u007f]/u.test(id)
      || !type || type.length > 80) {
      throw new Error(`CDP target inventory entry ${index} identity is malformed.`);
    }
    if (entry.type === 'page'
      && (typeof entry.url !== 'string' || entry.url.length === 0
        || entry.url.length > MAX_TARGET_URL_CHARS || /[\u0000-\u001f\u007f]/u.test(entry.url))) {
      throw new Error(`CDP page target inventory entry ${index} URL is malformed.`);
    }
    return { ...entry, id, type, url: typeof entry.url === 'string' ? entry.url : '' };
  });
  const ids = new Set();
  for (const target of targets) {
    if (ids.has(target.id)) throw new Error('CDP target inventory contains duplicate target IDs.');
    ids.add(target.id);
  }
  return targets;
}

export function normalizePageTargets(value) {
  return normalizeTargetInventory(value).filter((target) => target.type === 'page');
}

export function samePageInventory(left, right, excludedTargetId = null) {
  const identity = (targets) => normalizePageTargets(targets)
    .filter((target) => target.id !== excludedTargetId)
    .map(targetIdentity)
    .sort(compareIdentity);
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right));
}

export function targetIdentity(target) {
  return { id: target.id, type: target.type, url: target.url };
}

export function connectBoundedBrowser(url, { maxPayload = MAX_TARGET_INVENTORY_BYTES, handshakeTimeoutMs } = {}) {
  if (maxPayload !== MAX_TARGET_INVENTORY_BYTES || !Number.isSafeInteger(handshakeTimeoutMs)
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

export function requireProfileBrowserWebSocketUrl(value, cdpUrl, profileId) {
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

export async function fetchBoundedJson(url, fetchImpl, deadline) {
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

export function withDeadline(operation, deadline, onTimeout = () => {}) {
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

export function remainingMs(deadline) {
  return deadline.at - deadline.now();
}

function readBoundedResponseText(response, controller) {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_TARGET_INVENTORY_BYTES) {
    controller.abort();
    throw new Error(`Manager/CDP response exceeds bounded ${MAX_TARGET_INVENTORY_BYTES}-byte read limit.`);
  }
  if (response.body === null) return Promise.resolve('');
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('Manager/CDP response body stream is unavailable.');
  return (async () => {
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        totalBytes += item.value.byteLength;
        if (totalBytes > MAX_TARGET_INVENTORY_BYTES) {
          controller.abort();
          await reader.cancel().catch(() => {});
          throw new Error(`Manager/CDP response exceeds bounded ${MAX_TARGET_INVENTORY_BYTES}-byte read limit.`);
        }
        chunks.push(Buffer.from(item.value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  })();
}

function sameTargetIdentity(left, right) {
  return JSON.stringify(targetIdentity(left)) === JSON.stringify(targetIdentity(right));
}

function compareIdentity(left, right) {
  return left.id.localeCompare(right.id) || left.url.localeCompare(right.url);
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

function requireTargetId(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_TARGET_ID_CHARS
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Exact target ID is invalid.');
  }
  return value;
}

function boundedPositiveInteger(value, fallback) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 30_000) {
    if (value === undefined) return fallback;
    throw new Error('Retirement timeout must be a positive integer no greater than 30000ms.');
  }
  return value;
}

function deadlineError(timeoutMs) {
  return new Error(`Exact target retirement exceeded bounded ${timeoutMs}ms deadline.`);
}

function handshakeError(error, timeoutMs) {
  if (/handshake.*timed out/iu.test(String(error?.message || ''))) {
    return new Error(`Browser CDP WebSocket handshake exceeded bounded ${timeoutMs}ms deadline.`);
  }
  return error;
}

function transportError(error) {
  if (/max payload size exceeded/iu.test(String(error?.message || ''))) {
    return new Error(`Browser CDP frame exceeds bounded ${MAX_TARGET_INVENTORY_BYTES}-byte transport limit.`);
  }
  return error;
}
