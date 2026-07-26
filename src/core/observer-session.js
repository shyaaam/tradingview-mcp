let session = null;

export function getObserverSession() {
  return session;
}

export function requireObserverSession() {
  if (!session) {
    throw new Error('Observer session is not prepared. Call tv_observer_prepare with exact profile_id first.');
  }
  return session;
}

export function setObserverSession(nextSession) {
  const required = ['managerBaseUrl', 'profileId', 'cdpUrl', 'chartTargetId', 'chartTargetUrl'];
  if (!nextSession || required.some((key) => typeof nextSession[key] !== 'string' || !nextSession[key].trim())) {
    throw new Error('Observer session requires managerBaseUrl, profileId, cdpUrl, chartTargetId, and chartTargetUrl.');
  }

  const reviewAuthority = nextSession.reviewAuthority === undefined
    ? undefined
    : normalizeReviewAuthority(nextSession.reviewAuthority, nextSession.profileId, nextSession.chartTargetId);
  session = Object.freeze({
    managerBaseUrl: nextSession.managerBaseUrl.trim().replace(/\/+$/, ''),
    profileId: nextSession.profileId.trim(),
    cdpUrl: nextSession.cdpUrl.trim().replace(/\/+$/, ''),
    chartTargetId: nextSession.chartTargetId.trim(),
    chartTargetUrl: nextSession.chartTargetUrl.trim(),
    ...(reviewAuthority === undefined ? {} : { reviewAuthority }),
  });
  return session;
}

export function normalizeReviewAuthority(value, profileId, chartTargetId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Observer review authority must be an object.');
  }
  const expectedKeys = new Set([
    'profile_id', 'runtime_target_id', 'chart_target_id', 'symbol', 'timeframe',
    'source_candle_time', 'pane_capability_snapshot_id', 'sticky_placement_epoch_id',
    'active_layout_transition_id', 'active_layout_transition_hash', 'tab_index', 'pane_index',
    'mcp_release_commit', 'mcp_manifest_hash',
  ]);
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    throw new Error('Observer review authority contains ambiguous fields.');
  }
  const authority = value;
  if (authority.profile_id !== profileId || authority.chart_target_id !== chartTargetId) {
    throw new Error('Observer review authority does not match prepared session.');
  }
  const normalized = {
    profileId: safeString(authority.profile_id, 'profile_id', 160),
    runtimeTargetId: pattern(authority.runtime_target_id, 'runtime_target_id', /^[a-z0-9-]+:[0-9a-f]{64}$/),
    chartTargetId: pattern(authority.chart_target_id, 'chart_target_id', /^[A-Za-z0-9._:-]+$/),
    symbol: safeString(authority.symbol, 'symbol', 160),
    timeframe: pattern(authority.timeframe, 'timeframe', /^(?:[1-9][0-9]*[mhdwM]?|[1-9][0-9]*[SDWM])$/),
    sourceCandleTime: pattern(authority.source_candle_time, 'source_candle_time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    paneCapabilitySnapshotId: pattern(authority.pane_capability_snapshot_id, 'pane_capability_snapshot_id', /^pane-capability-snapshot-v1:[0-9a-f]{64}$/),
    stickyPlacementEpochId: pattern(authority.sticky_placement_epoch_id, 'sticky_placement_epoch_id', /^sticky-symbol-placement-epoch-v1:[0-9a-f]{64}$/),
    activeLayoutTransitionId: pattern(authority.active_layout_transition_id, 'active_layout_transition_id', /^active-pane-layout-transition-v1:[0-9a-f]{64}$/),
    activeLayoutTransitionHash: pattern(authority.active_layout_transition_hash, 'active_layout_transition_hash', /^[0-9a-f]{64}$/),
    tabIndex: index(authority.tab_index, 'tab_index'),
    paneIndex: index(authority.pane_index, 'pane_index'),
    mcpReleaseCommit: pattern(authority.mcp_release_commit, 'mcp_release_commit', /^[0-9a-f]{40}$/),
    mcpManifestHash: pattern(authority.mcp_manifest_hash, 'mcp_manifest_hash', /^[0-9a-f]{64}$/),
  };
  return Object.freeze(normalized);
}

function safeString(value, name, maxLength) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)
    || value.includes('/') || value.includes('\\') || value.includes('..') || value.includes('%')) {
    throw new Error(`Observer review authority ${name} is invalid.`);
  }
  return value.normalize('NFC');
}

function pattern(value, name, expression) {
  const normalized = safeString(value, name, 200);
  if (!expression.test(normalized)) throw new Error(`Observer review authority ${name} is invalid.`);
  return normalized;
}

function index(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Observer review authority ${name} is invalid.`);
  return value;
}

export function clearObserverSession() {
  session = null;
}
