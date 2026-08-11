import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { setLayoutScoped, ScopedPaneLayoutEffectError } from '../src/core/pane.js';
import { deriveLegacyLayoutIdFromSources } from '../src/core/layout-identity.js';
import { observerCapabilityManifest } from '../src/release/manifest.js';

const INPUT = {
  profile_id: 'profile-a',
  chart_target_id: 'target-a',
  expected_chart_id: 'SJ0J0zgb',
  expected_account_subject_sha256: 'a'.repeat(64),
  expected_saved_layout_uid: 'SJ0J0zgb',
  expected_pre_layout_id: 's',
  expected_pre_pane_count: 1,
  desired_layout_id: '8',
  expected_post_pane_count: 8,
  timeout_ms: 4,
  poll_interval_ms: 1,
};

const CHART_URL = 'https://www.tradingview.com/chart/SJ0J0zgb/';

function makeFixture({ state = {}, postStates = [], applyLayout = true } = {}) {
  let clock = 0;
  let reads = 0;
  let current = {
    profile_id: 'profile-a',
    chart_target_id: 'target-a',
    chart_id: 'SJ0J0zgb',
    canonical_url: CHART_URL,
    account_subject_sha256: 'a'.repeat(64),
    saved_layout_uid: 'SJ0J0zgb',
    workspace_layout_id: 's',
    pane_count: 1,
    ...state,
  };
  const calls = { layout: 0, reads: 0, sleeps: [], forbidden: [] };
  const deps = {
    session: { profileId: 'profile-a', chartTargetId: 'target-a', chartTargetUrl: CHART_URL },
    readManagerProfile: async (profileId) => ({ id: profileId, status: 'running' }),
    listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-a', chart_id: 'SJ0J0zgb', url: CHART_URL }] }),
    readState: async () => {
      reads += 1;
      calls.reads = reads;
      if (reads === 1) return { ...current };
      if (postStates.length > 0) return { ...postStates[Math.min(reads - 2, postStates.length - 1)] };
      return { ...current };
    },
    invokeLayout: async (layout) => {
      calls.layout += 1;
      if (applyLayout) current = { ...current, workspace_layout_id: layout, pane_count: 8 };
    },
    sleep: async (ms) => { calls.sleeps.push(ms); clock += ms; },
    now: () => clock,
  };
  return { deps, calls, current: () => ({ ...current }) };
}

async function rejectsWithoutMutation(overrides) {
  const fixture = makeFixture(overrides);
  await assert.rejects(() => setLayoutScoped({ ...INPUT, ...(overrides?.input || {}) }, { _deps: { ...fixture.deps, ...(overrides?.deps || {}) } }));
  assert.equal(fixture.calls.layout, 0);
}

test('scoped topology mutation proves exact s/1 to 8/8 with one setLayout call', async () => {
  const fixture = makeFixture();
  const result = await setLayoutScoped(INPUT, { _deps: fixture.deps });
  assert.deepEqual({
    success: result.success,
    version: result.topology_mutation_version,
    pre: [result.pre_layout_id, result.pre_pane_count],
    post: [result.post_layout_id, result.post_pane_count],
    effect: result.effect_state,
  }, {
    success: true,
    version: 'pane-set-layout-scoped-v1',
    pre: ['s', 1],
    post: ['8', 8],
    effect: 'confirmed',
  });
  assert.equal(fixture.calls.layout, 1);
  assert.equal(result.mutations_performed, true);
});

test('all pre-layout profile, target, chart, URL, account, saved UID, layout, and pane fences block with zero mutation', async (t) => {
  const cases = [
    ['profile', { deps: { session: { profileId: 'wrong', chartTargetId: 'target-a', chartTargetUrl: CHART_URL } } }],
    ['target', { deps: { session: { profileId: 'profile-a', chartTargetId: 'wrong', chartTargetUrl: CHART_URL } } }],
    ['chart', { deps: { listTabs: async () => ({ success: true, tabs: [{ id: 'target-a', chart_id: 'wrong', url: CHART_URL }] }) } }],
    ['URL', { deps: { listTabs: async () => ({ success: true, tabs: [{ id: 'target-a', chart_id: 'SJ0J0zgb', url: 'https://www.tradingview.com/chart/other/' }] }) } }],
    ['account', { state: { account_subject_sha256: 'b'.repeat(64) } }],
    ['saved UID', { state: { saved_layout_uid: 'other-layout' } }],
    ['pre-layout', { state: { workspace_layout_id: '8' } }],
    ['pre-pane-count', { state: { pane_count: 8 } }],
  ];
  for (const [label, overrides] of cases) {
    await t.test(label, async () => rejectsWithoutMutation(overrides));
  }
});

test('ambiguous account read blocks before layout effect', async () => {
  await rejectsWithoutMutation({ deps: { readState: async () => { throw new Error('authenticated account identity is ambiguous'); } } });
});

test('post layout or pane-count mismatch never replays setLayout', async (t) => {
  const cases = [
    ['layout remains s', { applyLayout: false }],
    ['layout 8 but pane count remains 1', { postStates: [{ ...makeFixture().current(), workspace_layout_id: '8', pane_count: 1 }] }],
    ['pane count 8 but layout remains s', { postStates: [{ ...makeFixture().current(), workspace_layout_id: 's', pane_count: 8 }] }],
  ];
  for (const [label, overrides] of cases) {
    await t.test(label, async () => {
      const fixture = makeFixture(overrides);
      await assert.rejects(
        () => setLayoutScoped(INPUT, { _deps: fixture.deps }),
        (error) => error instanceof ScopedPaneLayoutEffectError && error.effectState === 'ambiguous',
      );
      assert.equal(fixture.calls.layout, 1);
    });
  }
});

test('post saved UID, account, target, or chart identity drift becomes ambiguous without replay', async (t) => {
  const driftCases = [
    ['saved UID', { saved_layout_uid: 'changed' }],
    ['account', { account_subject_sha256: 'b'.repeat(64) }],
    ['target', { chart_target_id: 'changed' }],
    ['chart', { chart_id: 'changed' }],
  ];
  for (const [label, drift] of driftCases) {
    await t.test(label, async () => {
      const fixture = makeFixture({ postStates: [{ ...makeFixture().current(), ...drift, workspace_layout_id: '8', pane_count: 8 }] });
      await assert.rejects(() => setLayoutScoped(INPUT, { _deps: fixture.deps }), ScopedPaneLayoutEffectError);
      assert.equal(fixture.calls.layout, 1);
    });
  }
});

test('post-state timeout reports ambiguous effect after exactly one mutation', async () => {
  const fixture = makeFixture({ applyLayout: false });
  await assert.rejects(
    () => setLayoutScoped(INPUT, { _deps: fixture.deps }),
    (error) => error instanceof ScopedPaneLayoutEffectError
      && error.phase === 'post-layout-verification'
      && error.layoutInvoked === true,
  );
  assert.equal(fixture.calls.layout, 1);
  assert.ok(fixture.calls.sleeps.length > 0);
});

test('post-state read failure reports ambiguous effect after one attempted mutation', async () => {
  const fixture = makeFixture({ deps: { readState: async () => { throw new Error('post identity unavailable'); } } });
  let reads = 0;
  fixture.deps.readState = async () => {
    reads += 1;
    if (reads === 1) return fixture.current();
    throw new Error('post identity unavailable');
  };
  await assert.rejects(
    () => setLayoutScoped(INPUT, { _deps: fixture.deps }),
    (error) => error instanceof ScopedPaneLayoutEffectError
      && error.phase === 'post-layout-verification'
      && error.effectState === 'ambiguous'
      && error.layoutInvoked === true,
  );
  assert.equal(fixture.calls.layout, 1);
});

test('legacy layout helper is authoritative and scoped indicator code does not use _layoutType', async () => {
  assert.deepEqual(
    deriveLegacyLayoutIdFromSources({ collection: { _layoutId: 8, _layoutType: 's' }, active: { _layoutId: 8 } }),
    { layout_id: '8' },
  );
  assert.match(
    deriveLegacyLayoutIdFromSources({ collection: { _layoutId: 8 }, active: { _layoutId: 7 } }).error,
    /missing or ambiguous/,
  );
  const source = await readFile(new URL('../src/core/indicators.js', import.meta.url), 'utf8');
  assert.match(source, /LEGACY_LAYOUT_IDENTITY_HELPER/);
  assert.doesNotMatch(source, /_layoutType/);
});

test('manifest admits scoped topology mutation exactly once with chart_mutation classification', () => {
  const entries = observerCapabilityManifest.capabilities.filter(({ name }) => name === 'pane_set_layout_scoped_v1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].classification, 'chart_mutation');
  assert.equal(entries[0].inputSchema.properties.expected_pre_layout_id.type, 'string');
  assert.equal(entries[0].inputSchema.properties.expected_post_pane_count.type, 'integer');
  assert.equal(observerCapabilityManifest.capabilities.some(({ name }) => name === 'pane_set_layout'), false);
  assert.equal(observerCapabilityManifest.capabilities.some(({ name }) => name === 'pane_probe_layout_capability'), true);
});
