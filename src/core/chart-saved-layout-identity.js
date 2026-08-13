import { evaluate as defaultEvaluate, getBoundClient as defaultGetBoundClient, requireObserverSession } from '../connection.js';
import { list as defaultListTabs } from './tab.js';

const CANONICAL_URL = (chartId) => `https://www.tradingview.com/chart/${chartId}/`;

export async function readSavedLayoutIdentityV1({
  profile_id,
  tab_index,
  chart_target_id,
  expected_chart_id,
  expected_workspace_layout_id,
  expected_pane_count,
  _deps,
}) {
  const expected = normalizeInput({
    profile_id,
    tab_index,
    chart_target_id,
    expected_chart_id,
    expected_workspace_layout_id,
    expected_pane_count,
  });
  const evaluate = _deps?.evaluate || defaultEvaluate;
  const getBoundClient = _deps?.getBoundClient || defaultGetBoundClient;
  const listTabs = _deps?.listTabs || defaultListTabs;
  const session = requireObserverSession();
  const canonicalUrl = CANONICAL_URL(expected.chartId);

  assertExactTarget(session, expected, await listTabs());
  await getBoundClient();
  const evidence = await evaluate(LAYOUT_IDENTITY_EXPRESSION);
  assertLayoutIdentity(evidence, expected, canonicalUrl);

  return {
    success: true,
    schema_version: 'chart-saved-layout-identity-v1',
    profile_id: expected.profileId,
    chart_target_id: expected.targetId,
    chart_id: expected.chartId,
    canonical_url: canonicalUrl,
    tab_index: expected.tabIndex,
    workspace_layout_id: expected.workspaceLayoutId,
    saved_layout_uid: evidence.saved_layout_uid,
    pane_count: expected.paneCount,
  };
}

function normalizeInput(input) {
  const expected = {
    profileId: text(input.profile_id),
    tabIndex: Number(input.tab_index),
    targetId: text(input.chart_target_id),
    chartId: text(input.expected_chart_id),
    workspaceLayoutId: text(input.expected_workspace_layout_id),
    paneCount: Number(input.expected_pane_count),
  };
  if (!expected.profileId || !expected.targetId || !expected.chartId || !expected.workspaceLayoutId
    || !Number.isInteger(expected.tabIndex) || expected.tabIndex < 0
    || !Number.isInteger(expected.paneCount) || expected.paneCount < 1 || expected.paneCount > 16) {
    throw new Error('Saved-layout identity input is invalid.');
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
    throw new Error('Saved-layout identity target or profile does not match observer session.');
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
    throw new Error('Saved-layout identity target tab is missing or ambiguous.');
  }
}

function assertLayoutIdentity(evidence, expected, canonicalUrl) {
  if (!evidence
    || evidence.href !== canonicalUrl
    || evidence.canonical_url !== canonicalUrl
    || evidence.chart_id !== expected.chartId
    || evidence.workspace_layout_id !== expected.workspaceLayoutId
    || typeof evidence.saved_layout_uid !== 'string'
    || !evidence.saved_layout_uid.trim()
    || evidence.pane_count !== expected.paneCount
    || evidence.chart_available !== true) {
    throw new Error('Saved-layout identity does not match exact chart authority.');
  }
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
    };
  })()
`;
