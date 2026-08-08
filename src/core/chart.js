/**
 * Core chart control logic.
 */
import {
  evaluate as _evaluate,
  evaluateAsync as _evaluateAsync,
  getBoundClient as _getBoundClient,
  requireObserverSession,
  safeString,
  requireFinite,
} from '../connection.js';
import { list as _listTabs } from './tab.js';
import { indicatorSignatures, mutationIdentityInventory, derivePaneIndicatorParityHash } from './pane.js';
import { waitForChartReady as _waitForChartReady } from '../wait.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    getBoundClient: deps?.getBoundClient || _getBoundClient,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
  };
}

const CANONICAL_CHART_URL = (chartId) => `https://www.tradingview.com/chart/${chartId}/`;

/**
 * Save the currently bound, existing chart through TradingView's scoped save
 * service. This never creates, renames, switches, focuses, or mutates studies.
 */
export async function saveExistingChartScoped({
  profile_id,
  tab_index,
  chart_target_id,
  chart_id,
  layout_id,
  expected_pane_count,
  expected_indicator_parity_hash,
  _deps,
}) {
  const { evaluate, evaluateAsync, getBoundClient } = _resolve(_deps);
  const listTabs = _deps?.listTabs || _listTabs;
  const inspectInventory = _deps?.inspectInventory || mutationIdentityInventory;
  const inspectSignatures = _deps?.inspectSignatures || indicatorSignatures;
  const session = requireObserverSession();
  const expected = {
    profileId: String(profile_id || '').trim(),
    tabIndex: Number(tab_index),
    targetId: String(chart_target_id || '').trim(),
    chartId: String(chart_id || '').trim(),
    layoutId: String(layout_id || '').trim(),
    paneCount: Number(expected_pane_count),
    parityHash: String(expected_indicator_parity_hash || '').trim(),
  };
  if (!expected.profileId || !expected.targetId || !expected.chartId || !expected.layoutId
    || !Number.isInteger(expected.tabIndex) || expected.tabIndex < 0
    || !Number.isInteger(expected.paneCount) || expected.paneCount < 1 || expected.paneCount > 16
    || !/^[0-9a-f]{64}$/.test(expected.parityHash)) {
    throw new Error('Scoped existing-chart save input is invalid.');
  }
  const canonicalUrl = CANONICAL_CHART_URL(expected.chartId);
  if (session.profileId !== expected.profileId || session.chartTargetId !== expected.targetId
    || session.chartTargetUrl !== canonicalUrl) {
    throw new Error('Scoped existing-chart save target or profile does not match observer session.');
  }

  const tabs = await listTabs();
  const tabEntries = tabs && Array.isArray(tabs.tabs) ? tabs.tabs : null;
  const matchingTabs = (tabEntries || []).filter((tab) => tab
    && Number(tab.index) === expected.tabIndex
    && tab.id === expected.targetId
    && tab.chart_id === expected.chartId
    && tab.url === canonicalUrl);
  if (tabs?.success !== true || !tabEntries || matchingTabs.length !== 1
    || tabEntries.filter((tab) => tab?.id === expected.targetId).length !== 1) {
    throw new Error('Scoped existing-chart save target tab is missing or ambiguous.');
  }

  // Forces exact operation-scoped CDP attachment before any save API call.
  await getBoundClient();
  const pre = await evaluate(`
    (function() {
      var cwc = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
      var chart = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV
        && window.TradingViewApi._activeChartWidgetWV.value();
      var count = cwc && cwc.inlineChartsCount;
      if (typeof count === 'object' && count && typeof count.value === 'function') count = count.value();
      var layoutId = cwc && cwc.metaInfo && cwc.metaInfo().uid;
      if (layoutId && typeof layoutId.value === 'function') layoutId = layoutId.value();
      return {
        href: window.location.href,
        pane_count: Number(count),
        layout_id: layoutId == null ? null : String(layoutId),
        chart_available: Boolean(chart),
      };
    })()
  `);
  if (!pre || pre.href !== canonicalUrl || pre.layout_id !== expected.layoutId
    || pre.pane_count !== expected.paneCount || pre.chart_available !== true) {
    throw new Error('Scoped existing-chart save authority changed before save.');
  }

  const inventory = await inspectInventory();
  if (inventory?.success !== true || inventory.pane_count !== expected.paneCount
    || !Array.isArray(inventory.panes) || inventory.panes.length !== expected.paneCount
    || inventory.panes.some((pane, index) => pane.index !== index || !Array.isArray(pane.indicators)
      || pane.indicators.some((indicator) => indicator.get_study_by_id_resolves !== true))) {
    throw new Error('Scoped existing-chart save indicator identity is incomplete.');
  }
  const signatures = await inspectSignatures();
  if (signatures?.success !== true || signatures.pane_count !== expected.paneCount
    || !Array.isArray(signatures.panes) || signatures.panes.length !== expected.paneCount
    || signatures.panes.some((pane, index) => pane.index !== index)) {
    throw new Error('Scoped existing-chart save indicator parity is unavailable.');
  }
  const parityHash = derivePaneIndicatorParityHash({
    paneCapacity: expected.paneCount,
    canonicalPaneIndex: signatures.canonical_pane_index,
    panes: signatures.panes,
  });
  if (parityHash !== expected.parityHash) {
    throw new Error('Scoped existing-chart save indicator parity does not match reviewed authority.');
  }

  const saved = await evaluateAsync(`
    (function() {
      var service = window.TradingViewApi && window.TradingViewApi._saveChartService;
      if (!service || typeof service.saveExistentChart !== 'function') {
        return { success: false, error: 'Existing-chart save service is unavailable.' };
      }
      return new Promise(function(resolve) {
        var settled = false;
        function finish(value) {
          if (settled) return;
          settled = true;
          resolve(value);
        }
        try {
          service.saveExistentChart(function(value) {
            finish({ success: true, uid: value && value.uid != null ? String(value.uid) : null });
          }, function(error) {
            finish({ success: false, error: 'Existing-chart save failed.' });
          }, { autoSave: false });
        } catch (error) {
          finish({ success: false, error: 'Existing-chart save failed.' });
        }
      });
    })()
  `);
  if (!saved || saved.success !== true || saved.uid !== expected.layoutId) {
    throw new Error('Existing-chart save did not preserve reviewed layout identity.');
  }

  const post = await evaluate(`
    (function() {
      var cwc = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
      var layoutId = cwc && cwc.metaInfo && cwc.metaInfo().uid;
      if (layoutId && typeof layoutId.value === 'function') layoutId = layoutId.value();
      return { href: window.location.href, layout_id: layoutId == null ? null : String(layoutId) };
    })()
  `);
  if (!post || post.href !== canonicalUrl || post.layout_id !== expected.layoutId) {
    throw new Error('Existing-chart save postcondition changed reviewed chart identity.');
  }
  return {
    success: true,
    save_version: 'chart-save-existing-scoped-v1',
    profile_id: expected.profileId,
    chart_target_id: expected.targetId,
    chart_id: expected.chartId,
    layout_id: expected.layoutId,
    pane_count: expected.paneCount,
    indicator_parity_hash: parityHash,
    saved_layout_id: saved.uid,
    saved_existing: true,
    mutations_performed: true,
  };
}

export async function getState({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const state = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      } catch(e) {}
      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        chartType: chart.chartType(),
        studies: studies,
      };
    })()
  `);
  return { success: true, ...state };
}

export async function setSymbol({ symbol, _deps }) {
  const { evaluateAsync, waitForChartReady } = _resolve(_deps);
  await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(symbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);
  const ready = await waitForChartReady(symbol);
  return { success: true, symbol, chart_ready: ready };
}

export async function setTimeframe({ timeframe, _deps }) {
  const { evaluate, waitForChartReady } = _resolve(_deps);
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setResolution(${safeString(timeframe)}, {});
    })()
  `);
  const ready = await waitForChartReady(null, timeframe);
  return { success: true, timeframe, chart_ready: ready };
}

export async function setType({ chart_type, _deps }) {
  const { evaluate } = _resolve(_deps);
  const typeMap = {
    'Bars': 0, 'Candles': 1, 'Line': 2, 'Area': 3,
    'Renko': 4, 'Kagi': 5, 'PointAndFigure': 6, 'LineBreak': 7,
    'HeikinAshi': 8, 'HollowCandles': 9,
  };
  const typeNum = typeMap[chart_type] ?? Number(chart_type);
  if (isNaN(typeNum) || typeNum < 0 || typeNum > 9 || !Number.isInteger(typeNum)) {
    throw new Error(`Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`);
  }
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setChartType(${typeNum});
    })()
  `);
  return { success: true, chart_type, type_num: typeNum };
}

export async function manageIndicator({ action, indicator, entity_id, inputs: inputsRaw, _deps }) {
  const { evaluate } = _resolve(_deps);
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;

  if (action === 'add') {
    const inputArr = inputs ? Object.entries(inputs).map(([k, v]) => ({ id: k, value: v })) : [];
    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy(${safeString(indicator)}, false, false, ${JSON.stringify(inputArr)});
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));
    const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    const newIds = (after || []).filter(id => !(before || []).includes(id));
    return { success: newIds.length > 0, action: 'add', indicator, entity_id: newIds[0] || null, new_study_count: newIds.length };
  } else if (action === 'remove') {
    if (!entity_id) throw new Error('entity_id required for remove action. Use chart_get_state to find study IDs.');
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.removeEntity(${safeString(entity_id)});
      })()
    `);
    return { success: true, action: 'remove', entity_id };
  } else {
    throw new Error('action must be "add" or "remove"');
  }
}

export async function getVisibleRange() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { visible_range: chart.getVisibleRange(), bars_range: chart.getVisibleBarsRange() };
    })()
  `);
  return { success: true, visible_range: result.visible_range, bars_range: result.bars_range };
}

export async function setVisibleRange({ from, to, _deps }) {
  const { evaluate } = _resolve(_deps);
  const f = requireFinite(from, 'from');
  const t = requireFinite(to, 'to');
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${f} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${t}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  const actual = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `);
  return { success: true, requested: { from, to }, actual: actual || { from: 0, to: 0 } };
}

export async function scrollToDate({ date }) {
  let timestamp;
  if (/^\d+$/.test(date)) timestamp = Number(date);
  else timestamp = Math.floor(new Date(date).getTime() / 1000);
  if (isNaN(timestamp)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  const resolution = await evaluate(`${CHART_API}.resolution()`);
  let secsPerBar = 60;
  const res = String(resolution);
  if (res === 'D' || res === '1D') secsPerBar = 86400;
  else if (res === 'W' || res === '1W') secsPerBar = 604800;
  else if (res === 'M' || res === '1M') secsPerBar = 2592000;
  else { const mins = parseInt(res, 10); if (!isNaN(mins)) secsPerBar = mins * 60; }

  const halfWindow = 25 * secsPerBar;
  const from = timestamp - halfWindow;
  const to = timestamp + halfWindow;

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  return { success: true, date, centered_on: timestamp, resolution, window: { from, to } };
}

export async function symbolInfo() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var info = chart.symbolExt();
      return {
        symbol: info.symbol, full_name: info.full_name, exchange: info.exchange,
        description: info.description, type: info.type, pro_name: info.pro_name,
        typespecs: info.typespecs, resolution: chart.resolution(), chart_type: chart.chartType()
      };
    })()
  `);
  return { success: true, ...result };
}

export async function symbolSearch({ query, type }) {
  // Use TradingView's public symbol search REST API (works without auth)
  const params = new URLSearchParams({
    text: query,
    hl: '1',
    exchange: '',
    lang: 'en',
    search_type: type || '',
    domain: 'production',
  });

  const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
  });
  if (!resp.ok) throw new Error(`Symbol search API returned ${resp.status}`);
  const data = await resp.json();

  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const results = (data.symbols || data || []).slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}
