import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { TextEncoder } from 'node:util';

import {
  ACCOUNT_LAYOUT_PROBE,
  ensureSavedChartAuthority,
  preflightSavedChartAuthority,
  savedChartLayoutMarker,
} from '../src/core/saved-chart-authority.js';

const INPUT = Object.freeze({
  profileName: 'tv-observer-1',
  expectedProfileId: 'ephemeral-manager-id',
  captureSlotId: 'v5-capture-slot-a',
  reconciliationKey: 'a'.repeat(64),
});
const ACCOUNT_HASH = 'b'.repeat(64);
const MARKER = savedChartLayoutMarker(INPUT.captureSlotId, INPUT.reconciliationKey);

async function runProbe(charts) {
  const window = {
    TradingViewApi: {
      _user: { id: 'current-account' },
      getSavedCharts(callback) { callback(charts); },
    },
    crypto: { subtle: { digest: async () => new Uint8Array(32).buffer } },
    location: { pathname: '/chart/current-route-uid/' },
  };
  return await vm.runInNewContext(ACCOUNT_LAYOUT_PROBE, {
    window,
    TextEncoder,
    setTimeout,
    clearTimeout,
  });
}

function inventory(layouts = []) {
  return {
    profile: { profileName: INPUT.profileName, profileId: INPUT.expectedProfileId },
    targets: [{ id: 'transient-target', url: 'https://www.tradingview.com/chart/' }],
    page: { close: async () => {} },
    layouts,
    accountSubjectSha256: ACCOUNT_HASH,
    authenticated: true,
  };
}

test('layout marker is deterministic, account-independent, and slot-specific', () => {
  assert.match(MARKER, /^V5OBS-A-[A-Za-z0-9_-]{32}$/u);
  assert.equal(savedChartLayoutMarker(INPUT.captureSlotId, INPUT.reconciliationKey), MARKER);
  assert.notEqual(savedChartLayoutMarker('v5-capture-slot-b', INPUT.reconciliationKey), MARKER);
  assert.notEqual(savedChartLayoutMarker(INPUT.captureSlotId, 'c'.repeat(64)), MARKER);
});

test('saved-layout probe fails closed instead of silently dropping malformed entries', async () => {
  const malformed = await runProbe([
    { id: 'good-layout-id', name: 'Good chart' },
    { id: '', name: 'Malformed chart' },
  ]);
  assert.equal(malformed.authenticated, true);
  assert.equal(malformed.layouts, null);

  const valid = await runProbe([{ id: 'good-layout-id', name: 'Good chart' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(valid.layouts)), [
    { layout_id: 'good-layout-id', name: 'Good chart', symbol: '', resolution: '' },
  ]);
});

test('read-only preflight reports current-account marker state and create availability', async () => {
  let menuProbeCount = 0;
  const result = await preflightSavedChartAuthority(INPUT, {
    readProfileInventory: async () => inventory([
      { layoutId: 'user-layout-id', name: 'User chart', symbol: 'BATS:META', resolution: '60' },
    ]),
    canCreateSavedLayout: async () => {
      menuProbeCount += 1;
      return { available: true, failureCode: null, inputCount: 1, inputMaxLength: -1 };
    },
  });

  assert.deepEqual(result, {
    success: true,
    preflight_version: 'saved-chart-authority-preflight-v1',
    profile_name: INPUT.profileName,
    capture_slot_id: INPUT.captureSlotId,
    reconciliation_key: INPUT.reconciliationKey,
    layout_marker: MARKER,
    authenticated: true,
    account_subject_sha256: ACCOUNT_HASH,
    action: 'not_found',
    match_count: 0,
    layout_count: 1,
    layout_inventory_sha256: createHash('sha256').update(JSON.stringify([
      { layoutId: 'user-layout-id', name: 'User chart', symbol: 'BATS:META', resolution: '60' },
    ])).digest('hex'),
    chart_target_count: 1,
    can_create: true,
    create_preflight_failure_code: null,
    create_marker_length: MARKER.length,
    create_input_count: 1,
    create_input_max_length: -1,
    failure_code: null,
  });
  assert.equal(menuProbeCount, 1);
});

test('read-only preflight diagnoses a marker length limit before any saved-chart create click', async () => {
  let closeCount = 0;
  let pressedClicks = 0;
  const page = {
    Runtime: {
      evaluate: async ({ expression }) => {
        if (expression.includes('save-load-menu') || expression.includes('Create new layout')) {
          return { result: { value: { x: 10, y: 10 } } };
        }
        if (expression.includes("querySelectorAll('[role=\"dialog\"]')")) {
          if (expression.includes("input[type=\"text\"]")) {
            return { result: { value: {
              inputCount: 1,
              inputMaxLength: 32,
              inputCoords: { x: 20, y: 20 },
              createButtonCount: 1,
              createCoords: { x: 30, y: 30 },
            } } };
          }
          return { result: { value: 1 } };
        }
        return { result: { value: null } };
      },
    },
    close: async () => { closeCount += 1; },
  };
  const result = await preflightSavedChartAuthority(INPUT, {
    readProfileInventory: async () => ({ ...inventory([]), page }),
    dispatchMouseEvent: async (event) => { if (event.type === 'mousePressed') pressedClicks += 1; },
    dispatchKeyEvent: async () => {},
    sleep: async () => {},
  });

  assert.equal(result.can_create, false);
  assert.equal(result.create_preflight_failure_code, 'CREATE_LAYOUT_MARKER_EXCEEDS_INPUT_LIMIT');
  assert.equal(result.create_marker_length, MARKER.length);
  assert.equal(result.create_input_count, 1);
  assert.equal(result.create_input_max_length, 32);
  assert.equal(pressedClicks, 2, 'preflight may open menu and dialog, but must not click Create');
  assert.equal(closeCount, 1);
});

test('preflight refuses stale profile UUID before reporting create capability', async () => {
  const result = await preflightSavedChartAuthority(INPUT, {
    readProfileInventory: async () => ({ ...inventory([]), profile: { ...inventory([]).profile, profileId: 'replacement-id' } }),
    canCreateSavedLayout: async () => assert.fail('must not inspect create UI after UUID mismatch'),
  });

  assert.equal(result.authenticated, false);
  assert.equal(result.can_create, false);
  assert.equal(result.failure_code, 'PROFILE_UUID_CHANGED_BEFORE_PREFLIGHT');
});

test('default profile inventory marks verified current-account tabs authenticated', async () => {
  const target = {
    id: 'ephemeral-chart-target',
    type: 'page',
    url: 'https://www.tradingview.com/chart/current-route-uid/',
    webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/ephemeral-chart-target',
  };
  const page = {
    Runtime: {
      enable: async () => {},
      evaluate: async () => ({ result: { value: {
        authenticated: true,
        account_subject_sha256: ACCOUNT_HASH,
        layouts: [{ layout_id: 'current-account-layout', name: 'Current chart' }],
        chart_uid: 'current-route-uid',
      } } }),
    },
    Page: { enable: async () => {} },
    close: async () => {},
  };
  const result = await preflightSavedChartAuthority({
    ...INPUT,
    expectedProfileId: undefined,
  }, {
    managerBaseUrl: 'http://manager.test/api',
    fetch: async (url) => ({
      ok: true,
      json: async () => String(url).endsWith('/profiles')
        ? [{ id: INPUT.expectedProfileId, name: INPUT.profileName, status: 'running' }]
        : [target],
    }),
    connectTarget: async () => page,
    canCreateSavedLayout: async () => ({
      available: false,
      failureCode: 'CREATE_LAYOUT_MENU_NOT_AVAILABLE',
      inputCount: null,
      inputMaxLength: null,
    }),
  });

  assert.equal(result.authenticated, true);
  assert.equal(result.account_subject_sha256, ACCOUNT_HASH);
  assert.equal(result.layout_count, 1);
  assert.equal(result.chart_target_count, 1);
  assert.equal(result.failure_code, null);
});

test('cold profile preflight opens one exact-profile chart tab, reads current account, and closes it', async () => {
  const cdpUrl = 'http://127.0.0.1:9222/profiles/ephemeral-manager-id/cdp';
  let targets = [];
  let createCount = 0;
  let navigateCount = 0;
  let closeCount = 0;
  const page = {
    Runtime: {
      enable: async () => {},
      evaluate: async ({ expression }) => ({ result: { value: expression.includes('location.href')
        ? { url: 'about:blank' }
        : {
          authenticated: true,
          account_subject_sha256: ACCOUNT_HASH,
          layouts: [{ layout_id: 'new-account-layout', name: 'Current account chart' }],
          chart_uid: null,
        } } }),
    },
    Page: {
      enable: async () => {},
      navigate: async ({ url }) => {
        navigateCount += 1;
        targets = targets.map((target) => ({ ...target, url }));
        return {};
      },
    },
    close: async () => { closeCount += 1; },
  };
  const browser = {
    Target: {
      createTarget: async ({ url }) => {
        assert.equal(url, 'about:blank');
        createCount += 1;
        const id = 'temporary-current-profile-target';
        targets = [{
          id,
          type: 'page',
          url,
          webSocketDebuggerUrl: `${cdpUrl}/devtools/page/${id}`,
        }];
        return { targetId: id };
      },
      closeTarget: async ({ targetId }) => {
        targets = targets.filter((target) => target.id !== targetId);
        return { success: true };
      },
    },
    close: async () => {},
  };
  const result = await preflightSavedChartAuthority({ ...INPUT, expectedProfileId: undefined }, {
    managerBaseUrl: 'http://manager.test/api',
    fetch: async (value) => {
      const url = String(value);
      const body = url.endsWith('/profiles')
        ? [{ id: INPUT.expectedProfileId, name: INPUT.profileName, status: 'running', cdp_url: cdpUrl }]
        : url.endsWith('/json/version')
          ? { webSocketDebuggerUrl: `ws://127.0.0.1:9222/profiles/${INPUT.expectedProfileId}/cdp` }
          : targets;
      return { ok: true, json: async () => body };
    },
    connectBrowser: async () => browser,
    connectTarget: async () => page,
    canCreateSavedLayout: async () => ({ available: true, failureCode: null, inputCount: 1, inputMaxLength: -1 }),
  });

  assert.equal(result.authenticated, true);
  assert.equal(result.chart_target_count, 1);
  assert.equal(result.can_create, true);
  assert.equal(createCount, 1);
  assert.equal(navigateCount, 1);
  assert.equal(closeCount, 1);
  assert.deepEqual(targets, []);
});

test('cold profile refuses an unresolved blank tab instead of opening a duplicate target', async () => {
  const cdpUrl = 'http://127.0.0.1:9222/profiles/ephemeral-manager-id/cdp';
  let createCount = 0;
  const result = await preflightSavedChartAuthority({ ...INPUT, expectedProfileId: undefined }, {
    managerBaseUrl: 'http://manager.test/api',
    fetch: async (value) => {
      const url = String(value);
      const body = url.endsWith('/profiles')
        ? [{ id: INPUT.expectedProfileId, name: INPUT.profileName, status: 'running', cdp_url: cdpUrl }]
        : [{ id: 'existing-blank', type: 'page', url: 'about:blank' }];
      return { ok: true, json: async () => body };
    },
    connectBrowser: async () => {
      createCount += 1;
      return assert.fail('must not create while prior blank target is unresolved');
    },
  });

  assert.equal(result.authenticated, false);
  assert.equal(result.can_create, false);
  assert.equal(result.failure_code, 'AMBIGUOUS_BLANK_TARGET_PRESENT');
  assert.equal(createCount, 0);
});

test('existing exact marker is mapped to verified route UID without any new saved-layout mutation', async () => {
  let createCount = 0;
  const result = await ensureSavedChartAuthority({
    ...INPUT,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    createIfAbsent: true,
  }, {
    readProfileInventory: async () => inventory([{ layoutId: 'internal-layout-id', name: MARKER }]),
    resolveSavedLayoutRoute: async (_profileName, _profileId, layout) => {
      assert.equal(layout.layoutId, 'internal-layout-id');
      return { chartId: 'saved-route-uid', temporaryTargetClosed: true };
    },
    createSavedLayout: async () => { createCount += 1; throw new Error('must not create'); },
  });

  assert.equal(result.action, 'reused');
  assert.equal(result.saved_chart_id, 'saved-route-uid');
  assert.equal(result.canonical_chart_url, 'https://www.tradingview.com/chart/saved-route-uid/');
  assert.equal(result.mutations_performed, false);
  assert.equal(result.create_if_absent, true);
  assert.equal(createCount, 0);
});

test('one-shot create reports exact saved chart UID and preserves unknown outcome for discovery-only retry', async () => {
  let createCount = 0;
  const createDependencies = {
    readProfileInventory: async () => inventory([]),
    createSavedLayout: async (_profileName, _profileId, _slot, marker, _prior, _deps, onAttempt) => {
      assert.equal(marker, MARKER);
      createCount += 1;
      onAttempt();
      return { chartId: 'fresh-chart-uid', temporaryTargetClosed: true };
    },
  };
  const request = { ...INPUT, expectedAccountSubjectSha256: ACCOUNT_HASH, createIfAbsent: true };
  const created = await ensureSavedChartAuthority(request, createDependencies);
  assert.equal(created.action, 'created');
  assert.equal(created.saved_chart_id, 'fresh-chart-uid');
  assert.equal(created.mutations_performed, true);
  assert.equal(created.create_if_absent, true);
  assert.equal(createCount, 1);

  const ambiguous = await ensureSavedChartAuthority(request, {
    readProfileInventory: async () => inventory([]),
    createSavedLayout: async (_profileName, _profileId, _slot, _marker, _prior, _deps, onAttempt) => {
      createCount += 1;
      onAttempt();
      throw new Error('SAVED_CHART_CREATE_OR_DISCOVERY_NOT_CONFIRMED');
    },
  });
  assert.equal(ambiguous.action, 'unknown');
  assert.equal(ambiguous.mutations_performed, true);
  assert.equal(ambiguous.create_if_absent, true);
  assert.equal(createCount, 2);
});

test('discovery-only result echoes false create authority and never creates a chart', async () => {
  let createCount = 0;
  const result = await ensureSavedChartAuthority({
    ...INPUT,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    createIfAbsent: false,
  }, {
    readProfileInventory: async () => inventory([]),
    createSavedLayout: async () => { createCount += 1; throw new Error('must not create'); },
  });

  assert.equal(result.action, 'not_found');
  assert.equal(result.create_if_absent, false);
  assert.equal(result.mutations_performed, false);
  assert.equal(createCount, 0);
});

test('account switch and duplicate marker fail closed without create retry', async () => {
  const switched = await ensureSavedChartAuthority({
    ...INPUT,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    createIfAbsent: true,
  }, { readProfileInventory: async () => ({ ...inventory([]), accountSubjectSha256: 'c'.repeat(64) }) });
  assert.equal(switched.action, 'unknown');
  assert.equal(switched.failure_code, 'ACCOUNT_IDENTITY_CHANGED');

  let creates = 0;
  const multiple = await ensureSavedChartAuthority({
    ...INPUT,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    createIfAbsent: true,
  }, {
    readProfileInventory: async () => inventory([
      { layoutId: 'one', name: MARKER },
      { layoutId: 'two', name: MARKER },
    ]),
    createSavedLayout: async () => { creates += 1; throw new Error('must not create'); },
  });
  assert.equal(multiple.action, 'multiple');
  assert.equal(multiple.mutations_performed, false);
  assert.equal(creates, 0);
});
