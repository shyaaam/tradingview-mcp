import { evaluateBound } from '../connection.js';
import { requireObserverSession } from './observer-session.js';

export const OBSERVER_ADAPTER_VERSION = 'tradingview-mcp-observer-v1';

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const HASH = /^[0-9a-f]{64}$/;

export async function identity({ _deps } = {}) {
  const session = requireObserverSession();
  const evaluate = _deps?.evaluateBound || _deps?.evaluate || evaluateBound;
  const identity = await evaluate(`
    (async function() {
      function read(value) {
        try {
          if (typeof value === 'function') value = value();
          if (value && typeof value.value === 'function') value = value.value();
          return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
        } catch (e) { return ''; }
      }

      var api = window.TradingViewApi;
      var active = api && api._activeChartWidgetWV && typeof api._activeChartWidgetWV.value === 'function'
        ? api._activeChartWidgetWV.value() : null;
      var collection = api && api._chartWidgetCollection;
      var chartIds = [];
      var pathMatch = String(window.location && window.location.pathname || '').match(/\\/chart\\/([^/?#]+)/i);
      if (pathMatch) chartIds.push(pathMatch[1]);
      if (active) chartIds.push(read(active.chartId || active._chartId || active.id));
      chartIds = chartIds.filter(function(value, index) { return value && chartIds.indexOf(value) === index; });

      var layoutIds = [];
      if (collection) layoutIds.push(read(
        collection._layoutId
        || collection.layoutId
        || collection.layout
        || collection._layout
        && collection._layout.id,
      ));
      if (active) layoutIds.push(read(active.layoutId || active._layoutId));
      layoutIds = layoutIds.filter(function(value, index) { return value && layoutIds.indexOf(value) === index; });

      var subjects = [];
      var candidates = [
        api && api._user && (api._user.id || api._user.user_id || api._user.username),
        window.TradingView && window.TradingView.user && (window.TradingView.user.id || window.TradingView.user.user_id || window.TradingView.user.username),
        collection && collection.metaInfo && collection.metaInfo.username,
      ];
      for (var i = 0; i < candidates.length; i++) {
        var subject = read(candidates[i]);
        if (subject && subjects.indexOf(subject) === -1) subjects.push(subject);
      }

      if (chartIds.length !== 1 || layoutIds.length !== 1 || subjects.length !== 1) {
        return { error: 'Bound authenticated chart identity is missing or ambiguous.' };
      }
      if (!window.crypto || !window.crypto.subtle || typeof window.crypto.subtle.digest !== 'function') {
        return { error: 'Bound authenticated chart identity hashing is unavailable.' };
      }
      var bytes = new TextEncoder().encode(subjects[0]);
      var digest = await window.crypto.subtle.digest('SHA-256', bytes);
      var hash = Array.prototype.map.call(new Uint8Array(digest), function(byte) {
        return byte.toString(16).padStart(2, '0');
      }).join('');
      return { chart_id: chartIds[0], layout_id: layoutIds[0], account_subject_sha256: hash };
    })()
  `, { awaitPromise: true });

  if (!identity || identity.error || !HASH.test(identity.account_subject_sha256 || '')) {
    throw new Error(identity?.error || 'Bound authenticated chart identity is unavailable.');
  }
  if (!identity.chart_id || !identity.layout_id) {
    throw new Error('Bound authenticated chart identity is incomplete.');
  }
  return {
    success: true,
    profile_id: session.profileId,
    chart_target_id: session.chartTargetId,
    chart_id: String(identity.chart_id),
    layout_id: String(identity.layout_id),
    account_subject_sha256: identity.account_subject_sha256,
  };
}

export async function captureCandle({ symbol, timeframe, source_candle_time, _deps } = {}) {
  const session = requireObserverSession();
  const requestedSymbol = requireNonEmptyString(symbol, 'symbol');
  const requestedTimeframe = requireNonEmptyString(timeframe, 'timeframe');
  const sourceTime = requireIsoDateTime(source_candle_time, 'source_candle_time');
  const evaluate = _deps?.evaluateBound || _deps?.evaluate || evaluateBound;
  const result = await evaluate(`
    (function() {
      var expectedSymbol = ${JSON.stringify(requestedSymbol)};
      var expectedTimeframe = ${JSON.stringify(requestedTimeframe)};
      var sourceEpochMs = Date.parse(${JSON.stringify(sourceTime)});
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var chartWidget = chart && chart._chartWidget;
      var model = chartWidget && chartWidget.model();
      var series = model && model.mainSeries();
      var bars = series && series.bars();
      var actualSymbol = chart && typeof chart.symbol === 'function' ? String(chart.symbol()) : '';
      var actualTimeframe = chart && typeof chart.resolution === 'function' ? String(chart.resolution()) : '';
      if (actualSymbol !== expectedSymbol || actualTimeframe !== expectedTimeframe) {
        return { error: 'Bound chart symbol or timeframe does not match the requested capture.' };
      }
      if (!bars || typeof bars.firstIndex !== 'function' || typeof bars.lastIndex !== 'function' || typeof bars.valueAt !== 'function') {
        return { error: 'Bound chart candle series is unavailable.' };
      }

      var matches = [];
      var first = bars.firstIndex();
      var last = bars.lastIndex();
      for (var index = first; index <= last; index++) {
        var value = bars.valueAt(index);
        if (!Array.isArray(value) || value.length < 6) continue;
        var rawTime = Number(value[0]);
        if (!Number.isFinite(rawTime)) continue;
        var barEpochMs = Math.abs(rawTime) < 100000000000 ? rawTime * 1000 : rawTime;
        if (barEpochMs !== sourceEpochMs) continue;
        var candle = {
          open: Number(value[1]), high: Number(value[2]), low: Number(value[3]),
          close: Number(value[4]), volume: Number(value[5]),
        };
        if (Object.values(candle).some(function(number) { return !Number.isFinite(number); })) {
          return { error: 'Requested candle contains partial or non-finite OHLCV data.' };
        }
        matches.push(candle);
      }
      if (matches.length === 0) return { error: 'Requested candle is missing from the bound chart.' };
      if (matches.length !== 1) return { error: 'Requested candle timestamp is duplicated or ambiguous.' };
      return matches[0];
    })()
  `);

  if (!result || result.error) throw new Error(result?.error || 'Requested candle capture failed.');
  for (const field of ['open', 'high', 'low', 'close', 'volume']) {
    if (typeof result[field] !== 'number' || !Number.isFinite(result[field])) {
      throw new Error('Requested candle contains partial or non-finite OHLCV data.');
    }
  }
  const capturedAt = (_deps?.now || (() => new Date()))().toISOString();
  if (!ISO_DATE_TIME.test(capturedAt)) throw new Error('Capture timestamp is invalid.');
  return {
    success: true,
    symbol: requestedSymbol,
    timeframe: requestedTimeframe,
    source_candle_time: sourceTime,
    captured_at: capturedAt,
    open: result.open,
    high: result.high,
    low: result.low,
    close: result.close,
    volume: result.volume,
    adapter_version: OBSERVER_ADAPTER_VERSION,
  };
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function requireIsoDateTime(value, name) {
  const normalized = requireNonEmptyString(value, name);
  if (!ISO_DATE_TIME.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${name} must be an ISO date-time with UTC Z suffix.`);
  }
  return normalized;
}
