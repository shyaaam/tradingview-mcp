import assert from 'node:assert/strict';
import test from 'node:test';

import { createBootstrapTargetProof } from '../src/core/bootstrap-target-proof.js';
import { retireOwnedDiagnosticTarget } from '../src/core/diagnostic-target-retirement.js';

const MANAGER_URL = 'http://manager.test/api';
const PROFILE_ID = 'profile-current';
const PROFILE_NAME = 'tv-observer-1';
const CDP_URL = `${MANAGER_URL}/profiles/${PROFILE_ID}/cdp`;
const DIAGNOSTIC_ID = 'diagnostic-target';
const PROTECTED_ID = 'protected-ltc';

function page(id, url) {
  return { id, type: 'page', url };
}

function bootstrapResult({ targetId = DIAGNOSTIC_ID, targetUrl = 'https://www.tradingview.com/chart/' } = {}) {
  return {
    success: true,
    open_version: 'bootstrap-chart-target-v1',
    profile_name: PROFILE_NAME,
    profile_id: PROFILE_ID,
    target_id: targetId,
    target_url: targetUrl,
    target_created: true,
    ownership_proof: createBootstrapTargetProof(PROFILE_NAME, PROFILE_ID, targetId),
    navigation_performed: true,
    page_state: 'generic_chart',
    mutations_performed: true,
  };
}

function makeHarness({
  targets = [
    page(PROTECTED_ID, 'https://www.tradingview.com/chart/protected/'),
    page(DIAGNOSTIC_ID, 'https://www.tradingview.com/chart/'),
  ],
  closeBehavior = 'close',
  addCompetingPageAfterFirstRead = false,
  profileId = PROFILE_ID,
  receipt = bootstrapResult(),
} = {}) {
  const state = { targets: targets.map((entry) => ({ ...entry })) };
  const calls = { list: 0, close: [], browserClosed: 0, invalidated: 0 };
  let currentTime = 0;
  const deps = {
    managerBaseUrl: MANAGER_URL,
    timeoutMs: 40,
    now: () => currentTime,
    sleep: async (ms) => { currentTime += ms; },
    resolveExactRunningProfile: async (name) => ({
      managerBaseUrl: MANAGER_URL,
      profileName: name,
      profileId,
      cdpUrl: `${MANAGER_URL}/profiles/${profileId}/cdp`,
    }),
    fetch: async (url) => {
      if (url === `${CDP_URL}/json/version`) {
        return new Response(JSON.stringify({
          webSocketDebuggerUrl: `ws://manager.test/api/profiles/${PROFILE_ID}/cdp`,
        }));
      }
      if (url === `${CDP_URL}/json/list`) {
        calls.list += 1;
        if (addCompetingPageAfterFirstRead && calls.list === 2) {
          state.targets.push(page('competing-page', 'https://example.invalid/'));
        }
        return new Response(JSON.stringify(state.targets.map((entry) => ({ ...entry }))));
      }
      throw new Error(`unexpected URL: ${url}`);
    },
    connectBrowser: async () => ({
      Target: {
        closeTarget: async ({ targetId }) => {
          calls.close.push(targetId);
          if (closeBehavior !== 'persist') {
            state.targets = state.targets.filter((entry) => entry.id !== targetId);
          }
          if (closeBehavior === 'lost-receipt') throw new Error('close receipt lost');
          return { success: true };
        },
      },
      close: async () => { calls.browserClosed += 1; },
    }),
    getObserverSession: () => null,
    invalidateObserverSession: async () => { calls.invalidated += 1; },
  };
  return { state, calls, deps, receipt };
}

test('closes exact owned diagnostic target and preserves protected page', async () => {
  const harness = makeHarness();
  const result = await retireOwnedDiagnosticTarget({
    profile_name: PROFILE_NAME,
    target_id: DIAGNOSTIC_ID,
    bootstrap_result: harness.receipt,
  }, harness.deps);

  assert.equal(result.success, true);
  assert.equal(result.action, 'closed');
  assert.equal(result.remaining_page_targets, 1);
  assert.deepEqual(harness.calls.close, [DIAGNOSTIC_ID]);
  assert.deepEqual(harness.state.targets, [page(PROTECTED_ID, 'https://www.tradingview.com/chart/protected/')]);
  assert.equal(harness.calls.browserClosed, 1);
});

test('refuses to close last page', async () => {
  const harness = makeHarness({ targets: [page(DIAGNOSTIC_ID, 'https://www.tradingview.com/chart/')] });
  await assert.rejects(
    retireOwnedDiagnosticTarget({
      profile_name: PROFILE_NAME, target_id: DIAGNOSTIC_ID, bootstrap_result: harness.receipt,
    }, harness.deps),
    /last browser page/u,
  );
  assert.deepEqual(harness.calls.close, []);
});

test('missing or mismatched target ID fails before profile access', async () => {
  const harness = makeHarness();
  await assert.rejects(
    retireOwnedDiagnosticTarget({
      profile_name: PROFILE_NAME, bootstrap_result: harness.receipt,
    }, harness.deps),
    /target_id is invalid/u,
  );
  await assert.rejects(
    retireOwnedDiagnosticTarget({
      profile_name: PROFILE_NAME, target_id: PROTECTED_ID, bootstrap_result: harness.receipt,
    }, harness.deps),
    /does not match its bootstrap result/u,
  );
  assert.equal(harness.calls.list, 0);
  assert.deepEqual(harness.calls.close, []);
});

test('absent owned target fails fresh pre-close inventory check', async () => {
  const harness = makeHarness({ targets: [page(PROTECTED_ID, 'https://www.tradingview.com/chart/protected/')] });
  await assert.rejects(
    retireOwnedDiagnosticTarget({
      profile_name: PROFILE_NAME, target_id: DIAGNOSTIC_ID, bootstrap_result: harness.receipt,
    }, harness.deps),
    /not present exactly once in current profile inventory/u,
  );
  assert.equal(harness.calls.list, 1);
  assert.deepEqual(harness.calls.close, []);
  assert.deepEqual(harness.state.targets, [page(PROTECTED_ID, 'https://www.tradingview.com/chart/protected/')]);
});

test('competing page inventory change fails before exact close', async () => {
  const harness = makeHarness({ addCompetingPageAfterFirstRead: true });
  await assert.rejects(
    retireOwnedDiagnosticTarget({
      profile_name: PROFILE_NAME, target_id: DIAGNOSTIC_ID, bootstrap_result: harness.receipt,
    }, harness.deps),
    /page inventory changed/u,
  );
  assert.deepEqual(harness.calls.close, []);
  assert.ok(harness.state.targets.some((entry) => entry.id === PROTECTED_ID));
});

test('duplicate target identities make profile inventory ambiguous before close', async () => {
  const harness = makeHarness({ targets: [
    page(PROTECTED_ID, 'https://www.tradingview.com/chart/protected/'),
    page(DIAGNOSTIC_ID, 'https://www.tradingview.com/chart/'),
    page(DIAGNOSTIC_ID, 'https://www.tradingview.com/chart/'),
  ] });
  await assert.rejects(
    retireOwnedDiagnosticTarget({
      profile_name: PROFILE_NAME, target_id: DIAGNOSTIC_ID, bootstrap_result: harness.receipt,
    }, harness.deps),
    /duplicate target IDs/u,
  );
  assert.deepEqual(harness.calls.close, []);
});

test('lost close receipt converges to success when fresh inventory shows target gone', async () => {
  const harness = makeHarness({ closeBehavior: 'lost-receipt' });
  const result = await retireOwnedDiagnosticTarget({
    profile_name: PROFILE_NAME, target_id: DIAGNOSTIC_ID, bootstrap_result: harness.receipt,
  }, harness.deps);
  assert.equal(result.action, 'closed');
  assert.deepEqual(harness.calls.close, [DIAGNOSTIC_ID]);
  assert.deepEqual(harness.state.targets.map((entry) => entry.id), [PROTECTED_ID]);
});

test('acknowledged close with persistent target fails within bound', async () => {
  const harness = makeHarness({ closeBehavior: 'persist' });
  await assert.rejects(
    retireOwnedDiagnosticTarget({
      profile_name: PROFILE_NAME, target_id: DIAGNOSTIC_ID, bootstrap_result: harness.receipt,
    }, harness.deps),
    /remained open after bounded retirement/u,
  );
  assert.deepEqual(harness.calls.close, [DIAGNOSTIC_ID]);
  assert.ok(harness.state.targets.some((entry) => entry.id === DIAGNOSTIC_ID));
});

test('forged receipt and protected-target substitution cannot authorize close', async () => {
  const harness = makeHarness();
  const forged = { ...harness.receipt, ownership_proof: '0'.repeat(64) };
  await assert.rejects(
    retireOwnedDiagnosticTarget({
      profile_name: PROFILE_NAME, target_id: DIAGNOSTIC_ID, bootstrap_result: forged,
    }, harness.deps),
    /ownership proof is invalid/u,
  );
  const substituted = {
    ...harness.receipt,
    target_id: PROTECTED_ID,
    target_url: 'https://www.tradingview.com/chart/protected/',
  };
  await assert.rejects(
    retireOwnedDiagnosticTarget({
      profile_name: PROFILE_NAME, target_id: PROTECTED_ID, bootstrap_result: substituted,
    }, harness.deps),
    /ownership proof is invalid/u,
  );
  assert.deepEqual(harness.calls.close, []);
  assert.ok(harness.state.targets.some((entry) => entry.id === PROTECTED_ID));
});

test('non-owned bootstrap result cannot authorize close', async () => {
  const harness = makeHarness({ receipt: { ...bootstrapResult(), target_created: false } });
  await assert.rejects(
    retireOwnedDiagnosticTarget({
      profile_name: PROFILE_NAME, target_id: DIAGNOSTIC_ID, bootstrap_result: harness.receipt,
    }, harness.deps),
    /successful fresh-target bootstrap result is required/u,
  );
  assert.equal(harness.calls.list, 0);
  assert.deepEqual(harness.calls.close, []);
});

test('changed exact profile identity cannot authorize close', async () => {
  const harness = makeHarness({ profileId: 'replaced-profile' });
  await assert.rejects(
    retireOwnedDiagnosticTarget({
      profile_name: PROFILE_NAME, target_id: DIAGNOSTIC_ID, bootstrap_result: harness.receipt,
    }, harness.deps),
    /different current profile identity/u,
  );
  assert.deepEqual(harness.calls.close, []);
});
