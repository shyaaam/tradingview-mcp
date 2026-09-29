import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSavedChartIdempotencyProbe,
  ensureSavedChartAuthority,
  inspectSavedChartIdempotencyProbe,
  isExplicitSavedChartDuplicateRejection,
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
