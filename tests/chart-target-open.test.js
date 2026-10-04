import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { openBootstrapChartTarget, startExactProfileByName } from '../src/core/chart-target-open.js';
import { observerToolDefinitions } from '../src/release/observer-schema.js';

const BASE_URL = 'http://manager.test/api';
const PROFILE_ID = 'current-profile';
const PROFILE_NAME = 'tv-observer-1';
const CHART_URL = 'https://www.tradingview.com/chart/';

function response(value) {
  return { ok: true, status: 200, json: async () => value };
}

function makeHarness({
  targets = [{ id: 'home', type: 'page', url: 'https://www.tradingview.com/', webSocketDebuggerUrl: 'ws://home' }],
  profileId = PROFILE_ID,
  profileName = PROFILE_NAME,
  profileStatus = 'running',
  profileInventory,
  targetInventory,
  targetInventorySequence,
  finalUrl = CHART_URL,
  runtimeUrl = finalUrl,
  runtimeSnapshots = null,
  runtimeEnableHangs = false,
  runtimeEvaluateHangs = false,
  createResult = { targetId: 'target-new' },
  extraTargetsAfterCreate = [],
  delayedTargetReads = 0,
  extraTargetsAfterNavigation = [],
  navigateResult = { frameId: 'main', errorText: null },
  closeBehavior = 'close',
  browserWebSocketUrl = `ws://manager.test/api/profiles/${profileId}/cdp`,
} = {}) {
  const state = { targets: targets.map((target) => ({ ...target })) };
  const cdpUrl = `${BASE_URL}/profiles/${profileId}/cdp`;
  const profiles = profileInventory ?? [{
    id: profileId,
    name: profileName,
    status: profileStatus,
    cdp_url: `/api/profiles/${profileId}/cdp`,
  }];
  const calls = {
    createTarget: [], closeTargets: [], browserClosed: 0, navigate: [], browserWebSockets: [],
    targetWebSockets: [], bound: [], invalidated: 0, targetLists: 0, targetListsAfterCreate: 0,
    runtimeReads: 0,
  };
  const deps = {
    managerBaseUrl: BASE_URL,
    fetch: async (url) => {
      if (url === `${BASE_URL}/profiles`) {
        return response(profiles);
      }
      if (url === `${cdpUrl}/json/version`) return response({ webSocketDebuggerUrl: browserWebSocketUrl });
      if (url === `${cdpUrl}/json/list`) {
        if (targetInventorySequence) {
          const snapshot = targetInventorySequence[Math.min(calls.targetLists, targetInventorySequence.length - 1)];
          calls.targetLists += 1;
          return response(typeof snapshot === 'function' ? snapshot(state) : snapshot);
        }
        calls.targetLists += 1;
        if (calls.createTarget.length > 0) calls.targetListsAfterCreate += 1;
        const currentTargets = targetInventory ?? state.targets.map((target) => ({ ...target }));
        if (calls.targetListsAfterCreate > 0 && calls.targetListsAfterCreate <= delayedTargetReads) {
          return response(currentTargets.filter((target) => target.id !== createResult?.targetId));
        }
        return response(currentTargets);
      }
      throw new Error(`unexpected URL: ${url}`);
    },
    connectBrowser: async (url) => {
      calls.browserWebSockets.push(url);
      return {
        Target: {
          createTarget: async (input) => {
            calls.createTarget.push(input);
            if (createResult?.targetId) {
              state.targets.push({
                id: createResult.targetId,
                type: 'page',
                url: 'about:blank',
                webSocketDebuggerUrl: `ws://${createResult.targetId}`,
              });
              state.targets.push(...extraTargetsAfterCreate.map((target) => ({ ...target })));
            }
            return createResult;
          },
          closeTarget: async ({ targetId }) => {
            calls.closeTargets.push(targetId);
            if (closeBehavior !== 'persist') {
              state.targets = state.targets.filter((target) => target.id !== targetId);
            }
            if (closeBehavior === 'lost-receipt') throw new Error('CDP close receipt lost.');
            return { success: true };
          },
        },
        close: async () => { calls.browserClosed += 1; },
      };
    },
    connectTarget: async (webSocketUrl) => {
      calls.targetWebSockets.push(webSocketUrl);
      return {
        Page: {
          enable: async () => {},
          navigate: async ({ url: requested }) => {
            calls.navigate.push(requested);
            const target = state.targets.find((entry) => entry.webSocketDebuggerUrl === webSocketUrl);
            if (target) target.url = finalUrl;
            state.targets.push(...extraTargetsAfterNavigation.map((entry) => ({ ...entry })));
            return navigateResult;
          },
        },
        Runtime: {
          enable: async () => {
            if (runtimeEnableHangs) return new Promise(() => {});
          },
          evaluate: async () => {
            if (runtimeEvaluateHangs) return new Promise(() => {});
            const isLogin = runtimeUrl.includes('/accounts/signin/') || runtimeUrl.includes('/accounts/login/');
            const snapshot = runtimeSnapshots
              ? runtimeSnapshots[Math.min(calls.runtimeReads, runtimeSnapshots.length - 1)]
              : {
                current_url: runtimeUrl,
                document_ready_state: 'complete',
                tradingview_api_present: true,
                chart_widget_collection_present: true,
                active_widget_value_callable: true,
                active_widget_non_null: true,
                account_subject_state: isLogin ? 'missing' : 'ready',
                disconnected_session_state: 'absent',
                login_state: isLogin ? 'present' : 'absent',
              };
            calls.runtimeReads += 1;
            return { result: { value: snapshot } };
          },
        },
        close: async () => {},
      };
    },
    sleep: async () => {},
    getObserverSession: () => null,
    invalidateObserverSession: async () => { calls.invalidated += 1; },
    bindObserverSession: async (binding) => { calls.bound.push(binding); },
  };
  return { calls, deps, state };
}

test('opens one exact-profile blank target and navigates it to generic TradingView chart', async () => {
  const harness = makeHarness();
  const result = await openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps);
  const { ownership_proof: ownershipProof, ...resultWithoutProof } = result;

  assert.deepEqual(resultWithoutProof, {
    success: true,
    open_version: 'bootstrap-chart-target-v1',
    profile_name: PROFILE_NAME,
    profile_id: PROFILE_ID,
    target_id: 'target-new',
    target_url: CHART_URL,
    target_created: true,
    navigation_performed: true,
    page_state: 'generic_chart',
    mutations_performed: true,
  });
  assert.match(ownershipProof, /^[0-9a-f]{64}$/u);
  z.object(observerToolDefinitions.tv_observer_open_bootstrap_chart_target_v1.inputSchema)
    .parse({ profile_name: PROFILE_NAME });
  z.object(observerToolDefinitions.tv_observer_open_bootstrap_chart_target_v1.outputSchema).parse(result);
  assert.deepEqual(harness.calls.createTarget, [{ url: 'about:blank' }]);
  assert.deepEqual(harness.calls.navigate, [CHART_URL]);
  assert.deepEqual(harness.calls.browserWebSockets, [`ws://manager.test/api/profiles/${PROFILE_ID}/cdp`]);
  assert.deepEqual(harness.calls.targetWebSockets, ['ws://target-new', 'ws://target-new']);
  assert.equal(harness.calls.bound[0].profileId, PROFILE_ID);
  assert.equal(harness.calls.bound[0].chartTargetId, 'target-new');
  assert.equal(harness.calls.invalidated, 1);
  assert.deepEqual(harness.calls.closeTargets, []);
  assert.equal(harness.calls.browserClosed, 1);
});

test('bootstrap waits for exact generic chart runtime and authentication before binding', async () => {
  const ready = {
    current_url: CHART_URL,
    document_ready_state: 'complete',
    tradingview_api_present: true,
    chart_widget_collection_present: true,
    active_widget_value_callable: true,
    active_widget_non_null: true,
    account_subject_state: 'ready',
    disconnected_session_state: 'absent',
    login_state: 'absent',
  };
  const harness = makeHarness({
    runtimeSnapshots: [
      { ...ready, document_ready_state: 'loading', tradingview_api_present: false, account_subject_state: 'missing' },
      ready,
      ready,
      ready,
    ],
  });
  const result = await openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps);
  assert.equal(result.page_state, 'generic_chart');
  assert.equal(harness.calls.runtimeReads, 4);
  assert.equal(harness.calls.bound[0].chartTargetId, 'target-new');
});

test('bootstrap retires fresh target when generic route redirects to a saved chart', async () => {
  const harness = makeHarness({ runtimeUrl: 'https://www.tradingview.com/chart/y1mABBJk/' });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps),
    (error) => /redirected to an unsupported runtime route/u.test(error.message)
      && error.cleanupState === 'confirmed',
  );
  assert.deepEqual(harness.calls.closeTargets, ['target-new']);
  assert.deepEqual(harness.state.targets.map(({ id, url }) => ({ id, url })), [
    { id: 'home', url: 'https://www.tradingview.com/' },
  ]);
  assert.deepEqual(harness.calls.bound, []);
});

for (const hangingCall of ['enable', 'evaluate']) {
  test(`bootstrap bounds a hung Runtime.${hangingCall} call and retires its exact target`, async () => {
    const harness = makeHarness({ [`runtime${hangingCall[0].toUpperCase()}${hangingCall.slice(1)}Hangs`]: true });
    harness.deps.runtimeReadinessTimeoutMs = 25;
    const startedAt = Date.now();
    await assert.rejects(
      openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps),
      (error) => error.failureCode === 'BOOTSTRAP_RUNTIME_DEADLINE' && error.cleanupState === 'confirmed',
    );

    assert.ok(Date.now() - startedAt < 1_000, 'hung runtime call must not hold bootstrap indefinitely');
    assert.deepEqual(harness.calls.closeTargets, ['target-new']);
    assert.deepEqual(harness.state.targets.map(({ id, url }) => ({ id, url })), [
      { id: 'home', url: 'https://www.tradingview.com/' },
    ]);
    assert.deepEqual(harness.calls.bound, []);
  });
}

test('failed bootstrap retires its exact newly-created target and preserves prior pages', async () => {
  const harness = makeHarness({ navigateResult: { errorText: 'navigation rejected' } });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps),
    (error) => error.message === 'TradingView generic chart navigation failed.'
      && error.cleanupState === 'confirmed',
  );
  assert.deepEqual(harness.calls.closeTargets, ['target-new']);
  assert.deepEqual(harness.state.targets.map(({ id, url }) => ({ id, url })), [
    { id: 'home', url: 'https://www.tradingview.com/' },
  ]);
  assert.deepEqual(harness.calls.bound, []);
});

test('fresh-target creation waits for exact readback while preserving other-page inventory', async () => {
  const harness = makeHarness({ delayedTargetReads: 2 });
  const result = await openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps);
  assert.equal(result.target_created, true);
  assert.ok(harness.calls.targetListsAfterCreate >= 3);
  assert.deepEqual(harness.calls.closeTargets, []);
  assert.deepEqual(harness.state.targets.map(({ id }) => id).sort(), ['home', 'target-new']);
});

test('bootstrap cleanup fails closed when another page appears before retirement', async () => {
  const harness = makeHarness({
    navigateResult: { errorText: 'navigation rejected' },
    extraTargetsAfterNavigation: [{ id: 'competing', type: 'page', url: 'https://example.invalid/' }],
  });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps),
    (error) => error.failureCode === 'BOOTSTRAP_CLEANUP_FAILED'
      && error.cleanupState === 'unconfirmed',
  );
  assert.deepEqual(harness.calls.closeTargets, []);
  assert.deepEqual(harness.state.targets.map(({ id }) => id).sort(), ['competing', 'home', 'target-new']);
});

test('bootstrap does not close a target when ownership readback is ambiguous', async () => {
  const harness = makeHarness({
    extraTargetsAfterCreate: [{ id: 'competing', type: 'page', url: 'https://example.invalid/' }],
  });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps),
    (error) => /ownership is ambiguous/u.test(error.message)
      && error.cleanupState === 'not_attempted_ambiguous',
  );
  assert.deepEqual(harness.calls.closeTargets, []);
  assert.deepEqual(harness.calls.navigate, []);
  assert.deepEqual(harness.calls.bound, []);
});

test('adopts and navigates the sole exact about:blank target without creating another target', async () => {
  const harness = makeHarness({ targets: [{
    id: 'existing-blank', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://existing-blank',
  }] });
  const result = await openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps);

  assert.deepEqual(result, {
    success: true,
    open_version: 'bootstrap-chart-target-v1',
    profile_name: PROFILE_NAME,
    profile_id: PROFILE_ID,
    target_id: 'existing-blank',
    target_url: CHART_URL,
    target_created: false,
    ownership_proof: null,
    navigation_performed: true,
    page_state: 'generic_chart',
    mutations_performed: true,
  });
  assert.deepEqual(harness.calls.createTarget, []);
  assert.deepEqual(harness.calls.navigate, [CHART_URL]);
  assert.deepEqual(harness.calls.targetWebSockets, ['ws://existing-blank']);
  assert.equal(harness.calls.bound.length, 1);
  assert.equal(harness.calls.bound[0].chartTargetId, 'existing-blank');
});

test('adopted blank landing on TradingView login route is reported without claiming authentication', async () => {
  const harness = makeHarness({
    targets: [{ id: 'existing-blank', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://existing-blank' }],
    finalUrl: 'https://www.tradingview.com/accounts/signin/',
  });
  const result = await openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps);

  assert.equal(result.target_created, false);
  assert.equal(result.navigation_performed, true);
  assert.equal(result.page_state, 'login_route');
  assert.equal(result.mutations_performed, true);
  assert.deepEqual(harness.calls.createTarget, []);
  assert.equal(harness.calls.bound[0].chartTargetId, 'existing-blank');
});

test('stalled adopted-target landing inventory aborts at its per-request deadline without binding', async () => {
  const harness = makeHarness({ targets: [{
    id: 'existing-blank', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://existing-blank',
  }] });
  const cdpUrl = `${BASE_URL}/profiles/${PROFILE_ID}/cdp`;
  let jsonListCalls = 0;
  let requestSignal;
  const deps = {
    ...harness.deps,
    fetch: async (url, init = {}) => {
      if (url === `${cdpUrl}/json/list`) {
        jsonListCalls += 1;
        if (jsonListCalls === 3) {
          return await new Promise((_resolve, reject) => {
            requestSignal = init.signal;
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          });
        }
      }
      return harness.deps.fetch(url, init);
    },
  };

  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, deps),
    /bounded deadline/u,
  );
  assert.ok(requestSignal instanceof AbortSignal);
  assert.equal(requestSignal.aborted, true);
  assert.equal(harness.calls.navigate.length, 1);
  assert.equal(harness.calls.bound.length, 0);
});

test('refuses blank-target adoption when page inventory is ambiguous', async () => {
  const cases = [
    [
      { id: 'blank-a', type: 'page', url: 'about:blank' },
      { id: 'blank-b', type: 'page', url: 'about:blank' },
    ],
    [
      { id: 'blank', type: 'page', url: 'about:blank' },
      { id: 'other', type: 'page', url: 'https://example.invalid/' },
    ],
    [
      { id: 'blank', type: 'page', url: 'about:blank' },
      { id: 'generic', type: 'page', url: CHART_URL },
    ],
    [
      { id: 'blank', type: 'page', url: 'about:blank' },
      { id: 'login', type: 'page', url: 'https://www.tradingview.com/accounts/signin/' },
    ],
  ];
  for (const targets of cases) {
    const harness = makeHarness({ targets });
    await assert.rejects(
      openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps),
      /competing page targets/u,
    );
    assert.equal(harness.calls.createTarget.length, 0);
    assert.equal(harness.calls.navigate.length, 0);
    assert.equal(harness.calls.bound.length, 0);
  }
});

test('refuses adopted blank target with missing websocket, target-ID drift, or websocket drift', async () => {
  const missingWebSocket = makeHarness({ targets: [{
    id: 'existing-blank', type: 'page', url: 'about:blank',
  }] });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, missingWebSocket.deps),
    /no CDP websocket; no navigation was attempted/u,
  );
  assert.equal(missingWebSocket.calls.navigate.length, 0);
  assert.equal(missingWebSocket.calls.bound.length, 0);

  const drifted = makeHarness({
    targets: [{ id: 'existing-blank', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://existing-blank' }],
    targetInventorySequence: [
      [{ id: 'existing-blank', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://existing-blank' }],
      [{ id: 'replacement-blank', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://replacement-blank' }],
    ],
  });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, drifted.deps),
    /target-ID drift or ambiguity/u,
  );
  assert.equal(drifted.calls.navigate.length, 0);
  assert.equal(drifted.calls.bound.length, 0);

  const websocketDrift = makeHarness({
    targets: [{ id: 'existing-blank', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://existing-blank' }],
    targetInventorySequence: [
      [{ id: 'existing-blank', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://existing-blank' }],
      [{ id: 'existing-blank', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://replacement-websocket' }],
    ],
  });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, websocketDrift.deps),
    /websocket changed before navigation; refusing websocket drift/u,
  );
  assert.equal(websocketDrift.calls.targetWebSockets.length, 0);
  assert.equal(websocketDrift.calls.navigate.length, 0);
  assert.equal(websocketDrift.calls.bound.length, 0);
});

test('refuses adopted target with unexpected landing or a competing target after navigation', async () => {
  const unexpected = makeHarness({
    targets: [{ id: 'existing-blank', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://existing-blank' }],
    finalUrl: 'https://example.invalid/chart/',
  });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, unexpected.deps),
    /did not reach the exact generic chart or login route/u,
  );
  assert.equal(unexpected.calls.bound.length, 0);

  const competing = makeHarness({
    targets: [{ id: 'existing-blank', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://existing-blank' }],
    extraTargetsAfterNavigation: [{
      id: 'login-popup', type: 'page', url: 'https://www.tradingview.com/accounts/signin/',
    }],
  });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, competing.deps),
    /landing became ambiguous/u,
  );
  assert.equal(competing.calls.bound.length, 0);
});

test('reuses exactly one generic chart route after an ambiguous prior response', async () => {
  const harness = makeHarness({ targets: [{
    id: 'generic-existing', type: 'page', url: CHART_URL, webSocketDebuggerUrl: 'ws://generic-existing',
  }] });
  const result = await openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps);

  assert.equal(result.target_id, 'generic-existing');
  assert.equal(result.target_created, false);
  assert.equal(result.navigation_performed, false);
  assert.equal(result.mutations_performed, false);
  assert.equal(harness.calls.createTarget.length, 0);
  assert.equal(harness.calls.navigate.length, 0);
  assert.equal(harness.calls.bound[0].chartTargetId, 'generic-existing');
});

test('resolves the current UUID from exact profile name instead of reusing a stale UUID', async () => {
  const currentId = 'recreated-profile-uuid';
  const harness = makeHarness({ profileId: currentId });
  const result = await openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps);

  assert.equal(result.profile_name, PROFILE_NAME);
  assert.equal(result.profile_id, currentId);
  assert.equal(harness.calls.browserWebSockets[0], `ws://manager.test/api/profiles/${currentId}/cdp`);
  assert.equal(harness.calls.bound[0].profileId, currentId);
});

test('starts only exact stable-name profile and returns no runtime UUID', async () => {
  const calls = [];
  let status = 'stopped';
  const cdpUrl = `${BASE_URL}/profiles/${PROFILE_ID}/cdp`;
  const result = await startExactProfileByName(PROFILE_NAME, {
    managerBaseUrl: BASE_URL,
    sleep: async () => {},
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET' });
      if (url === `${BASE_URL}/profiles`) {
        return response([{ id: PROFILE_ID, name: PROFILE_NAME, status, cdp_url: `/api/profiles/${PROFILE_ID}/cdp` }]);
      }
      if (url === `${BASE_URL}/profiles/${PROFILE_ID}/launch`) {
        assert.equal(init.method, 'POST');
        status = 'running';
        return response({ status: 'running' });
      }
      if (url === `${cdpUrl}/json/version`) {
        return response({ webSocketDebuggerUrl: `ws://manager.test/api/profiles/${PROFILE_ID}/cdp` });
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  });

  assert.deepEqual(result, {
    success: true,
    profile_name: PROFILE_NAME,
    status: 'running',
    launch_performed: true,
    cdp_ready: true,
  });
  assert.equal(Object.hasOwn(result, 'profile_id'), false);
  assert.deepEqual(calls.map(({ method, url }) => [method, url]), [
    ['GET', `${BASE_URL}/profiles`],
    ['POST', `${BASE_URL}/profiles/${PROFILE_ID}/launch`],
    ['GET', `${BASE_URL}/profiles`],
    ['GET', `${cdpUrl}/json/version`],
  ]);
  z.object(observerToolDefinitions.tv_observer_start_profile_by_name_v1.inputSchema)
    .parse({ profile_name: PROFILE_NAME });
  z.object(observerToolDefinitions.tv_observer_start_profile_by_name_v1.outputSchema).parse(result);
});

test('lost profile-launch response is reconciled by exact-name readback without replaying launch', async () => {
  const calls = [];
  let status = 'stopped';
  const cdpUrl = `${BASE_URL}/profiles/${PROFILE_ID}/cdp`;
  const result = await startExactProfileByName(PROFILE_NAME, {
    managerBaseUrl: BASE_URL,
    sleep: async () => {},
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET' });
      if (url === `${BASE_URL}/profiles`) {
        return response([{ id: PROFILE_ID, name: PROFILE_NAME, status, cdp_url: `/api/profiles/${PROFILE_ID}/cdp` }]);
      }
      if (url === `${BASE_URL}/profiles/${PROFILE_ID}/launch`) {
        assert.equal(init.method, 'POST');
        status = 'running'; // remote effect happened, but Manager response was lost/failed
        return { ok: false, status: 502, statusText: 'Bad Gateway', json: async () => ({}) };
      }
      if (url === `${cdpUrl}/json/version`) {
        return response({ webSocketDebuggerUrl: `ws://manager.test/api/profiles/${PROFILE_ID}/cdp` });
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  });

  assert.deepEqual(result, {
    success: true,
    profile_name: PROFILE_NAME,
    status: 'running',
    launch_performed: false,
    cdp_ready: true,
  });
  assert.equal(calls.filter(({ method }) => method === 'POST').length, 1);
  assert.deepEqual(calls.map(({ method, url }) => [method, url]), [
    ['GET', `${BASE_URL}/profiles`],
    ['POST', `${BASE_URL}/profiles/${PROFILE_ID}/launch`],
    ['GET', `${BASE_URL}/profiles`],
    ['GET', `${cdpUrl}/json/version`],
  ]);
});

test('failed launch with stopped readback fails closed and never replays launch', async () => {
  let launches = 0;
  await assert.rejects(startExactProfileByName(PROFILE_NAME, {
    managerBaseUrl: BASE_URL,
    sleep: async () => {},
    fetch: async (url, init = {}) => {
      if (url === `${BASE_URL}/profiles`) {
        return response([{ id: PROFILE_ID, name: PROFILE_NAME, status: 'stopped',
          cdp_url: `/api/profiles/${PROFILE_ID}/cdp` }]);
      }
      if (url === `${BASE_URL}/profiles/${PROFILE_ID}/launch`) {
        launches += 1;
        return { ok: false, status: 503, statusText: 'Unavailable', json: async () => ({}) };
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  }), (error) => error.failureCode === 'PROFILE_LAUNCH_FAILED');
  assert.equal(launches, 1);
});

test('does not launch when exact profile name is ambiguous', async () => {
  let launches = 0;
  await assert.rejects(startExactProfileByName(PROFILE_NAME, {
    managerBaseUrl: BASE_URL,
    fetch: async (url, init = {}) => {
      if (url === `${BASE_URL}/profiles`) {
        return response([
          { id: 'first', name: PROFILE_NAME, status: 'stopped' },
          { id: 'second', name: PROFILE_NAME, status: 'stopped' },
        ]);
      }
      if (init.method === 'POST') launches += 1;
      throw new Error(`unexpected URL: ${url}`);
    },
  }), (error) => error.failureCode === 'PROFILE_NAME_MISSING_OR_AMBIGUOUS');
  assert.equal(launches, 0);
});

test('Manager transport failure has inventory-unavailable code, not profile-missing code', async () => {
  await assert.rejects(startExactProfileByName(PROFILE_NAME, {
    managerBaseUrl: BASE_URL,
    fetch: async () => { throw new Error('connection refused'); },
  }), (error) => error.failureCode === 'PROFILE_INVENTORY_UNAVAILABLE');
});

test('malformed Manager inventory has its own fail-closed code', async () => {
  await assert.rejects(startExactProfileByName(PROFILE_NAME, {
    managerBaseUrl: BASE_URL,
    fetch: async () => response([{ id: PROFILE_ID, name: PROFILE_NAME }]),
  }), (error) => error.failureCode === 'PROFILE_INVENTORY_INVALID');
});

test('invalid Manager inventory JSON is not mislabeled as missing profile', async () => {
  await assert.rejects(startExactProfileByName(PROFILE_NAME, {
    managerBaseUrl: BASE_URL,
    fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('invalid'); } }),
  }), (error) => error.failureCode === 'PROFILE_INVENTORY_INVALID');
});

test('stalled Manager inventory request aborts at its per-request deadline', async () => {
  let requestSignal;
  await assert.rejects(startExactProfileByName(PROFILE_NAME, {
    managerBaseUrl: BASE_URL,
    fetch: async (_url, init = {}) => await new Promise((_resolve, reject) => {
      requestSignal = init.signal;
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }),
  }), (error) => error.failureCode === 'PROFILE_INVENTORY_UNAVAILABLE');
  assert.ok(requestSignal instanceof AbortSignal);
  assert.equal(requestSignal.aborted, true);
});

test('stalled profile CDP request aborts instead of outliving readiness attempts', async () => {
  let requestSignal;
  const cdpUrl = `${BASE_URL}/profiles/${PROFILE_ID}/cdp`;
  await assert.rejects(startExactProfileByName(PROFILE_NAME, {
    managerBaseUrl: BASE_URL,
    fetch: async (url, init = {}) => {
      if (url === `${BASE_URL}/profiles`) {
        return response([{ id: PROFILE_ID, name: PROFILE_NAME, status: 'running',
          cdp_url: `/api/profiles/${PROFILE_ID}/cdp` }]);
      }
      if (url === `${cdpUrl}/json/version`) {
        return await new Promise((_resolve, reject) => {
          requestSignal = init.signal;
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  }), (error) => error.failureCode === 'PROFILE_CDP_NOT_READY');
  assert.ok(requestSignal instanceof AbortSignal);
  assert.equal(requestSignal.aborted, true);
});

test('waits on an existing profile start without issuing a second launch', async () => {
  let status = 'starting';
  let inventoryReads = 0;
  let launches = 0;
  const cdpUrl = `${BASE_URL}/profiles/${PROFILE_ID}/cdp`;
  const result = await startExactProfileByName(PROFILE_NAME, {
    managerBaseUrl: BASE_URL,
    sleep: async () => {},
    fetch: async (url, init = {}) => {
      if (url === `${BASE_URL}/profiles`) {
        inventoryReads += 1;
        if (inventoryReads === 2) status = 'running';
        return response([{ id: PROFILE_ID, name: PROFILE_NAME, status, cdp_url: `/api/profiles/${PROFILE_ID}/cdp` }]);
      }
      if (url === `${cdpUrl}/json/version`) {
        return response({ webSocketDebuggerUrl: `ws://manager.test/api/profiles/${PROFILE_ID}/cdp` });
      }
      if (init.method === 'POST') launches += 1;
      throw new Error(`unexpected URL: ${url}`);
    },
  });

  assert.equal(result.launch_performed, false);
  assert.equal(result.status, 'running');
  assert.equal(launches, 0);
});

test('unsupported profile state fails closed without launch', async () => {
  let launches = 0;
  await assert.rejects(startExactProfileByName(PROFILE_NAME, {
    managerBaseUrl: BASE_URL,
    fetch: async (url, init = {}) => {
      if (url === `${BASE_URL}/profiles`) {
        return response([{ id: PROFILE_ID, name: PROFILE_NAME, status: 'error' }]);
      }
      if (init.method === 'POST') launches += 1;
      throw new Error(`unexpected URL: ${url}`);
    },
  }), (error) => error.failureCode === 'PROFILE_STATE_UNSUPPORTED');
  assert.equal(launches, 0);
});

test('creates a new generic target without hydrating an existing saved-chart route', async () => {
  const existing = {
    id: 'stale-chart', type: 'page', url: 'https://www.tradingview.com/chart/old-account-id/',
    webSocketDebuggerUrl: 'ws://stale-chart',
  };
  const harness = makeHarness({ targets: [{
    ...existing,
  }] });
  const result = await openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps);

  assert.equal(result.success, true);
  assert.equal(result.target_id, 'target-new');
  assert.equal(result.target_url, CHART_URL);
  assert.equal(result.target_created, true);
  assert.equal(result.navigation_performed, true);
  assert.deepEqual(harness.calls.createTarget, [{ url: 'about:blank' }]);
  assert.deepEqual(harness.calls.navigate, [CHART_URL]);
  assert.deepEqual(harness.calls.targetWebSockets, ['ws://target-new', 'ws://target-new']);
  assert.deepEqual(harness.state.targets[0], existing);
  assert.equal(harness.calls.bound.length, 1);
  assert.equal(harness.calls.bound[0].chartTargetId, 'target-new');
});

test('refuses multiple generic chart targets and blank-target ambiguity', async () => {
  for (const targets of [
    [
      { id: 'generic-a', type: 'page', url: CHART_URL },
      { id: 'generic-b', type: 'page', url: CHART_URL },
    ],
    [{ id: 'orphan-blank', type: 'page', url: 'about:blank' }],
  ]) {
    const harness = makeHarness({ targets });
    await assert.rejects(openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps));
    assert.equal(harness.calls.createTarget.length, 0);
    assert.equal(harness.calls.navigate.length, 0);
  }
});

test('does not create another chart beside an existing login route or duplicate home tabs', async () => {
  for (const targets of [
    [{ id: 'login', type: 'page', url: 'https://www.tradingview.com/accounts/signin/' }],
    [
      { id: 'home-a', type: 'page', url: 'https://www.tradingview.com/' },
      { id: 'home-b', type: 'page', url: 'https://www.tradingview.com/' },
    ],
  ]) {
    const harness = makeHarness({ targets });
    await assert.rejects(openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps));
    assert.equal(harness.calls.createTarget.length, 0);
    assert.equal(harness.calls.navigate.length, 0);
  }
});

test('does not launch a stopped profile or navigate without an exact profile binding', async () => {
  const harness = makeHarness({ profileStatus: 'stopped' });
  await assert.rejects(openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps), /already be running/u);
  assert.equal(harness.calls.createTarget.length, 0);

  const missing = makeHarness();
  await assert.rejects(openBootstrapChartTarget({}, missing.deps), /profile_name is required/u);
  assert.equal(missing.calls.createTarget.length, 0);
});

test('rejects a profile endpoint redirected to another profile', async () => {
  const harness = makeHarness({ browserWebSocketUrl: 'ws://manager.test/api/profiles/other-profile/cdp' });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps),
    /outside exact Manager profile authority/u,
  );
  assert.equal(harness.calls.createTarget.length, 0);
  assert.equal(harness.calls.navigate.length, 0);
});

test('unknown create response leaves no retry or second target creation', async () => {
  const ambiguous = makeHarness({ createResult: {} });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, ambiguous.deps),
    (error) => /created target id is required/u.test(error.message)
      && error.cleanupState === 'not_attempted_ambiguous',
  );
  assert.equal(ambiguous.calls.createTarget.length, 1);
  assert.equal(ambiguous.calls.navigate.length, 0);

  const nextAttempt = makeHarness({ targets: [
    { id: 'home', type: 'page', url: 'https://www.tradingview.com/' },
    { id: 'orphan-blank', type: 'page', url: 'about:blank' },
  ] });
  await assert.rejects(openBootstrapChartTarget({ profile_name: PROFILE_NAME }, nextAttempt.deps), /blank page target exists/u);
  assert.equal(nextAttempt.calls.createTarget.length, 0);
});

test('reports login route without claiming saved-chart authority', async () => {
  const loginUrl = 'https://www.tradingview.com/accounts/signin/';
  const harness = makeHarness({ finalUrl: loginUrl });
  const result = await openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps);
  assert.equal(result.page_state, 'login_route');
  assert.equal(result.target_url, loginUrl);
  assert.equal(Object.hasOwn(result, 'saved_chart_id'), false);
});

test('does not bind an ID-backed chart route as a generic bootstrap landing', async () => {
  const harness = makeHarness({ finalUrl: 'https://www.tradingview.com/chart/account-layout-id/' });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps),
    /did not reach the exact generic chart or login route/u,
  );
  assert.equal(harness.calls.createTarget.length, 1);
  assert.equal(harness.calls.navigate.length, 1);
  assert.equal(harness.calls.bound.length, 0);
});

test('rejects navigation that leaves TradingView origin', async () => {
  const harness = makeHarness({ finalUrl: 'https://example.invalid/chart/' });
  await assert.rejects(openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps), /did not reach the exact generic chart or login route/u);
  assert.equal(harness.calls.createTarget.length, 1);
  assert.equal(harness.calls.bound.length, 0);
});

test('fails closed on malformed profile or target inventories', async () => {
  const malformedProfiles = makeHarness({ profileInventory: { profiles: 'unknown' } });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, malformedProfiles.deps),
    /profile inventory is malformed/u,
  );
  assert.equal(malformedProfiles.calls.createTarget.length, 0);

  const malformedTargets = makeHarness({ targetInventory: { targets: [] } });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, malformedTargets.deps),
    /CDP target inventory is malformed/u,
  );
  assert.equal(malformedTargets.calls.createTarget.length, 0);

  const ambiguousProfiles = makeHarness({ profileInventory: [
    { id: 'profile-one', name: PROFILE_NAME, status: 'running' },
    { id: 'profile-two', name: PROFILE_NAME, status: 'running' },
  ] });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, ambiguousProfiles.deps),
    /profile name is missing or ambiguous/u,
  );
  assert.equal(ambiguousProfiles.calls.createTarget.length, 0);

  const malformedMember = makeHarness({ profileInventory: [
    { id: PROFILE_ID, name: PROFILE_NAME, status: 'running', cdp_url: `/api/profiles/${PROFILE_ID}/cdp` },
    null,
  ] });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, malformedMember.deps),
    /profile inventory entry 1 is malformed/u,
  );
  assert.equal(malformedMember.calls.createTarget.length, 0);

  const conflictingProfileAliases = makeHarness({ profileInventory: [{
    id: PROFILE_ID,
    profile_id: 'different-profile-id',
    name: PROFILE_NAME,
    status: 'running',
  }] });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, conflictingProfileAliases.deps),
    /profile inventory entry 0 id aliases conflict/u,
  );
  assert.equal(conflictingProfileAliases.calls.createTarget.length, 0);

  const blankAndPresentEndpointAliases = makeHarness({ profileInventory: [{
    id: PROFILE_ID,
    name: PROFILE_NAME,
    status: 'running',
    cdp_url: `/api/profiles/${PROFILE_ID}/cdp`,
    cdp_endpoint: '',
  }] });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, blankAndPresentEndpointAliases.deps),
    /profile inventory entry 0 CDP endpoint aliases conflict/u,
  );
  assert.equal(blankAndPresentEndpointAliases.calls.createTarget.length, 0);

  const malformedTargetMember = makeHarness({ targetInventory: [null] });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, malformedTargetMember.deps),
    /CDP target inventory entry 0 is malformed/u,
  );
  assert.equal(malformedTargetMember.calls.createTarget.length, 0);

  const conflictingTargetAliases = makeHarness({ targetInventory: [{
    id: 'target-one', targetId: 'target-two', type: 'page', url: 'https://www.tradingview.com/',
  }] });
  await assert.rejects(
    openBootstrapChartTarget({ profile_name: PROFILE_NAME }, conflictingTargetAliases.deps),
    /CDP target inventory entry 0 id aliases conflict/u,
  );
  assert.equal(conflictingTargetAliases.calls.createTarget.length, 0);
});

test('ignores empty optional CDP endpoint on unrelated stopped Manager profile', async () => {
  const harness = makeHarness({ profileInventory: [
    {
      id: PROFILE_ID,
      name: PROFILE_NAME,
      status: 'running',
      cdp_url: `/api/profiles/${PROFILE_ID}/cdp`,
    },
    {
      id: 'stopped-profile',
      name: 'other-profile',
      status: 'stopped',
      cdp_url: '',
    },
  ] });

  const result = await openBootstrapChartTarget({ profile_name: PROFILE_NAME }, harness.deps);

  assert.equal(result.success, true);
  assert.equal(result.profile_name, PROFILE_NAME);
  assert.equal(harness.calls.createTarget.length, 1);
  assert.deepEqual(harness.calls.browserWebSockets, [`ws://manager.test/api/profiles/${PROFILE_ID}/cdp`]);
  assert.equal(harness.calls.bound.length, 1);
  assert.equal(harness.calls.bound[0].profileId, PROFILE_ID);
});
