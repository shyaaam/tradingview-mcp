import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { retireOwnedSavedLayoutTarget } from '../src/core/chart-target-retirement.js';
import { registerChartTargetRetirementTool } from '../src/tools/chart-target-retirement.js';
import { profileInstanceSha256, savedChartLayoutMarker } from '../src/core/saved-chart-authority.js';
import { observerToolDefinitions } from '../src/release/observer-schema.js';

const ACCOUNT_HASH = createHash('sha256').update('observer-account', 'utf8').digest('hex');
const RECONCILIATION_KEY = 'a'.repeat(64);
const SLOT = 'v5-capture-slot-b';
const MARKER = savedChartLayoutMarker(SLOT, RECONCILIATION_KEY);
const ROUTE = 'https://www.tradingview.com/chart/runtime-chart/';
const PROFILE_NAME = 'tv-observer-1';
const PROFILE_ID = 'current-profile';
const AUTHORITY = makeAuthority();
const RECEIPT = Object.freeze({
  schema_version: 'saved-layout-created-target-v2',
  created_by_this_attempt: true,
  profile_name: PROFILE_NAME,
  profile_instance_sha256: profileInstanceSha256(PROFILE_ID),
  target_id: 'owned-target',
  capture_slot_id: SLOT,
  reconciliation_key: RECONCILIATION_KEY,
  saved_layout_id: '206146606',
  layout_marker: MARKER,
  account_subject_sha256: ACCOUNT_HASH,
});

function makeAuthority() {
  const value = {
    profile_name: 'tv-observer-1',
    capture_slot_id: SLOT,
    layout_code: 's',
    saved_layout_id: '206146606',
    reconciliation_key: RECONCILIATION_KEY,
    allowed_origins: ['https://www.tradingview.com'],
  };
  const authorityHash = createHash('sha256').update(JSON.stringify({
    allowedOrigins: value.allowed_origins,
    captureSlotId: value.capture_slot_id,
    layoutCode: value.layout_code,
    profileId: value.profile_name,
    savedLayoutId: value.saved_layout_id,
    schemaVersion: 'v5-capture-slot-authority-v3',
  }), 'utf8').digest('hex');
  return Object.freeze({
    ...value,
    authority_hash: authorityHash,
    authority_id: `v5-capture-slot:${authorityHash}`,
  });
}

function fixture(overrides = {}) {
  const targets = new Map([
    ['user-tab-a', { targetId: 'user-tab-a', type: 'page', url: ROUTE }],
    ['user-tab-b', { targetId: 'user-tab-b', type: 'page', url: ROUTE }],
    ['owned-target', { targetId: 'owned-target', type: 'page', url: ROUTE }],
  ]);
  const calls = { closed: [], inspected: [], detached: [], browserClosed: 0, fetch: [] };
  let sessionTargetId;
  const browser = {
    Target: {
      async getTargetInfo({ targetId }) {
        const targetInfo = targets.get(targetId);
        if (!targetInfo) throw new Error('Browser CDP command failed: No target with given id found');
        return { targetInfo };
      },
      async attachToTarget({ targetId, flatten }) {
        assert.equal(flatten, true);
        sessionTargetId = targetId;
        return { sessionId: 'session-owned' };
      },
      async detachFromTarget({ sessionId }) { calls.detached.push(sessionId); },
      async closeTarget({ targetId }) {
        calls.closed.push(targetId);
        targets.delete(targetId);
        return { success: true };
      },
    },
    async send(method, _params, sessionId) {
      assert.equal(method, 'Runtime.evaluate');
      assert.equal(sessionId, 'session-owned');
      calls.inspected.push(sessionTargetId);
      return { result: { value: {
        authenticated: true,
        account_subject_sha256: overrides.accountHash ?? ACCOUNT_HASH,
        current_url: ROUTE,
        chart_uid: 'runtime-chart',
        active_saved_layout_id: overrides.activeLayoutId ?? '206146606',
        active_saved_layout_name: overrides.activeMarker ?? MARKER,
        layouts: [{ layout_id: '206146606', name: MARKER }],
      } } };
    },
    async close() { calls.browserClosed += 1; },
  };
  return {
    targets,
    calls,
    async fetch(url) {
      calls.fetch.push(String(url));
      return new Response(JSON.stringify({
        webSocketDebuggerUrl: `ws://manager.test/profiles/${overrides.profileId ?? PROFILE_ID}/cdp`,
      }), { status: 200 });
    },
    connectBrowser: async () => browser,
    resolveExactRunningProfile: async (name) => {
      assert.equal(name, PROFILE_NAME);
      const profileId = overrides.profileId ?? PROFILE_ID;
      return { profileId, cdpUrl: `http://manager.test/profiles/${profileId}/cdp` };
    },
  };
}

test('fresh receipt closes only its target and leaves duplicate user tabs untouched', async () => {
  const deps = fixture();
  const result = await retireOwnedSavedLayoutTarget({
    ...AUTHORITY,
    target_id: RECEIPT.target_id,
    expected_account_subject_sha256: ACCOUNT_HASH,
    ownership_receipt: RECEIPT,
  }, { ...deps, reviewedAuthority: AUTHORITY, managerBaseUrl: 'http://manager.test', sleep: async () => {} });

  assert.equal(result.action, 'closed');
  assert.equal(result.target_id, 'owned-target');
  assert.deepEqual(deps.calls.closed, ['owned-target']);
  assert.equal(deps.targets.has('owned-target'), false);
  assert.equal(deps.targets.has('user-tab-a'), true);
  assert.equal(deps.targets.has('user-tab-b'), true);
  assert.deepEqual(deps.calls.inspected, ['owned-target']);
  assert.equal(deps.calls.browserClosed, 1);
  assert.ok(!Object.hasOwn(result, 'remaining_chart_targets'));
});

test('missing or altered ownership receipt fails before browser access', async () => {
  for (const ownershipReceipt of [
    null,
    { ...RECEIPT, target_id: 'user-tab-a' },
    { ...RECEIPT, schema_version: 'saved-layout-created-target-v1' },
    { ...RECEIPT, profile_instance_sha256: 'not-a-fingerprint' },
  ]) {
    const deps = fixture();
    await assert.rejects(retireOwnedSavedLayoutTarget({
      ...AUTHORITY,
      target_id: 'owned-target',
      expected_account_subject_sha256: ACCOUNT_HASH,
      ownership_receipt: ownershipReceipt,
    }, { ...deps, reviewedAuthority: AUTHORITY, managerBaseUrl: 'http://manager.test' }));
    assert.deepEqual(deps.calls.fetch, []);
    assert.deepEqual(deps.calls.closed, []);
  }
});

test('replaced profile instance fails before CDP access and leaves receipt target open', async () => {
  const deps = fixture({ profileId: 'replacement-profile' });
  await assert.rejects(retireOwnedSavedLayoutTarget({
    ...AUTHORITY,
    target_id: RECEIPT.target_id,
    expected_account_subject_sha256: ACCOUNT_HASH,
    ownership_receipt: RECEIPT,
  }, { ...deps, reviewedAuthority: AUTHORITY, managerBaseUrl: 'http://manager.test' }),
  /Current profile instance differs from owned target receipt/u);
  assert.deepEqual(deps.calls.fetch, []);
  assert.deepEqual(deps.calls.closed, []);
  assert.equal(deps.targets.has('owned-target'), true);
});

test('account or saved-layout mismatch leaves receipt target open', async () => {
  for (const overrides of [{ accountHash: 'f'.repeat(64) }, { activeLayoutId: 'other-layout' }]) {
    const deps = fixture(overrides);
    await assert.rejects(retireOwnedSavedLayoutTarget({
      ...AUTHORITY,
      target_id: 'owned-target',
      expected_account_subject_sha256: ACCOUNT_HASH,
      ownership_receipt: RECEIPT,
    }, { ...deps, reviewedAuthority: AUTHORITY, managerBaseUrl: 'http://manager.test' }));
    assert.deepEqual(deps.calls.closed, []);
    assert.equal(deps.targets.has('owned-target'), true);
  }
});

test('already-closed receipt target is idempotent and does not inspect or close another tab', async () => {
  const deps = fixture();
  deps.targets.delete('owned-target');
  const result = await retireOwnedSavedLayoutTarget({
    ...AUTHORITY,
    target_id: 'owned-target',
    expected_account_subject_sha256: ACCOUNT_HASH,
    ownership_receipt: RECEIPT,
  }, { ...deps, reviewedAuthority: AUTHORITY, managerBaseUrl: 'http://manager.test' });
  assert.equal(result.action, 'already-closed');
  assert.deepEqual(deps.calls.closed, []);
  assert.deepEqual(deps.calls.inspected, []);
  assert.equal(deps.targets.has('user-tab-a'), true);
  assert.equal(deps.targets.has('user-tab-b'), true);
});

test('provider exposes only receipt-owned target retirement', () => {
  assert.equal(observerToolDefinitions.tv_observer_retire_saved_chart_v2, undefined);
  assert.ok(observerToolDefinitions.tv_observer_retire_owned_saved_layout_target_v1);
  const registered = [];
  registerChartTargetRetirementTool({
    registerTool(name, definition, handler) { registered.push({ name, definition, handler }); },
  });
  assert.deepEqual(registered.map(({ name }) => name), ['tv_observer_retire_owned_saved_layout_target_v1']);
});
