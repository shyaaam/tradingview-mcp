import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PROBE_MARKER,
  PROBE_PROFILE_NAME,
  armProbeCreate,
  markProbeClickDispatched,
  prepareProbeJournal,
  readProbeJournal,
  recordProbeDiscovery,
  recordProbeResponse,
  recoveryAction,
} from '../scripts/saved-chart-idempotency-probe-journal.mjs';
import {
  assertProviderIdentity,
  reconcileProbeDiscovery,
} from '../scripts/saved-chart-idempotency-probe.mjs';

const INPUT = {
  providerCommit: 'a'.repeat(40),
  providerManifestSha256: 'b'.repeat(64),
  profileName: PROBE_PROFILE_NAME,
  accountSubjectSha256: 'c'.repeat(64),
  preInventoryCount: 0,
  preInventorySha256: createHash('sha256').update('[]', 'utf8').digest('hex'),
  preTargetCount: 1,
  preBlankTargetCount: 0,
  preProbeMarkerTargetCount: 0,
  preNonProbeLayoutCount: 0,
  preNonProbeInventorySha256: createHash('sha256').update('[]', 'utf8').digest('hex'),
  preExistingProbeNames: [],
};
const JOURNAL_MODULE_URL = new URL('../scripts/saved-chart-idempotency-probe-journal.mjs', import.meta.url).href;
const PROBE_SCRIPT_URL = new URL('../scripts/saved-chart-idempotency-probe.mjs', import.meta.url).href;

function runChild(path, body) {
  const source = `
    import { armProbeCreate, markProbeClickDispatched, readProbeJournal, recordProbeResponse } from ${JSON.stringify(JOURNAL_MODULE_URL)};
    import { reconcileProbeDiscovery } from ${JSON.stringify(PROBE_SCRIPT_URL)};
    const journalPath = process.env.PROBE_TEST_JOURNAL;
    ${body}
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, PROBE_TEST_JOURNAL: path },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function withJournal(run) {
  const directory = await mkdtemp(join(tmpdir(), 'tv-probe-journal-'));
  const path = join(directory, 'journal.json');
  try { await run(path); } finally { await rm(directory, { recursive: true, force: true }); }
}

function discovered(layouts, inventorySha256 = INPUT.preInventorySha256, overrides = {}) {
  return {
    accountSubjectSha256: INPUT.accountSubjectSha256,
    inventorySha256,
    targetCount: INPUT.preTargetCount,
    blankTargetCount: INPUT.preBlankTargetCount,
    probeMarkerTargetCount: 0,
    nonProbeLayoutCount: 0,
    nonProbeInventorySha256: INPUT.preNonProbeInventorySha256,
    probePrefixNames: layouts.filter(([, name]) => name.startsWith('V5_IDEMPOTENCY_PROBE_')).map(([, name]) => name),
    layouts: layouts.map(([layoutId, name]) => ({ layoutId, name })),
    ...overrides,
  };
}

test('PREPARED recovery discovers exact durable marker before any first create', async () => {
  await withJournal(async (path) => {
    await prepareProbeJournal(path, INPUT);

    const reopened = await readProbeJournal(path);
    assert.deepEqual(recoveryAction(reopened), {
      action: 'DISCOVER', marker: PROBE_MARKER, stage: 'PREPARED',
    });
    const result = await recordProbeDiscovery(path, discovered([]));
    assert.equal(result.outcome, 'PREPARED_NO_REMOTE_EFFECT');
    assert.equal(result.createAllowed, true);
    assert.equal(result.record.marker, PROBE_MARKER);
  });
});

test('late old-unknown probe marker is recorded but does not block the fixed new marker', async () => {
  await withJournal(async (path) => {
    await prepareProbeJournal(path, INPUT);
    const result = await recordProbeDiscovery(path, discovered([
      ['old-unknown-id', 'V5_IDEMPOTENCY_PROBE_OLD_UNKNOWN'],
    ], 'e'.repeat(64)));
    assert.equal(result.outcome, 'PREPARED_NO_REMOTE_EFFECT');
    assert.equal(result.createAllowed, true);
    assert.deepEqual(result.record.lastDiscovery.probePrefixNames, ['V5_IDEMPOTENCY_PROBE_OLD_UNKNOWN']);
    assert.equal(result.record.marker, PROBE_MARKER);
  });
});

test('crash after CREATE_ARMED but before click recovers marker and never blindly retries', async () => {
  await withJournal(async (path) => {
    await prepareProbeJournal(path, INPUT);
    const child = await runChild(path, `await armProbeCreate(journalPath, 1);`);
    assert.equal(child.code, 0);

    const reopened = await readProbeJournal(path);
    assert.deepEqual(recoveryAction(reopened), {
      action: 'DISCOVER', marker: PROBE_MARKER, stage: 'CREATE_ARMED',
    });
    const result = await recordProbeDiscovery(path, discovered([]));
    assert.equal(result.outcome, 'FIRST_CREATE_STILL_AMBIGUOUS');
    assert.equal(result.createAllowed, false);
    assert.equal(result.record.stage, 'FIRST_OUTCOME_UNKNOWN');
    assert.equal(result.record.marker, PROBE_MARKER);
  });
});

test('crash after remote create effect but before response reconciles by exact marker', async () => {
  await withJournal(async (path) => {
    await prepareProbeJournal(path, INPUT);
    const child = await runChild(path, `await armProbeCreate(journalPath, 1); await markProbeClickDispatched(journalPath, 1);`);
    assert.equal(child.code, 0);
    const remoteLayouts = [['saved-id-1', PROBE_MARKER]];

    const reopened = await readProbeJournal(path);
    assert.equal(recoveryAction(reopened).action, 'DISCOVER');
    const result = await recordProbeDiscovery(path, discovered(remoteLayouts, 'e'.repeat(64)));
    assert.equal(result.outcome, 'FIRST_CREATE_CONFIRMED');
    assert.equal(result.record.firstSavedChartId, 'saved-id-1');
    assert.equal(result.record.marker, PROBE_MARKER);
    assert.equal(result.createAllowed, false);
  });
});

test('crash after provider response but before local result journaling still discovers first effect', async () => {
  await withJournal(async (path) => {
    await prepareProbeJournal(path, INPUT);
    const child = await runChild(path, `
      await armProbeCreate(journalPath, 1);
      await markProbeClickDispatched(journalPath, 1);
      const providerResponse = { action: 'created', savedChartId: 'saved-id-1' };
      process.stdout.write(JSON.stringify(providerResponse));
    `);
    assert.equal(child.code, 0);
    assert.deepEqual(JSON.parse(child.stdout), { action: 'created', savedChartId: 'saved-id-1' });
    // Simulated provider response exists only in the dead process; journal remains CREATE_ARMED.

    const reopened = await readProbeJournal(path);
    assert.deepEqual(recoveryAction(reopened), {
      action: 'DISCOVER', marker: PROBE_MARKER, stage: 'CREATE_ARMED',
    });
    const result = await recordProbeDiscovery(path, discovered([['saved-id-1', PROBE_MARKER]], 'e'.repeat(64)));
    assert.equal(result.outcome, 'FIRST_CREATE_CONFIRMED');
    assert.equal(result.record.providerResponse, undefined);
    assert.equal(result.record.marker, PROBE_MARKER);
  });
});

test('fresh exact-marker target readback recovers prior target-count conflict without new create', async () => {
  await withJournal(async (path) => {
    await prepareProbeJournal(path, INPUT);
    const armed = await runChild(path, `await armProbeCreate(journalPath, 1); await markProbeClickDispatched(journalPath, 1);`);
    assert.equal(armed.code, 0);

    const oldDiagnostic = await recordProbeDiscovery(path, discovered(
      [['saved-id-1', PROBE_MARKER]],
      'e'.repeat(64),
      { targetCount: INPUT.preTargetCount + 1 },
    ));
    assert.equal(oldDiagnostic.outcome, 'PROFILE_TARGET_COUNT_CHANGED');
    assert.equal(oldDiagnostic.record.stage, 'CONFLICT');

    const reopened = await readProbeJournal(path);
    assert.deepEqual(recoveryAction(reopened), {
      action: 'DISCOVER', marker: PROBE_MARKER, stage: 'CONFLICT',
    });
    const reconciled = await recordProbeDiscovery(path, discovered(
      [['saved-id-1', PROBE_MARKER]],
      'e'.repeat(64),
      { targetCount: INPUT.preTargetCount + 1, probeMarkerTargetCount: 1 },
    ));
    assert.equal(reconciled.outcome, 'FIRST_CREATE_CONFIRMED_AFTER_TARGET_RECONCILIATION');
    assert.equal(reconciled.record.stage, 'FIRST_CONFIRMED');
    assert.equal(reconciled.record.firstSavedChartId, 'saved-id-1');
    assert.equal(reconciled.record.firstTargetCount, INPUT.preTargetCount + 1);
    assert.equal(reconciled.record.firstProbeMarkerTargetCount, 1);
    assert.equal(reconciled.createAllowed, false);

    const stable = await recordProbeDiscovery(path, discovered(
      [['saved-id-1', PROBE_MARKER]],
      'e'.repeat(64),
      { targetCount: INPUT.preTargetCount + 1, probeMarkerTargetCount: 1 },
    ));
    assert.equal(stable.outcome, 'FIRST_CREATE_STILL_CONFIRMED');
    assert.equal(stable.createAllowed, true);
  });
});

test('prior target-count conflict does not recover when marker page count or layout ID disagrees', async () => {
  await withJournal(async (path) => {
    await prepareProbeJournal(path, INPUT);
    const armed = await runChild(path, `await armProbeCreate(journalPath, 1); await markProbeClickDispatched(journalPath, 1);`);
    assert.equal(armed.code, 0);
    await recordProbeDiscovery(path, discovered(
      [['saved-id-1', PROBE_MARKER]],
      'e'.repeat(64),
      { targetCount: INPUT.preTargetCount + 1 },
    ));

    const noMatchingPage = await recordProbeDiscovery(path, discovered(
      [['saved-id-1', PROBE_MARKER]],
      'e'.repeat(64),
      { targetCount: INPUT.preTargetCount + 1, probeMarkerTargetCount: 0 },
    ));
    assert.equal(noMatchingPage.record.stage, 'CONFLICT');
    assert.equal(noMatchingPage.createAllowed, false);

    const markerTabGone = await recordProbeDiscovery(path, discovered(
      [['saved-id-1', PROBE_MARKER]],
      'e'.repeat(64),
      { targetCount: INPUT.preTargetCount, probeMarkerTargetCount: 0 },
    ));
    assert.equal(markerTabGone.record.stage, 'CONFLICT');
    assert.equal(markerTabGone.outcome, 'PROFILE_TARGET_COUNT_CHANGED');
    assert.equal(markerTabGone.createAllowed, false);

    const changedLayout = await recordProbeDiscovery(path, discovered(
      [['different-saved-id', PROBE_MARKER]],
      'e'.repeat(64),
      { targetCount: INPUT.preTargetCount + 1, probeMarkerTargetCount: 1 },
    ));
    assert.equal(changedLayout.record.stage, 'CONFLICT');
    assert.equal(changedLayout.createAllowed, false);
  });
});

test('same-name second create is armed only after first identity is durably confirmed', async () => {
  await withJournal(async (path) => {
    await prepareProbeJournal(path, INPUT);
    await assert.rejects(armProbeCreate(path, 2), /PROBE_CREATE_STAGE_NOT_AUTHORIZED/u);
    const first = await runChild(path, `await armProbeCreate(journalPath, 1); await markProbeClickDispatched(journalPath, 1); await recordProbeResponse(journalPath, 1, { action: 'created', savedChartId: 'saved-id-1' });`);
    assert.equal(first.code, 0);
    await recordProbeDiscovery(path, discovered([['saved-id-1', PROBE_MARKER]], 'e'.repeat(64)));
    const second = await runChild(path, `await armProbeCreate(journalPath, 2); await markProbeClickDispatched(journalPath, 2);`);
    assert.equal(second.code, 0);

    const result = await recordProbeDiscovery(path, discovered([
      ['saved-id-1', PROBE_MARKER], ['saved-id-2', PROBE_MARKER],
    ], 'f'.repeat(64)));
    assert.equal(result.outcome, 'TWO_DISTINCT_LAYOUTS');
    assert.equal(result.record.stage, 'NOT_IDEMPOTENT');
    assert.deepEqual(result.record.lastDiscovery.matchLayoutIds, ['saved-id-1', 'saved-id-2']);
  });
});

test('revised provider identity is recorded by discovery before it may run second create', async () => {
  await withJournal(async (path) => {
    const firstProvider = { providerCommit: 'a'.repeat(40), providerManifestSha256: 'b'.repeat(64) };
    const secondProvider = { providerCommit: 'd'.repeat(40), providerManifestSha256: 'e'.repeat(64) };
    await prepareProbeJournal(path, { ...INPUT, ...firstProvider });
    const first = await runChild(path, `await armProbeCreate(journalPath, 1); await markProbeClickDispatched(journalPath, 1); await recordProbeResponse(journalPath, 1, { action: 'created', savedChartId: 'saved-id-1' });`);
    assert.equal(first.code, 0);
    await recordProbeDiscovery(path, discovered([['saved-id-1', PROBE_MARKER]]), firstProvider);

    const freshDiscovery = await reconcileProbeDiscovery(path, discovered([['saved-id-1', PROBE_MARKER]]), secondProvider);
    assert.equal(freshDiscovery.record.stage, 'FIRST_CONFIRMED');
    assert.equal(freshDiscovery.record.lastDiscovery.providerCommit, secondProvider.providerCommit);
    assert.doesNotThrow(() => assertProviderIdentity(freshDiscovery.record, firstProvider, 'create-first'));
    assert.throws(() => assertProviderIdentity(freshDiscovery.record, secondProvider, 'create-first'),
      /PROBE_PROVIDER_IDENTITY_CHANGED/u);
    assert.doesNotThrow(() => assertProviderIdentity(freshDiscovery.record, secondProvider, 'create-second'));
    assert.throws(() => assertProviderIdentity(freshDiscovery.record, firstProvider, 'create-second'),
      /PROBE_PROVIDER_IDENTITY_CHANGED/u);
    assert.doesNotThrow(() => assertProviderIdentity(freshDiscovery.record, secondProvider, 'discover'));

    const armed = await armProbeCreate(path, 2, freshDiscovery.record.lastDiscovery);
    assert.equal(armed.preSecondCreateDiscovery.providerCommit, secondProvider.providerCommit);
    assert.equal(armed.preSecondCreateDiscovery.providerManifestSha256, secondProvider.providerManifestSha256);
  });
});

test('one inventory match after an ambiguous second create is not mislabeled idempotent', async () => {
  await withJournal(async (path) => {
    await prepareProbeJournal(path, INPUT);
    const first = await runChild(path, `await armProbeCreate(journalPath, 1); await markProbeClickDispatched(journalPath, 1); await recordProbeResponse(journalPath, 1, { action: 'created', savedChartId: 'saved-id-1' });`);
    assert.equal(first.code, 0);
    await recordProbeDiscovery(path, discovered([['saved-id-1', PROBE_MARKER]], 'e'.repeat(64)));
    const second = await runChild(path, `await armProbeCreate(journalPath, 2); await markProbeClickDispatched(journalPath, 2);`);
    assert.equal(second.code, 0);

    const result = await recordProbeDiscovery(path, discovered([['saved-id-1', PROBE_MARKER]], 'e'.repeat(64)));
    assert.equal(result.outcome, 'SECOND_CREATE_STILL_AMBIGUOUS');
    assert.equal(result.record.stage, 'SECOND_OUTCOME_UNKNOWN');
  });
});

test('same-name second create is only a candidate uniqueness result when response, cleanup, and inventory agree', async () => {
  await withJournal(async (path) => {
    await prepareProbeJournal(path, INPUT);
    const first = await runChild(path, `await armProbeCreate(journalPath, 1); await markProbeClickDispatched(journalPath, 1); await recordProbeResponse(journalPath, 1, { action: 'created', savedChartId: 'saved-id-1' });`);
    assert.equal(first.code, 0);
    await recordProbeDiscovery(path, discovered([['saved-id-1', PROBE_MARKER]], 'e'.repeat(64)));
    const second = await runChild(path, `await armProbeCreate(journalPath, 2); await markProbeClickDispatched(journalPath, 2); await recordProbeResponse(journalPath, 2, { action: 'created', savedChartId: 'saved-id-1', temporaryTargetClosed: true });`);
    assert.equal(second.code, 0);

    const result = await recordProbeDiscovery(path, discovered([['saved-id-1', PROBE_MARKER]], 'e'.repeat(64)));
    assert.equal(result.outcome, 'ONE_LAYOUT_AFTER_SECOND_CLICK');
    assert.equal(result.record.stage, 'CANDIDATE_UNIQUE');
  });
});

test('two fresh CLI processes cannot arm the same create attempt', async () => {
  await withJournal(async (path) => {
    await prepareProbeJournal(path, INPUT);
    const source = `
      try { await armProbeCreate(journalPath, 1); process.stdout.write('ARMED'); }
      catch (error) { process.stdout.write(error.message); process.exitCode = 2; }
    `;
    const outcomes = await Promise.all([runChild(path, source), runChild(path, source)]);
    assert.equal(outcomes.filter(({ code, stdout }) => code === 0 && stdout === 'ARMED').length, 1);
    assert.equal(outcomes.filter(({ code }) => code === 2).length, 1);
    assert.equal((await readProbeJournal(path)).stage, 'CREATE_ARMED');
  });
});

test('fresh CLI discovery reopens armed journal and never generates or creates a new marker', async () => {
  await withJournal(async (path) => {
    await prepareProbeJournal(path, INPUT);
    const crashed = await runChild(path, `await armProbeCreate(journalPath, 1);`);
    assert.equal(crashed.code, 0);
    const reopened = await runChild(path, `
      const result = await reconcileProbeDiscovery(journalPath, ${JSON.stringify(discovered([]))});
      process.stdout.write(JSON.stringify({ marker: result.record.marker, stage: result.record.stage,
        outcome: result.outcome, createAllowed: result.createAllowed }));
    `);
    assert.equal(reopened.code, 0);
    assert.deepEqual(JSON.parse(reopened.stdout), {
      marker: PROBE_MARKER, stage: 'FIRST_OUTCOME_UNKNOWN',
      outcome: 'FIRST_CREATE_STILL_AMBIGUOUS', createAllowed: false,
    });
  });
});

test('explicit duplicate rejection plus one unchanged layout is recorded as candidate uniqueness', async () => {
  await withJournal(async (path) => {
    await prepareProbeJournal(path, INPUT);
    const first = await runChild(path, `await armProbeCreate(journalPath, 1); await markProbeClickDispatched(journalPath, 1); await recordProbeResponse(journalPath, 1, { action: 'created', savedChartId: 'saved-id-1' });`);
    assert.equal(first.code, 0);
    await recordProbeDiscovery(path, discovered([['saved-id-1', PROBE_MARKER]], 'e'.repeat(64)));
    const second = await runChild(path, `await armProbeCreate(journalPath, 2); await markProbeClickDispatched(journalPath, 2); await recordProbeResponse(journalPath, 2, { action: 'duplicate_rejected', failureCode: 'SAVED_CHART_NAME_DUPLICATE_REJECTED', temporaryTargetClosed: true });`);
    assert.equal(second.code, 0);

    const result = await recordProbeDiscovery(path, discovered([['saved-id-1', PROBE_MARKER]], 'e'.repeat(64)));
    assert.equal(result.outcome, 'EXPLICIT_DUPLICATE_REJECTION');
    assert.equal(result.record.stage, 'CANDIDATE_UNIQUE');
  });
});

test('profile target-count drift blocks create eligibility after inventory reconciliation', async () => {
  await withJournal(async (path) => {
    await prepareProbeJournal(path, INPUT);
    const result = await recordProbeDiscovery(path, {
      ...discovered([]),
      targetCount: INPUT.preTargetCount + 1,
    });
    assert.equal(result.outcome, 'PROFILE_TARGET_COUNT_CHANGED');
    assert.equal(result.createAllowed, false);
    assert.equal(result.record.stage, 'CONFLICT');
  });
});

test('non-probe layout inventory drift blocks recovery and create eligibility', async () => {
  await withJournal(async (path) => {
    await prepareProbeJournal(path, INPUT);
    const result = await recordProbeDiscovery(path, {
      ...discovered([]),
      nonProbeLayoutCount: INPUT.preNonProbeLayoutCount + 1,
      nonProbeInventorySha256: createHash('sha256').update('["changed"]', 'utf8').digest('hex'),
    });
    assert.equal(result.outcome, 'NON_PROBE_INVENTORY_CHANGED');
    assert.equal(result.createAllowed, false);
    assert.equal(result.record.stage, 'CONFLICT');
  });
});

test('leftover about:blank target drift blocks create eligibility without storing target IDs', async () => {
  await withJournal(async (path) => {
    await prepareProbeJournal(path, INPUT);
    const result = await recordProbeDiscovery(path, {
      ...discovered([]),
      targetCount: INPUT.preTargetCount + 1,
      blankTargetCount: 1,
    });
    assert.equal(result.outcome, 'PROFILE_TARGET_COUNT_CHANGED');
    assert.equal(result.createAllowed, false);
    assert.equal('targetIds' in result.record, false);
  });
});
