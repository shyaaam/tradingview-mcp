import { z } from 'zod';

import { OBSERVER_CONTRACT_ID, OBSERVER_MANIFEST_SCHEMA_VERSION } from './constants.js';
import { requireObserverSession } from '../connection.js';

const emptyInput = Object.freeze({});
const jsonObject = z.record(z.string(), z.unknown());

const scopedIndicatorMutationOutput = {
  success: z.literal(true),
  profile_id: z.string().min(1),
  tab_index: z.number().int().nonnegative(),
  pane_index: z.number().int().nonnegative(),
  indicator_name: z.string().min(1),
  action: z.enum(['apply_indicator', 'update_indicator_settings', 'remove_indicator']),
  applied: z.literal(true),
  entity_id: z.string().nullable(),
  previous_settings: jsonObject,
  new_settings: jsonObject,
  previous_settings_source: z.string().min(1),
  new_settings_source: z.string().min(1),
  settings_unavailable_reason: jsonObject,
  post_mutation_signature: z.string().regex(/^[0-9a-f]{64}$/i),
  post_mutation_indicator: jsonObject.nullable(),
  post_mutation_indicator_count: z.number().int().nonnegative(),
  focus: jsonObject,
  message: z.string().min(1),
};

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

const lifecycleTargetOutput = {
  id: z.string().min(1),
  type: z.string().nullable(),
  url: z.string(),
  title: z.string().nullable(),
};

const lifecycleTargetViewOutput = {
  success: z.boolean(),
  targets: z.array(z.object(lifecycleTargetOutput)),
  exact_target_ids: z.array(z.string().min(1)),
  target_present: z.boolean(),
  exact_target_present: z.boolean(),
  error: z.string().nullable(),
};

const lifecycleBrowserTargetInfoOutput = {
  success: z.boolean(),
  target_id: z.string().min(1),
  type: z.string().nullable(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  attached: z.boolean().nullable(),
  error: z.string().nullable(),
};

const lifecycleBrowserViewOutput = {
  ...lifecycleTargetViewOutput,
  target_info: z.object(lifecycleBrowserTargetInfoOutput),
};

const lifecycleNavigationTimingOutput = {
  available: z.boolean(),
  type: z.string().nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  response_end_ms: z.number().int().nonnegative().nullable(),
  dom_content_loaded_ms: z.number().int().nonnegative().nullable(),
  load_event_end_ms: z.number().int().nonnegative().nullable(),
  redirect_count: z.number().int().nonnegative().nullable(),
};

const lifecycleNavigationHistoryOutput = {
  available: z.boolean(),
  entry_count: z.number().int().nonnegative().nullable(),
  current_index: z.number().int().nonnegative().nullable(),
  current_entry_url_matches_expected: z.boolean().nullable(),
  current_entry_scheme: z.string().nullable(),
  current_entry_title: z.string().nullable(),
  current_entry_transition_type: z.string().nullable(),
  error: z.string().nullable(),
};

const lifecycleRuntimeViewOutput = {
  success: z.boolean(),
  current_url: z.string(),
  document_ready_state: z.enum(['loading', 'interactive', 'complete', 'unavailable']),
  document_title: z.string(),
  runtime_scheme: z.string(),
  chrome_error_page: z.boolean(),
  chrome_error_code: z.string().nullable(),
  chrome_error_code_source: z.enum(['structured', 'selector', 'body_regex']).nullable(),
  error_heading_summary: z.string().nullable(),
  navigator_online: z.boolean().nullable(),
  navigation_timing: z.object(lifecycleNavigationTimingOutput),
  navigation_disposition: z.enum(['DOCUMENT_EXACT', 'DOCUMENT_ABOUT_BLANK', 'CHROME_NETWORK_ERROR', 'DOCUMENT_OTHER_URL', 'RUNTIME_UNAVAILABLE']),
  navigation_history: z.object(lifecycleNavigationHistoryOutput),
  error: z.string().nullable(),
};

const chartRuntimeTargetLifecycleTraceInput = {
  ...chartRuntimeReadinessInput,
  duration_ms: z.coerce.number().int().min(35_000).max(40_000).optional().default(35_000),
  poll_interval_ms: z.coerce.number().int().min(100).max(5_000).optional().default(500),
};

const chartRuntimeTargetLifecycleTraceOutput = {
  success: z.literal(true),
  trace_version: z.literal('chart-runtime-target-lifecycle-trace-v1'),
  status: z.literal('COMPLETED'),
  profile_id: z.string().min(1),
  target_id: z.string().min(1),
  target_url: z.string().url(),
  duration_ms: z.number().int().nonnegative(),
  requested_duration_ms: z.number().int().min(35_000).max(40_000),
  poll_interval_ms: z.number().int().positive(),
  trace_classification: z.enum([
    'STABLE_EXACT_TARGET',
    'SAME_TARGET_BECAME_BLANK',
    'TARGET_REPLACED',
    'MANAGER_BROWSER_DISAGREEMENT',
    'MULTIPLE_EXACT_TARGETS',
    'RUNTIME_URL_MISMATCH',
    'MANAGER_VIEW_UNAVAILABLE',
    'BROWSER_TARGET_VIEW_UNAVAILABLE',
    'RUNTIME_VIEW_UNAVAILABLE',
  ]),
  samples: z.array(z.object({
    elapsed_ms: z.number().int().nonnegative(),
    manager_view: z.object(lifecycleTargetViewOutput),
    browser_view: z.object(lifecycleBrowserViewOutput),
    runtime_view: z.object(lifecycleRuntimeViewOutput),
    classification: z.enum([
      'STABLE_EXACT_TARGET',
      'SAME_TARGET_BECAME_BLANK',
      'TARGET_REPLACED',
      'MANAGER_BROWSER_DISAGREEMENT',
      'MULTIPLE_EXACT_TARGETS',
      'RUNTIME_URL_MISMATCH',
      'MANAGER_VIEW_UNAVAILABLE',
      'BROWSER_TARGET_VIEW_UNAVAILABLE',
      'RUNTIME_VIEW_UNAVAILABLE',
    ]),
  })),
  auto_adoption_performed: z.literal(false),
  mutations_performed: z.literal(false),
};

export const paneIndicatorSignaturesOutput = {
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
};

export const paneIndicatorMutationInventoryOutput = {
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
};

export const chartStateOutput = {
  success: z.literal(true),
  symbol: z.string(),
  resolution: z.string(),
  chartType: z.number(),
  studies: z.array(z.object({ id: z.string(), name: z.string() })),
};

export const chartRuntimeContentSnapshotOutput = {
  success: z.literal(true),
  snapshot_version: z.literal('chart-runtime-content-snapshot-v1'),
  status: z.enum(['READY', 'BLOCKED']),
  block_reason: z.string().nullable(),
  profile_id: z.string().min(1),
  target_id: z.string().min(1),
  target_url: z.string().url(),
  chart_id: z.string().nullable(),
  workspace_layout_id: z.string().nullable(),
  saved_layout_uid: z.string().nullable(),
  account_subject_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  pane_count: z.number().int().min(1).max(16).nullable(),
  chart_symbol: z.string().nullable(),
  chart_resolution: z.string().nullable(),
  chart_type: z.number().nullable(),
  chart_state: z.object(chartStateOutput).nullable(),
  pane_indicator_signatures: z.object(paneIndicatorSignaturesOutput).nullable(),
  pane_mutation_inventory: z.object(paneIndicatorMutationInventoryOutput).nullable(),
  indicator_parity_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  pre_readiness: z.object(chartRuntimeWaitReadyOutput),
  post_readiness: z.object(chartRuntimeWaitReadyOutput).nullable(),
  mutations_performed: z.literal(false),
};

export const chartRuntimeContentSnapshotV2Output = {
  ...chartRuntimeContentSnapshotOutput,
  snapshot_version: z.literal('chart-runtime-content-snapshot-v2'),
};

export const chartRuntimeContentSnapshotInput = {
  profile_id: z.string().min(1),
  target_id: z.string().min(1),
  target_url: z.string().url(),
  expected_chart_id: z.string().min(1),
  expected_workspace_layout_id: z.string().min(1),
  expected_saved_layout_uid: z.string().min(1),
  expected_pane_count: z.number().int().min(1).max(16),
  expected_account_subject_sha256: z.string().regex(/^[0-9a-f]{64}$/),
};

const chartTargetHydrationV2PageNavigateOutput = {
  frame_id: z.string().nullable(),
  loader_id: z.string().nullable(),
  error_text: z.string().nullable(),
  is_download: z.boolean().nullable(),
};

const chartTargetHydrationV2ResponseOutput = {
  status: z.number().nullable(),
  mime_type: z.string().nullable(),
  protocol: z.string().nullable(),
};

const chartTargetHydrationV2NetworkOutput = {
  request_id: z.string().nullable(),
  frame_id: z.string().nullable(),
  loader_id: z.string().nullable(),
  error_text: z.string().nullable(),
  canceled: z.boolean().nullable(),
  blocked_reason: z.string().nullable(),
  cors_error_status: z.object({
    corsError: z.string().nullable(),
    failedParameter: z.string().nullable(),
  }).nullable(),
  response: z.object(chartTargetHydrationV2ResponseOutput).nullable(),
};

const chartTargetHydrationV2RuntimeEvaluationOutput = {
  status: z.enum(['ok', 'protocol-error', 'exception']),
  error_text: z.string().nullable(),
  exception_class: z.string().nullable(),
  attempt_count: z.number().int().nonnegative(),
  connection_source: z.literal('fresh-current-target'),
};

const chartTargetHydrationV2FrameTreeOutput = {
  status: z.enum(['available', 'unavailable']),
  main_frame_id: z.string().nullable(),
  loader_id: z.string().nullable(),
  url: z.string(),
  url_matches_expected: z.boolean(),
  mime_type: z.string().nullable(),
  scheme: z.string().nullable(),
  origin_matches_expected: z.boolean(),
};

const chartTargetHydrationV2Output = {
  success: z.literal(true),
  hydration_version: z.literal('chart-target-hydration-v2'),
  authority_id: z.string().regex(/^[a-z0-9-]+:[0-9a-f]{64}$/),
  authority_hash: z.string().regex(/^[0-9a-f]{64}$/),
  profile_id: z.string().min(1),
  target_id: z.string().min(1).nullable(),
  requested_url: z.string().url(),
  target_metadata_url: z.string().nullable(),
  runtime_url: z.string(),
  document_ready_state: z.enum(['loading', 'interactive', 'complete', 'unavailable']),
  saved_chart_id: z.string().min(1),
  navigation_performed: z.boolean(),
  target_created: z.boolean(),
  renderer_verified: z.boolean(),
  page_navigate: z.object(chartTargetHydrationV2PageNavigateOutput),
  main_document_network: z.object(chartTargetHydrationV2NetworkOutput),
  runtime_evaluation: z.object(chartTargetHydrationV2RuntimeEvaluationOutput),
  frame_tree: z.object(chartTargetHydrationV2FrameTreeOutput),
  chrome_error_page: z.boolean(),
  state: z.enum([
    'renderer-verified',
    'existing-renderer-verified',
    'blocked-page-navigate-error',
    'blocked-main-document-network-failure',
    'blocked-chrome-error-document',
    'blocked-login-required',
    'blocked-runtime-url-mismatch',
    'blocked-runtime-evaluation-unavailable',
    'blocked-target-missing',
    'blocked-target-ambiguous',
    'blocked-timeout',
  ]),
  mutations_performed: z.boolean(),
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
  chart_runtime_target_lifecycle_trace_v1: {
    classification: 'read_only',
    inputSchema: chartRuntimeTargetLifecycleTraceInput,
    outputSchema: chartRuntimeTargetLifecycleTraceOutput,
  },
  chart_runtime_content_snapshot_v1: {
    classification: 'read_only',
    inputSchema: chartRuntimeContentSnapshotInput,
    outputSchema: chartRuntimeContentSnapshotOutput,
  },
  chart_runtime_content_snapshot_v2: {
    classification: 'read_only',
    inputSchema: chartRuntimeContentSnapshotInput,
    outputSchema: chartRuntimeContentSnapshotV2Output,
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
  tv_observer_hydrate_chart_target_v2: {
    classification: 'bootstrap_mutation',
    inputSchema: {
      profile_id: z.string().min(1),
      authority_id: z.string().regex(/^[a-z0-9-]+:[0-9a-f]{64}$/),
      authority_hash: z.string().regex(/^[0-9a-f]{64}$/),
      chart_url: z.string().url(),
      saved_chart_id: z.string().min(1),
      allowed_origins: z.array(z.string().url()).min(1),
    },
    outputSchema: chartTargetHydrationV2Output,
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
  tv_observer_capture_pane_telemetry_ohlcv: {
    classification: 'read_only',
    inputSchema: {
      profile_id: z.string().min(1),
      expected_chart_target_id: z.string().min(1),
      expected_chart_id: z.string().min(1),
      expected_layout_id: z.string().min(1),
      tab_index: z.coerce.number().int().nonnegative(),
      pane_index: z.coerce.number().int().nonnegative(),
      symbol: z.string().min(1),
      timeframe: z.string().min(1),
      count: z.coerce.number().int().positive().max(500),
    },
    outputSchema: {
      success: z.literal(true),
      extraction_version: z.literal('observer-pane-telemetry-ohlcv-v1'),
      profile_id: z.string().min(1),
      chart_target_id: z.string().min(1),
      chart_id: z.string().min(1),
      layout_id: z.string().min(1),
      tab_index: z.number().int().nonnegative(),
      pane_index: z.number().int().nonnegative(),
      pane_count: z.number().int().positive().max(16),
      symbol: z.string().min(1),
      timeframe: z.string().min(1),
      requested_count: z.number().int().positive().max(500),
      captured_at: z.string().datetime(),
      candles: z.array(z.object({
        opened_at: z.string().datetime(),
        open: z.string().min(1),
        high: z.string().min(1),
        low: z.string().min(1),
        close: z.string().min(1),
        volume: z.string().min(1).nullable(),
      })).min(1).max(500),
      study_telemetry_state: z.enum(['available', 'unavailable']),
      study_telemetry_reason: z.enum(['missing-or-ambiguous']).nullable(),
      studies: z.array(z.object({
        study_id: z.string().min(1),
        study_name: z.string().min(1),
        values: z.array(z.object({
          source_label: z.string().min(1),
          field_label: z.string().min(1),
          raw_value: z.string().min(1),
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
    outputSchema: paneIndicatorSignaturesOutput,
    rejectUnexpectedInput: true,
  },
  pane_indicator_mutation_inventory: {
    classification: 'read_only',
    inputSchema: emptyInput,
    outputSchema: paneIndicatorMutationInventoryOutput,
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
  pane_set_layout_scoped_v1: {
    classification: 'chart_mutation',
    inputSchema: {
      profile_id: z.string().min(1),
      chart_target_id: z.string().min(1),
      expected_chart_id: z.string().min(1),
      expected_account_subject_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      expected_saved_layout_uid: z.string().min(1),
      expected_pre_layout_id: z.string().min(1),
      expected_pre_pane_count: z.coerce.number().int().min(1).max(16),
      desired_layout_id: z.string().min(1),
      expected_post_pane_count: z.coerce.number().int().min(1).max(16),
      timeout_ms: z.coerce.number().int().min(1).max(10_000).optional().default(10_000),
      poll_interval_ms: z.coerce.number().int().min(1).max(2_000).optional().default(500),
    },
    outputSchema: {
      success: z.literal(true),
      topology_mutation_version: z.literal('pane-set-layout-scoped-v1'),
      profile_id: z.string().min(1),
      chart_target_id: z.string().min(1),
      chart_id: z.string().min(1),
      canonical_url: z.string().url(),
      account_subject_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      saved_layout_uid: z.string().min(1),
      pre_layout_id: z.string().min(1),
      pre_pane_count: z.number().int().min(1).max(16),
      desired_layout_id: z.string().min(1),
      post_layout_id: z.string().min(1),
      post_pane_count: z.number().int().min(1).max(16),
      layout_invoked: z.literal(true),
      mutations_performed: z.literal(true),
      effect_state: z.literal('confirmed'),
    },
  },
  indicator_apply_blueprint_scoped: {
    classification: 'chart_mutation',
    inputSchema: {
      profile_id: z.string().min(1),
      tab_index: z.number().int().nonnegative(),
      pane_index: z.number().int().nonnegative(),
      indicator_id: z.string().min(1),
      indicator_name: z.string().min(1),
      expected_is_price_study: z.boolean(),
      expected_chart_target_id: z.string().min(1),
      expected_chart_id: z.string().min(1),
      expected_layout_id: z.string().min(1),
      expected_pane_signature: z.string().regex(/^[0-9a-f]{64}$/),
      expected_post_pane_signature: z.string().regex(/^[0-9a-f]{64}$/),
      expected_settings: jsonObject,
    },
    outputSchema: {
      success: z.literal(true),
      blueprint_apply_version: z.literal('indicator-apply-blueprint-scoped-v1'),
      profile_id: z.string().min(1),
      tab_index: z.number().int().nonnegative(),
      pane_index: z.number().int().nonnegative(),
      indicator_id: z.string().min(1),
      indicator_name: z.string().min(1),
      is_price_study: z.boolean(),
      entity_id: z.string().nullable(),
      pre_mutation_signature: z.string().regex(/^[0-9a-f]{64}$/),
      post_mutation_signature: z.string().regex(/^[0-9a-f]{64}$/),
      post_mutation_indicator_count: z.number().int().nonnegative(),
      mutations_performed: z.literal(true),
      focus: jsonObject,
    },
  },
  indicator_apply_scoped: {
    classification: 'chart_mutation',
    inputSchema: {
      profile_id: z.string().describe('Runtime/browser profile id supplied by the orchestrator'),
      tab_index: z.coerce.number().int().nonnegative().describe('TradingView chart tab index'),
      pane_index: z.coerce.number().int().nonnegative().describe('TradingView pane index'),
      indicator_name: z.string().describe('TradingView-recognized study name/title to apply, including custom/private confluence indicators'),
      expected_chart_target_id: z.string().min(1),
      expected_chart_id: z.string().min(1),
      expected_layout_id: z.string().min(1),
      expected_pane_signature: z.string().regex(/^[0-9a-f]{64}$/i),
      expected_entity_id: z.string().min(1).optional(),
      expected_settings: z.string().describe('JSON object of expected custom indicator settings/inputs, e.g. \'{"length":14}\''),
    },
    outputSchema: scopedIndicatorMutationOutput,
  },
  indicator_update_settings_scoped: {
    classification: 'chart_mutation',
    inputSchema: {
      profile_id: z.string().describe('Runtime/browser profile id supplied by the orchestrator'),
      tab_index: z.coerce.number().int().nonnegative().describe('TradingView chart tab index'),
      pane_index: z.coerce.number().int().nonnegative().describe('TradingView pane index'),
      indicator_name: z.string().describe('Existing indicator/study name/title to update, including custom/private confluence indicators'),
      expected_chart_target_id: z.string().min(1),
      expected_chart_id: z.string().min(1),
      expected_layout_id: z.string().min(1),
      expected_pane_signature: z.string().regex(/^[0-9a-f]{64}$/i),
      expected_entity_id: z.string().min(1).optional(),
      expected_settings: z.string().describe('JSON object of expected custom indicator settings/inputs, e.g. \'{"length":14}\''),
    },
    outputSchema: scopedIndicatorMutationOutput,
  },
  indicator_remove_scoped: {
    classification: 'chart_mutation',
    inputSchema: {
      profile_id: z.string().describe('Runtime/browser profile id supplied by the orchestrator'),
      tab_index: z.coerce.number().int().nonnegative().describe('TradingView chart tab index'),
      pane_index: z.coerce.number().int().nonnegative().describe('TradingView pane index'),
      indicator_name: z.string().describe('Exact TradingView study name/title'),
      expected_chart_target_id: z.string().min(1),
      expected_chart_id: z.string().min(1),
      expected_layout_id: z.string().min(1),
      expected_pane_signature: z.string().regex(/^[0-9a-f]{64}$/i),
      expected_entity_id: z.string().min(1),
    },
    outputSchema: scopedIndicatorMutationOutput,
  },
  chart_get_state: {
    classification: 'read_only',
    inputSchema: emptyInput,
    outputSchema: chartStateOutput,
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
  pine_upsert_named: {
    classification: 'chart_mutation',
    inputSchema: {
      name: z.string().min(1).describe('Exact saved Pine Script name'),
      source: z.string().min(1).describe('Repository-controlled Pine Script source'),
      add_to_chart: z.boolean().optional(),
      pane_index: z.number().int().nonnegative().optional(),
    },
    outputSchema: {
      success: z.literal(true),
      action: z.enum(['created', 'updated', 'unchanged']),
      name: z.string().min(1),
      saved_script_id: z.string().min(1),
      chart_study_id: z.string().min(1).nullable(),
      source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      added_to_chart: z.boolean(),
      pane_index: z.number().int().nonnegative().nullable(),
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
    if (name !== 'tv_observer_contract' && name !== 'tv_observer_prepare' && name !== 'tv_observer_attach_existing_read_only' && name !== 'tv_observer_hydrate_chart_target' && name !== 'tv_observer_hydrate_chart_target_v2' && name !== 'chart_runtime_readiness_probe_v1' && name !== 'chart_runtime_wait_ready_v1' && name !== 'chart_runtime_target_lifecycle_trace_v1' && name !== 'chart_runtime_content_snapshot_v1' && name !== 'chart_runtime_content_snapshot_v2') {
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
