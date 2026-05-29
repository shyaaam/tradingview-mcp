/**
 * Core screenshot/capture logic.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  evaluate as defaultEvaluate,
  getChartCollection as defaultGetChartCollection,
  getClient as defaultGetClient,
} from '../connection.js';
import { targetReadinessCheck as defaultTargetReadinessCheck } from './target.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_VERIFY_WAIT_MS = 2000;
const DEFAULT_VERIFY_POLL_MS = 500;
const MIN_SCREENSHOT_BYTES = 2048;

function parsePositiveInteger(value, fallback, name) {
  const raw = value ?? fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got: ${raw}`);
  }
  return Math.floor(n);
}

function normalizeString(value) {
  return String(value ?? '').trim();
}

function readFileSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return null;
  }
}

function clipFromBounds(bounds) {
  if (!bounds) return null;
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height, scale: 1 };
}

function collectSuspicionReasons({
  captureFailed,
  fileExists,
  sizeBytes,
  region,
  chartBoundsAvailable,
  modalOverlayDetected,
  loadingDetected,
  expectedSymbolMatch,
  expectedTimeframeMatch,
  requiresFile = true,
  requiresChartBounds = true,
}) {
  const reasons = [];
  if (captureFailed) reasons.push('capture_failed');
  if (requiresFile && !fileExists) reasons.push('screenshot_file_missing');
  if (requiresFile && typeof sizeBytes === 'number' && sizeBytes < MIN_SCREENSHOT_BYTES) reasons.push('screenshot_too_small');
  if (requiresChartBounds && region === 'chart' && !chartBoundsAvailable) reasons.push('chart_bounds_unavailable');
  if (modalOverlayDetected) reasons.push('modal_overlay_detected');
  if (loadingDetected) reasons.push('loading_detected');
  if (expectedSymbolMatch === false) reasons.push('expected_symbol_mismatch');
  if (expectedTimeframeMatch === false) reasons.push('expected_timeframe_mismatch');
  return reasons;
}

async function briefPaintDelay(ms) {
  await new Promise(r => setTimeout(r, Math.max(50, Math.min(ms, 200))));
}

async function getReadinessSnapshot({
  target_id,
  expected_symbol,
  expected_timeframe,
  verify_chart_state,
  deps,
}) {
  if (!target_id || verify_chart_state === false) {
    return null;
  }

  return deps.targetReadinessCheck({
    target_id,
    expected_symbol,
    expected_timeframe,
    max_wait_ms: DEFAULT_VERIFY_WAIT_MS,
    poll_interval_ms: DEFAULT_VERIFY_POLL_MS,
    _deps: {
      listCdpTargets: deps.listCdpTargets,
      evaluate: deps.evaluate,
    },
  });
}

async function captureViaCdp({
  filePath,
  region,
  target_id,
  deps,
}) {
  const client = await deps.getClient({ target_id });
  let chartBoundsAvailable = true;
  let clip = undefined;

  if (region === 'chart') {
    const bounds = await deps.evaluate(`
      (function() {
        var el = document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('[class*="chart-container"]')
          || document.querySelector('canvas');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `, { target_id });
    clip = clipFromBounds(bounds);
    chartBoundsAvailable = !!clip;
  } else if (region === 'strategy_tester') {
    const bounds = await deps.evaluate(`
      (function() {
        var el = document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `, { target_id });
    clip = clipFromBounds(bounds);
  }

  const params = { format: 'png' };
  if (clip) params.clip = clip;

  const { data } = await client.Page.captureScreenshot(params);
  writeFileSync(filePath, Buffer.from(data, 'base64'));

  return {
    chartBoundsAvailable,
    fileExists: existsSync(filePath),
    sizeBytes: readFileSize(filePath),
  };
}

async function triggerApiScreenshot({ target_id, deps }) {
  const collectionPath = await deps.getChartCollection({ target_id });
  await deps.evaluate(`${collectionPath}.takeScreenshot()`, { target_id });
}

function makeResult({
  success,
  reason,
  target_id,
  expected_symbol,
  expected_timeframe,
  observed_symbol,
  observed_timeframe,
  verified_target_symbol,
  verified_target_timeframe,
  capture_attempts,
  screenshot_suspicious,
  retry_reason,
  modal_overlay_detected,
  modal_text_sample,
  loading_detected,
  file_path,
  size_bytes,
  region,
  method,
  chart_bounds_available,
  readiness,
  note,
}) {
  return {
    success,
    reason,
    target_id: target_id || undefined,
    expected_symbol: expected_symbol || undefined,
    expected_timeframe: expected_timeframe || undefined,
    observed_symbol: observed_symbol || undefined,
    observed_timeframe: observed_timeframe || undefined,
    verified_target_symbol: verified_target_symbol || undefined,
    verified_target_timeframe: verified_target_timeframe || undefined,
    capture_attempts,
    screenshot_suspicious,
    retry_reason: retry_reason || undefined,
    modal_overlay_detected: !!modal_overlay_detected,
    modal_text_sample: modal_text_sample || '',
    loading_detected: !!loading_detected,
    file_path: file_path || undefined,
    size_bytes: typeof size_bytes === 'number' ? size_bytes : undefined,
    region,
    method,
    chart_bounds_available: chart_bounds_available ?? undefined,
    readiness: readiness || undefined,
    note: note || undefined,
  };
}

export async function captureScreenshot({
  region = 'full',
  filename,
  method = 'cdp',
  target_id,
  expected_symbol,
  expected_timeframe,
  max_attempts = DEFAULT_MAX_ATTEMPTS,
  retry_delay_ms = DEFAULT_RETRY_DELAY_MS,
  verify_chart_state = true,
  fail_on_modal = false,
  _deps = {},
} = {}) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const deps = {
    getClient: _deps.getClient || defaultGetClient,
    evaluate: _deps.evaluate || defaultEvaluate,
    getChartCollection: _deps.getChartCollection || defaultGetChartCollection,
    targetReadinessCheck: _deps.targetReadinessCheck || defaultTargetReadinessCheck,
    listCdpTargets: _deps.listCdpTargets,
    sleep: _deps.sleep || (ms => new Promise(r => setTimeout(r, ms))),
  };

  const attemptsLimit = parsePositiveInteger(max_attempts, DEFAULT_MAX_ATTEMPTS, 'max_attempts');
  const retryDelay = parsePositiveInteger(retry_delay_ms, DEFAULT_RETRY_DELAY_MS, 'retry_delay_ms');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = (filename || `tv_${region}_${ts}`).replace(/[\\/]/g, '_');
  const filePath = join(SCREENSHOT_DIR, `${fname}.png`);

  let lastReadiness = null;
  let lastRetryReason = null;
  let lastObservedSymbol;
  let lastObservedTimeframe;
  let lastVerifiedTargetSymbol;
  let lastVerifiedTargetTimeframe;
  let lastModalOverlayDetected = false;
  let lastModalTextSample = '';
  let lastLoadingDetected = false;
  let lastChartBoundsAvailable = undefined;
  let lastFileExists = false;
  let lastSizeBytes = null;
  let lastCaptureAttempts = 0;
  let lastScreenshotSuspicious = false;

  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    lastCaptureAttempts = attempt;
    lastRetryReason = null;
    lastReadiness = null;
    lastModalOverlayDetected = false;
    lastModalTextSample = '';
    lastLoadingDetected = false;
    lastChartBoundsAvailable = undefined;
    lastFileExists = false;
    lastSizeBytes = null;

    try {
      lastReadiness = await getReadinessSnapshot({
        target_id,
        expected_symbol,
        expected_timeframe,
        verify_chart_state,
        deps,
      });

      if (lastReadiness?.chart) {
        lastObservedSymbol = lastReadiness.chart.symbol || '';
        lastObservedTimeframe = lastReadiness.chart.resolution || '';
        lastVerifiedTargetSymbol = lastObservedSymbol;
        lastVerifiedTargetTimeframe = lastObservedTimeframe;
      }
      if (lastReadiness?.ui) {
        lastModalOverlayDetected = !!lastReadiness.ui.modal_overlay_detected;
        lastModalTextSample = lastReadiness.ui.modal_text_sample || '';
        lastLoadingDetected = !!lastReadiness.ui.loading_detected;
      }

      if (lastModalOverlayDetected && fail_on_modal) {
        return makeResult({
          success: false,
          reason: 'modal_overlay_detected',
          target_id,
          expected_symbol,
          expected_timeframe,
          observed_symbol: lastObservedSymbol,
          observed_timeframe: lastObservedTimeframe,
          verified_target_symbol: lastVerifiedTargetSymbol,
          verified_target_timeframe: lastVerifiedTargetTimeframe,
          capture_attempts: attempt,
          screenshot_suspicious: true,
          retry_reason: 'modal_overlay_detected',
          modal_overlay_detected: true,
          modal_text_sample: lastModalTextSample,
          loading_detected: lastLoadingDetected,
          file_path: null,
          size_bytes: null,
          region,
          method: method === 'api' ? 'api' : 'cdp',
          chart_bounds_available: false,
          readiness: lastReadiness,
        });
      }

      await briefPaintDelay(retryDelay);

      let captureFailed = false;
      if (method === 'api') {
        await triggerApiScreenshot({ target_id, deps });
      } else {
        const captureOutcome = await captureViaCdp({
          filePath,
          region,
          target_id,
          deps,
        });
        lastChartBoundsAvailable = captureOutcome.chartBoundsAvailable;
        lastFileExists = captureOutcome.fileExists;
        lastSizeBytes = captureOutcome.sizeBytes;
      }

      if (method === 'api') {
        lastFileExists = false;
        lastSizeBytes = null;
      }

      const validation = lastReadiness?.validation || {};

      if (method === 'api') {
        const apiSuspenseReasons = collectSuspicionReasons({
          captureFailed: false,
          fileExists: false,
          sizeBytes: null,
          region,
          chartBoundsAvailable: undefined,
          modalOverlayDetected: lastModalOverlayDetected,
          loadingDetected: lastLoadingDetected,
          expectedSymbolMatch: validation.expected_symbol_match,
          expectedTimeframeMatch: validation.expected_timeframe_match,
          requiresFile: false,
          requiresChartBounds: false,
        });

        return makeResult({
          success: true,
          reason: null,
          target_id,
          expected_symbol,
          expected_timeframe,
          observed_symbol: lastObservedSymbol,
          observed_timeframe: lastObservedTimeframe,
          verified_target_symbol: lastVerifiedTargetSymbol,
          verified_target_timeframe: lastVerifiedTargetTimeframe,
          capture_attempts: attempt,
          screenshot_suspicious: apiSuspenseReasons.length > 0,
          retry_reason: apiSuspenseReasons[0] || null,
          modal_overlay_detected: lastModalOverlayDetected,
          modal_text_sample: lastModalTextSample,
          loading_detected: lastLoadingDetected,
          file_path: null,
          size_bytes: null,
          region,
          method: 'api',
          chart_bounds_available: undefined,
          readiness: lastReadiness,
          note: 'takeScreenshot() triggered — TradingView handles save/show via its own UI',
        });
      }

      const suspenseReasons = collectSuspicionReasons({
        captureFailed,
        fileExists: lastFileExists,
        sizeBytes: lastSizeBytes,
        region,
        chartBoundsAvailable: lastChartBoundsAvailable,
        modalOverlayDetected: lastModalOverlayDetected,
        loadingDetected: lastLoadingDetected,
        expectedSymbolMatch: validation.expected_symbol_match,
        expectedTimeframeMatch: validation.expected_timeframe_match,
        requiresFile: true,
        requiresChartBounds: true,
      });

      lastScreenshotSuspicious = suspenseReasons.length > 0;
      if (suspenseReasons.length === 0) {
        if (attempt > 1 && existsSync(filePath)) {
          lastSizeBytes = readFileSize(filePath);
        }
        return makeResult({
          success: true,
          reason: null,
          target_id,
          expected_symbol,
          expected_timeframe,
          observed_symbol: lastObservedSymbol,
          observed_timeframe: lastObservedTimeframe,
          verified_target_symbol: lastVerifiedTargetSymbol,
          verified_target_timeframe: lastVerifiedTargetTimeframe,
          capture_attempts: attempt,
          screenshot_suspicious: false,
          retry_reason: null,
          modal_overlay_detected: lastModalOverlayDetected,
          modal_text_sample: lastModalTextSample,
          loading_detected: lastLoadingDetected,
          file_path: filePath,
          size_bytes: lastSizeBytes,
          region,
          method: 'cdp',
          chart_bounds_available: lastChartBoundsAvailable,
          readiness: lastReadiness,
        });
      }

      lastRetryReason = suspenseReasons[0] || 'capture_suspicious';
    } catch (err) {
      const message = err?.message || String(err);
      lastRetryReason = message;
      if (/CDP target not found|No TradingView chart target found|Failed to activate target/i.test(message)) {
        return makeResult({
          success: false,
          reason: message,
          target_id,
          expected_symbol,
          expected_timeframe,
          observed_symbol: lastObservedSymbol,
          observed_timeframe: lastObservedTimeframe,
          verified_target_symbol: lastVerifiedTargetSymbol,
          verified_target_timeframe: lastVerifiedTargetTimeframe,
          capture_attempts: attempt,
          screenshot_suspicious: true,
          retry_reason: message,
          modal_overlay_detected: lastModalOverlayDetected,
          modal_text_sample: lastModalTextSample,
          loading_detected: lastLoadingDetected,
          file_path: existsSync(filePath) ? filePath : null,
          size_bytes: readFileSize(filePath),
          region,
          method: method === 'api' ? 'api' : 'cdp',
          chart_bounds_available: lastChartBoundsAvailable,
          readiness: lastReadiness,
        });
      }
    }

    if (attempt < attemptsLimit) {
      await deps.sleep(retryDelay);
    }
  }

  return makeResult({
    success: false,
    reason: lastRetryReason || 'capture_suspicious',
    target_id,
    expected_symbol,
    expected_timeframe,
    observed_symbol: lastObservedSymbol,
    observed_timeframe: lastObservedTimeframe,
    verified_target_symbol: lastVerifiedTargetSymbol,
    verified_target_timeframe: lastVerifiedTargetTimeframe,
    capture_attempts: lastCaptureAttempts,
    screenshot_suspicious: lastScreenshotSuspicious || true,
    retry_reason: lastRetryReason || 'capture_suspicious',
    modal_overlay_detected: lastModalOverlayDetected,
    modal_text_sample: lastModalTextSample,
    loading_detected: lastLoadingDetected,
    file_path: existsSync(filePath) ? filePath : null,
    size_bytes: readFileSize(filePath),
    region,
    method: method === 'api' ? 'api' : 'cdp',
    chart_bounds_available: lastChartBoundsAvailable,
    readiness: lastReadiness,
  });
}
