import { createHash } from 'node:crypto';

import { evaluateBound, getClient } from '../connection.js';
import { buildObserverContract } from '../release/identity.js';
import { captureCandle } from './observer-evidence.js';
import { requireObserverSession } from './observer-session.js';
import * as pane from './pane.js';
import * as tab from './tab.js';

export const OBSERVER_REVIEW_SCREENSHOT_VERSION = 'observer-review-screenshot-v1';
export const OBSERVER_REVIEW_SCREENSHOT_MAX_BYTES = 25 * 1024 * 1024;

const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DOMAIN_ID = /^[a-z0-9-]+:[0-9a-f]{64}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TIMEFRAME = /^(?:[1-9][0-9]*[mhdwM]?|[1-9][0-9]*[SDWM])$/;

export async function captureObserverReviewScreenshot(input = {}) {
  const request = normalizeRequest(input);
  const deps = input._deps || {};
  const session = (deps.requireObserverSession || requireObserverSession)();
  if (session.profileId !== request.profile_id || session.chartTargetId !== request.chart_target_id) {
    throw new Error('Prepared observer session does not match screenshot authority.');
  }

  const contract = (deps.buildObserverContract || buildObserverContract)();
  if (!contract.releaseReady
    || contract.releaseCommit !== request.mcp_release_commit
    || contract.manifestHash !== request.mcp_manifest_hash) {
    throw new Error('Pinned MCP release or manifest does not match screenshot authority.');
  }

  const listTabs = deps.listTabs || tab.list;
  const tabs = await listTabs();
  const requestedTab = tabs?.tabs?.[request.tab_index];
  if (!requestedTab || requestedTab.id !== session.chartTargetId) {
    throw new Error('Requested screenshot tab does not match prepared observer target.');
  }

  const listPanes = deps.listPanes || pane.list;
  const panes = await listPanes();
  const requestedPane = panes?.panes?.find((entry) => entry.index === request.pane_index);
  if (!requestedPane
    || panes.active_index !== request.pane_index
    || String(requestedPane.symbol) !== request.symbol
    || String(requestedPane.resolution) !== request.timeframe) {
    throw new Error('Requested screenshot pane is not the exact active promoted symbol/timeframe.');
  }

  const verifyCandle = deps.captureCandle || captureCandle;
  await verifyCandle({
    symbol: request.symbol,
    timeframe: request.timeframe,
    source_candle_time: request.source_candle_time,
    _deps: deps.candleDeps,
  });

  const evaluate = deps.evaluateBound || evaluateBound;
  const bounds = await evaluate(`
    (function() {
      var api = window.TradingViewApi;
      var active = api && api._activeChartWidgetWV && api._activeChartWidgetWV.value();
      var widget = active && active._chartWidget;
      var element = widget && widget._mainDiv;
      if (!element || typeof element.getBoundingClientRect !== 'function') return null;
      var rect = element.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()
  `);
  if (!bounds || !finiteBounds(bounds)) {
    throw new Error('Active promoted pane bounds are unavailable for screenshot capture.');
  }

  const getCdpClient = deps.getClient || getClient;
  const client = await getCdpClient();
  const result = await client.Page.captureScreenshot({
    format: 'png',
    clip: {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      scale: 1,
    },
    captureBeyondViewport: false,
    fromSurface: true,
  });
  const pngBase64 = requireCanonicalBase64(result?.data);
  const bytes = Buffer.from(pngBase64, 'base64');
  if (bytes.length < 8 || bytes.length > OBSERVER_REVIEW_SCREENSHOT_MAX_BYTES || !isPng(bytes)) {
    throw new Error('Captured screenshot is not a bounded PNG.');
  }
  const capturedAt = (deps.now || (() => new Date()))().toISOString();
  if (!ISO_DATE_TIME.test(capturedAt)) throw new Error('Screenshot capture timestamp is not canonical UTC.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  return {
    success: true,
    capture_version: OBSERVER_REVIEW_SCREENSHOT_VERSION,
    profile_id: request.profile_id,
    runtime_target_id: request.runtime_target_id,
    chart_target_id: request.chart_target_id,
    symbol: request.symbol,
    timeframe: request.timeframe,
    source_candle_time: request.source_candle_time,
    pane_capability_snapshot_id: request.pane_capability_snapshot_id,
    sticky_placement_epoch_id: request.sticky_placement_epoch_id,
    active_layout_transition_id: request.active_layout_transition_id,
    active_layout_transition_hash: request.active_layout_transition_hash,
    tab_index: request.tab_index,
    pane_index: request.pane_index,
    mcp_release_commit: request.mcp_release_commit,
    mcp_manifest_hash: request.mcp_manifest_hash,
    captured_at: capturedAt,
    content_type: 'image/png',
    byte_length: bytes.length,
    sha256,
    png_base64: pngBase64,
  };
}

function normalizeRequest(input) {
  if (input.format !== 'png') throw new Error('Review screenshot format must be png.');
  return {
    profile_id: requireSafeString(input.profile_id, 'profile_id', 160),
    runtime_target_id: requirePattern(input.runtime_target_id, 'runtime_target_id', DOMAIN_ID),
    chart_target_id: requireSafeString(input.chart_target_id, 'chart_target_id', 200),
    symbol: requireSafeString(input.symbol, 'symbol', 160),
    timeframe: requirePattern(input.timeframe, 'timeframe', TIMEFRAME),
    source_candle_time: requirePattern(input.source_candle_time, 'source_candle_time', ISO_DATE_TIME),
    pane_capability_snapshot_id: requirePattern(input.pane_capability_snapshot_id, 'pane_capability_snapshot_id', DOMAIN_ID),
    sticky_placement_epoch_id: requirePattern(input.sticky_placement_epoch_id, 'sticky_placement_epoch_id', DOMAIN_ID),
    active_layout_transition_id: requirePattern(input.active_layout_transition_id, 'active_layout_transition_id', DOMAIN_ID),
    active_layout_transition_hash: requirePattern(input.active_layout_transition_hash, 'active_layout_transition_hash', HASH),
    tab_index: requireIndex(input.tab_index, 'tab_index'),
    pane_index: requireIndex(input.pane_index, 'pane_index'),
    mcp_release_commit: requirePattern(input.mcp_release_commit, 'mcp_release_commit', COMMIT),
    mcp_manifest_hash: requirePattern(input.mcp_manifest_hash, 'mcp_manifest_hash', HASH),
  };
}

function requireSafeString(value, name, maxLength) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requirePattern(value, name, pattern) {
  const normalized = requireSafeString(value, name, 200);
  if (!pattern.test(normalized)) throw new Error(`${name} is invalid.`);
  return normalized;
}

function requireIndex(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid.`);
  return value;
}

function finiteBounds(value) {
  return ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key]))
    && value.width > 0
    && value.height > 0
    && value.width <= 16_384
    && value.height <= 16_384;
}

function requireCanonicalBase64(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > Math.ceil(OBSERVER_REVIEW_SCREENSHOT_MAX_BYTES / 3) * 4
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('Captured screenshot base64 is invalid.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('Captured screenshot base64 is not canonical.');
  return value;
}

function isPng(bytes) {
  return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
}
