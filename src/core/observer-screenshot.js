import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

import { evaluateBound, getClient } from '../connection.js';
import { buildObserverContract } from '../release/identity.js';
import { captureCandle } from './observer-evidence.js';
import { requireObserverSession } from './observer-session.js';
import * as pane from './pane.js';
import * as tab from './tab.js';

export const OBSERVER_REVIEW_SCREENSHOT_VERSION = 'observer-review-screenshot-v1';
export const OBSERVER_REVIEW_SCREENSHOT_MAX_BYTES = 25 * 1024 * 1024;
export const OBSERVER_REVIEW_SCREENSHOT_MAX_DECODED_BYTES = 256 * 1024 * 1024;

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
  if (!session.reviewAuthority || !reviewAuthorityMatches(session.reviewAuthority, request)) {
    throw new Error('Prepared observer review authority is unavailable or does not match screenshot authority.');
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
      if (!element || !element.isConnected || typeof element.getBoundingClientRect !== 'function') return null;
      var rect = element.getBoundingClientRect();
      var style = window.getComputedStyle(element);
      var viewport = window.visualViewport || { width: window.innerWidth, height: window.innerHeight };
      if (!rect || !style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
      if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewport_width: viewport.width, viewport_height: viewport.height };
    })()
  `);
  const clip = normalizeClip(bounds);
  if (!clip) {
    throw new Error('Active promoted pane bounds are unavailable for screenshot capture.');
  }

  const getCdpClient = deps.getClient || getClient;
  const client = await getCdpClient();
  const result = await client.Page.captureScreenshot({
    format: 'png',
    clip: {
      x: clip.x,
      y: clip.y,
      width: clip.width,
      height: clip.height,
      scale: 1,
    },
    captureBeyondViewport: false,
    fromSurface: true,
  });
  const pngBase64 = requireCanonicalBase64(result?.data);
  const bytes = Buffer.from(pngBase64, 'base64');
  if (bytes.length < 8 || bytes.length > OBSERVER_REVIEW_SCREENSHOT_MAX_BYTES) throw new Error('Captured screenshot is not a bounded PNG.');
  validatePng(bytes);
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
  const expected = new Set([
    'profile_id', 'runtime_target_id', 'chart_target_id', 'symbol', 'timeframe', 'source_candle_time',
    'pane_capability_snapshot_id', 'sticky_placement_epoch_id', 'active_layout_transition_id',
    'active_layout_transition_hash', 'tab_index', 'pane_index', 'mcp_release_commit', 'mcp_manifest_hash',
    'format', '_deps',
  ]);
  if (Object.keys(input).some((key) => !expected.has(key))) throw new Error('Review screenshot request contains ambiguous fields.');
  if (input.format !== 'png') throw new Error('Review screenshot format must be png.');
  return {
    profile_id: requireSafeString(input.profile_id, 'profile_id', 160),
    runtime_target_id: requirePattern(input.runtime_target_id, 'runtime_target_id', DOMAIN_ID),
    chart_target_id: requirePattern(input.chart_target_id, 'chart_target_id', /^[A-Za-z0-9._:-]+$/),
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
  const normalized = value.normalize('NFC');
  if (normalized !== value) throw new Error(`${name} is not canonical.`);
  if (value.includes('/') || value.includes('\\') || value.includes('..') || value.includes('%')) {
    throw new Error(`${name} is path-like.`);
  }
  return normalized;
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

function normalizeClip(value) {
  if (!value || !['x', 'y', 'width', 'height', 'viewport_width', 'viewport_height'].every((key) => Number.isFinite(value[key]))) return null;
  if (value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0
    || value.viewport_width <= 0 || value.viewport_height <= 0
    || value.x + value.width > value.viewport_width
    || value.y + value.height > value.viewport_height) return null;
  const x = Math.floor(value.x);
  const y = Math.floor(value.y);
  const right = Math.ceil(value.x + value.width);
  const bottom = Math.ceil(value.y + value.height);
  const width = right - x;
  const height = bottom - y;
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384 || right > Math.ceil(value.viewport_width) || bottom > Math.ceil(value.viewport_height)) return null;
  return { x, y, width, height };
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

function reviewAuthorityMatches(prepared, request) {
  return prepared.profileId === request.profile_id
    && prepared.runtimeTargetId === request.runtime_target_id
    && prepared.chartTargetId === request.chart_target_id
    && prepared.symbol === request.symbol
    && prepared.timeframe === request.timeframe
    && prepared.sourceCandleTime === request.source_candle_time
    && prepared.paneCapabilitySnapshotId === request.pane_capability_snapshot_id
    && prepared.stickyPlacementEpochId === request.sticky_placement_epoch_id
    && prepared.activeLayoutTransitionId === request.active_layout_transition_id
    && prepared.activeLayoutTransitionHash === request.active_layout_transition_hash
    && prepared.tabIndex === request.tab_index
    && prepared.paneIndex === request.pane_index
    && prepared.mcpReleaseCommit === request.mcp_release_commit
    && prepared.mcpManifestHash === request.mcp_manifest_hash;
}

function validatePng(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 45 || !signature.every((value, index) => bytes[index] === value)) throw new Error('Captured screenshot is not a bounded PNG.');
  let offset = 8;
  let chunks = 0;
  let sawIhdr = false;
  let sawPlte = false;
  let sawIdat = false;
  let sawIend = false;
  let colorType = -1;
  let expectedInflatedBytes = 0;
  let scanlineBytes = 0;
  const idat = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('Captured screenshot PNG is truncated.');
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new Error('Captured screenshot PNG chunk is truncated.');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] === type[2].toLowerCase()) throw new Error('Captured screenshot PNG chunk type is invalid.');
    const end = offset + 12 + length;
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (expectedCrc !== crc32(bytes, offset + 4, length + 4)) throw new Error('Captured screenshot PNG CRC is invalid.');
    if (chunks === 0) {
      if (type !== 'IHDR' || length !== 13) throw new Error('Captured screenshot PNG IHDR is invalid.');
      sawIhdr = true;
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      const bitDepth = bytes[offset + 16];
      colorType = bytes[offset + 17];
      if (!validBitDepth(colorType, bitDepth) || width < 1 || height < 1 || width > 16_384 || height > 16_384
        || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) throw new Error('Captured screenshot PNG IHDR is invalid.');
      const channels = colorType === 0 || colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
      scanlineBytes = Math.ceil(width * channels * bitDepth / 8) + 1;
      expectedInflatedBytes = scanlineBytes * height;
      if (expectedInflatedBytes > OBSERVER_REVIEW_SCREENSHOT_MAX_DECODED_BYTES) throw new Error('Captured screenshot PNG decoded size is unsafe.');
    }
    if (type === 'IHDR' && chunks !== 0) throw new Error('Captured screenshot PNG has duplicate IHDR.');
    if (type === 'PLTE') {
      if (sawPlte || sawIdat || length === 0 || length % 3 !== 0) throw new Error('Captured screenshot PNG palette is invalid.');
      sawPlte = true;
    }
    if (type === 'IDAT') {
      if (length === 0) throw new Error('Captured screenshot PNG IDAT is empty.');
      sawIdat = true;
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new Error('Captured screenshot APNG is unsupported.');
    if (type[0] === type[0].toUpperCase() && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) throw new Error('Captured screenshot PNG critical chunk is unsupported.');
    if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length) throw new Error('Captured screenshot PNG IEND is invalid.');
      sawIend = true;
    }
    offset = end;
    chunks += 1;
  }
  if (!sawIhdr || !sawIdat || !sawIend || (colorType === 3 && !sawPlte)) throw new Error('Captured screenshot PNG image data is missing.');
  try {
    const inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: OBSERVER_REVIEW_SCREENSHOT_MAX_DECODED_BYTES });
    if (inflated.length !== expectedInflatedBytes) throw new Error('decoded scanline length mismatch');
    for (let index = 0; index < inflated.length; index += scanlineBytes) if (inflated[index] > 4) throw new Error('invalid scanline filter');
  } catch (error) {
    throw new Error('Captured screenshot PNG image data cannot be decoded.', { cause: error });
  }
}

function validBitDepth(colorType, bitDepth) {
  if (![0, 2, 3, 4, 6].includes(colorType)) return false;
  if (colorType === 0 || colorType === 3) return [1, 2, 4, 8].includes(bitDepth);
  return [8, 16].includes(bitDepth);
}

function crc32(bytes, offset, length) {
  let crc = 0xffffffff;
  for (let index = offset; index < offset + length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
