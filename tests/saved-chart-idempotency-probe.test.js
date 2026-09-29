import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSavedChartIdempotencyProbe,
  ensureSavedChartAuthority,
  inspectSavedChartIdempotencyProbe,
  isExactSavedChartIdempotencyProbeTarget,
  isExplicitSavedChartDuplicateRejection,
  resolveSavedChartIdempotencyProbeRoute,
  SAVED_CHART_IDEMPOTENCY_PROBE_MARKER,
  waitForTargetClosed,
} from '../src/core/saved-chart-authority.js';
import {
  journalResponseFromError,
  journalResponseFromResult,
} from '../scripts/saved-chart-idempotency-probe.mjs';

const ACCOUNT_HASH = 'b'.repeat(64);
const PROFILE = 'tv-observer-1';
const MARKER = SAVED_CHART_IDEMPOTENCY_PROBE_MARKER;

function inventory(layouts = []) {
  let closed = 0;
  return {
    profile: { profileName: PROFILE, profileId: 'ephemeral-profile-id' },
    targets: [{ id: 'temporary-target', url: 'https://www.tradingview.com/chart/' }],
    page: { close: async () => { closed += 1; } },
    layouts,
    accountSubjectSha256: ACCOUNT_HASH,
    authenticated: true,
    close: async () => { closed += 1; },
    closeCount: () => closed,
  };
}

test('read-only acceptance inventory returns marker-prefix evidence without runtime browser identity', async () => {
  const state = inventory([
    { layoutId: 'saved-one', name: 'V5_IDEMPOTENCY_PROBE_OLD_UNKNOWN' },
    { layoutId: 'saved-two', name: 'ordinary layout' },
  ]);
  const result = await inspectSavedChartIdempotencyProbe(PROFILE, {
    readProfileInventory: async () => state,
  });

  assert.equal(result.layoutCount, 2);
  assert.equal(result.probeMarkerCount, 0);
  assert.deepEqual(result.probePrefixNames, ['V5_IDEMPOTENCY_PROBE_OLD_UNKNOWN']);
  assert.equal('profileId' in result, false);
  assert.equal(state.closeCount(), 1);
});

test('read-only acceptance inventory exposes only verified exact-marker target count', async () => {
  const state = inventory([{ layoutId: 'saved-one', name: MARKER }]);
  state.probeMarkerTargetCount = 1;
  const result = await inspectSavedChartIdempotencyProbe(PROFILE, {
    readProfileInventory: async () => state,
  });
  assert.equal(result.probeMarkerTargetCount, 1);
  assert.equal('targetIds' in result, false);
  assert.equal('profileId' in result, false);
  assert.equal(state.closeCount(), 1);
});

test('probe target ownership uses exact account and route/layout identity, not title', () => {
  const target = {
    targetId: 'marker-chart', title: 'Saved Chart - TradingView',
    urlRouteUid: 'probe-route', currentChartUid: 'probe-route',
    accountSubjectSha256: ACCOUNT_HASH, exactMarkerLayoutIds: ['probe-layout-id'],
  };
  const expected = { accountSubjectSha256: ACCOUNT_HASH, layoutId: 'probe-layout-id', chartUid: 'probe-route' };
  assert.equal(isExactSavedChartIdempotencyProbeTarget(target, expected), true);
  assert.equal(isExactSavedChartIdempotencyProbeTarget({ ...target, accountSubjectSha256: 'c'.repeat(64) }, expected), false);
  assert.equal(isExactSavedChartIdempotencyProbeTarget({ ...target, urlRouteUid: 'other-route' }, expected), false);
  assert.equal(isExactSavedChartIdempotencyProbeTarget({ ...target, currentChartUid: 'other-route' }, expected), false);
  assert.equal(isExactSavedChartIdempotencyProbeTarget({ ...target, exactMarkerLayoutIds: [] }, expected), false);
  assert.equal(isExactSavedChartIdempotencyProbeTarget({ ...target, exactMarkerLayoutIds: ['other-layout'] }, expected), false);
});

test('probe saved-layout route uses normal discovery and confirms temporary-target close', async () => {
  const state = inventory([{ layoutId: 'probe-layout-id', name: MARKER }]);
  const result = await resolveSavedChartIdempotencyProbeRoute(PROFILE, ACCOUNT_HASH, {
    readProfileInventory: async () => state,
    resolveSavedLayoutRoute: async (profileName, profileId, layout, accountHash) => {
      assert.equal(profileName, PROFILE);
      assert.equal(profileId, 'ephemeral-profile-id');
      assert.deepEqual(layout, { layoutId: 'probe-layout-id', name: MARKER });
      assert.equal(accountHash, ACCOUNT_HASH);
      return { chartId: 'probe-route-uid', temporaryTargetClosed: true };
    },
  });
  assert.equal(result.layoutId, 'probe-layout-id');
  assert.equal(result.chartUid, 'probe-route-uid');
  assert.equal(result.canonicalChartUrl, 'https://www.tradingview.com/chart/probe-route-uid/');
  assert.equal(result.temporaryTargetClosed, true);
  assert.equal(state.closeCount(), 1);
});

test('read-only inventory exposes target identity when page title omits marker', async () => {
  const profileId = 'ephemeral-manager-id';
  const cdpUrl = `http://127.0.0.1:9222/api/profiles/${profileId}/cdp`;
  const browserWebSocketUrl = `ws://127.0.0.1:9222/api/profiles/${profileId}/cdp`;
  const targets = [
    {
      id: 'ordinary-chart', type: 'page', url: 'https://www.tradingview.com/chart/ordinary-route/',
      title: 'Ordinary chart - TradingView', webSocketDebuggerUrl: `${cdpUrl}/devtools/page/ordinary-chart`,
    },
    {
      id: 'marker-chart', type: 'page', url: 'https://www.tradingview.com/chart/probe-route/',
      title: 'Saved Chart - TradingView', webSocketDebuggerUrl: `${cdpUrl}/devtools/page/marker-chart`,
    },
  ];
  let pageCloseCount = 0;
  const result = await inspectSavedChartIdempotencyProbe(PROFILE, {
    managerBaseUrl: 'http://manager.test/api',
    fetch: async (value) => {
      const url = new URL(String(value));
      const body = url.pathname.endsWith('/profiles')
        ? [{ id: profileId, name: PROFILE, status: 'running', cdp_url: cdpUrl }]
        : url.pathname.endsWith('/json/version')
          ? { webSocketDebuggerUrl: browserWebSocketUrl }
          : targets;
      return { ok: true, json: async () => body };
    },
    connectTarget: async (webSocketUrl) => {
      const target = targets.find((entry) => webSocketUrl.endsWith(`/devtools/page/${entry.id}`));
      const currentChartUid = new URL(target.url).pathname.match(/^\/chart\/([^/]+)\/?$/u)?.[1] ?? null;
      return {
        Runtime: {
          enable: async () => {},
          evaluate: async () => ({ result: { value: {
            authenticated: true,
            account_subject_sha256: ACCOUNT_HASH,
            layouts: [{ layout_id: 'probe-layout-id', name: MARKER }],
            chart_uid: currentChartUid,
          } } }),
        },
        Page: { enable: async () => {} },
        close: async () => { pageCloseCount += 1; },
      };
    },
  });

  assert.equal(result.targetCount, 2);
  assert.equal(result.chartTargetCount, 2);
  assert.equal(result.probeMarkerCount, 1);
  assert.equal(result.probeMarkerTargetCount, 0);
  assert.equal('targetIds' in result, false);
  const markerTarget = result.pageTargets.find((target) => target.targetId === 'marker-chart');
  assert.equal(markerTarget.title, 'Saved Chart - TradingView');
  assert.equal(markerTarget.urlRouteUid, 'probe-route');
  assert.equal(markerTarget.currentChartUid, 'probe-route');
  assert.equal(markerTarget.accountSubjectSha256, ACCOUNT_HASH);
  assert.deepEqual(markerTarget.exactMarkerLayoutIds, ['probe-layout-id']);
  assert.equal(isExactSavedChartIdempotencyProbeTarget(markerTarget, {
    accountSubjectSha256: ACCOUNT_HASH,
    layoutId: 'probe-layout-id',
    chartUid: 'probe-route',
  }), true);
  assert.equal(pageCloseCount, 2);
});

test('normal authority discovery can be given only the exact fixed acceptance marker through private dependencies', async () => {
  const result = await ensureSavedChartAuthority({
    profileName: PROFILE,
    captureSlotId: 'v5-capture-slot-a',
    reconciliationKey: 'a'.repeat(64),
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    createIfAbsent: false,
  }, {
    idempotencyProbeMarker: MARKER,
    readProfileInventory: async () => inventory([{ layoutId: 'probe-layout-id', name: MARKER }]),
    resolveSavedLayoutRoute: async () => ({ chartId: 'probe-route-id', temporaryTargetClosed: true }),
  });

  assert.equal(result.layout_marker, MARKER);
  assert.equal(result.action, 'reused');
  assert.equal(result.saved_chart_id, 'probe-route-id');
});

test('acceptance create arms durable intent before click callback and allows only exact fixed-marker match count', async () => {
  const events = [];
  const result = await createSavedChartIdempotencyProbe({
    profileName: PROFILE,
    marker: MARKER,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    expectedProfilePageTargetCount: 1,
    expectedBlankPageTargetCount: 0,
    allowExistingMarker: false,
  }, {
    readProfileInventory: async () => inventory([]),
    beforeCreateAttempt: async ({ marker }) => { events.push(`armed:${marker}`); },
    afterCreateClick: async ({ marker }) => { events.push(`clicked:${marker}`); },
    createSavedLayout: async (_profileName, _profileId, slot, marker, _prior, dependencies, beforeClick) => {
      assert.equal(slot, 'v5-idempotency-probe-263');
      assert.equal(marker, MARKER);
      await beforeClick();
      events.push('provider-click');
      await dependencies.afterCreateClick({ marker });
      return { chartId: 'saved-route-id', temporaryTargetClosed: true };
    },
  });

  assert.equal(result.chartId, 'saved-route-id');
  assert.deepEqual(events, [
    `armed:${MARKER}`,
    'provider-click',
    `clicked:${MARKER}`,
  ]);
});

async function runSeparateMarkerTargetCreate({ markerTargetCount = 1, failMarkerTargetClose = false } = {}) {
  const profileId = 'ephemeral-manager-id';
  const cdpUrl = `http://127.0.0.1:9222/api/profiles/${profileId}/cdp`;
  const browserWebSocketUrl = `ws://127.0.0.1:9222/api/profiles/${profileId}/cdp`;
  const baselineTarget = {
    id: 'pre-existing-chart-target',
    type: 'page',
    url: 'https://www.tradingview.com/chart/existing-route/',
    title: 'Existing chart',
    webSocketDebuggerUrl: `${cdpUrl}/devtools/page/pre-existing-chart-target`,
  };
  const targets = [baselineTarget];
  const closedTargetIds = [];
  let temporaryTargetId = null;
  let temporaryPageUrl = 'about:blank';
  let markerTyped = false;
  let markerCreated = false;
  let result = null;
  let error = null;

  const targetPage = (kind, chartUid = 'source-route-uid') => ({
    Runtime: {
      enable: async () => {},
      evaluate: async ({ expression }) => {
        if (expression.includes('getSavedCharts')) {
          return { result: { value: {
            authenticated: true,
            account_subject_sha256: ACCOUNT_HASH,
            layouts: kind === 'marker' || markerCreated ? [{ layout_id: 'probe-layout-id', name: MARKER }] : [],
            chart_uid: chartUid,
          } } };
        }
        if (expression.includes('V5_CREATE_LAYOUT_FORM_PROBE')) {
          return { result: { value: {
            rootKind: 'dialog', inputCount: 1, inputMaxLength: -1,
            inputCoords: { x: 1, y: 1 }, createButtonCount: 1,
            createCoords: { x: 2, y: 2 }, inputValue: markerTyped ? MARKER : '',
            createButtonEnabled: true,
          } } };
        }
        if (expression.includes('location.href')) return { result: { value: { url: temporaryPageUrl } } };
        return { result: { value: { x: 10, y: 10 } } };
      },
    },
    Page: {
      enable: async () => {},
      navigate: async ({ url }) => {
        temporaryPageUrl = url;
        const target = targets.find((entry) => entry.id === temporaryTargetId);
        if (target) target.url = url;
        return {};
      },
    },
    Input: { insertText: async () => {}, dispatchMouseEvent: async () => {} },
    close: async () => {},
  });

  await createSavedChartIdempotencyProbe({
    profileName: PROFILE,
    marker: MARKER,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    expectedProfilePageTargetCount: 1,
    expectedBlankPageTargetCount: 0,
    allowExistingMarker: false,
  }, {
    managerBaseUrl: 'http://manager.test/api',
    readProfileInventory: async () => inventory([]),
    fetch: async (value) => {
      const url = String(value);
      const body = url.endsWith('/profiles')
        ? [{ id: profileId, name: PROFILE, status: 'running', cdp_url: cdpUrl }]
        : url.endsWith('/json/version')
          ? { webSocketDebuggerUrl: browserWebSocketUrl }
          : targets;
      return { ok: true, json: async () => body };
    },
    connectBrowser: async () => ({
      Target: {
        createTarget: async ({ url }) => {
          temporaryTargetId = 'provider-temporary-target';
          targets.push({ id: temporaryTargetId, type: 'page', url,
            webSocketDebuggerUrl: `${cdpUrl}/devtools/page/${temporaryTargetId}` });
          return { targetId: temporaryTargetId };
        },
        closeTarget: async ({ targetId }) => {
          closedTargetIds.push(targetId);
          if (failMarkerTargetClose && targetId.startsWith('marker-created-target-')) {
            return { success: false };
          }
          const index = targets.findIndex((entry) => entry.id === targetId);
          if (index >= 0) targets.splice(index, 1);
          return { success: index >= 0 };
        },
      },
      close: async () => {},
    }),
    connectTarget: async (webSocketDebuggerUrl) => {
      const target = targets.find((entry) => entry.webSocketDebuggerUrl === webSocketDebuggerUrl);
      const routeId = target?.url.match(/^https:\/\/www\.tradingview\.com\/chart\/([A-Za-z0-9_-]+)\/?$/u)?.[1];
      return target?.id.startsWith('marker-created-target-')
        ? targetPage('marker', routeId) : targetPage('temporary');
    },
    insertText: async (text) => { assert.equal(text, MARKER); markerTyped = true; },
    dispatchMouseEvent: async (event) => {
      if (event.type === 'mouseReleased' && event.x === 2 && markerTyped && !markerCreated) {
        markerCreated = true;
        for (let index = 1; index <= markerTargetCount; index += 1) {
          const id = `marker-created-target-${index}`;
          targets.push({
            id,
            type: 'page',
            url: `https://www.tradingview.com/chart/probe-route-uid-${index}/`,
            title: `${MARKER} - TradingView`,
            webSocketDebuggerUrl: `${cdpUrl}/devtools/page/${id}`,
          });
        }
      }
    },
    sleep: async () => {},
    beforeCreateAttempt: async () => {},
    afterCreateClick: async () => {},
  }).then((value) => { result = value; }, (cause) => { error = cause; });

  return { result, error, targets, closedTargetIds };
}

test('saved-chart create adopts and closes a separate exact-marker page opened by Create', async () => {
  const { result, error, targets, closedTargetIds } = await runSeparateMarkerTargetCreate();
  assert.equal(error, null);
  assert.equal(result.chartId, 'probe-route-uid-1');
  assert.equal(result.temporaryTargetClosed, true);
  assert.deepEqual(closedTargetIds.sort(), ['marker-created-target-1', 'provider-temporary-target']);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, 'pre-existing-chart-target');
  assert.equal(JSON.stringify(result).includes('marker-created-target'), false);
});

test('saved-chart create fails closed and closes neither when multiple new exact-marker pages appear', async () => {
  const { result, error, targets, closedTargetIds } = await runSeparateMarkerTargetCreate({ markerTargetCount: 2 });
  assert.equal(result, null);
  assert.equal(error.message, 'MULTIPLE_CREATED_MARKER_TARGETS');
  assert.equal(error.temporaryTargetClosed, false);
  assert.deepEqual(closedTargetIds, ['provider-temporary-target']);
  assert.equal(targets.length, 3);
  assert.equal(targets[0].id, 'pre-existing-chart-target');
});

test('saved-chart create reports separate marker-page close uncertainty', async () => {
  const { result, error, targets, closedTargetIds } = await runSeparateMarkerTargetCreate({ failMarkerTargetClose: true });
  assert.equal(error, null);
  assert.equal(result.chartId, 'probe-route-uid-1');
  assert.equal(result.temporaryTargetClosed, false);
  assert.deepEqual(closedTargetIds, ['marker-created-target-1', 'provider-temporary-target']);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].id, 'pre-existing-chart-target');
});

test('same-name probe create requires exactly one existing marker and never accepts multiple matches', async () => {
  const call = (layouts, allowExistingMarker) => createSavedChartIdempotencyProbe({
    profileName: PROFILE,
    marker: MARKER,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    expectedProfilePageTargetCount: 1,
    expectedBlankPageTargetCount: 0,
    allowExistingMarker,
  }, {
    readProfileInventory: async () => inventory(layouts),
    beforeCreateAttempt: async () => {},
    afterCreateClick: async () => {},
    createSavedLayout: async () => ({ chartId: 'unused', temporaryTargetClosed: true }),
  });

  await assert.rejects(call([{ layoutId: 'one', name: MARKER }], false), /PROBE_MARKER_STATE_NOT_EXPECTED/u);
  await assert.rejects(call([
    { layoutId: 'one', name: MARKER }, { layoutId: 'two', name: MARKER },
  ], true), /MULTIPLE_PROBE_LAYOUTS/u);

  let duplicateAllowance = false;
  await createSavedChartIdempotencyProbe({
    profileName: PROFILE,
    marker: MARKER,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    expectedProfilePageTargetCount: 1,
    expectedBlankPageTargetCount: 0,
    allowExistingMarker: true,
  }, {
    readProfileInventory: async () => inventory([{ layoutId: 'one', name: MARKER }]),
    beforeCreateAttempt: async () => {},
    afterCreateClick: async () => {},
    createSavedLayout: async (_profileName, _profileId, _slot, marker, _prior, dependencies, beforeClick) => {
      assert.equal(marker, MARKER);
      duplicateAllowance = dependencies.allowSameNameIdempotencyProbe;
      await beforeClick();
      return { chartId: 'same-route-id', temporaryTargetClosed: true };
    },
  });
  assert.equal(duplicateAllowance, true);
});

test('only a visible explicit duplicate-name rejection qualifies as duplicate rejection evidence', () => {
  assert.equal(isExplicitSavedChartDuplicateRejection(['A layout with this name already exists'], MARKER), true);
  assert.equal(isExplicitSavedChartDuplicateRejection(['Duplicate request was rejected'], MARKER), false);
  assert.equal(isExplicitSavedChartDuplicateRejection(['Could not create chart'], MARKER), false);
  assert.equal(isExplicitSavedChartDuplicateRejection(['A duplicate layout exists'], 'OTHER_MARKER'), false);
  assert.equal(isExplicitSavedChartDuplicateRejection('A layout with this name already exists', MARKER), false);
});

test('temporary target cleanup requires bounded exact-target disappearance readback', async () => {
  let calls = 0;
  const states = [
    [{ id: 'owned-temp-target' }, { id: 'slot-a-target' }],
    [{ id: 'slot-a-target' }],
  ];
  const closed = await waitForTargetClosed('http://profile.invalid', 'owned-temp-target', {
    fetch: async () => ({ ok: true, json: async () => states[calls++] }),
    sleep: async () => {},
  });
  assert.equal(closed, true);
  assert.equal(calls, 2);

  calls = 0;
  const stuck = await waitForTargetClosed('http://profile.invalid', 'owned-temp-target', {
    fetch: async () => ({ ok: true, json: async () => { calls += 1; return [{ id: 'owned-temp-target' }]; } }),
    sleep: async () => {},
  });
  assert.equal(stuck, false);
  assert.equal(calls, 30);
});

test('CLI journal mapping preserves target-close truth for provider success and error', () => {
  assert.deepEqual(journalResponseFromResult({
    chartId: 'saved-route-id', temporaryTargetClosed: true,
  }, 1), {
    action: 'created', savedChartId: 'saved-route-id', failureCode: null, temporaryTargetClosed: true,
  });
  assert.deepEqual(journalResponseFromError(Object.assign(new Error('PROVIDER_OPERATION_FAILED'), {
    temporaryTargetClosed: false,
  }), 2), {
    action: 'unknown', savedChartId: null, failureCode: 'PROVIDER_OPERATION_FAILED', temporaryTargetClosed: false,
  });
  assert.deepEqual(journalResponseFromResult({
    action: 'duplicate_rejected', failureCode: 'SAVED_CHART_NAME_DUPLICATE_REJECTED', temporaryTargetClosed: true,
  }, 2), {
    action: 'duplicate_rejected', savedChartId: null,
    failureCode: 'SAVED_CHART_NAME_DUPLICATE_REJECTED', temporaryTargetClosed: true,
  });
});
