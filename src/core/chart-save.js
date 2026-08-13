import { createHash } from 'node:crypto';

import {
  evaluate as defaultEvaluate,
  evaluateAsync as defaultEvaluateAsync,
  getBoundClient as defaultGetBoundClient,
  requireObserverSession,
} from '../connection.js';
import { indicatorSignatures as defaultIndicatorSignatures } from './pane.js';
import { list as defaultListTabs } from './tab.js';

const HASH = /^[0-9a-f]{64}$/u;
const CANONICAL_URL = (chartId) => `https://www.tradingview.com/chart/${chartId}/`;

export class ScopedExistingChartSaveError extends Error {
  constructor(message, { phase, effectState, saveInvoked, saveCallbackConfirmed = false, cause } = {}) {
    super(message, cause === undefined ? {} : { cause });
    this.name = 'ScopedExistingChartSaveError';
    this.phase = phase;
    this.effectState = effectState;
    this.saveInvoked = saveInvoked;
    this.saveCallbackConfirmed = saveCallbackConfirmed;
    this.retrySafe = true;
  }
}

export async function saveExistingChartScopedV2({
  profile_id,
  tab_index,
  chart_target_id,
  expected_chart_id,
  expected_workspace_layout_id,
  expected_saved_layout_uid,
  expected_pane_count,
  expected_eight_pane_parity_sha256,
  _deps,
}) {
  const expected = normalizeInput({
    profile_id,
    tab_index,
    chart_target_id,
    expected_chart_id,
    expected_workspace_layout_id,
    expected_saved_layout_uid,
    expected_pane_count,
    expected_eight_pane_parity_sha256,
  });
  const evaluate = _deps?.evaluate || defaultEvaluate;
  const evaluateAsync = _deps?.evaluateAsync || defaultEvaluateAsync;
  const getBoundClient = _deps?.getBoundClient || defaultGetBoundClient;
  const listTabs = _deps?.listTabs || defaultListTabs;
  const inspectSignatures = _deps?.inspectSignatures || defaultIndicatorSignatures;
  const session = requireObserverSession();
  let saveInvoked = false;

  try {
    const canonicalUrl = assertExactTarget(session, expected, await listTabs());
    await getBoundClient();

    const pre = await evaluate(LAYOUT_IDENTITY_EXPRESSION);
    assertLayoutIdentity(pre, expected, { requireSaveService: true });
    const parity = await inspectParity(expected, inspectSignatures);

    saveInvoked = true;
    const savedUid = await invokeExistingChartSave(evaluateAsync, expected.savedLayoutUid);

    const post = await evaluate(LAYOUT_IDENTITY_EXPRESSION);
    assertLayoutIdentity(post, expected, { requireSaveService: false });
    if (savedUid !== expected.savedLayoutUid) {
      throw new ScopedExistingChartSaveError(
        'Existing-chart save callback returned an unexpected saved-layout identity.',
        {
          phase: 'save-callback',
          effectState: 'ambiguous',
          saveInvoked: true,
          saveCallbackConfirmed: true,
        },
      );
    }

    const postParity = await inspectParity(expected, inspectSignatures);
    if (postParity !== parity) {
      throw new ScopedExistingChartSaveError(
        'Existing-chart save changed indicator parity during post-save verification.',
        {
          phase: 'post-save-verification',
          effectState: 'confirmed',
          saveInvoked: true,
          saveCallbackConfirmed: true,
        },
      );
    }

    return {
      success: true,
      save_version: 'chart-save-existing-scoped-v2',
      profile_id: expected.profileId,
      chart_target_id: expected.targetId,
      chart_id: expected.chartId,
      canonical_url: canonicalUrl,
      workspace_layout_id: expected.workspaceLayoutId,
      saved_layout_uid: expected.savedLayoutUid,
      pane_count: expected.paneCount,
      indicator_parity_sha256: parity,
      saved_existing: true,
      mutations_performed: true,
      save_invoked: true,
      effect_state: 'confirmed',
      effect_phase: 'post-save-verification',
      save_callback_confirmed: true,
      retry_safe: true,
    };
  } catch (error) {
    if (error instanceof ScopedExistingChartSaveError) throw error;
    throw new ScopedExistingChartSaveError(
      error instanceof Error ? error.message : String(error),
      {
        phase: saveInvoked ? 'save-invocation' : 'pre-effect',
        effectState: saveInvoked ? 'ambiguous' : 'not-started',
        saveInvoked,
        cause: error,
      },
    );
  }
}

function normalizeInput(input) {
  const expected = {
    profileId: text(input.profile_id),
    tabIndex: Number(input.tab_index),
    targetId: text(input.chart_target_id),
    chartId: text(input.expected_chart_id),
    workspaceLayoutId: text(input.expected_workspace_layout_id),
    savedLayoutUid: text(input.expected_saved_layout_uid),
    paneCount: Number(input.expected_pane_count),
    paritySha256: text(input.expected_eight_pane_parity_sha256).toLowerCase(),
  };
  if (!expected.profileId || !expected.targetId || !expected.chartId
    || !expected.workspaceLayoutId || !expected.savedLayoutUid
    || !Number.isInteger(expected.tabIndex) || expected.tabIndex < 0
    || !Number.isInteger(expected.paneCount) || expected.paneCount < 1 || expected.paneCount > 16
    || !HASH.test(expected.paritySha256)) {
    throw new Error('Scoped existing-chart save input is invalid.');
  }
  return expected;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function assertExactTarget(session, expected, tabs) {
  const canonicalUrl = CANONICAL_URL(expected.chartId);
  if (session.profileId !== expected.profileId
    || session.chartTargetId !== expected.targetId
    || session.chartTargetUrl !== canonicalUrl) {
    throw new Error('Scoped existing-chart save target or profile does not match observer session.');
  }
  const entries = tabs?.tabs;
  const matching = Array.isArray(entries)
    ? entries.filter((tab) => tab && Number(tab.index) === expected.tabIndex
      && tab.id === expected.targetId
      && tab.chart_id === expected.chartId
      && tab.url === canonicalUrl)
    : [];
  if (tabs?.success !== true || !Array.isArray(entries) || matching.length !== 1
    || entries.filter((tab) => tab?.id === expected.targetId).length !== 1) {
    throw new Error('Scoped existing-chart save target tab is missing or ambiguous.');
  }
  return canonicalUrl;
}

function assertLayoutIdentity(evidence, expected, { requireSaveService }) {
  const canonicalUrl = CANONICAL_URL(expected.chartId);
  if (!evidence
    || evidence.href !== canonicalUrl
    || evidence.canonical_url !== canonicalUrl
    || evidence.chart_id !== expected.chartId
    || evidence.workspace_layout_id !== expected.workspaceLayoutId
    || evidence.saved_layout_uid !== expected.savedLayoutUid
    || evidence.pane_count !== expected.paneCount
    || evidence.chart_available !== true
    || (requireSaveService
      && (evidence.save_service_available !== true || evidence.save_existent_chart_type !== 'function'))) {
    throw new Error('Dual saved-layout identity does not match reviewed authority.');
  }
}

async function inspectParity(expected, inspectSignatures) {
  const signatures = await inspectSignatures();
  assertPaneEvidence(signatures, expected, 'signature');
  const parity = deriveExistingChartParitySha256(signatures);
  if (parity !== expected.paritySha256) {
    throw new Error('Existing-chart save indicator parity does not match expected authority.');
  }
  return parity;
}

function assertPaneEvidence(evidence, expected, label) {
  if (evidence?.success !== true
    || evidence.pane_count !== expected.paneCount
    || evidence.canonical_pane_index !== 0
    || !Array.isArray(evidence.panes)
    || evidence.panes.length !== expected.paneCount
    || evidence.panes.some((pane, index) => pane.index !== index || !Array.isArray(pane.indicators))) {
    throw new Error(`Existing-chart save ${label} pane evidence is incomplete.`);
  }
}

export function deriveExistingChartParitySha256(signatures) {
  return sha256(canonicalJson({
    schemaVersion: 'runtime-v2-indicator-parity-v1',
    paneCapacity: signatures.pane_count,
    canonicalPaneIndex: signatures.canonical_pane_index,
    panes: signatures.panes.map((pane) => ({ paneIndex: pane.index, signature: pane.signature })),
  }));
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Existing-chart save parity contains an unsafe number.');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Existing-chart save parity contains an unsupported value.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  // Keep hashing in browser-independent MCP code; parity inputs are already strings/integers.
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function invokeExistingChartSave(evaluateAsync, expectedSavedLayoutUid) {
  const saved = await evaluateAsync(`
    (function() {
      var api = window.TradingViewApi;
      var service = api && api._saveChartService;
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
          }, function() {
            finish({ success: false, error: 'Existing-chart save failed.' });
          }, { autoSave: false });
        } catch (error) {
          finish({ success: false, error: 'Existing-chart save failed.' });
        }
      });
    })()
  `);
  if (!saved || saved.success !== true) {
    throw new ScopedExistingChartSaveError(saved?.error || 'Existing-chart save failed.', {
      phase: 'save-callback',
      effectState: 'ambiguous',
      saveInvoked: true,
    });
  }
  const savedUid = saved.uid == null ? null : String(saved.uid);
  if (savedUid !== expectedSavedLayoutUid) {
    throw new ScopedExistingChartSaveError('Existing-chart save callback returned an unexpected saved-layout identity.', {
      phase: 'save-callback',
      effectState: 'ambiguous',
      saveInvoked: true,
      saveCallbackConfirmed: true,
    });
  }
  return savedUid;
}

const LAYOUT_IDENTITY_EXPRESSION = `
  (function() {
    function read(value) {
      try {
        if (typeof value === 'function') value = value();
        if (value && typeof value.value === 'function') value = value.value();
        else if (value && Object.prototype.hasOwnProperty.call(value, 'value')) value = value.value;
        return value === null || value === undefined ? null : String(value);
      } catch (error) { return null; }
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
    return {
      href: href,
      canonical_url: canonicalUrl,
      chart_id: chartId,
      workspace_layout_id: read(collection && collection._layoutType),
      saved_layout_uid: read(metaInfo && metaInfo.uid),
      pane_count: Number(read(collection && collection.inlineChartsCount)),
      chart_available: Boolean(chart),
      save_service_available: Boolean(api && api._saveChartService),
      save_existent_chart_type: api && api._saveChartService ? typeof api._saveChartService.saveExistentChart : 'missing',
    };
  })()
`;
