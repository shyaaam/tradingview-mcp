import { z } from 'zod';

import { OBSERVER_CONTRACT_ID, OBSERVER_MANIFEST_SCHEMA_VERSION } from './constants.js';
import { requireObserverSession } from '../connection.js';

const emptyInput = Object.freeze({});
const jsonObject = z.record(z.string(), z.unknown());

const tabShape = {
  index: z.number(),
  id: z.string(),
  ws_url: z.string().nullable(),
  title: z.string(),
  url: z.string(),
  chart_id: z.string().nullable(),
};

const tabListOutput = {
  success: z.literal(true),
  tab_count: z.number().int().nonnegative(),
  tabs: z.array(z.object(tabShape)),
};

const observerIdentityOutput = {
  success: z.literal(true),
  profile_id: z.string().min(1),
  chart_target_id: z.string().min(1),
  chart_id: z.string().min(1),
  layout_id: z.string().min(1),
  account_subject_sha256: z.string().regex(/^[0-9a-f]{64}$/),
};

const savedLayoutIdentityInput = {
  profile_id: z.string().min(1),
  tab_index: z.number().int().min(0),
  chart_target_id: z.string().min(1),
  expected_chart_id: z.string().min(1),
  expected_workspace_layout_id: z.string().min(1),
  expected_saved_layout_uid: z.string().min(1),
  expected_pane_count: z.number().int().min(1).max(16),
};

const savedLayoutIdentityOutput = {
  success: z.literal(true),
  identity_version: z.literal('chart-saved-layout-identity-v1'),
  profile_id: z.string().min(1),
  chart_target_id: z.string().min(1),
  workspace_layout_id: z.string().min(1),
  saved_layout_uid: z.string().min(1),
  chart_id: z.string().min(1),
  canonical_url: z.string().url(),
  pane_count: z.number().int().min(1).max(16),
  mutations_performed: z.literal(false),
};

const chartRuntimeReadinessInput = {
  profile_id: z.string().min(1),
  target_id: z.string().min(1),
  target_url: z.string().url(),
};

const chartRuntimeReadinessOutput = {
  success: z.literal(true),
  probe_version: z.literal('chart-runtime-readiness-probe-v1'),
  profile_id: z.string().min(1),
  target_id: z.string().min(1),
  target_url: z.string().url(),
  profile_state: z.enum(['ready', 'missing', 'not-running', 'ambiguous', 'unavailable']),
  target_state: z.enum(['exact', 'missing', 'changed', 'ambiguous', 'unavailable']),
  document_ready_state: z.enum(['loading', 'interactive', 'complete', 'unavailable']),
  current_url: z.string(),
  current_path: z.string(),
  tradingview_api_present: z.boolean(),
  tradingview_api_type: z.string(),
  chart_widget_collection_present: z.boolean(),
  chart_widget_collection_type: z.string(),
  active_widget_wrapper_present: z.boolean(),
  active_widget_wrapper_type: z.string(),
  active_widget_value_callable: z.boolean(),
  active_widget_non_null: z.boolean(),
  workspace_layout_status: z.enum(['ready', 'missing', 'ambiguous', 'unavailable']),
  workspace_layout_id: z.string().nullable(),
  saved_layout_meta_info_status: z.enum(['ready', 'missing', 'ambiguous', 'unavailable']),
  saved_layout_meta_info_type: z.string(),
  saved_layout_uid: z.string().nullable(),
  saved_layout_uid_ready: z.boolean(),
  account_subject_candidate_count: z.number().int().nonnegative(),
  account_subject_state: z.enum(['ready', 'missing', 'ambiguous', 'unavailable']),
  disconnected_session_state: z.enum(['present', 'absent', 'ambiguous', 'unavailable']),
  disconnected_popup_count: z.number().int().nonnegative(),
  exact_connect_count: z.number().int().nonnegative(),
  login_state: z.enum(['present', 'absent', 'ambiguous', 'unavailable']),
  login_marker_count: z.number().int().nonnegative(),
  mutations_performed: z.literal(false),
  probe_error: z.string().nullable(),
  ready: z.boolean(),
};

const chartRuntimeWaitReadyInput = {
  ...chartRuntimeReadinessInput,
  timeout_ms: z.coerce.number().int().min(1).max(30_000).optional().default(5_000),
  poll_interval_ms: z.coerce.number().int().min(1).max(5_000).optional().default(250),
};

const chartRuntimeWaitReadyOutput = {
  success: z.literal(true),
  wait_version: z.literal('chart-runtime-wait-ready-v1'),
  status: z.enum(['READY', 'DISCONNECTED_SESSION_PRESENT', 'LOGIN_REQUIRED', 'IDENTITY_AMBIGUOUS', 'TARGET_CHANGED', 'TIMEOUT_NOT_READY']),
  attempts: z.number().int().positive(),
  elapsed_ms: z.number().int().nonnegative(),
  probe: z.object(chartRuntimeReadinessOutput),
  mutations_performed: z.literal(false),
};

const observerCaptureCandleInput = {
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  source_candle_time: z.string().datetime(),
};

const observerCaptureCandleOutput = {
  success: z.literal(true),
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  source_candle_time: z.string().datetime(),
  captured_at: z.string().datetime(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite(),
  adapter_version: z.string().min(1),
};

const manifestCapabilityShape = {
  name: z.string(),
  classification: z.enum(['read_only', 'bootstrap_mutation', 'browser_focus_mutation', 'chart_mutation']),
  inputSchema: jsonObject,
  resultSchema: jsonObject,
};

const manifestShape = {
  contractId: z.literal(OBSERVER_CONTRACT_ID),
  schemaVersion: z.literal(OBSERVER_MANIFEST_SCHEMA_VERSION),
  transport: z.object({
    kind: z.literal('stdio'),
    protocol: z.literal('mcp'),
    shellAllowed: z.literal(false),
  }),
  lifecycle: z.object({
    startupHandshakeTimeoutMs: z.number().int().positive(),
    defaultCallTimeoutMs: z.number().int().positive(),
    shutdownGraceMs: z.number().int().positive(),
    maxCapturedStderrBytes: z.number().int().positive(),
  }),
  capabilities: z.array(z.object(manifestCapabilityShape)),
};

export const observerToolDefinitions = Object.freeze({
  tv_observer_contract: {
    classification: 'read_only',
    inputSchema: emptyInput,
    outputSchema: {
      contractId: z.literal(OBSERVER_CONTRACT_ID),
      schemaVersion: z.literal(OBSERVER_MANIFEST_SCHEMA_VERSION),
      serverName: z.string(),
      serverVersion: z.string(),
      nodeVersion: z.string(),
      manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
      expectedCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
      observedCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
      releaseCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
      releaseCommitSource: z.enum(['git', 'packaged', 'unavailable']),
      releaseCommitMatch: z.boolean(),
      releaseDirty: z.boolean(),
      releaseReady: z.boolean(),
      manifest: z.object(manifestShape),
    },
  },
  tv_health_check: {
    classification: 'read_only',
    inputSchema: emptyInput,
    outputSchema: {
      success: z.literal(true),
      cdp_connected: z.literal(true),
      target_id: z.string(),
      target_url: z.string(),
      target_title: z.string(),
      chart_symbol: z.string(),
      chart_resolution: z.string(),
      chart_type: z.number().nullable(),
      api_available: z.boolean(),
      session_state: z.enum(['connected', 'reclaimed']),
      disconnect_popup_count: z.number().int().nonnegative(),
      exact_connect_count: z.number().int().nonnegative(),
      reclaim_attempted: z.boolean(),
      reclaim_succeeded: z.boolean(),
      reclaim_click_count: z.number().int().nonnegative(),
    },
  },
  tv_observer_prepare: {
    classification: 'bootstrap_mutation',
    inputSchema: {
      profile_id: z.string().min(1).describe('Exact CloakBrowser Manager profile ID; never auto-selected.'),
      restart: z.boolean().optional().describe('Stop and relaunch exact profile before preparation (default false).'),
      review_authority: z.object({
        profile_id: z.string().min(1).max(160),
        runtime_target_id: z.string().regex(/^[a-z0-9-]+:[0-9a-f]{64}$/),
        chart_target_id: z.string().min(1).max(200),
        symbol: z.string().min(1).max(160),
        timeframe: z.string().regex(/^(?:[1-9][0-9]*[mhdwM]?|[1-9][0-9]*[SDWM])$/),
        source_candle_time: z.string().datetime(),
        pane_capability_snapshot_id: z.string().regex(/^pane-capability-snapshot-v1:[0-9a-f]{64}$/),
        sticky_placement_epoch_id: z.string().regex(/^sticky-symbol-placement-epoch-v1:[0-9a-f]{64}$/),
        active_layout_transition_id: z.string().regex(/^active-pane-layout-transition-v1:[0-9a-f]{64}$/),
        active_layout_transition_hash: z.string().regex(/^[0-9a-f]{64}$/),
        tab_index: z.number().int().nonnegative(),
        pane_index: z.number().int().nonnegative(),
        mcp_release_commit: z.string().regex(/^[0-9a-f]{40}$/),
        mcp_manifest_hash: z.string().regex(/^[0-9a-f]{64}$/),
      }).optional(),
    },
    outputSchema: {
      success: z.literal(true),
      manager_base_url: z.string(),
      profile_id: z.string(),
      restart_requested: z.boolean(),
      status: z.string(),
      cdp_ready: z.boolean(),
      cdp_url: z.string().nullable(),
      browser: z.string().nullable(),
      user_agent: z.string().nullable(),
      chart_target_id: z.string().nullable(),
      chart_target_url: z.string().nullable(),
    },
  },
  tv_observer_attach_existing_read_only: {
    classification: 'read_only',
    inputSchema: {
      profile_id: z.string().min(1).describe('Exact CloakBrowser Manager profile ID; no profile selection or launch is performed.'),
      chart_target_id: z.string().min(1).describe('Exact existing TradingView target ID to attach without navigation or hydration.'),
    },
    outputSchema: {
      success: z.literal(true),
      manager_base_url: z.string(),
      profile_id: z.string(),
      status: z.string(),
      cdp_ready: z.literal(true),
      cdp_url: z.string(),
      browser: z.string().nullable(),
      user_agent: z.string().nullable(),
      chart_target_id: z.string(),
      chart_target_url: z.string().url(),
      mutations_performed: z.literal(false),
    },
  },
  chart_runtime_readiness_probe_v1: {
    classification: 'read_only',
    inputSchema: chartRuntimeReadinessInput,
    outputSchema: chartRuntimeReadinessOutput,
  },
  chart_runtime_wait_ready_v1: {
    classification: 'read_only',
    inputSchema: chartRuntimeWaitReadyInput,
    outputSchema: chartRuntimeWaitReadyOutput,
  },
  tv_observer_hydrate_chart_target: {
    classification: 'bootstrap_mutation',
    inputSchema: {
      profile_id: z.string().min(1),
      authority_id: z.string().regex(/^[a-z0-9-]+:[0-9a-f]{64}$/),
      authority_hash: z.string().regex(/^[0-9a-f]{64}$/),
      chart_url: z.string().url(),
      saved_chart_id: z.string().min(1),
      allowed_origins: z.array(z.string().url()).min(1),
    },
    outputSchema: {
      success: z.literal(true),
      hydration_version: z.literal('chart-target-hydration-v1'),
      authority_id: z.string().regex(/^[a-z0-9-]+:[0-9a-f]{64}$/),
      authority_hash: z.string().regex(/^[0-9a-f]{64}$/),
      profile_id: z.string().min(1),
      target_id: z.string().min(1),
      target_url: z.string().url(),
      saved_chart_id: z.string().min(1),
      navigation_performed: z.boolean(),
      authenticated: z.literal(true),
      state: z.enum(['hydrated', 'existing-identical']),
    },
  },
  tv_observer_identity: {
    classification: 'read_only',
    inputSchema: emptyInput,
    outputSchema: observerIdentityOutput,
    rejectUnexpectedInput: true,
  },
  chart_saved_layout_identity: {
    classification: 'read_only',
    inputSchema: savedLayoutIdentityInput,
    outputSchema: savedLayoutIdentityOutput,
  },
  tv_observer_capture_candle: {
    classification: 'read_only',
    inputSchema: observerCaptureCandleInput,
    outputSchema: observerCaptureCandleOutput,
  },
  tv_observer_capture_screenshot: {
    classification: 'read_only',
    inputSchema: {
      profile_id: z.string().min(1).max(160),
      runtime_target_id: z.string().regex(/^[a-z0-9-]+:[0-9a-f]{64}$/),
      chart_target_id: z.string().min(1).max(200),
      symbol: z.string().min(1).max(160),
      timeframe: z.string().regex(/^(?:[1-9][0-9]*[mhdwM]?|[1-9][0-9]*[SDWM])$/),
      source_candle_time: z.string().datetime(),
      pane_capability_snapshot_id: z.string().regex(/^pane-capability-snapshot-v1:[0-9a-f]{64}$/),
      sticky_placement_epoch_id: z.string().regex(/^sticky-symbol-placement-epoch-v1:[0-9a-f]{64}$/),
      active_layout_transition_id: z.string().regex(/^active-pane-layout-transition-v1:[0-9a-f]{64}$/),
      active_layout_transition_hash: z.string().regex(/^[0-9a-f]{64}$/),
      tab_index: z.number().int().nonnegative(),
      pane_index: z.number().int().nonnegative(),
      mcp_release_commit: z.string().regex(/^[0-9a-f]{40}$/),
      mcp_manifest_hash: z.string().regex(/^[0-9a-f]{64}$/),
      format: z.literal('png'),
    },
    outputSchema: {
      success: z.literal(true),
      capture_version: z.literal('observer-review-screenshot-v1'),
      profile_id: z.string().min(1).max(160),
      runtime_target_id: z.string().regex(/^[a-z0-9-]+:[0-9a-f]{64}$/),
      chart_target_id: z.string().min(1).max(200),
      symbol: z.string().min(1).max(160),
      timeframe: z.string().min(1).max(32),
      source_candle_time: z.string().datetime(),
      pane_capability_snapshot_id: z.string().regex(/^pane-capability-snapshot-v1:[0-9a-f]{64}$/),
      sticky_placement_epoch_id: z.string().regex(/^sticky-symbol-placement-epoch-v1:[0-9a-f]{64}$/),
      active_layout_transition_id: z.string().regex(/^active-pane-layout-transition-v1:[0-9a-f]{64}$/),
      active_layout_transition_hash: z.string().regex(/^[0-9a-f]{64}$/),
      tab_index: z.number().int().nonnegative(),
      pane_index: z.number().int().nonnegative(),
      mcp_release_commit: z.string().regex(/^[0-9a-f]{40}$/),
      mcp_manifest_hash: z.string().regex(/^[0-9a-f]{64}$/),
      captured_at: z.string().datetime(),
      content_type: z.literal('image/png'),
      byte_length: z.number().int().positive().max(25 * 1024 * 1024),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      png_base64: z.string().min(1),
    },
  },
  tv_observer_capture_telemetry_ohlcv: {
    classification: 'read_only',
    inputSchema: {
      symbol: z.string().min(1),
      timeframe: z.string().min(1),
      count: z.coerce.number().int().positive().max(500),
    },
    outputSchema: {
      success: z.literal(true),
      extraction_version: z.literal('observer-telemetry-ohlcv-v1'),
      symbol: z.string().min(1),
      timeframe: z.string().min(1),
      requested_count: z.number().int().positive().max(500),
      captured_at: z.string().datetime(),
      candles: z.array(z.object({
        opened_at: z.string().datetime(),
        open: z.string(),
        high: z.string(),
        low: z.string(),
        close: z.string(),
        volume: z.string().nullable(),
      })).min(1).max(500),
      studies: z.array(z.object({
        study_id: z.string().min(1),
        study_name: z.string().min(1),
        values: z.array(z.object({
          source_label: z.string().min(1),
          field_label: z.string().min(1),
          raw_value: z.string(),
        })),
      })),
    },
  },
  tab_list: {
    classification: 'read_only',
    inputSchema: emptyInput,
    outputSchema: tabListOutput,
  },
  tab_new: {
    classification: 'bootstrap_mutation',
    inputSchema: emptyInput,
    outputSchema: {
      ...tabListOutput,
      action: z.literal('new_tab_opened'),
    },
  },
  tab_switch: {
    classification: 'browser_focus_mutation',
    inputSchema: { index: z.coerce.number().int().nonnegative().describe('Tab index (0-based, from tab_list).') },
    outputSchema: {
      success: z.literal(true),
      action: z.literal('switched'),
      index: z.number().int().nonnegative(),
      tab_id: z.string(),
      chart_id: z.string().nullable(),
    },
  },
  pane_list: {
    classification: 'read_only',
    inputSchema: emptyInput,
    outputSchema: {
      success: z.literal(true),
      layout: z.union([z.string(), z.number()]),
      layout_name: z.string(),
      chart_count: z.number().int().nonnegative(),
      active_index: z.number().int().nonnegative().nullable(),
      panes: z.array(z.object({
        index: z.number().int().nonnegative(),
        symbol: z.string(),
        resolution: z.union([z.string(), z.number(), z.null()]),
        error: z.string().optional(),
      })),
    },
  },
  pane_indicator_signatures: {
    classification: 'read_only',
    inputSchema: emptyInput,
    outputSchema: {
      success: z.literal(true),
      schema_version: z.literal('pane-indicator-signatures-v1'),
      pane_count: z.number().int().min(1).max(16),
      canonical_pane_index: z.literal(0),
      panes: z.array(z.object({
        index: z.number().int().nonnegative(),
        signature: z.string().regex(/^[0-9a-f]{64}$/),
        indicators: z.array(z.object({
          indicator_id: z.string().min(1),
          entity_id: z.string().min(1),
          indicator_name: z.string().min(1),
          is_price_study: z.boolean(),
          settings: jsonObject,
        })),
      })),
    },
    rejectUnexpectedInput: true,
  },
  pane_indicator_mutation_inventory: {
    classification: 'read_only',
    inputSchema: emptyInput,
    outputSchema: {
      success: z.literal(true),
      schema_version: z.literal('pane-indicator-mutation-inventory-v1'),
      pane_count: z.number().int().min(1).max(16),
      canonical_pane_index: z.literal(0),
      panes: z.array(z.object({
        index: z.number().int().nonnegative(),
        indicators: z.array(z.object({
          indicator_id: z.string().min(1),
          entity_id: z.string().min(1),
          indicator_name: z.string().min(1),
          is_price_study: z.boolean(),
          settings: jsonObject,
          get_study_by_id_resolves: z.boolean(),
          present_in_get_all_studies: z.boolean(),
          mutation_visible: z.boolean(),
        })),
      })),
    },
    rejectUnexpectedInput: true,
  },
  pane_probe_layout_capability: {
    classification: 'chart_mutation',
    inputSchema: {
      pane_count: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
      timeout_ms: z.coerce.number().int().positive().max(30000).optional().default(5000),
      poll_interval_ms: z.coerce.number().int().positive().max(5000).optional().default(200),
      stable_polls: z.coerce.number().int().positive().max(10).optional().default(2),
      validate_focus: z.boolean().optional().default(true),
    },
    outputSchema: {
      success: z.literal(true),
      probe_version: z.literal('pane-layout-capability-probe-v1'),
      requested_layout: z.string().min(1),
      requested_pane_count: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
      observed_layout: z.string(),
      observed_pane_count: z.number().int().nonnegative(),
      supported: z.boolean(),
      stable: z.boolean(),
      focus_validation_requested: z.boolean(),
      focus_validated: z.boolean(),
      restoration_attempted: z.boolean(),
      restoration_succeeded: z.boolean(),
      failure_reason: z.enum(['layout_mutation_failed', 'requested_layout_not_observed', 'pane_focus_validation_failed', 'probe_failed', 'layout_restoration_failed']).nullable(),
      error_detail: z.string().nullable(),
      before: jsonObject,
      observed: jsonObject,
      restored: jsonObject.nullable(),
      observations: z.array(jsonObject),
    },
  },
  chart_get_state: {
    classification: 'read_only',
    inputSchema: emptyInput,
    outputSchema: {
      success: z.literal(true),
      symbol: z.string(),
      resolution: z.string(),
      chartType: z.number(),
      studies: z.array(z.object({ id: z.string(), name: z.string() })),
    },
  },
  chart_save_existing_capability_probe: {
    classification: 'read_only',
    inputSchema: {
      profile_id: z.string().min(1),
      tab_index: z.number().int().min(0),
      chart_target_id: z.string().min(1),
      chart_id: z.string().min(1),
      layout_id: z.string().min(1),
      expected_pane_count: z.number().int().min(1).max(16),
    },
    outputSchema: {
      success: z.literal(true),
      probe_version: z.literal('chart-save-existing-capability-probe-v1'),
      profile_id: z.string().min(1),
      chart_target_id: z.string().min(1),
      chart_id: z.string().min(1),
      canonical_url: z.string().url(),
      layout_id: z.string().min(1),
      pane_count: z.number().int().min(1).max(16),
      meta_info_type: z.string(),
      meta_info_shape: z.string(),
      uid_shape: z.string(),
      derived_layout_id: z.string().min(1),
      chart_available: z.boolean(),
      save_service_available: z.boolean(),
      save_existent_chart_type: z.string(),
      save_capability_available: z.boolean(),
      mutations_performed: z.literal(false),
      persisted_state_authority: z.literal('unavailable'),
      persisted_state_note: z.string().min(1),
    },
  },
  chart_save_existing_capability_probe_v2: {
    classification: 'read_only',
    inputSchema: savedLayoutIdentityInput,
    outputSchema: {
      success: z.literal(true),
      probe_version: z.literal('chart-save-existing-capability-probe-v2'),
      profile_id: z.string().min(1),
      chart_target_id: z.string().min(1),
      workspace_layout_id: z.string().min(1),
      saved_layout_uid: z.string().min(1),
      chart_id: z.string().min(1),
      canonical_url: z.string().url(),
      pane_count: z.number().int().min(1).max(16),
      meta_info_type: z.string(),
      meta_info_shape: z.string(),
      uid_shape: z.string(),
      chart_available: z.boolean(),
      save_service_available: z.boolean(),
      save_existent_chart_type: z.string(),
      save_capability_available: z.boolean(),
      mutations_performed: z.literal(false),
      persisted_state_authority: z.literal('unavailable'),
      persisted_state_note: z.string().min(1),
    },
  },
  chart_save_existing_scoped: {
    classification: 'chart_mutation',
    inputSchema: {
      profile_id: z.string().min(1),
      tab_index: z.number().int().nonnegative(),
      chart_target_id: z.string().min(1),
      chart_id: z.string().min(1),
      layout_id: z.string().min(1),
      expected_pane_count: z.number().int().min(1).max(16),
      expected_indicator_parity_hash: z.string().regex(/^[0-9a-f]{64}$/),
    },
    outputSchema: {
      success: z.literal(true),
      save_version: z.literal('chart-save-existing-scoped-v1'),
      profile_id: z.string().min(1),
      chart_target_id: z.string().min(1),
      chart_id: z.string().min(1),
      layout_id: z.string().min(1),
      pane_count: z.number().int().min(1).max(16),
      indicator_parity_hash: z.string().regex(/^[0-9a-f]{64}$/),
      saved_layout_id: z.string().min(1),
      saved_existing: z.literal(true),
      mutations_performed: z.literal(true),
      save_invoked: z.literal(true),
      effect_state: z.literal('confirmed'),
      effect_phase: z.literal('post-save-verification'),
      save_callback_confirmed: z.literal(true),
    },
  },
  chart_save_existing_scoped_v2: {
    classification: 'chart_mutation',
    inputSchema: {
      profile_id: z.string().min(1),
      tab_index: z.number().int().nonnegative(),
      chart_target_id: z.string().min(1),
      expected_chart_id: z.string().min(1),
      expected_workspace_layout_id: z.string().min(1),
      expected_saved_layout_uid: z.string().min(1),
      expected_pane_count: z.number().int().min(1).max(16),
      expected_indicator_parity_hash: z.string().regex(/^[0-9a-f]{64}$/),
    },
    outputSchema: {
      success: z.literal(true),
      save_version: z.literal('chart-save-existing-scoped-v2'),
      profile_id: z.string().min(1),
      chart_target_id: z.string().min(1),
      chart_id: z.string().min(1),
      canonical_url: z.string().url(),
      workspace_layout_id: z.string().min(1),
      saved_layout_uid: z.string().min(1),
      pane_count: z.number().int().min(1).max(16),
      indicator_parity_hash: z.string().regex(/^[0-9a-f]{64}$/),
      saved_existing: z.literal(true),
      mutations_performed: z.literal(true),
      save_invoked: z.literal(true),
      effect_state: z.literal('confirmed'),
      effect_phase: z.literal('post-save-verification'),
      save_callback_confirmed: z.literal(true),
    },
  },
  chart_set_symbol: {
    classification: 'chart_mutation',
    inputSchema: { symbol: z.string().min(1).describe('Symbol to set (e.g., BTCUSD, AAPL, ES1!, NYMEX:CL1!).') },
    outputSchema: {
      success: z.literal(true),
      symbol: z.string(),
      chart_ready: z.boolean(),
    },
  },
  chart_set_timeframe: {
    classification: 'chart_mutation',
    inputSchema: { timeframe: z.string().min(1).describe('Timeframe (e.g., 1, 5, 15, 60, D, W, M).') },
    outputSchema: {
      success: z.literal(true),
      timeframe: z.string(),
      chart_ready: z.boolean(),
    },
  },
});

export function registerObserverTool(server, name, description, handler) {
  const definition = observerToolDefinitions[name];
  if (!definition) throw new Error(`Unknown observer capability: ${name}`);
  const guardedHandler = async (args, extra) => {
    if (definition.rejectUnexpectedInput && args && Object.keys(args).length > 0) {
      throw new Error(`${name} accepts no input arguments.`);
    }
    if (name !== 'tv_observer_contract' && name !== 'tv_observer_prepare' && name !== 'tv_observer_attach_existing_read_only' && name !== 'tv_observer_hydrate_chart_target' && name !== 'chart_runtime_readiness_probe_v1' && name !== 'chart_runtime_wait_ready_v1') {
      requireObserverSession();
    }
    return handler(args, extra);
  };
  if (typeof server.registerTool !== 'function') {
    return server.tool(name, description, definition.inputSchema, guardedHandler);
  }
  return server.registerTool(name, {
    description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
  }, guardedHandler);
}
