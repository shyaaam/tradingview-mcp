import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { openBootstrapChartTarget } from '../src/core/chart-target-open.js';
import { observerToolDefinitions } from '../src/release/observer-schema.js';

const BASE_URL = 'http://manager.test/api';
const PROFILE_ID = 'current-profile';
const CDP_URL = `${BASE_URL}/profiles/${PROFILE_ID}/cdp`;
const CHART_URL = 'https://www.tradingview.com/chart/';

function response(value) {
  return { ok: true, status: 200, json: async () => value };
}

function makeHarness({
  targets = [{ id: 'home', type: 'page', url: 'https://www.tradingview.com/', webSocketDebuggerUrl: 'ws://home' }],
  profileId = PROFILE_ID,
  profileStatus = 'running',
  finalUrl = CHART_URL,
  createResult = { targetId: 'target-new' },
  browserWebSocketUrl = `ws://manager.test/api/profiles/${PROFILE_ID}/cdp`,
} = {}) {
  const state = { targets: targets.map((target) => ({ ...target })) };
  const calls = { createTarget: [], navigate: [], browserWebSockets: [], targetWebSockets: [], bound: [], invalidated: 0 };
  const deps = {
    managerBaseUrl: BASE_URL,
    fetch: async (url) => {
      if (url === `${BASE_URL}/profiles`) {
        return response([{ id: PROFILE_ID, status: profileStatus, cdp_url: `/api/profiles/${PROFILE_ID}/cdp` }]);
      }
      if (url === `${CDP_URL}/json/version`) return response({ webSocketDebuggerUrl: browserWebSocketUrl });
      if (url === `${CDP_URL}/json/list`) return response(state.targets.map((target) => ({ ...target })));
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
            }
            return createResult;
          },
        },
        close: async () => {},
      };
    },
    connectTarget: async (url) => {
      calls.targetWebSockets.push(url);
      return {
        Page: {
          enable: async () => {},
          navigate: async ({ url: requested }) => {
            calls.navigate.push(requested);
            const target = state.targets.find((entry) => entry.id === 'target-new');
            if (target) target.url = finalUrl;
            return { frameId: 'main', errorText: null };
          },
        },
        close: async () => {},
      };
    },
    sleep: async () => {},
    invalidateObserverSession: async () => { calls.invalidated += 1; },
    bindObserverSession: async (binding) => { calls.bound.push(binding); },
  };
  return { calls, deps, state };
}

test('opens one exact-profile blank target and navigates it to generic TradingView chart', async () => {
  const harness = makeHarness();
  const result = await openBootstrapChartTarget({ profile_id: PROFILE_ID }, harness.deps);

  assert.deepEqual(result, {
    success: true,
    open_version: 'bootstrap-chart-target-v1',
    profile_id: PROFILE_ID,
    target_id: 'target-new',
    target_url: CHART_URL,
    target_created: true,
    navigation_performed: true,
    page_state: 'generic_chart',
    mutations_performed: true,
  });
  z.object(observerToolDefinitions.tv_observer_open_bootstrap_chart_target_v1.outputSchema).parse(result);
  assert.deepEqual(harness.calls.createTarget, [{ url: 'about:blank' }]);
  assert.deepEqual(harness.calls.navigate, [CHART_URL]);
  assert.deepEqual(harness.calls.browserWebSockets, [`ws://manager.test/api/profiles/${PROFILE_ID}/cdp`]);
  assert.deepEqual(harness.calls.targetWebSockets, ['ws://target-new']);
  assert.equal(harness.calls.bound[0].profileId, PROFILE_ID);
  assert.equal(harness.calls.bound[0].chartTargetId, 'target-new');
  assert.equal(harness.calls.invalidated, 1);
});

test('reuses exactly one generic chart route after an ambiguous prior response', async () => {
  const harness = makeHarness({ targets: [{
    id: 'generic-existing', type: 'page', url: CHART_URL, webSocketDebuggerUrl: 'ws://generic-existing',
  }] });
  const result = await openBootstrapChartTarget({ profile_id: PROFILE_ID }, harness.deps);

  assert.equal(result.target_id, 'generic-existing');
  assert.equal(result.target_created, false);
  assert.equal(result.navigation_performed, false);
  assert.equal(result.mutations_performed, false);
  assert.equal(harness.calls.createTarget.length, 0);
  assert.equal(harness.calls.navigate.length, 0);
  assert.equal(harness.calls.bound[0].chartTargetId, 'generic-existing');
});

test('refuses a stale/saved chart target instead of selecting it or creating another', async () => {
  const harness = makeHarness({ targets: [{
    id: 'stale-chart', type: 'page', url: 'https://www.tradingview.com/chart/old-account-id/',
    webSocketDebuggerUrl: 'ws://stale-chart',
  }] });
  await assert.rejects(
    openBootstrapChartTarget({ profile_id: PROFILE_ID }, harness.deps),
    /non-generic or ambiguous TradingView chart target/u,
  );
  assert.equal(harness.calls.createTarget.length, 0);
  assert.equal(harness.calls.navigate.length, 0);
  assert.equal(harness.calls.bound.length, 0);
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
    await assert.rejects(openBootstrapChartTarget({ profile_id: PROFILE_ID }, harness.deps));
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
    await assert.rejects(openBootstrapChartTarget({ profile_id: PROFILE_ID }, harness.deps));
    assert.equal(harness.calls.createTarget.length, 0);
    assert.equal(harness.calls.navigate.length, 0);
  }
});

test('does not launch a stopped profile or navigate without an exact profile binding', async () => {
  const harness = makeHarness({ profileStatus: 'stopped' });
  await assert.rejects(openBootstrapChartTarget({ profile_id: PROFILE_ID }, harness.deps), /already be running/u);
  assert.equal(harness.calls.createTarget.length, 0);

  const missing = makeHarness();
  await assert.rejects(openBootstrapChartTarget({}, missing.deps), /profile_id is required/u);
  assert.equal(missing.calls.createTarget.length, 0);
});

test('rejects a profile endpoint redirected to another profile', async () => {
  const harness = makeHarness({ browserWebSocketUrl: 'ws://manager.test/api/profiles/other-profile/cdp' });
  await assert.rejects(
    openBootstrapChartTarget({ profile_id: PROFILE_ID }, harness.deps),
    /outside exact Manager profile authority/u,
  );
  assert.equal(harness.calls.createTarget.length, 0);
  assert.equal(harness.calls.navigate.length, 0);
});

test('unknown create response leaves no retry or second target creation', async () => {
  const ambiguous = makeHarness({ createResult: {} });
  await assert.rejects(openBootstrapChartTarget({ profile_id: PROFILE_ID }, ambiguous.deps), /created target id is required/u);
  assert.equal(ambiguous.calls.createTarget.length, 1);
  assert.equal(ambiguous.calls.navigate.length, 0);

  const nextAttempt = makeHarness({ targets: [
    { id: 'home', type: 'page', url: 'https://www.tradingview.com/' },
    { id: 'orphan-blank', type: 'page', url: 'about:blank' },
  ] });
  await assert.rejects(openBootstrapChartTarget({ profile_id: PROFILE_ID }, nextAttempt.deps), /blank page target exists/u);
  assert.equal(nextAttempt.calls.createTarget.length, 0);
});

test('reports login route without claiming saved-chart authority', async () => {
  const loginUrl = 'https://www.tradingview.com/accounts/signin/';
  const harness = makeHarness({ finalUrl: loginUrl });
  const result = await openBootstrapChartTarget({ profile_id: PROFILE_ID }, harness.deps);
  assert.equal(result.page_state, 'login_route');
  assert.equal(result.target_url, loginUrl);
  assert.equal(Object.hasOwn(result, 'saved_chart_id'), false);
});

test('does not bind an ID-backed chart route as a generic bootstrap landing', async () => {
  const harness = makeHarness({ finalUrl: 'https://www.tradingview.com/chart/account-layout-id/' });
  await assert.rejects(
    openBootstrapChartTarget({ profile_id: PROFILE_ID }, harness.deps),
    /did not reach the exact generic chart or login route/u,
  );
  assert.equal(harness.calls.createTarget.length, 1);
  assert.equal(harness.calls.navigate.length, 1);
  assert.equal(harness.calls.bound.length, 0);
});

test('rejects navigation that leaves TradingView origin', async () => {
  const harness = makeHarness({ finalUrl: 'https://example.invalid/chart/' });
  await assert.rejects(openBootstrapChartTarget({ profile_id: PROFILE_ID }, harness.deps), /did not reach the exact generic chart or login route/u);
  assert.equal(harness.calls.createTarget.length, 1);
  assert.equal(harness.calls.bound.length, 0);
});
