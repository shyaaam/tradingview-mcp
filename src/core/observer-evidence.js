import { evaluateBound } from '../connection.js';
import { requireObserverSession } from './observer-session.js';
import { LEGACY_LAYOUT_IDENTITY_HELPER } from './layout-identity.js';
import { list as listTabs } from './tab.js';

export const OBSERVER_ADAPTER_VERSION = 'tradingview-mcp-observer-v1';
export const OBSERVER_TELEMETRY_OHLCV_VERSION = 'observer-telemetry-ohlcv-v1';
export const OBSERVER_PANE_TELEMETRY_OHLCV_VERSION = 'observer-pane-telemetry-ohlcv-v1';

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const HASH = /^[0-9a-f]{64}$/;

export const OBSERVER_IDENTITY_EVIDENCE_EXPRESSION = `
  (async function() {
    ${LEGACY_LAYOUT_IDENTITY_HELPER}
    function read(value) {
      try {
        if (typeof value === 'function') value = value();
        if (value && typeof value.value === 'function') value = value.value();
        return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
      } catch (e) { return ''; }
    }
    var api = window.TradingViewApi;
    var active = api && api._activeChartWidgetWV && typeof api._activeChartWidgetWV.value === 'function' ? api._activeChartWidgetWV.value() : null;
    var collection = api && api._chartWidgetCollection;
    var chartIds = [];
    var pathMatch = String(window.location && window.location.pathname || '').match(/\\/chart\\/([^/?#]+)/i);
    if (pathMatch) chartIds.push(pathMatch[1]);
    if (active) chartIds.push(read(active.chartId || active._chartId || active.id));
    chartIds = chartIds.filter(function(value, index) { return value && chartIds.indexOf(value) === index; });
    var layoutIdentity = deriveLegacyLayoutId(api);
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
    if (chartIds.length !== 1 || layoutIdentity.error || subjects.length !== 1) return { error: 'Bound authenticated chart identity is missing or ambiguous.' };
    if (!window.crypto || !window.crypto.subtle || typeof window.crypto.subtle.digest !== 'function') return { error: 'Bound authenticated chart identity hashing is unavailable.' };
    var bytes = new TextEncoder().encode(subjects[0]);
    var digest = await window.crypto.subtle.digest('SHA-256', bytes);
    var hash = Array.prototype.map.call(new Uint8Array(digest), function(byte) { return byte.toString(16).padStart(2, '0'); }).join('');
    return { chart_id: chartIds[0], layout_id: layoutIdentity.layout_id, account_subject_sha256: hash };
  })()
`;

export async function identity({ _deps } = {}) {
  const session = requireObserverSession();
  const evaluate = _deps?.evaluateBound || _deps?.evaluate || evaluateBound;
  const identity = await evaluate(OBSERVER_IDENTITY_EVIDENCE_EXPRESSION, { awaitPromise: true });
  if (!identity || identity.error || !HASH.test(identity.account_subject_sha256 || '')) throw new Error(identity?.error || 'Bound authenticated chart identity is unavailable.');
  if (!identity.chart_id || !identity.layout_id) throw new Error('Bound authenticated chart identity is incomplete.');
  return { success: true, profile_id: session.profileId, chart_target_id: session.chartTargetId, chart_id: String(identity.chart_id), layout_id: String(identity.layout_id), account_subject_sha256: identity.account_subject_sha256 };
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
      if (actualSymbol !== expectedSymbol || actualTimeframe !== expectedTimeframe) return { error: 'Bound chart symbol or timeframe does not match the requested capture.' };
      if (!bars || typeof bars.firstIndex !== 'function' || typeof bars.lastIndex !== 'function' || typeof bars.valueAt !== 'function') return { error: 'Bound chart candle series is unavailable.' };
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
        var candle = { open: Number(value[1]), high: Number(value[2]), low: Number(value[3]), close: Number(value[4]), volume: Number(value[5]) };
        if (Object.values(candle).some(function(number) { return !Number.isFinite(number); })) return { error: 'Requested candle contains partial or non-finite OHLCV data.' };
        matches.push(candle);
      }
      if (matches.length === 0) return { error: 'Requested candle is missing from the bound chart.' };
      if (matches.length !== 1) return { error: 'Requested candle timestamp is duplicated or ambiguous.' };
      return matches[0];
    })()
  `);
  if (!result || result.error) throw new Error(result?.error || 'Requested candle capture failed.');
  for (const field of ['open', 'high', 'low', 'close', 'volume']) if (typeof result[field] !== 'number' || !Number.isFinite(result[field])) throw new Error('Requested candle contains partial or non-finite OHLCV data.');
  const capturedAt = (_deps?.now || (() => new Date()))().toISOString();
  if (!ISO_DATE_TIME.test(capturedAt)) throw new Error('Capture timestamp is invalid.');
  return { success: true, symbol: requestedSymbol, timeframe: requestedTimeframe, source_candle_time: sourceTime, captured_at: capturedAt, open: result.open, high: result.high, low: result.low, close: result.close, volume: result.volume, adapter_version: OBSERVER_ADAPTER_VERSION };
}

export async function captureTelemetryOhlcv({ symbol, timeframe, count, _deps } = {}) {
  requireObserverSession();
  const requestedSymbol = requireNonEmptyString(symbol, 'symbol');
  const requestedTimeframe = requireNonEmptyString(timeframe, 'timeframe');
  const requestedCount = Number(count);
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 500) throw new Error('count must be an integer between 1 and 500.');
  const evaluate = _deps?.evaluateBound || _deps?.evaluate || evaluateBound;
  const result = await evaluate(`
    (function() {
      function text(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === 'number' && !Number.isFinite(value)) return null;
        return String(value);
      }
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var actualSymbol = chart && typeof chart.symbol === 'function' ? String(chart.symbol()) : '';
      var actualTimeframe = chart && typeof chart.resolution === 'function' ? String(chart.resolution()) : '';
      if (actualSymbol !== ${JSON.stringify(requestedSymbol)} || actualTimeframe !== ${JSON.stringify(requestedTimeframe)}) return { error: 'Bound chart symbol or timeframe does not match the requested extraction.' };
      var widget = chart && chart._chartWidget;
      var model = widget && widget.model();
      var series = model && model.mainSeries();
      var bars = series && series.bars();
      if (!bars || typeof bars.firstIndex !== 'function' || typeof bars.lastIndex !== 'function' || typeof bars.valueAt !== 'function') return { error: 'Bound chart candle series is unavailable.' };
      var end = bars.lastIndex();
      var start = Math.max(bars.firstIndex(), end - ${requestedCount} + 1);
      var candles = [];
      for (var index = start; index <= end; index++) {
        var value = bars.valueAt(index);
        if (!Array.isArray(value) || value.length < 6) continue;
        var rawTime = Number(value[0]);
        if (!Number.isFinite(rawTime)) continue;
        var epochMs = Math.abs(rawTime) < 100000000000 ? rawTime * 1000 : rawTime;
        var fields = [value[1], value[2], value[3], value[4]];
        if (fields.some(function(number) { return typeof number !== 'number' || !Number.isFinite(number); })) continue;
        candles.push({ opened_at: new Date(epochMs).toISOString(), open: text(value[1]), high: text(value[2]), low: text(value[3]), close: text(value[4]), volume: text(value[5]) });
      }
      if (candles.length === 0) return { error: 'No bounded OHLCV candles were available.' };
      var studies = [];
      var sources = model && model.model && model.model().dataSources ? model.model().dataSources() : [];
      for (var si = 0; si < sources.length; si++) {
        var source = sources[si];
        if (!source || !source.metaInfo) continue;
        try {
          var meta = source.metaInfo();
          var name = String(meta.description || meta.shortDescription || '');
          if (!name) continue;
          var studyId = String(source.id && typeof source.id === 'function' ? source.id() : source._id || name);
          var values = [];
          try {
            var view = source.dataWindowView && source.dataWindowView();
            var items = view && view.items && view.items();
            for (var vi = 0; items && vi < items.length; vi++) {
              var item = items[vi];
              if (!item || !item._title) continue;
              var raw = item._value;
              if (raw === undefined || raw === null || raw === '∅') continue;
              values.push({ source_label: 'data-window', field_label: String(item._title), raw_value: String(raw) });
            }
          } catch (e) {}
          studies.push({ study_id: studyId, study_name: name, values: values });
        } catch (e) {}
      }
      return { symbol: actualSymbol, timeframe: actualTimeframe, candles: candles, studies: studies };
    })()
  `);
  if (!result || result.error) throw new Error(result?.error || 'Bound telemetry/OHLCV extraction failed.');
  const capturedAt = (_deps?.now || (() => new Date()))().toISOString();
  return { success: true, extraction_version: OBSERVER_TELEMETRY_OHLCV_VERSION, symbol: requestedSymbol, timeframe: requestedTimeframe, requested_count: requestedCount, captured_at: capturedAt, candles: result.candles, studies: result.studies };
}

export async function capturePaneTelemetryOhlcv(input = {}) {
  const { _deps } = input;
  const scope = normalizePaneCaptureRequest(input);
  const session = requireObserverSession();
  const canonicalUrl = `https://www.tradingview.com/chart/${scope.expected_chart_id}/`;
  if (session.profileId !== scope.profile_id
    || session.chartTargetId !== scope.expected_chart_target_id
    || session.chartTargetUrl !== canonicalUrl) {
    throw new Error('exact pane observer identity does not match exact profile/chart authority');
  }

  const tabs = await (_deps?.listTabs || listTabs)();
  const matches = Array.isArray(tabs?.tabs)
    ? tabs.tabs.filter((tab) => tab?.index === scope.tab_index && tab?.id === scope.expected_chart_target_id)
    : [];
  if (tabs?.success !== true || matches.length !== 1) throw new Error('exact pane observer tab target is not unique');
  const tab = matches[0];
  if (tab.chart_id !== scope.expected_chart_id || tab.url !== canonicalUrl) {
    throw new Error('exact pane observer chart target does not match authority');
  }

  const evaluate = _deps?.evaluateBound || _deps?.evaluate || evaluateBound;
  const layout = await evaluate(`
    (function() {
      var cwc = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
      var layout = cwc && cwc._layoutType;
      if (layout && typeof layout.value === 'function') layout = layout.value();
      return { layout_id: layout == null ? '' : String(layout) };
    })()
  `);
  if (!layout || layout.layout_id !== scope.expected_layout_id) {
    throw new Error('exact pane observer layout does not match authority');
  }

  const result = await evaluate(`
    (function() {
      function text(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === 'number' && !Number.isFinite(value)) return null;
        return String(value);
      }
      var cwc = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
      var count = cwc && cwc.inlineChartsCount;
      if (count && typeof count.value === 'function') count = count.value();
      var paneCount = Number(count);
      var all = cwc && typeof cwc.getAll === 'function' ? cwc.getAll() : [];
      var paneIndex = ${scope.pane_index};
      if (!Number.isInteger(paneCount) || paneCount < 1 || paneCount > 16 || !Array.isArray(all) || all.length < paneCount || paneIndex >= paneCount || !all[paneIndex]) {
        return { error: 'Exact requested pane is missing or ambiguous.' };
      }
      var wrapper = typeof all[paneIndex].model === 'function' ? all[paneIndex].model() : null;
      var model = wrapper && typeof wrapper.model === 'function' ? wrapper.model() : wrapper;
      var mainSeries = model && typeof model.mainSeries === 'function' ? model.mainSeries() : null;
      var actualSymbol = mainSeries && typeof mainSeries.symbol === 'function' ? String(mainSeries.symbol()) : '';
      var actualTimeframe = mainSeries && typeof mainSeries.interval === 'function' ? String(mainSeries.interval()) : '';
      if (actualSymbol !== ${JSON.stringify(scope.symbol)} || actualTimeframe !== ${JSON.stringify(scope.timeframe)}) {
        return { error: 'Exact requested pane symbol or timeframe does not match.' };
      }
      var bars = mainSeries && typeof mainSeries.bars === 'function' ? mainSeries.bars() : null;
      if (!bars || typeof bars.firstIndex !== 'function' || typeof bars.lastIndex !== 'function' || typeof bars.valueAt !== 'function') {
        return { error: 'Exact requested pane candle series is unavailable.' };
      }
      var end = bars.lastIndex();
      var start = Math.max(bars.firstIndex(), end - ${scope.count} + 1);
      var candles = [];
      for (var index = start; index <= end; index++) {
        var value = bars.valueAt(index);
        if (!Array.isArray(value) || value.length < 6) continue;
        var rawTime = Number(value[0]);
        if (!Number.isFinite(rawTime)) continue;
        var epochMs = Math.abs(rawTime) < 100000000000 ? rawTime * 1000 : rawTime;
        if (!Number.isFinite(epochMs)) continue;
        var openedAt;
        try { openedAt = new Date(epochMs).toISOString(); } catch (_) { continue; }
        var fields = [value[1], value[2], value[3], value[4]];
        if (fields.some(function(number) { return typeof number !== 'number' || !Number.isFinite(number); })) continue;
        candles.push({ opened_at: openedAt, open: text(value[1]), high: text(value[2]), low: text(value[3]), close: text(value[4]), volume: text(value[5]) });
      }
      if (candles.length === 0) return { error: 'Exact requested pane has no bounded OHLCV candles.' };

      var sources = model && typeof model.dataSources === 'function' ? model.dataSources() : null;
      if (!Array.isArray(sources)) return { error: 'Exact requested pane study telemetry is unavailable.' };
      var studies = [];
      var studyIds = Object.create(null);
      for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        var source = sources[sourceIndex];
        if (!source || typeof source.metaInfo !== 'function') continue;
        var meta = source.metaInfo();
        var studyId = String(meta && (meta.id || '')).trim();
        var studyName = String(meta && (meta.description || meta.shortDescription || meta.id || '')).trim();
        if (!studyId || !studyName || studyIds[studyId]) return { error: 'Exact requested pane study telemetry is missing or ambiguous.' };
        studyIds[studyId] = true;
        var values = [];
        try {
          var view = source.dataWindowView && source.dataWindowView();
          var items = view && view.items && view.items();
          var valueKeys = Object.create(null);
          for (var valueIndex = 0; items && valueIndex < items.length; valueIndex++) {
            var item = items[valueIndex];
            if (!item || !item._title) continue;
            var raw = item._value;
            if (raw === undefined || raw === null || raw === '∅') continue;
            var fieldLabel = String(item._title);
            var valueKey = 'data-window:' + fieldLabel;
            if (valueKeys[valueKey]) return { error: 'Exact requested pane study telemetry is missing or ambiguous.' };
            valueKeys[valueKey] = true;
            values.push({ source_label: 'data-window', field_label: fieldLabel, raw_value: String(raw) });
          }
        } catch (_) {
          return { error: 'Exact requested pane study telemetry is unavailable.' };
        }
        studies.push({ study_id: studyId, study_name: studyName, values: values });
      }
      return { pane_index: paneIndex, pane_count: paneCount, symbol: actualSymbol, timeframe: actualTimeframe, candles: candles, studies: studies };
    })()
  `);
  if (!result || result.error) throw new Error(result?.error || 'Exact pane telemetry/OHLCV extraction failed.');
  if (Number(result.pane_index) !== scope.pane_index || Number(result.pane_count) < 1
    || result.symbol !== scope.symbol || result.timeframe !== scope.timeframe) {
    throw new Error('Exact pane telemetry/OHLCV readback does not match authority.');
  }
  const capturedAt = (_deps?.now || (() => new Date()))().toISOString();
  if (!ISO_DATE_TIME.test(capturedAt)) throw new Error('Capture timestamp is invalid.');
  const candles = normalizePaneCandles(result.candles);
  const studies = normalizePaneStudies(result.studies);
  return {
    success: true,
    extraction_version: OBSERVER_PANE_TELEMETRY_OHLCV_VERSION,
    profile_id: scope.profile_id,
    chart_target_id: scope.expected_chart_target_id,
    chart_id: scope.expected_chart_id,
    layout_id: scope.expected_layout_id,
    tab_index: scope.tab_index,
    pane_index: scope.pane_index,
    pane_count: Number(result.pane_count),
    symbol: scope.symbol,
    timeframe: scope.timeframe,
    requested_count: scope.count,
    captured_at: capturedAt,
    candles,
    study_telemetry_state: studies.length > 0 ? 'available' : 'unavailable',
    study_telemetry_reason: studies.length > 0 ? null : 'missing-or-ambiguous',
    studies,
  };
}

function normalizePaneCaptureRequest(input) {
  const text = (value, name) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
    return value.trim();
  };
  const index = (value, name) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer.`);
    return number;
  };
  const count = Number(input.count);
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('count must be an integer between 1 and 500.');
  return {
    profile_id: text(input.profile_id, 'profile_id'),
    expected_chart_target_id: text(input.expected_chart_target_id, 'expected_chart_target_id'),
    expected_chart_id: text(input.expected_chart_id, 'expected_chart_id'),
    expected_layout_id: text(input.expected_layout_id, 'expected_layout_id'),
    tab_index: index(input.tab_index, 'tab_index'),
    pane_index: index(input.pane_index, 'pane_index'),
    symbol: text(input.symbol, 'symbol'),
    timeframe: text(input.timeframe, 'timeframe'),
    count,
  };
}

function normalizePaneCandles(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) throw new Error('Exact pane telemetry/OHLCV candles are incompatible.');
  return value.map((candle, index) => {
    if (!candle || typeof candle !== 'object' || Array.isArray(candle)) throw new Error(`candles[${index}] is incompatible.`);
    const openedAt = String(candle.opened_at || '');
    if (!ISO_DATE_TIME.test(openedAt) || !Number.isFinite(Date.parse(openedAt))) throw new Error(`candles[${index}].opened_at is incompatible.`);
    for (const field of ['open', 'high', 'low', 'close']) if (typeof candle[field] !== 'string' || !candle[field]) throw new Error(`candles[${index}].${field} is incompatible.`);
    if (candle.volume !== null && (typeof candle.volume !== 'string' || !candle.volume)) throw new Error(`candles[${index}].volume is incompatible.`);
    return { opened_at: openedAt, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume };
  });
}

function normalizePaneStudies(value) {
  if (!Array.isArray(value)) throw new Error('Exact pane study telemetry is incompatible.');
  const studyIds = new Set();
  return value.map((study, index) => {
    if (!study || typeof study !== 'object' || Array.isArray(study)) throw new Error(`studies[${index}] is incompatible.`);
    const studyId = String(study.study_id || '').trim();
    const studyName = String(study.study_name || '').trim();
    if (!studyId || !studyName || studyIds.has(studyId) || !Array.isArray(study.values)) throw new Error(`studies[${index}] is ambiguous.`);
    studyIds.add(studyId);
    const valueKeys = new Set();
    const values = study.values.map((item, valueIndex) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`studies[${index}].values[${valueIndex}] is incompatible.`);
      const sourceLabel = String(item.source_label || '').trim();
      const fieldLabel = String(item.field_label || '').trim();
      const rawValue = String(item.raw_value ?? '');
      const key = `${sourceLabel}:${fieldLabel}`;
      if (!sourceLabel || !fieldLabel || !rawValue || valueKeys.has(key)) throw new Error(`studies[${index}].values is ambiguous.`);
      valueKeys.add(key);
      return { source_label: sourceLabel, field_label: fieldLabel, raw_value: rawValue };
    });
    return { study_id: studyId, study_name: studyName, values };
  });
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function requireIsoDateTime(value, name) {
  const normalized = requireNonEmptyString(value, name);
  if (!ISO_DATE_TIME.test(normalized) || !Number.isFinite(Date.parse(normalized))) throw new Error(`${name} must be an ISO date-time with UTC Z suffix.`);
  return normalized;
}
