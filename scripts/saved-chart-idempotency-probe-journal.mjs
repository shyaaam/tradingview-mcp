import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export const PROBE_MARKER = 'V5_IDEMPOTENCY_PROBE_263_A';
export const PROBE_PROFILE_NAME = 'tv-observer-1';

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const STAGES = new Set([
  'PREPARED',
  'CREATE_ARMED',
  'FIRST_CONFIRMED',
  'SECOND_CREATE_ARMED',
  'FIRST_OUTCOME_UNKNOWN',
  'SECOND_OUTCOME_UNKNOWN',
  'CANDIDATE_UNIQUE',
  'NOT_IDEMPOTENT',
  'CONFLICT',
]);

export async function prepareProbeJournal(path, input) {
  const record = {
    schemaVersion: 1,
    marker: PROBE_MARKER,
    providerCommit: requireCommit(input.providerCommit),
    providerManifestSha256: requireHash(input.providerManifestSha256, 'provider manifest hash'),
    profileName: requireProfile(input.profileName),
    accountSubjectSha256: requireHash(input.accountSubjectSha256, 'account identity hash'),
    preInventoryCount: requireCount(input.preInventoryCount, 'inventory count'),
    preInventorySha256: requireHash(input.preInventorySha256, 'inventory hash'),
    preTargetCount: requireCount(input.preTargetCount, 'profile target count'),
    preBlankTargetCount: requireCount(input.preBlankTargetCount, 'blank target count'),
    preProbeMarkerTargetCount: requireCount(input.preProbeMarkerTargetCount ?? 0, 'probe marker target count'),
    preNonProbeLayoutCount: requireCount(input.preNonProbeLayoutCount, 'non-probe inventory count'),
    preNonProbeInventorySha256: requireHash(input.preNonProbeInventorySha256, 'non-probe inventory hash'),
    preExistingProbeNames: validateProbeNames(input.preExistingProbeNames),
    stage: 'PREPARED',
    createdAt: new Date().toISOString(),
    events: [{ stage: 'PREPARED', at: new Date().toISOString() }],
  };
  await writeNewRecord(path, record);
  return record;
}

export async function readProbeJournal(path) {
  const record = JSON.parse(await readFile(path, 'utf8'));
  validateRecord(record);
  // Older v1 journals had no exact-marker target counter; their prepared marker count was zero.
  record.preProbeMarkerTargetCount ??= 0;
  return record;
}

/** Every reopened attempt starts with discovery; this function never creates or changes marker. */
export function recoveryAction(record) {
  validateRecord(record);
  return Object.freeze({ action: 'DISCOVER', marker: PROBE_MARKER, stage: record.stage });
}

export async function armProbeCreate(path, attempt, discovery = undefined) {
  const expected = attempt === 1 ? 'PREPARED' : attempt === 2 ? 'FIRST_CONFIRMED' : null;
  if (expected === null) throw new Error('PROBE_CREATE_STAGE_NOT_AUTHORIZED');
  const initial = await readProbeJournal(path);
  if (initial.stage !== expected) throw new Error('PROBE_CREATE_STAGE_NOT_AUTHORIZED');
  if (attempt === 2 && (!Number.isSafeInteger(initial.firstTargetCount)
    || !Number.isSafeInteger(initial.firstProbeMarkerTargetCount))) {
    throw new Error('PROBE_FIRST_CONFIRMATION_INCOMPLETE');
  }
  await claimProbeAttempt(path, attempt);
  const record = await readProbeJournal(path);
  if (record.stage !== expected) throw new Error('PROBE_CREATE_STAGE_CHANGED');
  record.stage = attempt === 1 ? 'CREATE_ARMED' : 'SECOND_CREATE_ARMED';
  record.activeAttempt = attempt;
  record.clickDispatched = false;
  if (discovery !== undefined) {
    record[attempt === 1 ? 'preCreateDiscovery' : 'preSecondCreateDiscovery'] = snapshotDiscovery(discovery);
  }
  appendEvent(record, record.stage);
  await replaceRecord(path, record);
  return record;
}

export async function markProbeClickDispatched(path, attempt) {
  const record = await readProbeJournal(path);
  if (record.activeAttempt !== attempt || !['CREATE_ARMED', 'SECOND_CREATE_ARMED'].includes(record.stage)) {
    throw new Error('PROBE_CLICK_STAGE_NOT_ARMED');
  }
  record.clickDispatched = true;
  record.clickDispatchedAt = new Date().toISOString();
  appendEvent(record, 'CLICK_DISPATCHED');
  await replaceRecord(path, record);
  return record;
}

export async function recordProbeResponse(path, attempt, response) {
  const record = await readProbeJournal(path);
  if (record.activeAttempt !== attempt || !record.clickDispatched
    || !['CREATE_ARMED', 'SECOND_CREATE_ARMED'].includes(record.stage)) {
    throw new Error('PROBE_RESPONSE_STAGE_NOT_ARMED');
  }
  record.providerResponse = {
    attempt,
    action: safeText(response?.action),
    savedChartId: safeText(response?.savedChartId),
    failureCode: safeText(response?.failureCode),
    temporaryTargetClosed: typeof response?.temporaryTargetClosed === 'boolean'
      ? response.temporaryTargetClosed : null,
    receivedAt: new Date().toISOString(),
  };
  const attemptDiscovery = record[attempt === 1 ? 'preCreateDiscovery' : 'preSecondCreateDiscovery'];
  if (attemptDiscovery?.providerCommit && attemptDiscovery?.providerManifestSha256) {
    record.providerResponse.providerCommit = attemptDiscovery.providerCommit;
    record.providerResponse.providerManifestSha256 = attemptDiscovery.providerManifestSha256;
  }
  appendEvent(record, 'PROVIDER_RESPONSE_RECORDED');
  await replaceRecord(path, record);
  return record;
}

export async function recordProbeDiscovery(path, inventory, providerIdentity = undefined) {
  const record = await readProbeJournal(path);
  const claims = await Promise.all([readProbeAttemptClaim(path, 1), readProbeAttemptClaim(path, 2)]);
  if (claims.some((claim) => claim && processIsAlive(claim.ownerPid))) {
    throw new Error('PROBE_CREATE_ATTEMPT_IN_PROGRESS');
  }
  const previousStage = record.stage;
  const priorDiscovery = record.lastDiscovery;
  if (record.stage === 'PREPARED' && claims[0]) {
    record.stage = 'CREATE_ARMED';
    record.activeAttempt = 1;
    record.clickDispatched = true;
  } else if (record.stage === 'FIRST_CONFIRMED' && claims[1]) {
    record.stage = 'SECOND_CREATE_ARMED';
    record.activeAttempt = 2;
    record.clickDispatched = true;
  }
  if ((record.stage === 'CREATE_ARMED' || record.stage === 'FIRST_OUTCOME_UNKNOWN') && !claims[0]) {
    record.stage = 'CONFLICT';
    record.lastDiscovery = { outcome: 'CREATE_CLAIM_MISSING', at: new Date().toISOString() };
    appendEvent(record, 'CONFLICT');
    await replaceRecord(path, record);
    return { record, outcome: 'CREATE_CLAIM_MISSING', createAllowed: false };
  }
  if ((record.stage === 'SECOND_CREATE_ARMED' || record.stage === 'SECOND_OUTCOME_UNKNOWN') && !claims[1]) {
    record.stage = 'CONFLICT';
    record.lastDiscovery = { outcome: 'CREATE_CLAIM_MISSING', at: new Date().toISOString() };
    appendEvent(record, 'CONFLICT');
    await replaceRecord(path, record);
    return { record, outcome: 'CREATE_CLAIM_MISSING', createAllowed: false };
  }
  const accountSubjectSha256 = requireHash(inventory.accountSubjectSha256, 'discovered account identity hash');
  if (accountSubjectSha256 !== record.accountSubjectSha256) {
    record.stage = 'CONFLICT';
    record.lastDiscovery = { outcome: 'ACCOUNT_IDENTITY_CHANGED', at: new Date().toISOString() };
    appendEvent(record, 'CONFLICT');
    await replaceRecord(path, record);
    return { record, outcome: 'ACCOUNT_IDENTITY_CHANGED', createAllowed: false };
  }

  const layouts = validateLayouts(inventory.layouts);
  const matches = layouts.filter((layout) => layout.name === PROBE_MARKER);
  const matchIds = matches.map((layout) => layout.layoutId).sort();
  const probePrefixNames = validateProbeNames(inventory.probePrefixNames);
  record.lastDiscovery = {
    at: new Date().toISOString(),
    layoutCount: layouts.length,
    targetCount: requireCount(inventory.targetCount, 'discovered profile target count'),
    blankTargetCount: requireCount(inventory.blankTargetCount, 'discovered blank target count'),
    probeMarkerTargetCount: requireCount(inventory.probeMarkerTargetCount ?? 0, 'discovered marker target count'),
    inventorySha256: requireHash(inventory.inventorySha256, 'discovered inventory hash'),
    nonProbeLayoutCount: requireCount(inventory.nonProbeLayoutCount, 'non-probe inventory count'),
    nonProbeInventorySha256: requireHash(inventory.nonProbeInventorySha256, 'non-probe inventory hash'),
    probePrefixNames,
    matchCount: matches.length,
    matchLayoutIds: matchIds,
    ...(providerIdentity === undefined ? {} : {
      providerCommit: requireCommit(providerIdentity.providerCommit),
      providerManifestSha256: requireHash(providerIdentity.providerManifestSha256, 'provider manifest hash'),
    }),
  };

  let outcome;
  let createAllowed = false;
  const nonProbeInventoryStable = record.lastDiscovery.nonProbeLayoutCount === record.preNonProbeLayoutCount
    && record.lastDiscovery.nonProbeInventorySha256 === record.preNonProbeInventorySha256;
  const priorTargetConflictMatchesMarker = record.stage === 'CONFLICT'
    && priorDiscovery?.outcome === 'PROFILE_TARGET_COUNT_CHANGED'
    && priorDiscovery.targetCount === record.preTargetCount + 1
    && priorDiscovery.blankTargetCount === record.preBlankTargetCount
    && priorDiscovery.nonProbeLayoutCount === record.preNonProbeLayoutCount
    && priorDiscovery.nonProbeInventorySha256 === record.preNonProbeInventorySha256
    && priorDiscovery.matchCount === 1
    && priorDiscovery.matchLayoutIds?.length === 1
    && matches.length === 1
    && priorDiscovery.matchLayoutIds[0] === matches[0].layoutId;
  const recoverPriorTargetConflict = priorTargetConflictMatchesMarker
    && firstEffectTargetState(record, record.lastDiscovery);

  if (!nonProbeInventoryStable) {
    record.stage = 'CONFLICT';
    outcome = 'NON_PROBE_INVENTORY_CHANGED';
  } else if (record.stage === 'PREPARED') {
    if (!baselineTargetState(record, record.lastDiscovery)) {
      outcome = 'PROFILE_TARGET_COUNT_CHANGED';
      record.stage = 'CONFLICT';
    } else if (matches.length === 0) {
      outcome = 'PREPARED_NO_REMOTE_EFFECT';
      createAllowed = true;
    } else {
      outcome = 'UNEXPECTED_PREPARED_STATE';
      record.stage = 'CONFLICT';
    }
  } else if (record.stage === 'CREATE_ARMED' || record.stage === 'FIRST_OUTCOME_UNKNOWN') {
    if (matches.length === 1 && firstEffectTargetState(record, record.lastDiscovery)) {
      record.firstSavedChartId = requireText(matches[0].layoutId, 'first saved chart ID');
      record.firstCreateProviderCommit = record.providerCommit;
      record.firstCreateProviderManifestSha256 = record.providerManifestSha256;
      record.firstTargetCount = record.lastDiscovery.targetCount;
      record.firstProbeMarkerTargetCount = record.lastDiscovery.probeMarkerTargetCount;
      record.stage = 'FIRST_CONFIRMED';
      outcome = 'FIRST_CREATE_CONFIRMED';
    } else if (matches.length === 0) {
      if (baselineTargetState(record, record.lastDiscovery)) {
        record.stage = 'FIRST_OUTCOME_UNKNOWN';
        outcome = 'FIRST_CREATE_STILL_AMBIGUOUS';
      } else {
        record.stage = 'CONFLICT';
        outcome = 'PROFILE_TARGET_COUNT_CHANGED';
      }
    } else {
      record.stage = 'CONFLICT';
      outcome = matches.length > 1 ? 'MULTIPLE_PROBE_LAYOUTS' : 'PROFILE_TARGET_COUNT_CHANGED';
    }
  } else if (recoverPriorTargetConflict) {
    record.firstSavedChartId = requireText(matches[0].layoutId, 'first saved chart ID');
    record.firstCreateProviderCommit = record.providerCommit;
    record.firstCreateProviderManifestSha256 = record.providerManifestSha256;
    record.firstTargetCount = record.lastDiscovery.targetCount;
    record.firstProbeMarkerTargetCount = record.lastDiscovery.probeMarkerTargetCount;
    record.stage = 'FIRST_CONFIRMED';
    outcome = 'FIRST_CREATE_CONFIRMED_AFTER_TARGET_RECONCILIATION';
  } else if (record.stage === 'FIRST_CONFIRMED') {
    if (matches.length === 1 && matches[0].layoutId === record.firstSavedChartId
      && firstConfirmationTargetState(record, record.lastDiscovery)) {
      outcome = 'FIRST_CREATE_STILL_CONFIRMED';
      createAllowed = true;
    } else {
      record.stage = 'CONFLICT';
      outcome = matches.length === 1 && matches[0].layoutId === record.firstSavedChartId
        ? 'PROFILE_TARGET_COUNT_CHANGED' : 'FIRST_AUTHORITY_CHANGED';
    }
  } else if (record.stage === 'SECOND_CREATE_ARMED' || record.stage === 'SECOND_OUTCOME_UNKNOWN') {
    if (matches.length === 2 && new Set(matchIds).size === 2) {
      record.stage = 'NOT_IDEMPOTENT';
      outcome = 'TWO_DISTINCT_LAYOUTS';
    } else if (matches.length === 1 && matches[0].layoutId === record.firstSavedChartId
      && record.clickDispatched === true && record.providerResponse?.attempt === 2
      && ((record.providerResponse.action === 'created'
        && record.providerResponse.savedChartId === record.firstSavedChartId)
        || (record.providerResponse.action === 'duplicate_rejected'
          && record.providerResponse.failureCode === 'SAVED_CHART_NAME_DUPLICATE_REJECTED'))
      && record.providerResponse.temporaryTargetClosed === true
      && firstConfirmationTargetState(record, record.lastDiscovery)) {
      record.stage = 'CANDIDATE_UNIQUE';
      outcome = record.providerResponse.action === 'duplicate_rejected'
        ? 'EXPLICIT_DUPLICATE_REJECTION' : 'ONE_LAYOUT_AFTER_SECOND_CLICK';
    } else {
      if (secondEffectTargetState(record, record.lastDiscovery)) {
        record.stage = 'SECOND_OUTCOME_UNKNOWN';
        outcome = 'SECOND_CREATE_STILL_AMBIGUOUS';
      } else {
        record.stage = 'CONFLICT';
        outcome = 'PROFILE_TARGET_COUNT_CHANGED';
      }
    }
  } else if (record.stage === 'CONFLICT') {
    outcome = priorDiscovery?.outcome || 'CONFLICT';
  } else {
    outcome = record.stage;
  }

  record.lastDiscovery.outcome = outcome;
  if (record.stage !== previousStage) appendEvent(record, record.stage);
  await replaceRecord(path, record);
  return { record, outcome, createAllowed };
}

function baselineTargetState(record, discovery) {
  return discovery.targetCount === record.preTargetCount
    && discovery.blankTargetCount === record.preBlankTargetCount
    && discovery.probeMarkerTargetCount === record.preProbeMarkerTargetCount;
}

function firstEffectTargetState(record, discovery) {
  const targetDelta = discovery.targetCount - record.preTargetCount;
  const markerTargetDelta = discovery.probeMarkerTargetCount - record.preProbeMarkerTargetCount;
  return discovery.blankTargetCount === record.preBlankTargetCount
    && (targetDelta === 0 || targetDelta === 1)
    && markerTargetDelta === targetDelta;
}

function firstConfirmationTargetState(record, discovery) {
  return Number.isSafeInteger(record.firstTargetCount)
    && Number.isSafeInteger(record.firstProbeMarkerTargetCount)
    && discovery.targetCount === record.firstTargetCount
    && discovery.probeMarkerTargetCount === record.firstProbeMarkerTargetCount
    && discovery.blankTargetCount === record.preBlankTargetCount;
}

function secondEffectTargetState(record, discovery) {
  if (!Number.isSafeInteger(record.firstTargetCount)
    || !Number.isSafeInteger(record.firstProbeMarkerTargetCount)) return false;
  const targetDelta = discovery.targetCount - record.firstTargetCount;
  const markerTargetDelta = discovery.probeMarkerTargetCount - record.firstProbeMarkerTargetCount;
  return discovery.blankTargetCount === record.preBlankTargetCount
    && (targetDelta === 0 || targetDelta === 1)
    && markerTargetDelta === targetDelta;
}

async function claimProbeAttempt(path, attempt) {
  const claimPath = probeAttemptClaimPath(path, attempt);
  try {
    await writeNewRecord(claimPath, {
      schemaVersion: 1,
      marker: PROBE_MARKER,
      attempt,
      ownerPid: process.pid,
      claimedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('PROBE_CREATE_ATTEMPT_ALREADY_CLAIMED');
    throw error;
  }
}

async function readProbeAttemptClaim(path, attempt) {
  try {
    const claim = JSON.parse(await readFile(probeAttemptClaimPath(path, attempt), 'utf8'));
    if (claim?.schemaVersion !== 1 || claim.marker !== PROBE_MARKER || claim.attempt !== attempt
      || !Number.isSafeInteger(claim.ownerPid) || claim.ownerPid < 1
      || typeof claim.claimedAt !== 'string') {
      throw new Error('PROBE_CREATE_CLAIM_INVALID');
    }
    return claim;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function probeAttemptClaimPath(path, attempt) {
  return `${path}.attempt-${attempt}.claim`;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw new Error('PROBE_CLAIM_OWNER_STATE_UNAVAILABLE');
  }
}

function snapshotDiscovery(discovery) {
  if (!discovery || typeof discovery !== 'object' || Array.isArray(discovery)) {
    throw new Error('PROBE_PRECREATE_DISCOVERY_INVALID');
  }
  return {
    at: requireText(discovery.at, 'discovery timestamp'),
    layoutCount: requireCount(discovery.layoutCount, 'discovery layout count'),
    targetCount: requireCount(discovery.targetCount, 'discovery target count'),
    blankTargetCount: requireCount(discovery.blankTargetCount, 'discovery blank target count'),
    inventorySha256: requireHash(discovery.inventorySha256, 'discovery inventory hash'),
    nonProbeLayoutCount: requireCount(discovery.nonProbeLayoutCount, 'discovery non-probe count'),
    nonProbeInventorySha256: requireHash(discovery.nonProbeInventorySha256, 'discovery non-probe inventory hash'),
    probePrefixNames: validateProbeNames(discovery.probePrefixNames),
    matchCount: requireCount(discovery.matchCount, 'discovery marker count'),
    matchLayoutIds: validateIds(discovery.matchLayoutIds),
    ...(discovery.providerCommit === undefined ? {} : {
      providerCommit: requireCommit(discovery.providerCommit),
      providerManifestSha256: requireHash(discovery.providerManifestSha256, 'provider manifest hash'),
    }),
  };
}

function validateIds(value) {
  if (!Array.isArray(value)) throw new Error('PROBE_DISCOVERY_IDS_INVALID');
  return value.map((id) => requireText(id, 'discovery layout ID')).sort();
}

function validateRecord(record) {
  if (!record || record.schemaVersion !== 1 || record.marker !== PROBE_MARKER
    || !STAGES.has(record.stage) || record.profileName !== PROBE_PROFILE_NAME
    || !COMMIT.test(String(record.providerCommit || ''))
    || !HASH.test(String(record.providerManifestSha256 || ''))
    || !HASH.test(String(record.accountSubjectSha256 || ''))
    || !HASH.test(String(record.preInventorySha256 || ''))
    || !HASH.test(String(record.preNonProbeInventorySha256 || ''))
    || !Number.isSafeInteger(record.preInventoryCount) || record.preInventoryCount < 0
    || !Number.isSafeInteger(record.preTargetCount) || record.preTargetCount < 0
    || !Number.isSafeInteger(record.preBlankTargetCount) || record.preBlankTargetCount < 0
    || (record.preProbeMarkerTargetCount !== undefined
      && (!Number.isSafeInteger(record.preProbeMarkerTargetCount) || record.preProbeMarkerTargetCount < 0))
    || (record.firstTargetCount !== undefined
      && (!Number.isSafeInteger(record.firstTargetCount) || record.firstTargetCount < 0))
    || (record.firstProbeMarkerTargetCount !== undefined
      && (!Number.isSafeInteger(record.firstProbeMarkerTargetCount) || record.firstProbeMarkerTargetCount < 0))
    || (record.firstCreateProviderCommit !== undefined
      && !COMMIT.test(String(record.firstCreateProviderCommit)))
    || (record.firstCreateProviderManifestSha256 !== undefined
      && !HASH.test(String(record.firstCreateProviderManifestSha256)))
    || !Number.isSafeInteger(record.preNonProbeLayoutCount) || record.preNonProbeLayoutCount < 0
    || !Array.isArray(record.events)) {
    throw new Error('PROBE_JOURNAL_INVALID');
  }
}

function validateLayouts(value) {
  if (!Array.isArray(value)) throw new Error('PROBE_DISCOVERY_LAYOUTS_INVALID');
  return value.map((layout) => ({
    layoutId: requireText(layout?.layoutId, 'layout ID'),
    name: requireText(layout?.name, 'layout name'),
  }));
}

function validateProbeNames(value) {
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
    throw new Error('PROBE_PREFIX_INVENTORY_INVALID');
  }
  return [...value].sort();
}

function requireProfile(value) {
  if (value !== PROBE_PROFILE_NAME) throw new Error('PROBE_PROFILE_NOT_AUTHORIZED');
  return value;
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  return value;
}

function requireCommit(value) {
  if (typeof value !== 'string' || !COMMIT.test(value)) throw new Error('PROVIDER_COMMIT_INVALID');
  return value;
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  return value;
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  return value;
}

function safeText(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/u.test(value) ? value : null;
}

function appendEvent(record, stage) {
  record.events.push({ stage, at: new Date().toISOString() });
}

async function writeNewRecord(path, record) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, path);
    await rm(temporaryPath, { force: true });
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function replaceRecord(path, record) {
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
