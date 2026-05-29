import CDP from 'chrome-remote-interface';

const clientsByTargetId = new Map();
const targetInfoByTargetId = new Map();
let defaultTargetId = null;

const MAX_RETRIES = 5;
const BASE_DELAY = 500;

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

export function getCdpConfig() {
  const host = process.env.CDP_HOST || 'localhost';
  const rawPort = process.env.CDP_PORT || '9222';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`CDP_PORT must be a valid TCP port, got: ${rawPort}`);
  }
  return { host, port };
}

export function getCdpBaseUrl() {
  const { host, port } = getCdpConfig();
  return `http://${host}:${port}`;
}

export async function listCdpTargets() {
  const resp = await fetch(`${getCdpBaseUrl()}/json/list`);
  if (!resp.ok) throw new Error(`CDP /json/list returned HTTP ${resp.status}`);
  return resp.json();
}

function targetIdFrom(opts = {}) {
  return String(opts.target_id || opts.targetId || opts.target?.id || '').trim();
}

function runtimeOpts(opts = {}) {
  const { target_id, targetId, target, ...rest } = opts;
  return rest;
}

async function findTargetById(targetId) {
  const targets = await listCdpTargets();
  return targets.find(t => t.id === targetId) || null;
}

async function findChartTarget({ target_id, targetId } = {}) {
  const requested = String(target_id || targetId || '').trim();
  if (requested) return findTargetById(requested);

  const targets = await listCdpTargets();
  // Prefer targets with tradingview.com/chart in the URL
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
}

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export async function setDefaultTargetId(targetId) {
  const target = await findTargetById(String(targetId || '').trim());
  if (!target) throw new Error(`CDP target not found: ${targetId}`);
  defaultTargetId = target.id;
  targetInfoByTargetId.set(target.id, target);
  return target;
}

export async function activateTarget(targetId) {
  const target = await setDefaultTargetId(targetId);
  const resp = await fetch(`${getCdpBaseUrl()}/json/activate/${encodeURIComponent(target.id)}`);
  if (!resp.ok) throw new Error(`Failed to activate target ${target.id}: HTTP ${resp.status}`);
  return target;
}

export async function getClient(opts = {}) {
  const requestedTargetId = targetIdFrom(opts) || defaultTargetId;
  const cacheKey = requestedTargetId || '__default__';
  const cached = clientsByTargetId.get(cacheKey);
  if (cached) {
    try {
      // Quick liveness check
      await cached.Runtime.evaluate({ expression: '1', returnByValue: true });
      return cached;
    } catch {
      clientsByTargetId.delete(cacheKey);
      if (requestedTargetId) targetInfoByTargetId.delete(requestedTargetId);
      if (defaultTargetId === requestedTargetId) defaultTargetId = null;
    }
  }
  return connect(opts);
}

export async function connect(opts = {}) {
  let lastError;
  const requestedTargetId = targetIdFrom(opts) || defaultTargetId;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget({ target_id: requestedTargetId });
      if (!target) {
        throw new Error(requestedTargetId
          ? `CDP target not found: ${requestedTargetId}`
          : 'No TradingView chart target found. Is TradingView open with a chart?');
      }

      const targetId = target.id;
      const c = await CDP({ ...getCdpConfig(), target: targetId });

      // Enable required domains
      await c.Runtime.enable();
      await c.Page.enable();
      await c.DOM.enable();

      clientsByTargetId.set(targetId, c);
      targetInfoByTargetId.set(targetId, target);
      if (!defaultTargetId || !requestedTargetId) defaultTargetId = targetId;

      return c;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

export async function getTargetInfo(opts = {}) {
  const requestedTargetId = targetIdFrom(opts) || defaultTargetId;
  if (requestedTargetId && targetInfoByTargetId.has(requestedTargetId)) {
    return targetInfoByTargetId.get(requestedTargetId);
  }

  await getClient(opts);
  const resolvedTargetId = targetIdFrom(opts) || defaultTargetId;
  return resolvedTargetId ? targetInfoByTargetId.get(resolvedTargetId) : null;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient(opts);
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...runtimeOpts(opts),
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression, opts = {}) {
  return evaluate(expression, { ...opts, awaitPromise: true });
}

export async function disconnect(opts = {}) {
  const requestedTargetId = targetIdFrom(opts);
  if (requestedTargetId) {
    const c = clientsByTargetId.get(requestedTargetId);
    if (c) {
      try { await c.close(); } catch {}
      clientsByTargetId.delete(requestedTargetId);
    }
    targetInfoByTargetId.delete(requestedTargetId);
    if (defaultTargetId === requestedTargetId) defaultTargetId = null;
    return;
  }

  for (const c of clientsByTargetId.values()) {
    try { await c.close(); } catch {}
  }
  clientsByTargetId.clear();
  targetInfoByTargetId.clear();
  defaultTargetId = null;
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name, opts = {}) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`, opts);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi(opts = {}) {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API', opts);
}

export async function getChartCollection(opts = {}) {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection', opts);
}

export async function getBottomBar(opts = {}) {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar', opts);
}

export async function getReplayApi(opts = {}) {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API', opts);
}

export async function getMainSeriesBars(opts = {}) {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars', opts);
}
