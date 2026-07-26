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
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const pngBase64 = png.toString('base64');

function input(overrides = {}) {
  return {
    profile_id: 'profile-1',
    runtime_target_id: ids.runtime,
    symbol: 'NASDAQ:AAPL',
    timeframe: '1h',
    source_candle_time: '2026-07-26T17:00:00.000Z',
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
      requireObserverSession: () => ({ profileId: 'profile-1', chartTargetId: ids.runtime }),
      buildObserverContract: () => ({
        releaseReady: true,
        releaseCommit: '6'.repeat(40),
        manifestHash: '7'.repeat(64),
      }),
      listTabs: async () => ({ tabs: [{ index: 0, id: ids.runtime }] }),
      listPanes: async () => ({
        active_index: 1,
        panes: [{ index: 1, symbol: 'NASDAQ:AAPL', resolution: '1h' }],
      }),
      captureCandle: async () => ({ success: true }),
      evaluateBound: async () => ({ x: 1, y: 2, width: 100, height: 80 }),
      getClient: async () => ({ Page: { captureScreenshot: async () => ({ data: pngBase64 }) } }),
      now: () => new Date('2026-07-26T17:01:00.000Z'),
    },
    ...overrides,
  };
}

test('captures exact immutable observer screenshot authority', async () => {
  const result = await captureObserverReviewScreenshot(input());
  assert.equal(result.capture_version, 'observer-review-screenshot-v1');
  assert.equal(result.profile_id, 'profile-1');
  assert.equal(result.runtime_target_id, ids.runtime);
  assert.equal(result.byte_length, png.length);
  assert.equal(result.sha256, createHash('sha256').update(png).digest('hex'));
  assert.equal(result.png_base64, pngBase64);
});

test('fails closed on release, tab, pane, and source authority mismatch', async () => {
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
