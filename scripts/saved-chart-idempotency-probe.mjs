import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createSavedChartIdempotencyProbe,
  inspectSavedChartIdempotencyProbe,
  preflightSavedChartAuthority,
  SAVED_CHART_IDEMPOTENCY_PROBE_MARKER,
} from '../src/core/saved-chart-authority.js';
import { observerManifestHash } from '../src/release/manifest.js';
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
} from './saved-chart-idempotency-probe-journal.mjs';

const RECONCILIATION_KEY = createHash('sha256').update(PROBE_MARKER, 'utf8').digest('hex');
const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INPUT = Object.freeze({
  profileName: PROBE_PROFILE_NAME,
  captureSlotId: 'v5-capture-slot-a',
  reconciliationKey: RECONCILIATION_KEY,
});

async function main(command) {
  const journalPath = process.env.TV_IDEMPOTENCY_PROBE_JOURNAL;
  if (!journalPath) throw new Error('TV_IDEMPOTENCY_PROBE_JOURNAL_REQUIRED');
  const identity = currentProviderIdentity();

  if (command === 'prepare') {
    const inventory = await inspectSavedChartIdempotencyProbe(PROBE_PROFILE_NAME);
    if (!inventory.authenticated || inventory.probeMarkerCount !== 0
      || !Number.isSafeInteger(inventory.targetCount) || inventory.targetCount < 0
      || !Number.isSafeInteger(inventory.blankTargetCount) || inventory.blankTargetCount < 0
      || inventory.probeMarkerTargetCount !== 0) {
      throw new Error('PROBE_BASELINE_INVENTORY_NOT_EXACT');
    }
    const record = await prepareProbeJournal(journalPath, {
      ...identity,
      profileName: PROBE_PROFILE_NAME,
      accountSubjectSha256: inventory.accountSubjectSha256,
      preInventoryCount: inventory.layoutCount,
      preInventorySha256: inventory.inventorySha256,
      preTargetCount: inventory.targetCount,
      preBlankTargetCount: inventory.blankTargetCount,
      preProbeMarkerTargetCount: inventory.probeMarkerTargetCount,
      preNonProbeLayoutCount: inventory.nonProbeLayoutCount,
      preNonProbeInventorySha256: inventory.nonProbeInventorySha256,
      preExistingProbeNames: inventory.probePrefixNames,
    });
    print({ command, marker: record.marker, stage: record.stage,
      authenticated: inventory.authenticated, accountSubjectSha256: inventory.accountSubjectSha256,
      layoutCount: inventory.layoutCount, inventorySha256: inventory.inventorySha256,
      targetCount: inventory.targetCount, blankTargetCount: inventory.blankTargetCount,
      probeMarkerCount: inventory.probeMarkerCount,
      probeMarkerTargetCount: inventory.probeMarkerTargetCount,
      probePrefixNames: inventory.probePrefixNames,
      providerCommit: record.providerCommit, providerManifestSha256: record.providerManifestSha256 });
    return;
  }

  const record = await readProbeJournal(journalPath);
  assertProviderIdentity(record, identity, command);

  if (command === 'discover') {
    print(await discover(journalPath, identity));
    return;
  }

  const attempt = command === 'create-first' ? 1 : command === 'create-second' ? 2 : null;
  if (attempt === null) throw new Error('PROBE_COMMAND_INVALID');

  const before = await inspectSavedChartIdempotencyProbe(PROBE_PROFILE_NAME);
  const discovery = await reconcileProbeDiscovery(journalPath, before, identity);
  if (!discovery.createAllowed) throw new Error('PROBE_DISCOVERY_REQUIRED_OR_NOT_SAFE');
  const current = discovery.record;
  const expectedTargetCount = attempt === 2 ? current.firstTargetCount : current.preTargetCount;
  const preflight = await preflightSavedChartAuthority(INPUT, {
    idempotencyProbeMarker: SAVED_CHART_IDEMPOTENCY_PROBE_MARKER,
  });
  if (before.inventorySha256 !== preflight.layout_inventory_sha256
    || before.layoutCount !== preflight.layout_count || before.targetCount !== expectedTargetCount
    || before.blankTargetCount !== current.preBlankTargetCount
    || before.chartTargetCount !== preflight.chart_target_count
    || before.accountSubjectSha256 !== current.accountSubjectSha256) {
    throw new Error('PROBE_INVENTORY_CHANGED_BEFORE_CREATE');
  }
  if (!discovery.createAllowed || preflight.authenticated !== true
    || (attempt === 1 && preflight.can_create !== true)) {
    throw new Error('PROBE_DISCOVERY_REQUIRED_OR_NOT_SAFE');
  }
  if (attempt === 1 && current.stage !== 'PREPARED') throw new Error('PROBE_FIRST_CREATE_NOT_AUTHORIZED');
  if (attempt === 2 && current.stage !== 'FIRST_CONFIRMED') throw new Error('PROBE_SECOND_CREATE_NOT_AUTHORIZED');

  let response;
  try {
    response = await createSavedChartIdempotencyProbe({
      profileName: PROBE_PROFILE_NAME,
      marker: PROBE_MARKER,
      expectedAccountSubjectSha256: current.accountSubjectSha256,
      expectedProfilePageTargetCount: expectedTargetCount,
      expectedBlankPageTargetCount: current.preBlankTargetCount,
      allowExistingMarker: attempt === 2,
    }, {
      beforeCreateAttempt: async () => {
        await armProbeCreate(journalPath, attempt, discovery.record.lastDiscovery);
      },
      afterCreateClick: async () => { await markProbeClickDispatched(journalPath, attempt); },
    });
  } catch (error) {
    let current = await readProbeJournal(journalPath);
    if (current.activeAttempt === attempt && current.clickDispatched) {
      await recordProbeResponse(journalPath, attempt, journalResponseFromError(error, attempt));
      current = await readProbeJournal(journalPath);
    }
    print({ command, marker: PROBE_MARKER, stage: current.stage, failureCode: safeCode(error) });
    throw error;
  }
  const journalResponse = journalResponseFromResult(response, attempt);
  const duplicateRejected = journalResponse.action === 'duplicate_rejected';
  await recordProbeResponse(journalPath, attempt, journalResponse);
  if (response.temporaryTargetClosed !== true) throw new Error('PROBE_TEMPORARY_TARGET_CLOSE_UNCONFIRMED');
  print({ command, marker: PROBE_MARKER, stage: (await readProbeJournal(journalPath)).stage,
    action: duplicateRejected ? 'duplicate_rejected' : 'created',
    savedChartId: duplicateRejected ? null : response.chartId,
    temporaryTargetClosed: response.temporaryTargetClosed });
}

async function discover(journalPath, identity) {
  const inventory = await inspectSavedChartIdempotencyProbe(PROBE_PROFILE_NAME);
  return await reconcileProbeDiscovery(journalPath, inventory, identity);
}

export async function reconcileProbeDiscovery(journalPath, inventory, identity = undefined) {
  const record = await readProbeJournal(journalPath);
  const action = recoveryAction(record);
  if (action.action !== 'DISCOVER' || action.marker !== PROBE_MARKER) throw new Error('PROBE_RECOVERY_NOT_DISCOVERY');
  return await recordProbeDiscovery(journalPath, inventory, identity);
}

export function journalResponseFromResult(response, attempt) {
  const duplicateRejected = attempt === 2 && response?.action === 'duplicate_rejected'
    && response.failureCode === 'SAVED_CHART_NAME_DUPLICATE_REJECTED';
  return {
    action: duplicateRejected ? 'duplicate_rejected' : 'created',
    savedChartId: duplicateRejected ? null : response?.chartId,
    failureCode: duplicateRejected ? response.failureCode : null,
    temporaryTargetClosed: typeof response?.temporaryTargetClosed === 'boolean'
      ? response.temporaryTargetClosed : null,
  };
}

export function journalResponseFromError(error, attempt) {
  const failureCode = safeCode(error);
  const duplicateRejected = attempt === 2 && failureCode === 'SAVED_CHART_NAME_DUPLICATE_REJECTED';
  return {
    action: duplicateRejected ? 'duplicate_rejected' : 'unknown',
    savedChartId: null,
    failureCode,
    temporaryTargetClosed: typeof error?.temporaryTargetClosed === 'boolean'
      ? error.temporaryTargetClosed : null,
  };
}

function currentProviderIdentity() {
  const providerCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
    cwd: REPOSITORY_ROOT, encoding: 'utf8',
  }).trim();
  if (dirty) throw new Error('PROVIDER_CHECKOUT_NOT_CLEAN');
  return { providerCommit, providerManifestSha256: observerManifestHash };
}

export function assertProviderIdentity(record, identity, command) {
  if (command === 'discover') return;
  const expected = command === 'create-first'
    ? { providerCommit: record.providerCommit, providerManifestSha256: record.providerManifestSha256 }
    : command === 'create-second'
      ? record.lastDiscovery
      : null;
  if (!expected || expected.providerCommit !== identity.providerCommit
    || expected.providerManifestSha256 !== identity.providerManifestSha256) {
    throw new Error('PROBE_PROVIDER_IDENTITY_CHANGED');
  }
}

function safeCode(error) {
  return error instanceof Error && /^[A-Z0-9_]{1,64}$/u.test(error.message)
    ? error.message : 'PROVIDER_OPERATION_FAILED';
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch((error) => {
    process.stderr.write(`${safeCode(error)}\n`);
    process.exitCode = 1;
  });
}
