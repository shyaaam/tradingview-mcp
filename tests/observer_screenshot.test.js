import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { captureObserverReviewScreenshot } from '../src/core/observer-screenshot.js';

const ids = {
  runtime: `runtime-target-v1:${'1'.repeat(64)}`,
  pane: `pane-capability-snapshot-v1:${'2'.repeat(64)}`,
  sticky: `sticky-symbol-placement-epoch-v1:${'3'.repeat(64)}`,
  transition: `active-pane-layout-transition-v1:${'4'.repeat(64)}`,
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const pngBase64 = png.toString('base64');

function input(overrides = {}) {
  return {
    profile_id: 'profile-1',
    runtime_target_id: ids.runtime,
    chart_target_id: 'cdp-target-1',
    symbol: 'NASDAQ:AAPL',
    timeframe: '1h',
    source_candle_time: '2026-07-26T18:00:00.000Z',
    pane_capability_snapshot_id: ids.pane,
    sticky_placement_epoch_id: ids.sticky,
    active_layout_transition_id: ids.transition,
    active_layout_transition_hash: '5'.repeat(64),
    tab_index: 0,
    pane_index: 1,
    mcp_release_commit: '6'.repeat(40),
    mcp_manifest_hash: '7'.repeat(64),
    format: 'png',
    _deps: {
      requireObserverSession: () => ({
        profileId: 'profile-1',
        chartTargetId: 'cdp-target-1',
        reviewAuthority: {
          profileId: 'profile-1',
          runtimeTargetId: ids.runtime,
          chartTargetId: 'cdp-target-1',
          symbol: 'NASDAQ:AAPL',
          timeframe: '1h',
          sourceCandleTime: '2026-07-26T18:00:00.000Z',
          paneCapabilitySnapshotId: ids.pane,
          stickyPlacementEpochId: ids.sticky,
          activeLayoutTransitionId: ids.transition,
          activeLayoutTransitionHash: '5'.repeat(64),
          tabIndex: 0,
          paneIndex: 1,
          mcpReleaseCommit: '6'.repeat(40),
          mcpManifestHash: '7'.repeat(64),
        },
      }),
      buildObserverContract: () => ({
        releaseReady: true,
        releaseCommit: '6'.repeat(40),
        manifestHash: '7'.repeat(64),
      }),
      listTabs: async () => ({ tabs: [{ index: 0, id: 'cdp-target-1' }] }),
      listPanes: async () => ({
        active_index: 1,
        panes: [{ index: 1, symbol: 'NASDAQ:AAPL', resolution: '1h' }],
      }),
      captureCandle: async () => ({ success: true }),
      evaluateBound: async () => ({ x: 1, y: 2, width: 100, height: 80, viewport_width: 1200, viewport_height: 800 }),
      getClient: async () => ({ Page: { captureScreenshot: async () => ({ data: pngBase64 }) } }),
      now: () => new Date('2026-07-26T18:10:00.000Z'),
    },
    ...overrides,
  };
}

test('captures exact immutable observer screenshot authority', async () => {
  const result = await captureObserverReviewScreenshot(input());
  assert.equal(result.capture_version, 'observer-review-screenshot-v1');
  assert.equal(result.profile_id, 'profile-1');
  assert.equal(result.runtime_target_id, ids.runtime);
  assert.equal(result.chart_target_id, 'cdp-target-1');
  assert.equal(result.byte_length, png.length);
  assert.equal(result.sha256, createHash('sha256').update(png).digest('hex'));
  assert.equal(result.png_base64, pngBase64);
});

test('fails closed on session, release, tab, pane, and source authority mismatch', async () => {
  await assert.rejects(
    captureObserverReviewScreenshot(input({ chart_target_id: 'cdp-target-2' })),
    /Prepared observer session/,
  );
  await assert.rejects(
    captureObserverReviewScreenshot(input({
      _deps: { ...input()._deps, buildObserverContract: () => ({ releaseReady: false }) },
    })),
    /Pinned MCP release/,
  );
  await assert.rejects(
    captureObserverReviewScreenshot(input({
      _deps: { ...input()._deps, listTabs: async () => ({ tabs: [] }) },
    })),
    /tab does not match/,
  );
  await assert.rejects(
    captureObserverReviewScreenshot(input({
      _deps: { ...input()._deps, listPanes: async () => ({ active_index: 0, panes: [] }) },
    })),
    /pane is not/,
  );
  await assert.rejects(
    captureObserverReviewScreenshot(input({
      _deps: { ...input()._deps, captureCandle: async () => { throw new Error('missing candle'); } },
    })),
    /missing candle/,
  );
});

test('fails closed on non-canonical screenshot bytes', async () => {
  await assert.rejects(
    captureObserverReviewScreenshot(input({
      _deps: {
        ...input()._deps,
        getClient: async () => ({ Page: { captureScreenshot: async () => ({ data: Buffer.from('not-png').toString('base64') }) } }),
      },
    })),
    /not a bounded PNG/,
  );
});

test('runtime and chart target authorities remain independent', async () => {
  const runtimeTargetId = `runtime-target-v1:${'9'.repeat(64)}`;
  const base = input();
  const result = await captureObserverReviewScreenshot(input({
    runtime_target_id: runtimeTargetId,
    _deps: {
      ...base._deps,
      requireObserverSession: () => ({
        ...base._deps.requireObserverSession(),
        reviewAuthority: { ...base._deps.requireObserverSession().reviewAuthority, runtimeTargetId },
      }),
    },
  }));
  assert.equal(result.runtime_target_id, runtimeTargetId);
  assert.equal(result.chart_target_id, 'cdp-target-1');
  await assert.rejects(
    captureObserverReviewScreenshot(input({ chart_target_id: 'cdp-target-2' })),
    /Prepared observer session/,
  );
});

test('prepared review authority is required for screenshot capture', async () => {
  const deps = input()._deps;
  await assert.rejects(
    captureObserverReviewScreenshot(input({ _deps: { ...deps, requireObserverSession: () => ({ profileId: 'profile-1', chartTargetId: 'cdp-target-1' }) } })),
    /review authority is unavailable/,
  );
});

test('bounds reject negative, oversized, and viewport-crossing panes', async () => {
  for (const bounds of [
    { x: -1, y: 2, width: 100, height: 80, viewport_width: 1200, viewport_height: 800 },
    { x: 1, y: 2, width: 20_000, height: 80, viewport_width: 1200, viewport_height: 800 },
    { x: 1_101, y: 2, width: 100, height: 80, viewport_width: 1200, viewport_height: 800 },
  ]) {
    await assert.rejects(
      captureObserverReviewScreenshot(input({ _deps: { ...input()._deps, evaluateBound: async () => bounds } })),
      /bounds are unavailable/,
    );
  }
});

test('PNG validation rejects CRC corruption and non-image compressed data', async () => {
  const corrupted = Buffer.from(png);
  corrupted[corrupted.length - 1] ^= 1;
  await assert.rejects(
    captureObserverReviewScreenshot(input({
      _deps: {
        ...input()._deps,
        getClient: async () => ({ Page: { captureScreenshot: async () => ({ data: corrupted.toString('base64') }) } }),
      },
    })),
    /CRC/,
  );
  const invalidImageData = Buffer.from(png);
  const idatOffset = 33;
  invalidImageData[idatOffset + 8] ^= 1;
  await assert.rejects(
    captureObserverReviewScreenshot(input({
      _deps: {
        ...input()._deps,
        getClient: async () => ({ Page: { captureScreenshot: async () => ({ data: invalidImageData.toString('base64') }) } }),
      },
    })),
    /CRC|cannot be decoded/,
  );
});
