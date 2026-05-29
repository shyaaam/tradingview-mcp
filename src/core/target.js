/**
 * Read-only target readiness diagnostics for TradingView CDP tabs.
 */
import { evaluate as defaultEvaluate, listCdpTargets } from '../connection.js';

const DEFAULT_MAX_WAIT_MS = 10000;
const DEFAULT_POLL_INTERVAL_MS = 500;

function normalizeValue(value) {
  return String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();
}

function parsePositiveInteger(value, fallback, name) {
  const raw = value ?? fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got: ${raw}`);
  }
  return Math.floor(n);
}

function baseSample() {
  return {
    page: {
      href: '',
      title: '',
      ready_state: '',
      visibility_state: '',
    },
    chart: {
      symbol: '',
      resolution: '',
      chart_type: null,
      study_count: 0,
      studies: [],
    },
    ohlcv: {
      available: false,
      first_index: null,
      last_index: null,
      size: null,
      latest_bar_time: null,
    },
    ui: {
      loading_detected: false,
      modal_overlay_detected: false,
      modal_text_sample: '',
    },
  };
}

function makeValidation(sample, expectedSymbol, expectedTimeframe) {
  const reasons = [];
  const expected_symbol = expectedSymbol ?? '';
  const expected_timeframe = expectedTimeframe ?? '';

  const expected_symbol_match = expectedSymbol ? normalizeValue(sample.chart.symbol) === normalizeValue(expectedSymbol) : null;
  const expected_timeframe_match = expectedTimeframe ? normalizeValue(sample.chart.resolution) === normalizeValue(expectedTimeframe) : null;

  if (!sample.page.href) reasons.push('page_href_missing');
  if (!sample.page.ready_state || !['interactive', 'complete'].includes(String(sample.page.ready_state))) {
    reasons.push('page_not_ready');
  }
  if (!sample.chart.symbol) reasons.push('chart_symbol_missing');
  if (!sample.chart.resolution) reasons.push('chart_resolution_missing');
  if (!sample.ohlcv.available) reasons.push('ohlcv_unavailable');
  if (sample.ohlcv.last_index == null) reasons.push('ohlcv_last_index_missing');
  if (!(Number(sample.ohlcv.size) > 0)) reasons.push('ohlcv_empty');
  if (!sample.ohlcv.latest_bar_time) reasons.push('ohlcv_latest_bar_time_missing');
  if (sample.ui.loading_detected) reasons.push('loading_spinner_visible');
  if (sample.ui.modal_overlay_detected) reasons.push('modal_overlay_visible');
  if (expectedSymbol && expected_symbol_match !== true) reasons.push('expected_symbol_mismatch');
  if (expectedTimeframe && expected_timeframe_match !== true) reasons.push('expected_timeframe_mismatch');

  const ready = reasons.length === 0;

  return {
    expected_symbol,
    expected_symbol_match,
    expected_timeframe,
    expected_timeframe_match,
    reasons,
    ready,
  };
}

async function collectSample({ target_id, _deps } = {}) {
  const evaluate = _deps?.evaluate || defaultEvaluate;

  return evaluate(`
    (function() {
      var sample = ${JSON.stringify(baseSample())};

      try {
        sample.page.href = location.href || '';
        sample.page.title = document.title || '';
        sample.page.ready_state = document.readyState || '';
        sample.page.visibility_state = document.visibilityState || '';
      } catch (e) {}

      var chart = null;
      try {
        chart = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV && window.TradingViewApi._activeChartWidgetWV.value();
      } catch (e) {
        sample.chart.api_error = e.message;
      }

      if (chart) {
        try { sample.chart.symbol = chart.symbol() || ''; } catch (e) { sample.chart.symbol_error = e.message; }
        try { sample.chart.resolution = chart.resolution() || ''; } catch (e) { sample.chart.resolution_error = e.message; }
        try { sample.chart.chart_type = chart.chartType(); } catch (e) { sample.chart.chart_type_error = e.message; }

        try {
          var studies = chart.getAllStudies ? chart.getAllStudies() : [];
          sample.chart.studies = (studies || []).map(function(study) {
            return {
              id: study.id,
              name: study.name || study.title || 'unknown',
            };
          });
          sample.chart.study_count = sample.chart.studies.length;
        } catch (e) {
          sample.chart.studies_error = e.message;
        }

        try {
          var bars = chart._chartWidget && chart._chartWidget.model && chart._chartWidget.model().mainSeries().bars();
          if (bars) {
            sample.ohlcv.available = true;
            try { sample.ohlcv.first_index = bars.firstIndex(); } catch (e) { sample.ohlcv.first_index_error = e.message; }
            try { sample.ohlcv.last_index = bars.lastIndex(); } catch (e) { sample.ohlcv.last_index_error = e.message; }
            try { sample.ohlcv.size = bars.size(); } catch (e) { sample.ohlcv.size_error = e.message; }
            if (typeof sample.ohlcv.last_index === 'number' && sample.ohlcv.last_index >= 0 && typeof bars.valueAt === 'function') {
              try {
                var last = bars.valueAt(sample.ohlcv.last_index);
                if (last && last[0] != null) sample.ohlcv.latest_bar_time = last[0];
              } catch (e) {
                sample.ohlcv.latest_bar_time_error = e.message;
              }
            }
          }
        } catch (e) {
          sample.ohlcv.error = e.message;
        }
      }

      function isVisible(el) {
        if (!el) return false;
        var rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        var style = window.getComputedStyle(el);
        return style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }

      try {
        var spinnerSelectors = [
          '[data-name*="spinner" i]',
          '[class*="spinner" i]',
          '[class*="loading" i]',
          '[class*="loader" i]',
          '[aria-label*="loading" i]',
          '[aria-busy="true"]',
        ].join(', ');
        var spinners = Array.from(document.querySelectorAll(spinnerSelectors)).filter(isVisible);
        sample.ui.loading_detected = spinners.length > 0;
      } catch (e) {
        sample.ui.loading_detected_error = e.message;
      }

      try {
        var modalSelectors = [
          '[role="dialog"]',
          '[aria-modal="true"]',
          '[class*="modal" i]',
          '[class*="popup" i]',
          '[class*="overlay" i]',
        ].join(', ');
        var modals = Array.from(document.querySelectorAll(modalSelectors)).filter(isVisible);
        sample.ui.modal_overlay_detected = modals.length > 0;
        if (modals.length > 0) {
          var text = (modals[0].innerText || modals[0].textContent || '').replace(/\s+/g, ' ').trim();
          sample.ui.modal_text_sample = text.slice(0, 240);
        }
      } catch (e) {
        sample.ui.modal_overlay_detected_error = e.message;
      }

      return sample;
    })()
  `, { target_id });
}

export async function targetReadinessCheck({
  target_id,
  expected_symbol,
  expected_timeframe,
  max_wait_ms = DEFAULT_MAX_WAIT_MS,
  poll_interval_ms = DEFAULT_POLL_INTERVAL_MS,
  _deps,
} = {}) {
  const maxWait = parsePositiveInteger(max_wait_ms, DEFAULT_MAX_WAIT_MS, 'max_wait_ms');
  const pollInterval = parsePositiveInteger(poll_interval_ms, DEFAULT_POLL_INTERVAL_MS, 'poll_interval_ms');
  const startedAt = Date.now();
  const targetId = String(target_id || '').trim();

  if (targetId) {
    const targets = await (_deps?.listCdpTargets || listCdpTargets)();
    if (!Array.isArray(targets) || !targets.some(t => t && t.id === targetId)) {
      throw new Error(`CDP target not found: ${targetId}`);
    }
  }

  let attempts = 0;
  let lastSample = baseSample();
  let lastValidation = makeValidation(lastSample, expected_symbol, expected_timeframe);
  let lastError = null;

  while (Date.now() - startedAt <= maxWait) {
    attempts += 1;
    try {
      lastSample = await collectSample({ target_id: targetId, _deps });
      lastValidation = makeValidation(lastSample, expected_symbol, expected_timeframe);
      if (lastValidation.ready) {
        return {
          success: true,
          target_id: targetId || undefined,
          ready: true,
          attempts,
          elapsed_ms: Date.now() - startedAt,
          page: lastSample.page,
          chart: lastSample.chart,
          ohlcv: lastSample.ohlcv,
          ui: lastSample.ui,
          validation: lastValidation,
        };
      }
    } catch (err) {
      lastError = err?.message || String(err);
      if (/CDP target not found|No TradingView chart target found|Failed to activate target/i.test(lastError)) {
        throw err;
      }
      lastValidation.reasons.push(`read_error:${lastError}`);
      lastValidation.ready = false;
    }

    const elapsed = Date.now() - startedAt;
    const remaining = maxWait - elapsed;
    if (remaining <= 0) break;
    await new Promise(r => setTimeout(r, Math.min(pollInterval, remaining)));
  }

  if (lastError && /CDP target not found|No TradingView chart target found|Failed to activate target/i.test(lastError)) {
    throw new Error(lastError);
  }

  return {
    success: true,
    target_id: targetId || undefined,
    ready: false,
    attempts,
    elapsed_ms: Date.now() - startedAt,
    page: lastSample.page,
    chart: lastSample.chart,
    ohlcv: lastSample.ohlcv,
    ui: lastSample.ui,
    validation: lastValidation,
  };
}
