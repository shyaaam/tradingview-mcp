import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  SERVER_NAME,
  SERVER_VERSION,
  buildObserverContract,
  resolveReleaseCommit,
} from '../src/release/identity.js';
import { installStdioLifecycle } from '../src/release/lifecycle.js';
import {
  observerCapabilityManifest,
  observerManifestCanonicalJson,
  observerManifestHash,
} from '../src/release/manifest.js';
import { observerToolDefinitions } from '../src/release/observer-schema.js';
import { registerReleaseTools } from '../src/tools/release.js';
import { registerHealthTools } from '../src/tools/health.js';
import { registerObserverEvidenceTools } from '../src/tools/observer-evidence.js';
import { registerTabTools } from '../src/tools/tab.js';
import { registerPaneTools } from '../src/tools/pane.js';
import { registerChartTools } from '../src/tools/chart.js';
import { registerChartTargetHydrationTool } from '../src/tools/chart-target-hydration.js';
import { registerIndicatorTools } from '../src/tools/indicators.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function cleanGitExec(command, args) {
  if (command !== 'git') throw new Error('unexpected command');
  if (args[0] === 'rev-parse') return `${COMMIT}\n`;
  if (args[0] === 'diff') return '';
  throw new Error('unexpected git args');
}

test('package, runtime pin, server, and observer contract share one version authority', async () => {
  const pinnedNode = (await readFile(new URL('../docs/runtime/node-version.txt', import.meta.url), 'utf8')).trim();
  assert.equal(SERVER_NAME, 'tradingview-mcp');
  assert.equal(SERVER_VERSION, packageJson.version);
  assert.equal(packageJson.version, '2.0.0');
  assert.equal(packageJson.engines.node, pinnedNode);
  assert.equal(process.versions.node, pinnedNode);
  const contract = buildObserverContract({
    env: { TRADINGVIEW_MCP_RELEASE_COMMIT: COMMIT },
    execFileSyncImpl: cleanGitExec,
  });
  assert.equal(contract.serverVersion, packageJson.version);
  assert.equal(contract.releaseReady, true);
  assert.equal(contract.expectedCommit, COMMIT);
  assert.equal(contract.observedCommit, COMMIT);
});

test('observer manifest is canonical, immutable, and uniquely classified', () => {
  assert.match(observerManifestHash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(observerManifestCanonicalJson).contractId, 'tv-observer-v1');
  assert.equal(Object.isFrozen(observerCapabilityManifest), true);

  const names = observerCapabilityManifest.capabilities.map((capability) => capability.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names, [
    'tv_observer_contract',
    'tv_health_check',
    'tv_observer_prepare',
    'tv_observer_hydrate_chart_target',
    'tv_observer_identity',
    'tv_observer_capture_candle',
    'tv_observer_capture_telemetry_ohlcv',
    'tv_observer_capture_pane_telemetry_ohlcv',
    'tv_observer_capture_named_plot_telemetry',
    'tab_list',
    'tab_new',
    'tab_switch',
    'pane_list',
    'pane_indicator_signatures',
    'pane_indicator_mutation_inventory',
    'indicator_apply_scoped',
    'indicator_update_settings_scoped',
    'indicator_remove_scoped',
    'pane_probe_layout_capability',
    'chart_get_state',
    'chart_saved_layout_identity',
    'chart_save_existing_scoped_v2',
    'chart_set_symbol',
    'chart_set_timeframe',
  ]);
  assert.equal(names.includes('data_get_ohlcv'), false);
  assert.equal(names.includes('capture_screenshot'), false);

  const classifications = Object.fromEntries(observerCapabilityManifest.capabilities.map((capability) => [capability.name, capability.classification]));
  assert.deepEqual({
    pane_indicator_signatures: classifications.pane_indicator_signatures,
    pane_indicator_mutation_inventory: classifications.pane_indicator_mutation_inventory,
    indicator_apply_scoped: classifications.indicator_apply_scoped,
    indicator_update_settings_scoped: classifications.indicator_update_settings_scoped,
    indicator_remove_scoped: classifications.indicator_remove_scoped,
    chart_saved_layout_identity: classifications.chart_saved_layout_identity,
    chart_save_existing_scoped_v2: classifications.chart_save_existing_scoped_v2,
    tv_observer_capture_pane_telemetry_ohlcv: classifications.tv_observer_capture_pane_telemetry_ohlcv,
    tv_observer_capture_named_plot_telemetry: classifications.tv_observer_capture_named_plot_telemetry,
  }, {
    pane_indicator_signatures: 'read_only',
    pane_indicator_mutation_inventory: 'read_only',
    indicator_apply_scoped: 'chart_mutation',
    indicator_update_settings_scoped: 'chart_mutation',
    indicator_remove_scoped: 'chart_mutation',
    chart_saved_layout_identity: 'read_only',
    chart_save_existing_scoped_v2: 'chart_mutation',
    tv_observer_capture_pane_telemetry_ohlcv: 'read_only',
    tv_observer_capture_named_plot_telemetry: 'read_only',
  });

  for (const capability of observerCapabilityManifest.capabilities) {
    assert.equal(capability.inputSchema.type, 'object');
    assert.equal(capability.resultSchema.type, 'object');
    assert.match(capability.classification, /^(read_only|bootstrap_mutation|browser_focus_mutation|chart_mutation)$/);
    assert.deepEqual(capability.inputSchema, schemaFor(observerToolDefinitions[capability.name].inputSchema, true));
    assert.deepEqual(capability.resultSchema, schemaFor(observerToolDefinitions[capability.name].outputSchema));
  }
});

test('every observer capability is registered by the MCP tool groups', () => {
  const registered = new Set();
  const fakeServer = { tool: (name) => { registered.add(name); } };
  registerReleaseTools(fakeServer);
  registerHealthTools(fakeServer);
  registerObserverEvidenceTools(fakeServer);
  registerTabTools(fakeServer);
  registerPaneTools(fakeServer);
  registerChartTools(fakeServer);
  registerChartTargetHydrationTool(fakeServer);
  registerIndicatorTools(fakeServer);

  for (const capability of observerCapabilityManifest.capabilities) {
    assert.equal(registered.has(capability.name), true, `missing MCP tool: ${capability.name}`);
  }
});

test('observer result fixtures satisfy registered output schemas', () => {
  const { z } = require('zod');
  const tabs = {
    success: true,
    tab_count: 1,
    tabs: [{ index: 0, id: 'tab-1', ws_url: null, title: 'AAPL', url: 'https://www.tradingview.com/chart/x/', chart_id: 'x' }],
  };
  const fixtures = {
    tv_observer_contract: buildObserverContract({
      env: { TRADINGVIEW_MCP_RELEASE_COMMIT: COMMIT },
      execFileSyncImpl: cleanGitExec,
    }),
    tv_health_check: {
      success: true, cdp_connected: true, target_id: 'target-1', target_url: 'https://www.tradingview.com/chart/x/',
      target_title: 'AAPL', chart_symbol: 'AAPL', chart_resolution: '60', chart_type: 1, api_available: true,
      session_state: 'connected', disconnect_popup_count: 0, exact_connect_count: 0,
      reclaim_attempted: false, reclaim_succeeded: false, reclaim_click_count: 0,
    },
    tv_observer_prepare: {
      success: true, manager_base_url: 'http://127.0.0.1:8080/api', profile_id: 'profile-a', restart_requested: false,
      status: 'running', cdp_ready: true, cdp_url: 'http://127.0.0.1:8080/api/profiles/profile-a/cdp',
      browser: 'Chrome/146', user_agent: 'test-agent', chart_target_id: 'chart-1', chart_target_url: 'https://www.tradingview.com/chart/x/',
    },
    tv_observer_hydrate_chart_target: {
      success: true,
      hydration_version: 'chart-target-hydration-v1',
      authority_id: `chart-target-authority-v1:${'a'.repeat(64)}`,
      authority_hash: 'b'.repeat(64),
      profile_id: 'profile-a',
      target_id: 'chart-1',
      target_url: 'https://www.tradingview.com/chart/x/',
      saved_chart_id: 'x',
      navigation_performed: false,
      authenticated: true,
      state: 'existing-identical',
    },
    tv_observer_identity: {
      success: true,
      profile_id: 'profile-a',
      chart_target_id: 'chart-1',
      chart_id: 'chart-id',
      layout_id: 'layout-id',
      account_subject_sha256: 'a'.repeat(64),
    },
    tv_observer_capture_candle: {
      success: true,
      symbol: 'AAPL',
      timeframe: '60',
      source_candle_time: '2026-07-17T10:00:00Z',
      captured_at: '2026-07-17T10:00:01Z',
      open: 100,
      high: 110,
      low: 95,
      close: 105,
      volume: 1234,
      adapter_version: 'tradingview-mcp-observer-v1',
    },
    tv_observer_capture_telemetry_ohlcv: {
      success: true,
      extraction_version: 'observer-telemetry-ohlcv-v1',
      symbol: 'AAPL',
      timeframe: '60',
      requested_count: 2,
      captured_at: '2026-07-17T10:00:01Z',
      candles: [
        { opened_at: '2026-07-17T08:00:00Z', open: '100', high: '110', low: '95', close: '105', volume: '1234' },
        { opened_at: '2026-07-17T09:00:00Z', open: '105', high: '112', low: '101', close: '111', volume: null },
      ],
      studies: [{
        study_id: 'study-rsi',
        study_name: 'RSI',
        values: [{ source_label: 'data-window', field_label: 'RSI', raw_value: '52.3' }],
      }],
    },
    tv_observer_capture_pane_telemetry_ohlcv: {
      success: true,
      extraction_version: 'observer-pane-telemetry-ohlcv-v1',
      profile_id: 'profile-a', chart_target_id: 'chart-1', chart_id: 'x', layout_id: '8',
      tab_index: 0, pane_index: 0, pane_count: 8, symbol: 'AAPL', timeframe: '60', requested_count: 2,
      captured_at: '2026-07-17T10:00:01Z',
      candles: [
        { opened_at: '2026-07-17T08:00:00Z', open: '100', high: '110', low: '95', close: '105', volume: '1234' },
      ],
      study_telemetry_state: 'available',
      study_telemetry_reason: null,
      studies: [{ study_id: 'study-rsi', study_name: 'RSI', values: [{ source_label: 'data-window', field_label: 'RSI', raw_value: '52.3' }] }],
    },
    tv_observer_capture_named_plot_telemetry: {
      success: true,
      extraction_version: 'observer-named-plot-telemetry-v1',
      profile_id: 'profile-a', chart_target_id: 'chart-1', chart_id: 'x', layout_id: '8',
      tab_index: 0, pane_index: 0, pane_count: 8, symbol: 'AAPL', timeframe: '60',
      study_id: 'study-telemetry', study_name: 'Telemetry Companion',
      plots: [{ plot_name: 'TVOBS_HTF_V1_PVP_RAIL', raw_value: '24123.5', value_state: 'present' }],
      captured_at: '2026-07-17T10:00:01Z',
    },
    tab_list: tabs,
    tab_new: { ...tabs, action: 'new_tab_opened' },
    tab_switch: { success: true, action: 'switched', index: 0, tab_id: 'tab-1', chart_id: 'x' },
    pane_list: {
      success: true, layout: 's', layout_name: '1 chart', chart_count: 1, active_index: 0,
      panes: [{ index: 0, symbol: 'AAPL', resolution: '60' }],
    },
    pane_indicator_signatures: {
      success: true,
      schema_version: 'pane-indicator-signatures-v1',
      profile_id: 'profile-a', chart_target_id: 'chart-1', chart_id: 'x', tab_index: 0, pane_index: 0,
      pane_count: 1, canonical_pane_index: 0,
      panes: [{ index: 0, signature: 'a'.repeat(64), indicators: [{
        indicator_id: 'RSI@tv-basicstudies', entity_id: 'study-1', indicator_name: 'Relative Strength Index',
        is_price_study: false, settings: { length: 14 },
      }] }],
    },
    pane_indicator_mutation_inventory: {
      success: true,
      schema_version: 'pane-indicator-mutation-inventory-v1',
      profile_id: 'profile-a', chart_target_id: 'chart-1', chart_id: 'x', tab_index: 0, pane_index: 0,
      pane_count: 1, canonical_pane_index: 0,
      panes: [{ index: 0, signature: 'a'.repeat(64), indicators: [{
        indicator_id: 'RSI@tv-basicstudies', entity_id: 'study-1', indicator_name: 'Relative Strength Index',
        is_price_study: false, settings: { length: 14 }, get_study_by_id_resolves: true,
        present_in_get_all_studies: true, mutation_visible: true,
      }] }],
    },
    indicator_apply_scoped: {
      success: true, profile_id: 'profile-a', chart_target_id: 'chart-1', chart_id: 'x', tab_index: 0, pane_index: 0,
      indicator_name: 'Relative Strength Index', action: 'apply_indicator', entity_id: 'study-1',
      pre_mutation_signature: 'a'.repeat(64), post_mutation_signature: 'b'.repeat(64),
      post_mutation_indicator_count: 1, mutations_performed: true, focus: { success: true, focused_index: 0 },
    },
    indicator_update_settings_scoped: {
      success: true, profile_id: 'profile-a', chart_target_id: 'chart-1', chart_id: 'x', tab_index: 0, pane_index: 0,
      indicator_name: 'Relative Strength Index', action: 'update_indicator_settings', entity_id: 'study-1',
      pre_mutation_signature: 'a'.repeat(64), post_mutation_signature: 'b'.repeat(64),
      post_mutation_indicator_count: 1, mutations_performed: true, focus: { success: true, focused_index: 0 },
    },
    indicator_remove_scoped: {
      success: true, profile_id: 'profile-a', chart_target_id: 'chart-1', chart_id: 'x', tab_index: 0, pane_index: 0,
      indicator_name: 'Relative Strength Index', action: 'remove_indicator', entity_id: 'study-1',
      pre_mutation_signature: 'a'.repeat(64), post_mutation_signature: 'b'.repeat(64),
      post_mutation_indicator_count: 0, mutations_performed: true, focus: { success: true, focused_index: 0 },
    },
    pane_probe_layout_capability: {
      success: true,
      probe_version: 'pane-layout-capability-probe-v1',
      requested_layout: '4',
      requested_pane_count: 4,
      observed_layout: '4',
      observed_pane_count: 4,
      supported: true,
      stable: true,
      focus_validation_requested: true,
      focus_validated: true,
      restoration_attempted: true,
      restoration_succeeded: true,
      failure_reason: null,
      error_detail: null,
      before: { layout: 's', chart_count: 1, active_index: 0, panes: [{ index: 0, symbol: 'AAPL', resolution: '60' }] },
      observed: { layout: '4', chart_count: 4, active_index: 3, panes: [] },
      restored: { layout: 's', chart_count: 1, active_index: 0, panes: [{ index: 0, symbol: 'AAPL', resolution: '60' }] },
      observations: [],
    },
    chart_get_state: { success: true, symbol: 'AAPL', resolution: '60', chartType: 1, studies: [{ id: 'study-1', name: 'Volume' }] },
    chart_saved_layout_identity: {
      success: true,
      schema_version: 'chart-saved-layout-identity-v1',
      profile_id: 'profile-a', chart_target_id: 'target-1', chart_id: 'x',
      canonical_url: 'https://www.tradingview.com/chart/x/', tab_index: 0,
      workspace_layout_id: '8', saved_layout_uid: 'layout-uid', pane_count: 8,
    },
    chart_save_existing_scoped_v2: {
      success: true,
      save_version: 'chart-save-existing-scoped-v2',
      profile_id: 'profile-a', chart_target_id: 'chart-1', chart_id: 'x',
      canonical_url: 'https://www.tradingview.com/chart/x/',
      workspace_layout_id: '8', saved_layout_uid: 'x', pane_count: 1,
      indicator_parity_sha256: 'a'.repeat(64), saved_existing: true,
      mutations_performed: true, save_invoked: true, effect_state: 'confirmed',
      effect_phase: 'post-save-verification', save_callback_confirmed: true, retry_safe: true,
    },
    chart_set_symbol: { success: true, symbol: 'AAPL', chart_ready: true },
    chart_set_timeframe: { success: true, timeframe: '60', chart_ready: true },
  };

  for (const capability of observerCapabilityManifest.capabilities) {
    assert.doesNotThrow(() => z.object(observerToolDefinitions[capability.name].outputSchema).parse(fixtures[capability.name]), capability.name);
  }
});

test('release commit is machine-readable and fails closed on invalid configuration', () => {
  assert.deepEqual(
    resolveReleaseCommit({ env: { TRADINGVIEW_MCP_RELEASE_COMMIT: COMMIT }, execFileSyncImpl: cleanGitExec }),
    {
      commit: COMMIT,
      source: 'git',
      expectedCommit: COMMIT,
      observedCommit: COMMIT,
      commitMatch: true,
      dirty: false,
    },
  );
  assert.equal(
    resolveReleaseCommit({ env: { TRADINGVIEW_MCP_RELEASE_COMMIT: COMMIT }, execFileSyncImpl: () => {
      throw new Error('git unavailable');
    }, readFileSyncImpl: () => JSON.stringify({ commit: COMMIT }) }).source,
    'packaged',
  );
  const packagedMismatch = resolveReleaseCommit({
    env: { TRADINGVIEW_MCP_RELEASE_COMMIT: COMMIT },
    execFileSyncImpl: () => { throw new Error('git unavailable'); },
    readFileSyncImpl: () => JSON.stringify({ commit: 'fedcba9876543210fedcba9876543210fedcba98' }),
  });
  assert.equal(packagedMismatch.source, 'packaged');
  assert.equal(packagedMismatch.commitMatch, false);
  const mismatch = resolveReleaseCommit({
    env: { TRADINGVIEW_MCP_RELEASE_COMMIT: COMMIT },
    execFileSyncImpl: (command, args) => args[0] === 'rev-parse' ? 'fedcba9876543210fedcba9876543210fedcba98\n' : '',
  });
  assert.equal(mismatch.commitMatch, false);
  assert.equal(mismatch.observedCommit, 'fedcba9876543210fedcba9876543210fedcba98');
  const dirty = resolveReleaseCommit({
    env: {},
    execFileSyncImpl: (command, args) => {
      if (args[0] === 'rev-parse') return `${COMMIT}\n`;
      throw new Error('dirty');
    },
  });
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.commitMatch, true);
  assert.throws(
    () => resolveReleaseCommit({ env: { TRADINGVIEW_MCP_RELEASE_COMMIT: 'not-a-commit' } }),
    /40-character commit/,
  );
  assert.deepEqual(
    resolveReleaseCommit({ env: {}, execFileSyncImpl: () => { throw new Error('no git'); } }),
    {
      commit: null,
      source: 'unavailable',
      expectedCommit: null,
      observedCommit: null,
      commitMatch: false,
      dirty: false,
    },
  );
});

test('stdio lifecycle closes once on repeated shutdown requests', async () => {
  const processLike = new EventEmitter();
  processLike.stdin = new EventEmitter();
  processLike.exitCode = undefined;
  let closes = 0;
  const lifecycle = installStdioLifecycle({
    processLike,
    shutdownGraceMs: 100,
    close: async () => { closes += 1; },
  });

  const [first, second] = await Promise.all([
    lifecycle.shutdown('test'),
    lifecycle.shutdown('duplicate'),
  ]);
  assert.equal(closes, 1);
  assert.equal(first.clean, true);
  assert.deepEqual(second, first);
  assert.equal(processLike.exitCode, 0);
});

test('stdio lifecycle responds to stdin closure and removes signal listeners', async () => {
  const processLike = new EventEmitter();
  processLike.stdin = new EventEmitter();
  processLike.exitCode = undefined;
  let closes = 0;
  const lifecycle = installStdioLifecycle({
    processLike,
    shutdownGraceMs: 100,
    close: async () => { closes += 1; },
  });
  processLike.stdin.emit('end');
  await lifecycle.shutdown('duplicate-after-stdin');
  assert.equal(closes, 1);
  assert.equal(processLike.listenerCount('SIGTERM'), 0);
  assert.equal(processLike.stdin.listenerCount('end'), 0);
});

test('stdio lifecycle fails closed when cleanup exceeds the grace period', async () => {
  const processLike = new EventEmitter();
  processLike.stdin = new EventEmitter();
  processLike.exitCode = undefined;
  let forced = 0;
  let hardExitCode;
  const lifecycle = installStdioLifecycle({
    processLike,
    shutdownGraceMs: 5,
    close: () => new Promise(() => {}),
    forceClose: () => { forced += 1; },
    hardExit: (code) => { hardExitCode = code; },
  });
  const result = await lifecycle.shutdown('timeout-test');
  assert.equal(result.clean, false);
  assert.match(result.error, /shutdown exceeded/);
  assert.equal(processLike.exitCode, 1);
  assert.equal(forced, 1);
  assert.equal(hardExitCode, 1);
});

function schemaFor(shape, strip = false) {
  const { toJSONSchema, z } = require('zod');
  if (Object.keys(shape).length === 0) {
    return {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {},
    };
  }
  const schema = toJSONSchema(z.object(shape), {
    target: 'draft-07',
    io: strip ? 'input' : 'output',
  });
  return strip ? stripRuntimeDefaults(schema) : schema;
}

function stripRuntimeDefaults(value) {
  if (Array.isArray(value)) return value.map(stripRuntimeDefaults);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'additionalProperties')
      .map(([key, entry]) => [key, stripRuntimeDefaults(entry)]),
  );
}
