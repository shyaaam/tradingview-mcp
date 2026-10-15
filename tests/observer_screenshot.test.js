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
const chartTargetUrl = 'https://www.tradingview.com/chart/ChartExact/';

const events = [];
let fitted = true;

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
        chartTargetUrl,
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
      listTabs: async () => ({ tabs: [{ index: 0, id: 'cdp-target-1', url: chartTargetUrl }] }),
      listPanes: async () => ({
        active_index: 1,
        panes: [{ index: 1, symbol: 'NASDAQ:AAPL', resolution: '1h' }],
      }),
      captureCandle: async () => ({ success: true }),
      evaluateBound: async (source) => {
        events.push(/TVOBS_SCREENSHOT_CLEAN_CHART_V1/.test(source) ? 'reset'
          : /TVOBS_DATA_WINDOW_CURSOR_RESET_V2/.test(source) ? 'park-point'
            : /TVOBS_SCREENSHOT_TOOLBAR_RESTORE_V1/.test(source) ? 'restore'
              : /isAutoScale/.test(source) ? 'fit-check' : 'other');
        if (/TVOBS_SCREENSHOT_CLEAN_CHART_V1/.test(source)) return true;
        if (/TVOBS_DATA_WINDOW_CURSOR_RESET_V2/.test(source)) return { x: 82, y: 2 };
        if (/TVOBS_SCREENSHOT_TOOLBAR_RESTORE_V1/.test(source)) return true;
        if (/isAutoScale/.test(source)) return fitted;
        return { x: 1, y: 2, width: 100, height: 80, viewport_width: 1200, viewport_height: 800 };
      },
      dispatchMouseEvent: async (event) => { events.push(`mouse:${event.x},${event.y}`); },
      getBoundClient: async () => ({ Page: { captureScreenshot: async () => { events.push('capture'); return { data: pngBase64 }; } } }),
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
      _deps: { ...input()._deps, listTabs: async () => ({ tabs: [{ index: 0, id: 'cdp-target-1', url: 'https://www.tradingview.com/chart/OtherChart/' }] }) },
    })),
    /target identity/,
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
        getBoundClient: async () => ({ Page: { captureScreenshot: async () => ({ data: Buffer.from('not-png').toString('base64') }) } }),
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
        getBoundClient: async () => ({ Page: { captureScreenshot: async () => ({ data: corrupted.toString('base64') }) } }),
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
        getBoundClient: async () => ({ Page: { captureScreenshot: async () => ({ data: invalidImageData.toString('base64') }) } }),
      },
    })),
    /CRC|cannot be decoded/,
  );
});

test('navigation after attachment fails before CDP screenshot capture', async () => {
  const base = input();
  let currentUrl = chartTargetUrl;
  let screenshotCalls = 0;
  const session = base._deps.requireObserverSession();
  await assert.rejects(
    captureObserverReviewScreenshot(input({
      _deps: {
        ...base._deps,
        captureCandle: async () => {
          currentUrl = 'https://www.tradingview.com/chart/OtherChart/';
          return { success: true };
        },
        getBoundClient: async () => {
          if (currentUrl !== session.chartTargetUrl) {
            throw new Error('Bound observer chart target changed after attachment.');
          }
          return { Page: { captureScreenshot: async () => {
            screenshotCalls += 1;
            return { data: pngBase64 };
          } } };
        },
      },
    })),
    /changed after attachment/u,
  );
  assert.equal(screenshotCalls, 0);
});

test('resets the chart view, parks the cursor off interactive elements, then captures and restores the toolbar', async () => {
  events.length = 0;
  fitted = true;
  await captureObserverReviewScreenshot(input());
  const interesting = events.filter((name) => name !== 'other');
  assert.deepEqual(interesting, ['reset', 'mouse:51,42', 'park-point', 'mouse:82,2', 'fit-check', 'capture', 'restore']);
});

test('fails closed and still restores the toolbar when the chart does not return to autoscale', async () => {
  events.length = 0;
  fitted = false;
  await assert.rejects(captureObserverReviewScreenshot(input()), /fit-to-screen autoscale/);
  assert.equal(events.includes('capture'), false);
  assert.equal(events.at(-1), 'restore');
  fitted = true;
});

test('restores the toolbar when the capture itself fails', async () => {
  events.length = 0;
  fitted = true;
  await assert.rejects(captureObserverReviewScreenshot(input({
    _deps: { ...input()._deps, getBoundClient: async () => ({ Page: { captureScreenshot: async () => { throw new Error('boom'); } } }) },
  })), /boom/);
  assert.equal(events.at(-1), 'restore');
});
