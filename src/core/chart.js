/**
 * Core chart control logic.
 */
import {
  evaluate as _evaluate,
  evaluateAsync as _evaluateAsync,
  getBoundClient as _getBoundClient,
  requireObserverSession,
  safeString,
  requireFinite,
} from '../connection.js';
import { list as _listTabs } from './tab.js';
import { indicatorSignatures, mutationIdentityInventory, derivePaneIndicatorParityHash } from './pane.js';
import { waitForChartReady as _waitForChartReady } from '../wait.js';
import { LEGACY_LAYOUT_IDENTITY_HELPER } from './layout-identity.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    getBoundClient: deps?.getBoundClient || _getBoundClient,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
  };
}

const CANONICAL_CHART_URL = (chartId) => `https://www.tradingview.com/chart/${chartId}/`;

export class ScopedSaveEffectError extends Error {
  constructor(message, { phase, effectState, saveInvoked, saveCallbackConfirmed = false, cause } = {}) {
    super(message, cause === undefined ? {} : { cause });
    this.name = 'ScopedSaveEffectError';
    this.phase = phase;
    this.effectState = effectState;
    this.saveInvoked = saveInvoked;
    this.saveCallbackConfirmed = saveCallbackConfirmed;
  }
}

export class SaveCapabilityProbeError extends Error {
  constructor(message, evidence) {
    super(message);
    this.name = 'SaveCapabilityProbeError';
    this.probeEvidence = Object.freeze({ ...evidence });
  }
}

function unwrapTradingViewValue(value) {
  let current = value;
  const seen = new Set();
  for (let index = 0; index < 8; index += 1) {
    if (current === null || current === undefined || (typeof current !== 'object' && typeof current !== 'function')) return current;
    if (seen.has(current)) return null;
    seen.add(current);
    if (typeof current === 'function') {
      current = current();
      continue;
    }
    if (typeof current.value === 'function') {
      current = current.value();
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(current, 'value')) {
      current = current.value;
      continue;
    }
    return current;
  }
  return null;
}

export function deriveLayoutIdFromMetaInfo(metaInfo) {
  const resolved = unwrapTradingViewValue(metaInfo);
  if (!resolved || typeof resolved !== 'object') return null;
  const uid = unwrapTradingViewValue(resolved.uid);
  return uid === null || uid === undefined || uid === '' ? null : String(uid);
}

export function describeMetaInfo(metaInfo) {
  const rawType = metaInfo === null ? 'null' : typeof metaInfo;
  const resolved = unwrapTradingViewValue(metaInfo);
  const resolvedShape = resolved === null
    ? 'null'
    : resolved === undefined
      ? 'missing'
      : typeof resolved === 'object'
        ? 'object'
        : typeof resolved;
  const uid = resolved && typeof resolved === 'object' ? resolved.uid : undefined;
  return {
    metaInfoType: rawType,
    metaInfoShape: resolvedShape,
    uidShape: uid === null ? 'null' : uid === undefined ? 'missing' : typeof uid,
  };
}

const LAYOUT_EVIDENCE_EXPRESSION = `
  (function() {
    var cwc = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
    var chart = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV
      && window.TradingViewApi._activeChartWidgetWV.value();
    var count = cwc && cwc.inlineChartsCount;
    if (count && typeof count.value === 'function') count = count.value();
    else if (count && Object.prototype.hasOwnProperty.call(count, 'value')) count = count.value;
    var rawMetaInfo = cwc && cwc.metaInfo;
    var metaInfo = rawMetaInfo;
    if (typeof metaInfo === 'function') metaInfo = metaInfo();
    var uid = metaInfo && metaInfo.uid;
    if (uid && typeof uid.value === 'function') uid = uid.value();
    else if (uid && Object.prototype.hasOwnProperty.call(uid, 'value')) uid = uid.value;
    var service = window.TradingViewApi && window.TradingViewApi._saveChartService;
    return {
      href: window.location.href,
      pane_count: Number(count),
      layout_id: uid == null ? null : String(uid),
      chart_available: Boolean(chart),
      meta_info_type: rawMetaInfo === null ? 'null' : typeof rawMetaInfo,
      meta_info_shape: metaInfo === null ? 'null' : metaInfo === undefined ? 'missing' : typeof metaInfo,
      uid_shape: uid === null ? 'null' : uid === undefined ? 'missing' : typeof uid,
      save_service_available: Boolean(service),
      save_existent_chart_type: service ? typeof service.saveExistentChart : 'missing',
    };
  })()
`;

const DUAL_LAYOUT_IDENTITY_EVIDENCE_EXPRESSION = `
  (function() {
    ${LEGACY_LAYOUT_IDENTITY_HELPER}
    function read(value) {
      try {
        if (typeof value === 'function') value = value();
        if (value && typeof value.value === 'function') value = value.value();
        else if (value && Object.prototype.hasOwnProperty.call(value, 'value')) value = value.value;
        return value === null || value === undefined ? null : String(value);
      } catch (e) { return null; }
    }
    var api = window.TradingViewApi;
    var collection = api && api._chartWidgetCollection;
    var chart = api && api._activeChartWidgetWV && typeof api._activeChartWidgetWV.value === 'function'
      ? api._activeChartWidgetWV.value() : null;
    var href = String(window.location && window.location.href || '');
    var pathMatch = String(window.location && window.location.pathname || '').match(/\\/chart\\/([^/?#]+)/i);
    var chartId = pathMatch ? String(pathMatch[1]) : null;
    var canonicalUrl = chartId ? 'https://www.tradingview.com/chart/' + chartId + '/' : null;
    var rawMetaInfo = collection && collection.metaInfo;
    var metaInfo = rawMetaInfo;
    if (typeof metaInfo === 'function') metaInfo = metaInfo();
    var savedLayoutUid = read(metaInfo && metaInfo.uid);
    var layoutIdentity = deriveLegacyLayoutId(api);
    return {
      href: href,
      canonical_url: canonicalUrl,
      chart_id: chartId,
      workspace_layout_id: layoutIdentity.layout_id || null,
      saved_layout_uid: savedLayoutUid,
      pane_count: Number(read(collection && collection.inlineChartsCount)),
      chart_available: Boolean(chart),
      meta_info_type: rawMetaInfo === null ? 'null' : typeof rawMetaInfo,
      meta_info_shape: metaInfo === null ? 'null' : metaInfo === undefined ? 'missing' : typeof metaInfo,
      uid_shape: savedLayoutUid === null ? 'missing' : typeof savedLayoutUid,
      save_service_available: Boolean(api && api._saveChartService),
      save_existent_chart_type: api && api._saveChartService ? typeof api._saveChartService.saveExistentChart : 'missing',
    };
  })()
`;

function normalizeSaveInput(input) {
  const expected = {
    profileId: String(input.profile_id || '').trim(),
    tabIndex: Number(input.tab_index),
    targetId: String(input.chart_target_id || '').trim(),
    chartId: String(input.chart_id || '').trim(),
    layoutId: String(input.layout_id || '').trim(),
    paneCount: Number(input.expected_pane_count),
    parityHash: String(input.expected_indicator_parity_hash || '').trim(),
  };
  if (!expected.profileId || !expected.targetId || !expected.chartId || !expected.layoutId
    || !Number.isInteger(expected.tabIndex) || expected.tabIndex < 0
    || !Number.isInteger(expected.paneCount) || expected.paneCount < 1 || expected.paneCount > 16
    || !/^[0-9a-f]{64}$/.test(expected.parityHash)) {
    throw new Error('Scoped existing-chart save input is invalid.');
  }
  return expected;
}

function normalizeDualLayoutInput(input, { requireParity = false } = {}) {
  const expected = {
    profileId: String(input.profile_id || '').trim(),
    tabIndex: Number(input.tab_index),
    targetId: String(input.chart_target_id || '').trim(),
    chartId: String(input.expected_chart_id || input.chart_id || '').trim(),
    workspaceLayoutId: String(input.expected_workspace_layout_id || '').trim(),
    savedLayoutUid: String(input.expected_saved_layout_uid || '').trim(),
    paneCount: Number(input.expected_pane_count),
    parityHash: String(input.expected_indicator_parity_hash || '').trim(),
  };
  if (!expected.profileId || !expected.targetId || !expected.chartId
    || !expected.workspaceLayoutId || !expected.savedLayoutUid
    || !Number.isInteger(expected.tabIndex) || expected.tabIndex < 0
    || !Number.isInteger(expected.paneCount) || expected.paneCount < 1 || expected.paneCount > 16
    || (requireParity && !/^[0-9a-f]{64}$/.test(expected.parityHash))) {
    throw new Error('Dual saved-layout identity input is invalid.');
  }
  return expected;
}

function assertDualLayoutIdentityEvidence(evidence, expected, { requireSaveService = false } = {}) {
  const canonicalUrl = CANONICAL_CHART_URL(expected.chartId);
  if (!evidence || evidence.href !== canonicalUrl || evidence.canonical_url !== canonicalUrl
    || evidence.chart_id !== expected.chartId
    || evidence.workspace_layout_id !== expected.workspaceLayoutId
    || evidence.saved_layout_uid !== expected.savedLayoutUid
    || evidence.pane_count !== expected.paneCount
    || evidence.chart_available !== true
    || (requireSaveService && (evidence.save_service_available !== true || evidence.save_existent_chart_type !== 'function'))) {
    throw new Error('Dual saved-layout identity does not match reviewed authority.');
  }
  return evidence;
}

async function inspectSaveParity({ expected, inspectInventory, inspectSignatures }) {
  const inventory = await inspectInventory();
  if (inventory?.success !== true || inventory.pane_count !== expected.paneCount
    || !Array.isArray(inventory.panes) || inventory.panes.length !== expected.paneCount
    || inventory.panes.some((pane, index) => pane.index !== index || !Array.isArray(pane.indicators)
      || pane.indicators.some((indicator) => indicator.get_study_by_id_resolves !== true))) {
    throw new Error('Scoped existing-chart save indicator identity is incomplete.');
  }
  const signatures = await inspectSignatures();
  if (signatures?.success !== true || signatures.pane_count !== expected.paneCount
    || !Array.isArray(signatures.panes) || signatures.panes.length !== expected.paneCount
    || signatures.panes.some((pane, index) => pane.index !== index)) {
    throw new Error('Scoped existing-chart save indicator parity is unavailable.');
  }
  const parityHash = derivePaneIndicatorParityHash({
    paneCapacity: expected.paneCount,
    canonicalPaneIndex: signatures.canonical_pane_index,
    panes: signatures.panes,
  });
  if (expected.parityHash && parityHash !== expected.parityHash) {
    throw new Error('Scoped existing-chart save indicator parity does not match reviewed authority.');
  }
  return parityHash;
}

async function invokeExistingChartSave(evaluateAsync, expectedSavedLayoutUid) {
  const saved = await evaluateAsync(`
    (function() {
      var service = window.TradingViewApi && window.TradingViewApi._saveChartService;
      if (!service || typeof service.saveExistentChart !== 'function') {
        return { success: false, error: 'Existing-chart save service is unavailable.' };
      }
      return new Promise(function(resolve) {
        var settled = false;
        function finish(value) {
          if (settled) return;
          settled = true;
          resolve(value);
        }
        try {
          service.saveExistentChart(function(value) {
            var explicitUid = null;
            if (typeof value === 'string' && value.trim()) {
              explicitUid = value.trim();
            } else if (value && typeof value.uid === 'string' && value.uid.trim()) {
              explicitUid = value.uid.trim();
            }
            finish({ success: true, explicit_uid: explicitUid });
          }, function(error) {
            finish({ success: false, error: 'Existing-chart save failed.' });
          }, { autoSave: false });
        } catch (error) {
          finish({ success: false, error: 'Existing-chart save failed.' });
        }
      });
    })()
  `);
  if (!saved || saved.success !== true) {
    throw new ScopedSaveEffectError(saved?.error || 'Existing-chart save failed.', {
      phase: 'save-invocation', effectState: 'ambiguous', saveInvoked: true,
    });
  }
  if (saved.explicit_uid !== null && saved.explicit_uid !== expectedSavedLayoutUid) {
    throw new ScopedSaveEffectError('Existing-chart save callback returned an unexpected saved-layout identity.', {
      phase: 'save-callback', effectState: 'ambiguous', saveInvoked: true,
      saveCallbackConfirmed: true,
    });
  }
  return saved.explicit_uid;
}

async function assertExactSaveTarget(expected, session, listTabs) {
  const canonicalUrl = CANONICAL_CHART_URL(expected.chartId);
  if (session.profileId !== expected.profileId || session.chartTargetId !== expected.targetId
    || session.chartTargetUrl !== canonicalUrl) {
    throw new Error('Scoped existing-chart save target or profile does not match observer session.');
  }
  const tabs = await listTabs();
  const tabEntries = tabs && Array.isArray(tabs.tabs) ? tabs.tabs : null;
  const matchingTabs = (tabEntries || []).filter((tab) => tab
    && Number(tab.index) === expected.tabIndex
    && tab.id === expected.targetId
    && tab.chart_id === expected.chartId
    && tab.url === canonicalUrl);
  if (tabs?.success !== true || !tabEntries || matchingTabs.length !== 1
    || tabEntries.filter((tab) => tab?.id === expected.targetId).length !== 1) {
    throw new Error('Scoped existing-chart save target tab is missing or ambiguous.');
  }
  return canonicalUrl;
}

function withSaveFailure(error, saveInvoked, phase, effectState, saveCallbackConfirmed = false) {
  if (error instanceof ScopedSaveEffectError) return error;
  return new ScopedSaveEffectError(error instanceof Error ? error.message : String(error), {
    phase,
    effectState,
    saveInvoked,
    saveCallbackConfirmed,
    cause: error,
  });
}

/**
 * Save the currently bound, existing chart through TradingView's scoped save
 * service. This never creates, renames, switches, focuses, or mutates studies.
 */
export async function saveExistingChartScoped({
  profile_id,
  tab_index,
  chart_target_id,
  chart_id,
  layout_id,
  expected_pane_count,
  expected_indicator_parity_hash,
  _deps,
}) {
  const { evaluate, evaluateAsync, getBoundClient } = _resolve(_deps);
  const listTabs = _deps?.listTabs || _listTabs;
  const inspectInventory = _deps?.inspectInventory || mutationIdentityInventory;
  const inspectSignatures = _deps?.inspectSignatures || indicatorSignatures;
  const session = requireObserverSession();
  const expected = normalizeSaveInput({ profile_id, tab_index, chart_target_id, chart_id, layout_id, expected_pane_count, expected_indicator_parity_hash });
  const canonicalUrl = CANONICAL_CHART_URL(expected.chartId);
  let saveInvoked = false;
  try {
    await assertExactSaveTarget(expected, session, listTabs);
    // Forces exact operation-scoped CDP attachment before any save API call.
    await getBoundClient();
    const pre = await evaluate(LAYOUT_EVIDENCE_EXPRESSION);
    if (!pre || pre.href !== canonicalUrl || pre.layout_id !== expected.layoutId
      || pre.pane_count !== expected.paneCount || pre.chart_available !== true
      || pre.save_service_available !== true || pre.save_existent_chart_type !== 'function') {
      throw new Error('Scoped existing-chart save authority changed before save.');
    }

    const inventory = await inspectInventory();
    if (inventory?.success !== true || inventory.pane_count !== expected.paneCount
      || !Array.isArray(inventory.panes) || inventory.panes.length !== expected.paneCount
      || inventory.panes.some((pane, index) => pane.index !== index || !Array.isArray(pane.indicators)
        || pane.indicators.some((indicator) => indicator.get_study_by_id_resolves !== true))) {
      throw new Error('Scoped existing-chart save indicator identity is incomplete.');
    }
    const signatures = await inspectSignatures();
    if (signatures?.success !== true || signatures.pane_count !== expected.paneCount
      || !Array.isArray(signatures.panes) || signatures.panes.length !== expected.paneCount
      || signatures.panes.some((pane, index) => pane.index !== index)) {
      throw new Error('Scoped existing-chart save indicator parity is unavailable.');
    }
    const parityHash = derivePaneIndicatorParityHash({
      paneCapacity: expected.paneCount,
      canonicalPaneIndex: signatures.canonical_pane_index,
      panes: signatures.panes,
    });
    if (parityHash !== expected.parityHash) {
      throw new Error('Scoped existing-chart save indicator parity does not match reviewed authority.');
    }

    saveInvoked = true;
    const saved = await evaluateAsync(`
    (function() {
      var service = window.TradingViewApi && window.TradingViewApi._saveChartService;
      if (!service || typeof service.saveExistentChart !== 'function') {
        return { success: false, error: 'Existing-chart save service is unavailable.' };
      }
      return new Promise(function(resolve) {
        var settled = false;
        function finish(value) {
          if (settled) return;
          settled = true;
          resolve(value);
        }
        try {
          service.saveExistentChart(function(value) {
            finish({ success: true, uid: value && value.uid != null ? String(value.uid) : null });
          }, function(error) {
            finish({ success: false, error: 'Existing-chart save failed.' });
          }, { autoSave: false });
        } catch (error) {
          finish({ success: false, error: 'Existing-chart save failed.' });
        }
      });
    })()
  `);
    if (!saved || saved.success !== true) {
      throw new ScopedSaveEffectError(saved?.error || 'Existing-chart save failed.', {
        phase: 'save-invocation', effectState: 'ambiguous', saveInvoked: true,
      });
    }
    const savedLayoutId = saved.uid == null ? null : String(saved.uid);
    if (savedLayoutId !== expected.layoutId) {
      throw new ScopedSaveEffectError('Existing-chart save callback returned an unexpected layout identity.', {
        phase: 'save-callback', effectState: 'ambiguous', saveInvoked: true,
        saveCallbackConfirmed: true,
      });
    }

    let post;
    try {
      post = await evaluate(LAYOUT_EVIDENCE_EXPRESSION);
    } catch (error) {
      throw new ScopedSaveEffectError(error instanceof Error ? error.message : String(error), {
        phase: 'post-save-verification', effectState: 'confirmed', saveInvoked: true,
        saveCallbackConfirmed: true, cause: error,
      });
    }
    if (!post || post.href !== canonicalUrl || post.layout_id !== expected.layoutId) {
      throw new ScopedSaveEffectError('Existing-chart save postcondition changed reviewed chart identity.', {
        phase: 'post-save-verification', effectState: 'confirmed', saveInvoked: true,
        saveCallbackConfirmed: true,
      });
    }
    return {
      success: true,
      save_version: 'chart-save-existing-scoped-v1',
      profile_id: expected.profileId,
      chart_target_id: expected.targetId,
      chart_id: expected.chartId,
      layout_id: expected.layoutId,
      pane_count: expected.paneCount,
      indicator_parity_hash: parityHash,
      saved_layout_id: savedLayoutId,
      saved_existing: true,
      mutations_performed: true,
      save_invoked: true,
      effect_state: 'confirmed',
      effect_phase: 'post-save-verification',
      save_callback_confirmed: true,
    };
  } catch (error) {
    throw withSaveFailure(
      error,
      saveInvoked,
      saveInvoked ? 'save-invocation' : 'pre-effect',
      saveInvoked ? 'ambiguous' : 'not-started',
    );
  }
}

export async function probeExistingChartSaveCapability({
  profile_id,
  tab_index,
  chart_target_id,
  chart_id,
  layout_id,
  expected_pane_count,
  _deps,
}) {
  const { evaluate, getBoundClient } = _resolve(_deps);
  const listTabs = _deps?.listTabs || _listTabs;
  const session = requireObserverSession();
  const expected = normalizeSaveInput({
    profile_id,
    tab_index,
    chart_target_id,
    chart_id,
    layout_id,
    expected_pane_count,
    expected_indicator_parity_hash: '0'.repeat(64),
  });
  const canonicalUrl = CANONICAL_CHART_URL(expected.chartId);
  await assertExactSaveTarget(expected, session, listTabs);
  await getBoundClient();
  const evidence = await evaluate(LAYOUT_EVIDENCE_EXPRESSION);
  if (!evidence || evidence.href !== canonicalUrl || evidence.layout_id !== expected.layoutId
    || evidence.pane_count !== expected.paneCount || evidence.chart_available !== true) {
    throw new SaveCapabilityProbeError('Read-only existing-chart save capability target/layout evidence is not exact.', {
      profile_id: expected.profileId,
      chart_target_id: expected.targetId,
      chart_id: expected.chartId,
      canonical_url: canonicalUrl,
      expected_layout_id: expected.layoutId,
      expected_pane_count: expected.paneCount,
      ...(evidence && {
        observed_href: evidence.href,
        observed_layout_id: evidence.layout_id,
        observed_pane_count: evidence.pane_count,
        chart_available: evidence.chart_available,
        meta_info_type: evidence.meta_info_type,
        meta_info_shape: evidence.meta_info_shape,
        uid_shape: evidence.uid_shape,
        save_service_available: evidence.save_service_available,
        save_existent_chart_type: evidence.save_existent_chart_type,
      }),
    });
  }
  return {
    success: true,
    probe_version: 'chart-save-existing-capability-probe-v1',
    profile_id: expected.profileId,
    chart_target_id: expected.targetId,
    chart_id: expected.chartId,
    canonical_url: canonicalUrl,
    layout_id: expected.layoutId,
    pane_count: expected.paneCount,
    meta_info_type: evidence.meta_info_type,
    meta_info_shape: evidence.meta_info_shape,
    uid_shape: evidence.uid_shape,
    derived_layout_id: evidence.layout_id,
    chart_available: evidence.chart_available,
    save_service_available: evidence.save_service_available,
    save_existent_chart_type: evidence.save_existent_chart_type,
    save_capability_available: evidence.save_service_available && evidence.save_existent_chart_type === 'function',
    mutations_performed: false,
    persisted_state_authority: 'unavailable',
    persisted_state_note: 'TradingView getSavedCharts metadata does not expose persisted pane indicator state; no authoritative persisted parity read is available through this MCP release.',
  };
}

/**
 * Read both layout identities without invoking any save or navigation API.
 * `workspace_layout_id` is the legacy layout topology; `saved_layout_uid` is
 * the server-saved chart UID exposed by TradingView metaInfo.
 */
export async function inspectSavedLayoutIdentity({
  profile_id,
  tab_index,
  chart_target_id,
  expected_chart_id,
  expected_workspace_layout_id,
  expected_saved_layout_uid,
  expected_pane_count,
  _deps,
}) {
  const { evaluate, getBoundClient } = _resolve(_deps);
  const listTabs = _deps?.listTabs || _listTabs;
  const session = requireObserverSession();
  const expected = normalizeDualLayoutInput({
    profile_id,
    tab_index,
    chart_target_id,
    expected_chart_id,
    expected_workspace_layout_id,
    expected_saved_layout_uid,
    expected_pane_count,
  });
  await assertExactSaveTarget(expected, session, listTabs);
  await getBoundClient();
  const evidence = await evaluate(DUAL_LAYOUT_IDENTITY_EVIDENCE_EXPRESSION);
  assertDualLayoutIdentityEvidence(evidence, expected);
  return {
    success: true,
    identity_version: 'chart-saved-layout-identity-v1',
    profile_id: expected.profileId,
    chart_target_id: expected.targetId,
    workspace_layout_id: evidence.workspace_layout_id,
    saved_layout_uid: evidence.saved_layout_uid,
    chart_id: evidence.chart_id,
    canonical_url: evidence.canonical_url,
    pane_count: evidence.pane_count,
    mutations_performed: false,
  };
}

/**
 * Read-only v2 save capability probe. This is separate from the historical v1
 * probe so `layout_id` keeps its original saved-UID meaning.
 */
export async function probeExistingChartSaveCapabilityV2({
  profile_id,
  tab_index,
  chart_target_id,
  expected_chart_id,
  expected_workspace_layout_id,
  expected_saved_layout_uid,
  expected_pane_count,
  _deps,
}) {
  const { evaluate, getBoundClient } = _resolve(_deps);
  const listTabs = _deps?.listTabs || _listTabs;
  const session = requireObserverSession();
  const expected = normalizeDualLayoutInput({
    profile_id,
    tab_index,
    chart_target_id,
    expected_chart_id,
    expected_workspace_layout_id,
    expected_saved_layout_uid,
    expected_pane_count,
  });
  await assertExactSaveTarget(expected, session, listTabs);
  await getBoundClient();
  const evidence = await evaluate(DUAL_LAYOUT_IDENTITY_EVIDENCE_EXPRESSION);
  assertDualLayoutIdentityEvidence(evidence, expected);
  return {
    success: true,
    probe_version: 'chart-save-existing-capability-probe-v2',
    profile_id: expected.profileId,
    chart_target_id: expected.targetId,
    workspace_layout_id: evidence.workspace_layout_id,
    saved_layout_uid: evidence.saved_layout_uid,
    chart_id: evidence.chart_id,
    canonical_url: evidence.canonical_url,
    pane_count: evidence.pane_count,
    meta_info_type: evidence.meta_info_type,
    meta_info_shape: evidence.meta_info_shape,
    uid_shape: evidence.uid_shape,
    chart_available: evidence.chart_available,
    save_service_available: evidence.save_service_available,
    save_existent_chart_type: evidence.save_existent_chart_type,
    save_capability_available: evidence.save_service_available && evidence.save_existent_chart_type === 'function',
    mutations_performed: false,
    persisted_state_authority: 'unavailable',
    persisted_state_note: 'TradingView getSavedCharts metadata does not expose persisted pane indicator state; no authoritative persisted parity read is available through this MCP release.',
  };
}

/**
 * Versioned dual-identity existing-chart save. Historical v1 remains
 * unchanged and continues to interpret `layout_id` as the saved UID.
 */
export async function saveExistingChartScopedV2({
  profile_id,
  tab_index,
  chart_target_id,
  expected_chart_id,
  expected_workspace_layout_id,
  expected_saved_layout_uid,
  expected_pane_count,
  expected_indicator_parity_hash,
  _deps,
}) {
  const { evaluate, evaluateAsync, getBoundClient } = _resolve(_deps);
  const listTabs = _deps?.listTabs || _listTabs;
  const inspectInventory = _deps?.inspectInventory || mutationIdentityInventory;
  const inspectSignatures = _deps?.inspectSignatures || indicatorSignatures;
  const session = requireObserverSession();
  const expected = normalizeDualLayoutInput({
    profile_id,
    tab_index,
    chart_target_id,
    expected_chart_id,
    expected_workspace_layout_id,
    expected_saved_layout_uid,
    expected_pane_count,
    expected_indicator_parity_hash,
  }, { requireParity: true });
  let saveInvoked = false;
  try {
    await assertExactSaveTarget(expected, session, listTabs);
    await getBoundClient();
    const pre = await evaluate(DUAL_LAYOUT_IDENTITY_EVIDENCE_EXPRESSION);
    assertDualLayoutIdentityEvidence(pre, expected, { requireSaveService: true });
    const parityHash = await inspectSaveParity({ expected, inspectInventory, inspectSignatures });

    saveInvoked = true;
    await invokeExistingChartSave(evaluateAsync, expected.savedLayoutUid);

    let post;
    try {
      post = await evaluate(DUAL_LAYOUT_IDENTITY_EVIDENCE_EXPRESSION);
    } catch (error) {
      throw new ScopedSaveEffectError(error instanceof Error ? error.message : String(error), {
        phase: 'post-save-verification', effectState: 'confirmed', saveInvoked: true,
        saveCallbackConfirmed: true, cause: error,
      });
    }
    assertDualLayoutIdentityEvidence(post, expected);
    return {
      success: true,
      save_version: 'chart-save-existing-scoped-v2',
      profile_id: expected.profileId,
      chart_target_id: expected.targetId,
      chart_id: post.chart_id,
      canonical_url: post.canonical_url,
      workspace_layout_id: post.workspace_layout_id,
      saved_layout_uid: expected.savedLayoutUid,
      pane_count: post.pane_count,
      indicator_parity_hash: parityHash,
      saved_existing: true,
      mutations_performed: true,
      save_invoked: true,
      effect_state: 'confirmed',
      effect_phase: 'post-save-verification',
      save_callback_confirmed: true,
    };
  } catch (error) {
    throw withSaveFailure(
      error,
      saveInvoked,
      saveInvoked ? 'save-invocation' : 'pre-effect',
      saveInvoked ? 'ambiguous' : 'not-started',
    );
  }
}

export async function getState({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const state = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      } catch(e) {}
      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        chartType: chart.chartType(),
        studies: studies,
      };
    })()
  `);
  return { success: true, ...state };
}

export async function setSymbol({ symbol, _deps }) {
  const { evaluateAsync, waitForChartReady } = _resolve(_deps);
  await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(symbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);
  const ready = await waitForChartReady(symbol);
  return { success: true, symbol, chart_ready: ready };
}

export async function setTimeframe({ timeframe, _deps }) {
  const { evaluate, waitForChartReady } = _resolve(_deps);
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setResolution(${safeString(timeframe)}, {});
    })()
  `);
  const ready = await waitForChartReady(null, timeframe);
  return { success: true, timeframe, chart_ready: ready };
}

export async function setType({ chart_type, _deps }) {
  const { evaluate } = _resolve(_deps);
  const typeMap = {
    'Bars': 0, 'Candles': 1, 'Line': 2, 'Area': 3,
    'Renko': 4, 'Kagi': 5, 'PointAndFigure': 6, 'LineBreak': 7,
    'HeikinAshi': 8, 'HollowCandles': 9,
  };
  const typeNum = typeMap[chart_type] ?? Number(chart_type);
  if (isNaN(typeNum) || typeNum < 0 || typeNum > 9 || !Number.isInteger(typeNum)) {
    throw new Error(`Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`);
  }
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setChartType(${typeNum});
    })()
  `);
  return { success: true, chart_type, type_num: typeNum };
}

export async function manageIndicator({ action, indicator, entity_id, inputs: inputsRaw, _deps }) {
  const { evaluate } = _resolve(_deps);
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;

  if (action === 'add') {
    const inputArr = inputs ? Object.entries(inputs).map(([k, v]) => ({ id: k, value: v })) : [];
    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy(${safeString(indicator)}, false, false, ${JSON.stringify(inputArr)});
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));
    const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    const newIds = (after || []).filter(id => !(before || []).includes(id));
    return { success: newIds.length > 0, action: 'add', indicator, entity_id: newIds[0] || null, new_study_count: newIds.length };
  } else if (action === 'remove') {
    if (!entity_id) throw new Error('entity_id required for remove action. Use chart_get_state to find study IDs.');
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.removeEntity(${safeString(entity_id)});
      })()
    `);
    return { success: true, action: 'remove', entity_id };
  } else {
    throw new Error('action must be "add" or "remove"');
  }
}

export async function getVisibleRange() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { visible_range: chart.getVisibleRange(), bars_range: chart.getVisibleBarsRange() };
    })()
  `);
  return { success: true, visible_range: result.visible_range, bars_range: result.bars_range };
}

export async function setVisibleRange({ from, to, _deps }) {
  const { evaluate } = _resolve(_deps);
  const f = requireFinite(from, 'from');
  const t = requireFinite(to, 'to');
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${f} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${t}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  const actual = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `);
  return { success: true, requested: { from, to }, actual: actual || { from: 0, to: 0 } };
}

export async function scrollToDate({ date }) {
  let timestamp;
  if (/^\d+$/.test(date)) timestamp = Number(date);
  else timestamp = Math.floor(new Date(date).getTime() / 1000);
  if (isNaN(timestamp)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  const resolution = await evaluate(`${CHART_API}.resolution()`);
  let secsPerBar = 60;
  const res = String(resolution);
  if (res === 'D' || res === '1D') secsPerBar = 86400;
  else if (res === 'W' || res === '1W') secsPerBar = 604800;
  else if (res === 'M' || res === '1M') secsPerBar = 2592000;
  else { const mins = parseInt(res, 10); if (!isNaN(mins)) secsPerBar = mins * 60; }

  const halfWindow = 25 * secsPerBar;
  const from = timestamp - halfWindow;
  const to = timestamp + halfWindow;

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  return { success: true, date, centered_on: timestamp, resolution, window: { from, to } };
}

export async function symbolInfo() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var info = chart.symbolExt();
      return {
        symbol: info.symbol, full_name: info.full_name, exchange: info.exchange,
        description: info.description, type: info.type, pro_name: info.pro_name,
        typespecs: info.typespecs, resolution: chart.resolution(), chart_type: chart.chartType()
      };
    })()
  `);
  return { success: true, ...result };
}

export async function symbolSearch({ query, type }) {
  // Use TradingView's public symbol search REST API (works without auth)
  const params = new URLSearchParams({
    text: query,
    hl: '1',
    exchange: '',
    lang: 'en',
    search_type: type || '',
    domain: 'production',
  });

  const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
  });
  if (!resp.ok) throw new Error(`Symbol search API returned ${resp.status}`);
  const data = await resp.json();

  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const results = (data.symbols || data || []).slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}
