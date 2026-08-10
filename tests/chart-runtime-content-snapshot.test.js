import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { z } from 'zod';

import { chartRuntimeContentSnapshot } from '../src/core/chart-runtime-content-snapshot.js';
import {
  chartRuntimeContentSnapshotOutput,
  observerToolDefinitions,
} from '../src/release/observer-schema.js';
import { derivePaneIndicatorParityHash } from '../src/core/pane.js';

const INPUT = {
  profile_id: 'profile-disposable',
  target_id: 'target-exact',
  target_url: 'https://www.tradingview.com/chart/SJ0J0zgb/',
  expected_chart_id: 'SJ0J0zgb',
  expected_workspace_layout_id: '8',
  expected_saved_layout_uid: 'SJ0J0zgb',
  expected_pane_count: 8,
  expected_account_subject_sha256: 'a'.repeat(64),
};

function readiness(overrides = {}) {
  return {
    success: true,
    wait_version: 'chart-runtime-wait-ready-v1',
    status: 'READY',
    attempts: 1,
    elapsed_ms: 1,
    probe: {
      success: true,
      probe_version: 'chart-runtime-readiness-probe-v1',
      profile_id: INPUT.profile_id,
      target_id: INPUT.target_id,
      target_url: INPUT.target_url,
      profile_state: 'ready',
      target_state: 'exact',
      document_ready_state: 'complete',
      current_url: INPUT.target_url,
      current_path: '/chart/SJ0J0zgb/',
      tradingview_api_present: true,
      tradingview_api_type: 'object',
      chart_widget_collection_present: true,
      chart_widget_collection_type: 'object',
      active_widget_wrapper_present: true,
      active_widget_wrapper_type: 'object',
      active_widget_value_callable: true,
      active_widget_non_null: true,
      workspace_layout_status: 'ready',
      workspace_layout_id: INPUT.expected_workspace_layout_id,
      saved_layout_meta_info_status: 'ready',
      saved_layout_meta_info_type: 'object',
      saved_layout_uid: INPUT.expected_saved_layout_uid,
      saved_layout_uid_ready: true,
      account_subject_candidate_count: 1,
      account_subject_state: 'ready',
      disconnected_session_state: 'absent',
      disconnected_popup_count: 0,
      exact_connect_count: 0,
      login_state: 'absent',
      login_marker_count: 0,
      mutations_performed: false,
      probe_error: null,
      ready: true,
      ...overrides,
    },
    mutations_performed: false,
  };
}

function paneEvidence(paneCount = 8) {
  const panes = Array.from({ length: paneCount }, (_, index) => ({
    index,
    signature: 'b'.repeat(64),
    indicators: [{
      indicator_id: 'EMA@tv-basicstudies',
      entity_id: `study-${index}`,
      indicator_name: 'Moving Average Exponential',
      is_price_study: false,
      settings: { length: 20 },
    }],
  }));
  const signatures = {
    success: true,
    schema_version: 'pane-indicator-signatures-v1',
    pane_count: paneCount,
    canonical_pane_index: 0,
    panes,
  };
  const inventory = {
    success: true,
    schema_version: 'pane-indicator-mutation-inventory-v1',
    pane_count: paneCount,
    canonical_pane_index: 0,
    panes: panes.map((pane) => ({
      index: pane.index,
      indicators: pane.indicators.map((indicator) => ({
        ...indicator,
        get_study_by_id_resolves: true,
        present_in_get_all_studies: true,
        mutation_visible: true,
      })),
    })),
  };
  return { signatures, inventory };
}

function rawDeps({
  identity = INPUT.expected_account_subject_sha256,
  signatures,
  inventory,
  chartState,
  identitySequence,
  signaturesSequence,
  inventorySequence,
  chartStateSequence,
  rawCalls,
} = {}) {
  const evidence = paneEvidence();
  const sequences = {
    identity: [...(identitySequence || [])],
    signatures: [...(signaturesSequence || [])],
    inventory: [...(inventorySequence || [])],
    chartState: [...(chartStateSequence || [])],
  };
  const indexes = { identity: 0, signatures: 0, inventory: 0, chartState: 0 };
  let call = 0;
  const next = (name, fallback) => {
    const sequence = sequences[name];
    const value = sequence.length > 0 ? sequence[Math.min(indexes[name]++, sequence.length - 1)] : fallback;
    if (value instanceof Error) throw value;
    return value;
  };
  const evaluate = async (expression) => {
    call += 1;
    if (expression.includes('account_subject_sha256')) {
      return next('identity', { chart_id: INPUT.expected_chart_id, layout_id: INPUT.expected_workspace_layout_id, account_subject_sha256: identity });
    }
    if (expression.includes('pane indicator inventory')) return next('signatures', signatures || evidence.signatures);
    if (expression.includes('mutation identity inventory')) return next('inventory', inventory || evidence.inventory);
    if (expression.includes('getAllStudies')) return next('chartState', chartState || { success: true, symbol: 'NQ1!', resolution: '60', chartType: 1, studies: [] });
    throw new Error(`unexpected raw expression ${call}`);
  };
  return {
    waitReady: async () => readiness(),
    withExactRawTarget: async (_input, operation) => {
      if (rawCalls) rawCalls.count += 1;
      return operation({ evaluate });
    },
    contentWaitTimeoutMs: 1,
    contentPollIntervalMs: 1,
    now: () => 0,
    sleep: async () => {},
  };
}

function relativeRawTargetDeps() {
  const evidence = paneEvidence();
  const evaluate = async (expression) => {
    if (expression.includes('account_subject_sha256')) {
      return { chart_id: INPUT.expected_chart_id, layout_id: INPUT.expected_workspace_layout_id, account_subject_sha256: INPUT.expected_account_subject_sha256 };
    }
    if (expression.includes('pane indicator inventory')) return evidence.signatures;
    if (expression.includes('mutation identity inventory')) return evidence.inventory;
    if (expression.includes('getAllStudies')) return { success: true, symbol: 'NQ1!', resolution: '60', chartType: 1, studies: [] };
    throw new Error('unexpected raw expression');
  };
  return {
    waitReady: async () => readiness(),
    fetch: async (url) => {
      if (url.endsWith('/profiles')) return { ok: true, json: async () => [{ id: INPUT.profile_id, status: 'running', cdp_url: `/api/profiles/${INPUT.profile_id}/cdp/` }] };
      if (url.endsWith('/json/list')) return { ok: true, json: async () => [{ id: INPUT.target_id, type: 'page', url: INPUT.target_url, webSocketDebuggerUrl: 'ws://target-exact' }] };
      throw new Error(`unexpected URL: ${url}`);
    },
    managerBaseUrl: 'http://127.0.0.1:8080/api',
    connect: async () => ({ Runtime: { enable: async () => {}, evaluate: async () => ({ result: { value: undefined } }) }, close: async () => {} }),
    rawEvaluate: evaluate,
    contentWaitTimeoutMs: 1,
    contentPollIntervalMs: 1,
    now: () => 0,
    sleep: async () => {},
  };
}

test('readiness block prevents raw content extraction and clicking', async () => {
  let rawCalls = 0;
  const result = await chartRuntimeContentSnapshot(INPUT, {
    waitReady: async () => ({ ...readiness(), status: 'DISCONNECTED_SESSION_PRESENT' }),
    withExactRawTarget: async () => { rawCalls += 1; throw new Error('must not attach'); },
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.block_reason, 'PRE_READINESS_DISCONNECTED_SESSION_PRESENT');
  assert.equal(rawCalls, 0);
  assert.equal(result.mutations_performed, false);
});

test('login, target drift, and readiness-not-ready states block before content', async () => {
  for (const status of ['LOGIN_REQUIRED', 'TARGET_CHANGED', 'TIMEOUT_NOT_READY', 'IDENTITY_AMBIGUOUS']) {
    let rawCalls = 0;
    const result = await chartRuntimeContentSnapshot(INPUT, {
      waitReady: async () => ({ ...readiness(), status }),
      withExactRawTarget: async () => { rawCalls += 1; throw new Error('must not attach'); },
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(rawCalls, 0);
  }
});

test('READY snapshot reuses deterministic pane schemas and parity derivation', async () => {
  const result = await chartRuntimeContentSnapshot(INPUT, rawDeps());
  assert.equal(result.status, 'READY');
  assert.equal(result.chart_id, INPUT.expected_chart_id);
  assert.equal(result.workspace_layout_id, INPUT.expected_workspace_layout_id);
  assert.equal(result.saved_layout_uid, INPUT.expected_saved_layout_uid);
  assert.equal(result.account_subject_sha256, INPUT.expected_account_subject_sha256);
  assert.equal(result.pane_count, 8);
  assert.equal(result.pane_indicator_signatures.schema_version, 'pane-indicator-signatures-v1');
  assert.equal(result.pane_mutation_inventory.schema_version, 'pane-indicator-mutation-inventory-v1');
  assert.equal(result.indicator_parity_hash, derivePaneIndicatorParityHash({
    paneCapacity: result.pane_indicator_signatures.pane_count,
    canonicalPaneIndex: result.pane_indicator_signatures.canonical_pane_index,
    panes: result.pane_indicator_signatures.panes,
  }));
  assert.equal(result.mutations_performed, false);
  assert.equal(result.pre_readiness.status, 'READY');
  assert.equal(result.post_readiness.status, 'READY');
  assert.doesNotThrow(() => z.object(chartRuntimeContentSnapshotOutput).parse(result));
});

test('transient identity, signature, inventory, and chart-state reads retry and converge', async () => {
  const cases = [
    ['identity', { identitySequence: [new Error('identity transient'), { chart_id: INPUT.expected_chart_id, layout_id: INPUT.expected_workspace_layout_id, account_subject_sha256: INPUT.expected_account_subject_sha256 }] }],
    ['signatures', { signaturesSequence: [new Error('signatures transient'), paneEvidence().signatures] }],
    ['inventory', { inventorySequence: [new Error('inventory transient'), paneEvidence().inventory] }],
    ['chart state', { chartStateSequence: [new Error('chart state transient'), { success: true, symbol: 'NQ1!', resolution: '60', chartType: 1, studies: [] }] }],
  ];
  for (const [label, options] of cases) {
    const result = await chartRuntimeContentSnapshot(INPUT, rawDeps(options));
    assert.equal(result.status, 'READY', label);
    assert.equal(result.mutations_performed, false, label);
  }
});

test('persistent content reader failures return stage-specific block reasons and final readiness', async () => {
  const cases = [
    ['PANE_SIGNATURES_UNAVAILABLE', { signaturesSequence: [new Error('signature secret')] }],
    ['PANE_MUTATION_INVENTORY_UNAVAILABLE', { inventorySequence: [new Error('inventory secret')] }],
    ['CHART_STATE_UNAVAILABLE', { chartStateSequence: [new Error('chart secret')] }],
  ];
  for (const [blockReason, options] of cases) {
    const result = await chartRuntimeContentSnapshot(INPUT, rawDeps(options));
    assert.equal(result.status, 'BLOCKED', blockReason);
    assert.equal(result.block_reason, blockReason);
    assert.equal(result.post_readiness.status, 'READY', blockReason);
    assert.doesNotMatch(JSON.stringify(result), /secret/u, blockReason);
  }
});

test('authority mismatches terminate immediately without content retry', async () => {
  const rawCalls = { count: 0 };
  const result = await chartRuntimeContentSnapshot(INPUT, rawDeps({
    identity: 'c'.repeat(64),
    rawCalls,
  }));
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.block_reason, 'ACCOUNT_HASH_MISMATCH');
  assert.equal(rawCalls.count, 1);
  assert.equal(result.post_readiness, null);
});

test('pre-readiness workspace and saved UID mismatches terminate without retry', async () => {
  for (const [blockReason, overrides] of [
    ['WORKSPACE_LAYOUT_MISMATCH', { workspace_layout_id: '4' }],
    ['SAVED_LAYOUT_UID_MISMATCH', { saved_layout_uid: 'other' }],
  ]) {
    const rawCalls = { count: 0 };
    const result = await chartRuntimeContentSnapshot(INPUT, {
      ...rawDeps({ rawCalls }),
      waitReady: async () => readiness(overrides),
    });
    assert.equal(result.status, 'BLOCKED', blockReason);
    assert.equal(result.block_reason, blockReason);
    assert.equal(rawCalls.count, 0);
    assert.equal(result.post_readiness, null);
  }
});

test('pane evidence mismatch may retry and converge', async () => {
  const bad = paneEvidence(7);
  const good = paneEvidence();
  const result = await chartRuntimeContentSnapshot(INPUT, rawDeps({
    signaturesSequence: [bad.signatures, good.signatures],
    inventorySequence: [bad.inventory, good.inventory],
  }));
  assert.equal(result.status, 'READY');
  assert.equal(result.mutations_performed, false);
});

test('content snapshot uses corrected relative Manager CDP binding', async () => {
  const dependencies = relativeRawTargetDeps();
  dependencies.connect = async () => ({
    Runtime: {
      enable: async () => {},
      evaluate: async ({ expression }) => ({ result: { value: await dependencies.rawEvaluate(expression) } }),
    },
    close: async () => {},
  });
  const result = await chartRuntimeContentSnapshot(INPUT, dependencies);
  assert.equal(result.status, 'READY');
});

test('independent account, workspace, saved UID, and pane-count drift blocks', async () => {
  const cases = [
    ['account hash', rawDeps({ identity: 'c'.repeat(64) })],
    ['workspace layout', { ...rawDeps(), waitReady: async () => readiness({ workspace_layout_id: '4' }) }],
    ['saved UID', { ...rawDeps(), waitReady: async () => readiness({ saved_layout_uid: 'other' }) }],
    ['pane count', rawDeps({ signatures: paneEvidence(7).signatures, inventory: paneEvidence(7).inventory })],
  ];
  for (const [label, dependencies] of cases) {
    const result = await chartRuntimeContentSnapshot(INPUT, dependencies);
    assert.equal(result.status, 'BLOCKED', label);
  }
});

test('post-readiness identity drift invalidates whole snapshot', async () => {
  let waits = 0;
  let rawCalls = 0;
  const evidence = paneEvidence();
  const result = await chartRuntimeContentSnapshot(INPUT, {
    waitReady: async () => { waits += 1; return readiness(); },
    withExactRawTarget: async (_input, operation) => {
      rawCalls += 1;
      const identity = rawCalls === 1 ? INPUT.expected_account_subject_sha256 : 'd'.repeat(64);
      return operation({ evaluate: async (expression) => {
        if (expression.includes('account_subject_sha256')) return { chart_id: INPUT.expected_chart_id, layout_id: INPUT.expected_workspace_layout_id, account_subject_sha256: identity };
        if (expression.includes('pane indicator inventory')) return evidence.signatures;
        if (expression.includes('mutation identity inventory')) return evidence.inventory;
        if (expression.includes('getAllStudies')) return { success: true, symbol: 'NQ1!', resolution: '60', chartType: 1, studies: [] };
        throw new Error('unexpected expression');
      } });
    },
  });
  assert.equal(waits, 2);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.block_reason, 'ACCOUNT_HASH_MISMATCH');
  assert.equal(result.account_subject_sha256, null);
});

test('raw account identity never appears in snapshot output or errors', async () => {
  const secret = 'raw-account-subject-secret';
  const result = await chartRuntimeContentSnapshot(INPUT, {
    waitReady: async () => readiness(),
    contentWaitTimeoutMs: 1,
    contentPollIntervalMs: 1,
    now: () => 0,
    sleep: async () => {},
    withExactRawTarget: async (_input, operation) => operation({
      evaluate: async (expression) => {
        if (expression.includes('account_subject_sha256')) throw new Error(secret);
        throw new Error('unexpected');
      },
    }),
  });
  assert.equal(result.status, 'BLOCKED');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, 'u'));
});

test('content snapshot source has no bound recovery or mutation path', async () => {
  const source = await readFile(new URL('../src/core/chart-runtime-content-snapshot.js', import.meta.url), 'utf8');
  for (const forbidden of [/getBoundClient/iu, /recoverDisconnectedSession/iu, /\.click\s*\(/u, /Page\.navigate/iu, /\.reload\s*\(/u, /Target\.createTarget/iu, /saveExisting/iu, /\.focus\s*\(/u]) {
    assert.doesNotMatch(source, forbidden);
  }
  assert.doesNotMatch(source, /CONTENT_READ_FAILED/iu);
  assert.equal(observerToolDefinitions.chart_runtime_content_snapshot_v1.classification, 'read_only');
});
