import { OBSERVER_IDENTITY_EVIDENCE_EXPRESSION } from './observer-evidence.js';
import { derivePaneIndicatorParityHash, indicatorSignatures, mutationIdentityInventory } from './pane.js';
import { getState } from './chart.js';
import {
  waitForChartRuntimeReady,
  withExactRawTarget,
} from './chart-runtime-readiness.js';

const HASH = /^[0-9a-f]{64}$/u;
const CONTENT_WAIT_TIMEOUT_MS = 30_000;
const CONTENT_POLL_INTERVAL_MS = 1_000;
const RETRYABLE_CONTENT_FAILURES = new Set([
  'IDENTITY_READ_UNAVAILABLE',
  'IDENTITY_UNAVAILABLE',
  'PANE_SIGNATURES_UNAVAILABLE',
  'PANE_MUTATION_INVENTORY_UNAVAILABLE',
  'CHART_STATE_UNAVAILABLE',
  'PANE_EVIDENCE_MISMATCH',
]);

export async function chartRuntimeContentSnapshot(input = {}, dependencies = {}) {
  const expected = normalizeInput(input);
  const waitReady = dependencies.waitReady || ((probeInput) => waitForChartRuntimeReady(probeInput, dependencies));
  const runRaw = dependencies.withExactRawTarget || ((targetInput, operation) => withExactRawTarget(targetInput, operation, dependencies));

  const preReadiness = await waitReady(input);
  if (preReadiness.status !== 'READY') {
    return blockedSnapshot(expected, `PRE_READINESS_${preReadiness.status}`, preReadiness, null);
  }
  const preReadinessError = validatePreReadinessAuthority(preReadiness, expected);
  if (preReadinessError) {
    return blockedSnapshot(expected, preReadinessError, preReadiness, null);
  }

  const extraction = await readContentWithRetry({
    input,
    expected,
    preReadiness,
    runRaw,
    dependencies,
  });
  if (!extraction.value) {
    const postReadiness = extraction.retryExhausted ? await safeWaitReady(waitReady, input) : null;
    return blockedSnapshot(expected, extraction.code, preReadiness, postReadiness);
  }
  const extracted = extraction.value;

  const postReadiness = await waitReady(input);
  if (postReadiness.status !== 'READY') {
    return blockedSnapshot(expected, `POST_READINESS_${postReadiness.status}`, preReadiness, postReadiness);
  }

  let post;
  try {
    post = await runRaw(input, async ({ evaluate }) => ({
      identity: await readRawIdentity(evaluate),
      signatures: await readPaneSignatures(evaluate),
    }));
    assertExpectedIdentity(post.identity, expected);
    assertIdentityStable(extracted.identity, post.identity);
    assertPaneEvidence(post.signatures, extracted.inventory, expected.paneCount);
    assertReadinessStable(preReadiness, postReadiness, expected);
  } catch (error) {
    return blockedSnapshot(expected, normalizeContentError(error), preReadiness, postReadiness);
  }

  return {
    success: true,
    snapshot_version: 'chart-runtime-content-snapshot-v1',
    status: 'READY',
    block_reason: null,
    profile_id: expected.profileId,
    target_id: expected.targetId,
    target_url: expected.targetUrl,
    chart_id: extracted.identity.chart_id,
    workspace_layout_id: extracted.identity.layout_id,
    saved_layout_uid: extracted.savedLayoutUid,
    account_subject_sha256: extracted.identity.account_subject_sha256,
    pane_count: extracted.signatures.pane_count,
    chart_symbol: extracted.chartState.symbol,
    chart_resolution: extracted.chartState.resolution,
    chart_type: extracted.chartState.chartType,
    chart_state: extracted.chartState,
    pane_indicator_signatures: extracted.signatures,
    pane_mutation_inventory: extracted.inventory,
    indicator_parity_hash: extracted.parityHash,
    pre_readiness: preReadiness,
    post_readiness: postReadiness,
    mutations_performed: false,
  };
}

async function readContentWithRetry({ input, expected, preReadiness, runRaw, dependencies }) {
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = boundedDependencyNumber(dependencies.contentWaitTimeoutMs, CONTENT_WAIT_TIMEOUT_MS, 1, CONTENT_WAIT_TIMEOUT_MS);
  const pollIntervalMs = boundedDependencyNumber(dependencies.contentPollIntervalMs, CONTENT_POLL_INTERVAL_MS, 1, timeoutMs);
  const started = now();
  const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs) + 1;
  let attempts = 0;
  let lastCode = 'IDENTITY_READ_UNAVAILABLE';

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      return { value: await readContentAttempt({ input, expected, preReadiness, runRaw }), code: null, retryExhausted: false };
    } catch (error) {
      lastCode = normalizeContentError(error);
      if (!RETRYABLE_CONTENT_FAILURES.has(lastCode)) {
        return { value: null, code: lastCode, retryExhausted: false };
      }
      const elapsed = Math.max(0, now() - started);
      if (elapsed >= timeoutMs || attempts >= maxAttempts) break;
      await sleep(Math.min(pollIntervalMs, timeoutMs - elapsed));
    }
  }
  return { value: null, code: lastCode, retryExhausted: true };
}

async function readContentAttempt({ input, expected, preReadiness, runRaw }) {
  return runRaw(input, async ({ evaluate }) => {
    const identity = await readRawIdentity(evaluate);
    assertExpectedIdentity(identity, expected);
    const signatures = await readPaneSignatures(evaluate);
    const inventory = await readPaneMutationInventory(evaluate);
    assertPaneEvidence(signatures, inventory, expected.paneCount);
    const chartState = await readChartState(evaluate);
    const savedLayoutUid = preReadiness.probe.saved_layout_uid;
    if (savedLayoutUid !== expected.savedLayoutUid) throw new SnapshotContractError('SAVED_LAYOUT_UID_MISMATCH');
    return {
      identity,
      signatures,
      inventory,
      chartState,
      savedLayoutUid,
      parityHash: derivePaneIndicatorParityHash({
        paneCapacity: expected.paneCount,
        canonicalPaneIndex: signatures.canonical_pane_index,
        panes: signatures.panes,
      }),
    };
  });
}

async function readPaneSignatures(evaluate) {
  let signatures;
  try {
    signatures = await indicatorSignatures({ _deps: { evaluate } });
  } catch {
    throw new SnapshotContractError('PANE_SIGNATURES_UNAVAILABLE');
  }
  if (!signatures || typeof signatures !== 'object' || signatures.success !== true || !Array.isArray(signatures.panes)) {
    throw new SnapshotContractError('PANE_SIGNATURES_UNAVAILABLE');
  }
  return signatures;
}

async function readPaneMutationInventory(evaluate) {
  let inventory;
  try {
    inventory = await mutationIdentityInventory({ _deps: { evaluate } });
  } catch {
    throw new SnapshotContractError('PANE_MUTATION_INVENTORY_UNAVAILABLE');
  }
  if (!inventory || typeof inventory !== 'object' || inventory.success !== true || !Array.isArray(inventory.panes)) {
    throw new SnapshotContractError('PANE_MUTATION_INVENTORY_UNAVAILABLE');
  }
  return inventory;
}

async function readChartState(evaluate) {
  let chartState;
  try {
    chartState = await getState({ _deps: { evaluate } });
  } catch {
    throw new SnapshotContractError('CHART_STATE_UNAVAILABLE');
  }
  assertChartState(chartState);
  return chartState;
}

async function readRawIdentity(evaluate) {
  let identity;
  try {
    identity = await evaluate(OBSERVER_IDENTITY_EVIDENCE_EXPRESSION, { awaitPromise: true });
  } catch {
    throw new SnapshotContractError('IDENTITY_READ_UNAVAILABLE');
  }
  if (!identity || identity.error || !HASH.test(String(identity.account_subject_sha256 || ''))) {
    throw new SnapshotContractError('IDENTITY_READ_UNAVAILABLE');
  }
  return {
    chart_id: String(identity.chart_id || ''),
    layout_id: String(identity.layout_id || ''),
    account_subject_sha256: String(identity.account_subject_sha256),
  };
}

function assertExpectedIdentity(identity, expected) {
  if (identity.chart_id !== expected.chartId) throw new SnapshotContractError('CHART_ID_MISMATCH');
  if (identity.layout_id !== expected.workspaceLayoutId) throw new SnapshotContractError('WORKSPACE_LAYOUT_MISMATCH');
  if (identity.account_subject_sha256 !== expected.accountSubjectHash) throw new SnapshotContractError('ACCOUNT_HASH_MISMATCH');
}

function assertIdentityStable(before, after) {
  if (before.chart_id !== after.chart_id
    || before.layout_id !== after.layout_id
    || before.account_subject_sha256 !== after.account_subject_sha256) {
    throw new SnapshotContractError('POST_IDENTITY_DRIFT');
  }
}

function assertReadinessStable(before, after, expected) {
  const beforeProbe = before.probe;
  const afterProbe = after.probe;
  if (!beforeProbe || !afterProbe
    || beforeProbe.profile_id !== expected.profileId
    || beforeProbe.target_id !== expected.targetId
    || beforeProbe.target_url !== expected.targetUrl
    || afterProbe.profile_id !== expected.profileId
    || afterProbe.target_id !== expected.targetId
    || afterProbe.target_url !== expected.targetUrl
    || beforeProbe.workspace_layout_id !== expected.workspaceLayoutId
    || afterProbe.workspace_layout_id !== expected.workspaceLayoutId
    || beforeProbe.saved_layout_uid !== expected.savedLayoutUid
    || afterProbe.saved_layout_uid !== expected.savedLayoutUid) {
    throw new SnapshotContractError('READINESS_IDENTITY_DRIFT');
  }
}

function validatePreReadinessAuthority(readiness, expected) {
  const probe = readiness?.probe;
  if (!probe
    || probe.profile_id !== expected.profileId
    || probe.target_id !== expected.targetId
    || probe.target_url !== expected.targetUrl) {
    return 'TARGET_BINDING_UNAVAILABLE';
  }
  if (probe.workspace_layout_id !== expected.workspaceLayoutId) return 'WORKSPACE_LAYOUT_MISMATCH';
  if (probe.saved_layout_uid !== expected.savedLayoutUid) return 'SAVED_LAYOUT_UID_MISMATCH';
  return null;
}

function assertPaneEvidence(signatures, inventory, expectedPaneCount) {
  if (signatures?.success !== true || inventory?.success !== true
    || signatures.pane_count !== expectedPaneCount || inventory.pane_count !== expectedPaneCount
    || signatures.canonical_pane_index !== 0 || inventory.canonical_pane_index !== 0
    || signatures.panes.length !== expectedPaneCount || inventory.panes.length !== expectedPaneCount) {
    throw new SnapshotContractError('PANE_EVIDENCE_MISMATCH');
  }
  for (let index = 0; index < expectedPaneCount; index += 1) {
    const signaturePane = signatures.panes[index];
    const inventoryPane = inventory.panes[index];
    if (signaturePane.index !== index || inventoryPane.index !== index
      || signaturePane.indicators.length !== inventoryPane.indicators.length) {
      throw new SnapshotContractError('PANE_EVIDENCE_MISMATCH');
    }
    const signatureIndicators = signaturePane.indicators.map(stableIndicator).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
    const inventoryIndicators = inventoryPane.indicators.map(stableMutationIndicator).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
    for (let indicatorIndex = 0; indicatorIndex < signatureIndicators.length; indicatorIndex += 1) {
      if (canonicalJson(signatureIndicators[indicatorIndex]) !== canonicalJson(inventoryIndicators[indicatorIndex])) {
        throw new SnapshotContractError('PANE_EVIDENCE_MISMATCH');
      }
    }
  }
}

function assertChartState(chartState) {
  if (chartState?.success !== true || typeof chartState.symbol !== 'string'
    || typeof chartState.resolution !== 'string' || typeof chartState.chartType !== 'number'
    || !Array.isArray(chartState.studies)) throw new SnapshotContractError('CHART_STATE_UNAVAILABLE');
}

async function safeWaitReady(waitReady, input) {
  try {
    return await waitReady(input);
  } catch {
    return null;
  }
}

function normalizeContentError(error) {
  if (error instanceof SnapshotContractError) return error.code;
  return 'TARGET_BINDING_UNAVAILABLE';
}

function boundedDependencyNumber(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function blockedSnapshot(expected, reason, preReadiness, postReadiness) {
  return {
    success: true,
    snapshot_version: 'chart-runtime-content-snapshot-v1',
    status: 'BLOCKED',
    block_reason: reason,
    profile_id: expected.profileId,
    target_id: expected.targetId,
    target_url: expected.targetUrl,
    chart_id: null,
    workspace_layout_id: null,
    saved_layout_uid: null,
    account_subject_sha256: null,
    pane_count: null,
    chart_symbol: null,
    chart_resolution: null,
    chart_type: null,
    chart_state: null,
    pane_indicator_signatures: null,
    pane_mutation_inventory: null,
    indicator_parity_hash: null,
    pre_readiness: preReadiness,
    post_readiness: postReadiness,
    mutations_performed: false,
  };
}

function normalizeInput(input) {
  const expected = {
    profileId: text(input.profile_id),
    targetId: text(input.target_id),
    targetUrl: text(input.target_url),
    chartId: text(input.expected_chart_id),
    workspaceLayoutId: text(input.expected_workspace_layout_id),
    savedLayoutUid: text(input.expected_saved_layout_uid),
    paneCount: Number(input.expected_pane_count),
    accountSubjectHash: text(input.expected_account_subject_sha256),
  };
  if (Object.values(expected).some((value) => value === '')
    || !Number.isInteger(expected.paneCount) || expected.paneCount < 1 || expected.paneCount > 16
    || !HASH.test(expected.accountSubjectHash)) throw new Error('Chart runtime content snapshot input is invalid.');
  return expected;
}

function stableIndicator(indicator) {
  return {
    indicator_id: indicator.indicator_id,
    entity_id: indicator.entity_id,
    indicator_name: indicator.indicator_name,
    is_price_study: indicator.is_price_study,
    settings: indicator.settings,
  };
}

function stableMutationIndicator(indicator) {
  return stableIndicator(indicator);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function text(value) { return typeof value === 'string' ? value.trim() : String(value || '').trim(); }

class SnapshotContractError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
