import CDP from 'chrome-remote-interface';
import { resolveCdpBaseUrl } from './core/cloak.js';
import {
  clearObserverSession,
  getObserverSession as readObserverSession,
  requireObserverSession as requireSession,
  setObserverSession,
} from './core/observer-session.js';
import {
  DisconnectedSessionRecoveryError,
  recoverDisconnectedSession,
} from './core/session-recovery.js';

export { getObserverSession, requireObserverSession } from './core/observer-session.js';

let client = null;
let targetInfo = null;
const sessionRecoveryEvidence = new WeakMap();
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

async function recoverAndRecordSession(activeClient) {
  const evidence = await recoverDisconnectedSession(activeClient);
  sessionRecoveryEvidence.set(activeClient, evidence);
  return evidence;
}

export function getSessionRecoveryEvidence(activeClient) {
  const evidence = sessionRecoveryEvidence.get(activeClient);
  return evidence ? { ...evidence } : null;
}

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      await recoverAndRecordSession(client);
      return client;
    } catch (error) {
      if (error instanceof DisconnectedSessionRecoveryError) {
        await disconnect();
        throw error;
      }
      await disconnect();
    }
  }
  return connect();
}

/**
 * Return a client for one already-prepared observer binding.
 * Unlike the general client path, this path performs no reconnect retry loop.
 */
export async function getBoundClient() {
  const session = requireSession();
  const target = await findChartTarget(session);
  if (!target) throw new Error('Bound observer chart target is unavailable. Re-run tv_observer_prepare.');

  if (client) {
    if (targetInfo?.id !== target.id || targetInfo?.url !== target.url) {
      await disconnect();
      throw new Error(`Bound observer chart target ${session.chartTargetId} changed or is unavailable. Re-run tv_observer_prepare.`);
    }
    try {
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      await recoverAndRecordSession(client);
      return client;
    } catch (error) {
      if (error instanceof DisconnectedSessionRecoveryError) {
        await disconnect();
        throw error;
      }
      await disconnect();
    }
  }

  targetInfo = target;
  client = await CDP({ target: target.webSocketDebuggerUrl, local: true });
  try {
    await client.Runtime.enable();
    await client.Page.enable();
    await client.DOM.enable();
    await recoverAndRecordSession(client);
  } catch (error) {
    await disconnect();
    throw error;
  }
  return client;
}

export async function evaluateBound(expression, opts = {}) {
  const c = await getBoundClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function invalidateObserverSession() {
  clearObserverSession();
  await disconnect();
}

export async function bindObserverSession(session) {
  await disconnect();
  return setObserverSession(session);
}

export async function updateObserverSessionTarget({ chartTargetId, chartTargetUrl }) {
  const current = requireSession();
  if (typeof chartTargetId !== 'string' || !chartTargetId.trim()
    || typeof chartTargetUrl !== 'string' || !chartTargetUrl.trim()) {
    throw new Error('Observer session target requires chartTargetId and chartTargetUrl.');
  }

  await disconnect();
  return setObserverSession({
    ...current,
    chartTargetId: chartTargetId.trim(),
    chartTargetUrl: chartTargetUrl.trim(),
  });
}

export async function connect() {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget(readObserverSession());
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await CDP({ target: target.webSocketDebuggerUrl, local: true });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();
      await recoverAndRecordSession(client);

      return client;
    } catch (err) {
      if (err instanceof DisconnectedSessionRecoveryError) {
        await disconnect();
        throw err;
      }
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

async function findChartTarget(session = readObserverSession()) {
  const baseUrl = session?.cdpUrl || await resolveCdpBaseUrl();
  const resp = await fetch(`${baseUrl}/json/list`);
  const targets = await resp.json();
  if (session) {
    const boundTarget = targets.find((target) => target?.id === session.chartTargetId);
    if (!boundTarget
      || boundTarget.type !== 'page'
      || boundTarget.url !== session.chartTargetUrl
      || !/tradingview\.com\/chart/i.test(boundTarget.url || '')) {
      throw new Error(`Bound observer chart target ${session.chartTargetId} changed or is unavailable. Re-run tv_observer_prepare.`);
    }
    return boundTarget;
  }
  // Prefer targets with tradingview.com/chart in the URL
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
