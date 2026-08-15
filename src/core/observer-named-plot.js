import { evaluateBound } from '../connection.js';
import { requireObserverSession } from './observer-session.js';
import { list as listTabs } from './tab.js';

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const PLOT_NAME = /^TVOBS_[A-Z0-9]+_V1_[A-Z0-9_]+$/;

export async function captureNamedPlotTelemetry(input = {}) {
  const { _deps } = input;
  const scope = normalizeNamedPlotCaptureRequest(input);
  const session = requireObserverSession();
  const canonicalUrl = `https://www.tradingview.com/chart/${scope.expected_chart_id}/`;
  if (session.profileId !== scope.profile_id
    || session.chartTargetId !== scope.expected_chart_target_id
    || session.chartTargetUrl !== canonicalUrl) {
    throw new Error('exact named-plot observer identity does not match exact profile/chart authority');
  }

  const tabs = await (_deps?.listTabs || listTabs)();
  const matches = Array.isArray(tabs?.tabs)
    ? tabs.tabs.filter((tab) => tab?.index === scope.tab_index && tab?.id === scope.expected_chart_target_id)
    : [];
  if (tabs?.success !== true || matches.length !== 1) throw new Error('exact named-plot observer tab target is not unique');
  const tab = matches[0];
  if (tab.chart_id !== scope.expected_chart_id || tab.url !== canonicalUrl) {
    throw new Error('exact named-plot observer chart target does not match authority');
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
    throw new Error('exact named-plot observer layout does not match authority');
  }

  const result = await evaluate(`
    (function() {
      var cwc = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
      var count = cwc && cwc.inlineChartsCount;
      if (count && typeof count.value === 'function') count = count.value();
      var paneCount = Number(count);
      var all = cwc && typeof cwc.getAll === 'function' ? cwc.getAll() : [];
      var paneIndex = ${scope.pane_index};
      if (!Number.isInteger(paneCount) || paneCount < 1 || paneCount > 16
        || !Array.isArray(all) || all.length < paneCount || paneIndex >= paneCount || !all[paneIndex]) {
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
      var sources = model && typeof model.dataSources === 'function' ? model.dataSources() : null;
      if (!Array.isArray(sources)) return { error: 'Exact requested pane study sources are unavailable.' };
      var studyMatches = [];
      for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        var source = sources[sourceIndex];
        if (!source || typeof source.metaInfo !== 'function') continue;
        var meta;
        try { meta = source.metaInfo(); } catch (_) { return { error: 'Exact requested study metadata is unavailable.' }; }
        var studyId = String(meta && (meta.id || '')).trim();
        var studyName = String(meta && (meta.description || meta.shortDescription || meta.id || '')).trim();
        if (studyId === ${JSON.stringify(scope.study_id)} && studyName === ${JSON.stringify(scope.study_name)}) studyMatches.push(source);
      }
      if (studyMatches.length !== 1) return { error: 'Exact requested study is missing or ambiguous.' };
      var view;
      try { view = studyMatches[0].dataWindowView && studyMatches[0].dataWindowView(); } catch (_) { return { error: 'Exact requested study plot values are unavailable.' }; }
      var items;
      try { items = view && view.items && view.items(); } catch (_) { return { error: 'Exact requested study plot values are unavailable.' }; }
      if (!Array.isArray(items)) return { error: 'Exact requested study plot values are unavailable.' };
      var requested = ${JSON.stringify(scope.plot_names)};
      var requestedSet = Object.create(null);
      for (var requestedIndex = 0; requestedIndex < requested.length; requestedIndex++) requestedSet[requested[requestedIndex]] = true;
      var found = Object.create(null);
      for (var valueIndex = 0; valueIndex < items.length; valueIndex++) {
        var item = items[valueIndex];
        var fieldLabel = item && item._title != null ? String(item._title).trim() : '';
        if (!requestedSet[fieldLabel]) continue;
        if (Object.prototype.hasOwnProperty.call(found, fieldLabel)) return { error: 'Requested study plot is duplicated or ambiguous.' };
        var raw = item._value;
        if (raw === undefined || raw === null) return { error: 'Requested study plot value is missing or ambiguous.' };
        found[fieldLabel] = raw === '∅'
          ? { raw_value: null, value_state: 'not-present' }
          : { raw_value: String(raw), value_state: 'present' };
      }
      var plots = [];
      for (var outputIndex = 0; outputIndex < requested.length; outputIndex++) {
        var plotName = requested[outputIndex];
        if (!Object.prototype.hasOwnProperty.call(found, plotName)) return { error: 'Requested study plot is missing or ambiguous.' };
        plots.push({ plot_name: plotName, ...found[plotName] });
      }
      return { pane_index: paneIndex, pane_count: paneCount, symbol: actualSymbol, timeframe: actualTimeframe, study_id: ${JSON.stringify(scope.study_id)}, study_name: ${JSON.stringify(scope.study_name)}, plots: plots };
    })()
  `);
  if (!result || result.error) throw new Error(result?.error || 'Exact named-plot telemetry extraction failed.');
  if (Number(result.pane_index) !== scope.pane_index || Number(result.pane_count) < 1
    || result.symbol !== scope.symbol || result.timeframe !== scope.timeframe
    || result.study_id !== scope.study_id || result.study_name !== scope.study_name) {
    throw new Error('Exact named-plot telemetry readback does not match authority.');
  }
  if (!Array.isArray(result.plots) || result.plots.length !== scope.plot_names.length) throw new Error('Exact named-plot telemetry result is incomplete or ambiguous.');
  const requestedNames = new Set(scope.plot_names);
  const seenNames = new Set();
  const plots = result.plots.map((plot, index) => {
    if (!plot || typeof plot !== 'object' || Array.isArray(plot)) throw new Error(`plots[${index}] is incompatible.`);
    const plotName = String(plot.plot_name || '').trim();
    const rawValue = plot.raw_value === null ? null : String(plot.raw_value ?? '');
    const valueState = String(plot.value_state || '').trim();
    if (!requestedNames.has(plotName) || seenNames.has(plotName)
      || !['present', 'not-present'].includes(valueState)
      || (valueState === 'present' && !rawValue)
      || (valueState === 'not-present' && rawValue !== null)) throw new Error(`plots[${index}] is missing or ambiguous.`);
    seenNames.add(plotName);
    return { plot_name: plotName, raw_value: rawValue, value_state: valueState };
  });
  if (seenNames.size !== requestedNames.size) throw new Error('Exact named-plot telemetry result is incomplete or ambiguous.');
  const capturedAt = (_deps?.now || (() => new Date()))().toISOString();
  if (!ISO_DATE_TIME.test(capturedAt)) throw new Error('Capture timestamp is invalid.');
  return {
    success: true,
    extraction_version: 'observer-named-plot-telemetry-v1',
    profile_id: scope.profile_id,
    chart_target_id: scope.expected_chart_target_id,
    chart_id: scope.expected_chart_id,
    layout_id: scope.expected_layout_id,
    tab_index: scope.tab_index,
    pane_index: scope.pane_index,
    pane_count: Number(result.pane_count),
    symbol: scope.symbol,
    timeframe: scope.timeframe,
    study_id: scope.study_id,
    study_name: scope.study_name,
    plots,
    captured_at: capturedAt,
  };
}

function normalizeNamedPlotCaptureRequest(input) {
  const text = (value, name) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
    return value.trim();
  };
  const index = (value, name) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer.`);
    return number;
  };
  if (!Array.isArray(input.plot_names) || input.plot_names.length < 1 || input.plot_names.length > 64) throw new Error('plot_names must contain between 1 and 64 names.');
  const plotNames = input.plot_names.map((value, index) => text(value, `plot_names[${index}]`));
  if (new Set(plotNames).size !== plotNames.length) throw new Error('plot_names must be unique.');
  if (plotNames.some((value) => !PLOT_NAME.test(value))) throw new Error('plot_names must use TVOBS_*_V1_* names.');
  return {
    profile_id: text(input.profile_id, 'profile_id'),
    expected_chart_target_id: text(input.expected_chart_target_id, 'expected_chart_target_id'),
    expected_chart_id: text(input.expected_chart_id, 'expected_chart_id'),
    expected_layout_id: text(input.expected_layout_id, 'expected_layout_id'),
    tab_index: index(input.tab_index, 'tab_index'),
    pane_index: index(input.pane_index, 'pane_index'),
    symbol: text(input.symbol, 'symbol'),
    timeframe: text(input.timeframe, 'timeframe'),
    study_id: text(input.study_id, 'study_id'),
    study_name: text(input.study_name, 'study_name'),
    plot_names: plotNames,
  };
}
