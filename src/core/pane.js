/**
 * Core pane/layout management logic.
 * Controls multi-chart layouts (split panes) in TradingView.
 */
import { createHash } from 'node:crypto';
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';

const CWC = 'window.TradingViewApi._chartWidgetCollection';
export const PANE_INDICATOR_SIGNATURE_SCHEMA_VERSION = 'pane-indicator-signatures-v1';
const VOLATILE_INDICATOR_INPUT_KEYS = new Set([
  'first_visible_bar_time',
  'last_visible_bar_time',
  'subscribeRealtime',
]);

export const LAYOUT_NAMES = {
  's': '1 chart',
  '2h': '2 horizontal',
  '2v': '2 vertical',
  '2-1': '2 top, 1 bottom',
  '1-2': '1 top, 2 bottom',
  '3h': '3 horizontal',
  '3v': '3 vertical',
  '3s': '3 custom',
  '4': '2x2 grid',
  '4h': '4 horizontal',
  '4v': '4 vertical',
  '4s': '4 custom',
  '6': '6 charts',
  '8': '8 charts',
  '10': '10 charts',
  '12': '12 charts',
  '14': '14 charts',
  '16': '16 charts',
};

/**
 * List all panes in the current layout with their symbols and index.
 */
export async function list() {
  const result = await evaluate(`
    (function() {
      var cwc = ${CWC};
      var layoutType = cwc._layoutType;
      if (typeof layoutType === 'object' && layoutType && typeof layoutType.value === 'function') layoutType = layoutType.value();
      var count = cwc.inlineChartsCount;
      if (typeof count === 'object' && count && typeof count.value === 'function') count = count.value();

      var all = cwc.getAll();
      var visibleCount = Number(count);
      var panes = [];
      for (var i = 0; i < all.length && i < visibleCount; i++) {
        try {
          var c = all[i];
          var model = c.model ? c.model() : null;
          var mainSeries = model ? model.mainSeries() : null;
          var sym = mainSeries ? mainSeries.symbol() : 'unknown';
          var res = mainSeries ? mainSeries.interval() : null;
          panes.push({ index: i, symbol: sym, resolution: res || null });
        } catch(e) { panes.push({ index: i, error: e.message }); }
      }

      // Check which pane is active
      var activeChart = window.TradingViewApi._activeChartWidgetWV.value();
      var activeIndex = null;
      for (var j = 0; j < all.length && j < visibleCount; j++) {
        try {
          if (all[j].model && activeChart._chartWidget && all[j] === activeChart._chartWidget) { activeIndex = j; break; }
        } catch(e) {}
      }

      return { layout: layoutType, chart_count: count, active_index: activeIndex, panes: panes };
    })()
  `);

  return {
    success: true,
    layout: result.layout,
    layout_name: LAYOUT_NAMES[result.layout] || result.layout,
    chart_count: result.chart_count,
    active_index: result.active_index,
    panes: result.panes,
  };
}

/**
 * Read every pane's indicator inventory without focusing or mutating a pane.
 * Pane zero is the canonical inventory; pane indexes never enter signatures.
 */
export async function indicatorSignatures({ _deps } = {}) {
  const evaluateFn = _deps?.evaluate || evaluate;
  const raw = await evaluateFn(`
    (function() {
      var cwc = ${CWC};
      var count = cwc && cwc.inlineChartsCount;
      if (typeof count === 'object' && count && typeof count.value === 'function') count = count.value();
      var visibleCount = Number(count);
      var all = cwc && typeof cwc.getAll === 'function' ? cwc.getAll() : [];
      if (!Number.isInteger(visibleCount) || visibleCount < 1 || all.length < visibleCount) {
        return { error: 'TradingView pane indicator inventory is unavailable.' };
      }
      var panes = [];
      for (var paneIndex = 0; paneIndex < visibleCount; paneIndex++) {
        var widget = all[paneIndex];
        var model = widget && typeof widget.model === 'function' ? widget.model() : null;
        var chartModel = model && typeof model.model === 'function' ? model.model() : null;
        var sources = chartModel && typeof chartModel.dataSources === 'function'
          ? chartModel.dataSources()
          : null;
        if (!Array.isArray(sources)) {
          return { error: 'TradingView pane indicator inventory is unavailable.' };
        }
        var indicators = [];
        for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
          var source = sources[sourceIndex];
          if (!source || typeof source.metaInfo !== 'function') continue;
          var meta = source.metaInfo();
          if (!meta || typeof meta.id !== 'string' || meta.id.length === 0) continue;
          if (typeof source.inputs !== 'function') {
            return { error: 'TradingView pane indicator settings are unavailable.' };
          }
          var settings;
          try {
            settings = source.inputs();
            JSON.stringify(settings);
          } catch (error) {
            return { error: 'TradingView pane indicator settings are unavailable.' };
          }
          indicators.push({
            indicator_id: meta.id,
            indicator_name: String(meta.description || meta.shortDescription || meta.id),
            is_price_study: meta.is_price_study === true,
            settings: settings,
          });
        }
        panes.push({ index: paneIndex, indicators: indicators });
      }
      return { pane_count: visibleCount, panes: panes };
    })()
  `);
  if (!raw || typeof raw !== 'object' || raw.error) {
    throw new Error(raw?.error || 'TradingView pane indicator inventory is unavailable.');
  }
  const paneCount = Number(raw.pane_count);
  if (!Number.isInteger(paneCount) || paneCount < 1 || !Array.isArray(raw.panes) || raw.panes.length !== paneCount) {
    throw new Error('TradingView pane indicator inventory is incompatible.');
  }
  const panes = raw.panes.map((pane, index) => {
    if (!pane || Number(pane.index) !== index || !Array.isArray(pane.indicators)) {
      throw new Error('TradingView pane indicator inventory is incompatible.');
    }
    const indicators = pane.indicators.map((indicator) => normalizeIndicator(indicator));
    indicators.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    return {
      index,
      signature: derivePaneIndicatorSignature(indicators),
      indicators,
    };
  });
  return {
    success: true,
    schema_version: PANE_INDICATOR_SIGNATURE_SCHEMA_VERSION,
    pane_count: paneCount,
    canonical_pane_index: 0,
    panes,
  };
}

export function derivePaneIndicatorSignature(indicators) {
  return createHash('sha256')
    .update(canonicalJson({
      schema_version: PANE_INDICATOR_SIGNATURE_SCHEMA_VERSION,
      indicators,
    }), 'utf8')
    .digest('hex');
}

function normalizeIndicator(indicator) {
  if (!indicator || typeof indicator !== 'object' || Array.isArray(indicator)) {
    throw new Error('TradingView pane indicator inventory is incompatible.');
  }
  const id = String(indicator.indicator_id || '').trim();
  const name = String(indicator.indicator_name || '').trim();
  if (!id || !name || typeof indicator.is_price_study !== 'boolean') {
    throw new Error('TradingView pane indicator inventory is incompatible.');
  }
  return {
    indicator_id: id,
    indicator_name: name,
    is_price_study: indicator.is_price_study,
    settings: normalizeJsonValue(indicator.settings, 'indicator settings'),
  };
}

function normalizeJsonValue(value, label) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeJsonValue(entry, label));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !VOLATILE_INDICATOR_INPUT_KEYS.has(key))
        .sort()
        .map((key) => [key, normalizeJsonValue(value[key], `${label}.${key}`)]),
    );
  }
  throw new Error(`${label} is not JSON-compatible.`);
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * Set the chart layout grid.
 * @param {string} layout - Layout code: s, 2h, 2v, 2-1, 1-2, 3h, 3v, 4, 6, 8, etc.
 */
export async function setLayout({ layout }) {
  const code = layout.toLowerCase().replace(/\s+/g, '');

  // Map friendly names to codes
  const aliases = {
    'single': 's', '1': 's', '1x1': 's',
    '2x1': '2h', '1x2': '2v',
    '2x2': '4', 'grid': '4', 'quad': '4',
    '3x1': '3h', '1x3': '3v',
  };
  const resolved = aliases[code] || code;

  if (!LAYOUT_NAMES[resolved]) {
    const available = Object.entries(LAYOUT_NAMES).map(([k, v]) => `  ${k} — ${v}`).join('\n');
    throw new Error(`Unknown layout "${layout}". Available layouts:\n${available}`);
  }

  await evaluateAsync(`${CWC}.setLayout(${safeString(resolved)})`);
  await new Promise(r => setTimeout(r, 500));

  const state = await list();
  return {
    success: true,
    layout: resolved,
    layout_name: LAYOUT_NAMES[resolved],
    chart_count: state.chart_count,
    panes: state.panes,
  };
}

/**
 * Focus a specific pane by index.
 */
export async function focus({ index }) {
  const idx = Number(index);
  const result = await evaluate(`
    (function() {
      var cwc = ${CWC};
      var all = cwc.getAll();
      if (${idx} >= all.length) return { error: 'Pane index ' + ${idx} + ' out of range (have ' + all.length + ' panes)' };
      var chart = all[${idx}];
      // Click the main div to activate it
      if (chart._mainDiv) chart._mainDiv.click();
      return { focused: ${idx}, total: all.length };
    })()
  `);

  if (result?.error) throw new Error(result.error);
  return { success: true, focused_index: result.focused, total_panes: result.total };
}

/**
 * Set the symbol on a specific pane by index.
 * Works by focusing the pane, then using the active chart's setSymbol.
 */
export const PANE_CAPABILITY_LAYOUTS = Object.freeze({
  1: 's',
  2: '2h',
  4: '4',
  8: '8',
  16: '16',
});

/**
 * Probe one exact TradingView pane capability and restore the prior layout.
 * The probe returns supported=false for a clean subscription/layout mismatch,
 * while unstable state, focus failure, and restoration failure are explicit.
 */
export async function probeLayoutCapability({
  paneCount,
  timeoutMs = 5000,
  pollIntervalMs = 200,
  stablePolls = 2,
  validateFocus = true,
}, operations = {}) {
  const requestedPaneCount = Number(paneCount);
  const requestedLayout = PANE_CAPABILITY_LAYOUTS[requestedPaneCount];
  if (!requestedLayout) throw new Error(`Unsupported capability probe pane count: ${paneCount}`);
  const timeout = Number(timeoutMs);
  const interval = Number(pollIntervalMs);
  const requiredStablePolls = Number(stablePolls);
  if (!Number.isInteger(timeout) || timeout <= 0) throw new Error('timeoutMs must be a positive integer');
  if (!Number.isInteger(interval) || interval <= 0) throw new Error('pollIntervalMs must be a positive integer');
  if (!Number.isInteger(requiredStablePolls) || requiredStablePolls <= 0) throw new Error('stablePolls must be a positive integer');

  const read = operations.list || list;
  const mutateLayout = operations.setLayout || setLayout;
  const focusPane = operations.focus || focus;
  const sleep = operations.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = operations.now || (() => Date.now());

  const before = await read();
  const previousLayout = String(before.layout);
  let observed = before;
  let supported = false;
  let stable = false;
  let focusValidated = !validateFocus;
  let failureReason = null;
  let mutationError = null;
  let restorationAttempted = false;
  let restorationSucceeded = false;
  let restored = null;
  let stableCount = 0;
  let priorSignature = null;
  const observations = [];

  try {
    try {
      await mutateLayout({ layout: requestedLayout });
    } catch (error) {
      mutationError = error instanceof Error ? error.message : String(error);
      failureReason = 'layout_mutation_failed';
    }

    if (mutationError === null) {
      const deadline = now() + timeout;
      while (now() <= deadline) {
        observed = await read();
        const signature = JSON.stringify({
          layout: String(observed.layout),
          chart_count: Number(observed.chart_count),
          pane_indexes: observed.panes.map((pane) => pane.index),
        });
        observations.push({
          layout: String(observed.layout),
          chart_count: Number(observed.chart_count),
          active_index: observed.active_index,
          panes: observed.panes,
        });
        stableCount = signature === priorSignature ? stableCount + 1 : 1;
        priorSignature = signature;
        if (Number(observed.chart_count) === requestedPaneCount && observed.panes.length === requestedPaneCount && stableCount >= requiredStablePolls) {
          stable = true;
          supported = true;
          break;
        }
        await sleep(interval);
      }
      if (!stable) failureReason = 'requested_layout_not_observed';
    }

    if (supported && validateFocus) {
      for (let index = 0; index < requestedPaneCount; index += 1) {
        await focusPane({ index });
        const focused = await read();
        observations.push({
          layout: String(focused.layout),
          chart_count: Number(focused.chart_count),
          active_index: focused.active_index,
          panes: focused.panes,
        });
        if (focused.active_index !== index) {
          supported = false;
          failureReason = 'pane_focus_validation_failed';
          break;
        }
      }
      focusValidated = supported;
    }
  } catch (error) {
    supported = false;
    failureReason = failureReason || 'probe_failed';
    mutationError = mutationError || (error instanceof Error ? error.message : String(error));
  } finally {
    restorationAttempted = true;
    try {
      await mutateLayout({ layout: previousLayout });
      const deadline = now() + timeout;
      while (now() <= deadline) {
        restored = await read();
        if (String(restored.layout) === previousLayout && Number(restored.chart_count) === Number(before.chart_count)) {
          restorationSucceeded = true;
          break;
        }
        await sleep(interval);
      }
    } catch (error) {
      mutationError = mutationError || (error instanceof Error ? error.message : String(error));
    }
    if (!restorationSucceeded) {
      supported = false;
      failureReason = 'layout_restoration_failed';
    }
  }

  return {
    success: true,
    probe_version: 'pane-layout-capability-probe-v1',
    requested_layout: requestedLayout,
    requested_pane_count: requestedPaneCount,
    observed_layout: String(observed.layout),
    observed_pane_count: Number(observed.chart_count),
    supported,
    stable,
    focus_validation_requested: Boolean(validateFocus),
    focus_validated: focusValidated,
    restoration_attempted: restorationAttempted,
    restoration_succeeded: restorationSucceeded,
    failure_reason: failureReason,
    error_detail: mutationError,
    before,
    observed,
    restored,
    observations,
  };
}

export async function setSymbol({ index, symbol }) {
  const idx = Number(index);

  // Focus the target pane first
  await focus({ index: idx });
  await new Promise(r => setTimeout(r, 300));

  // Now set symbol on the now-active chart
  await evaluateAsync(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(symbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);

  return { success: true, index: idx, symbol };
}
