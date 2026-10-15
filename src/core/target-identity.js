/**
 * Exact chart-target lookup by stable target ID.
 *
 * `tab.index` is a position in the live tab list, so it shifts whenever another capture slot opens or closes a
 * tab. Tool inputs still carry `tab_index` (schema unchanged) but it must never be used to match a target.
 */
export function exactTargetMatches(tabs, { targetId, chartId, url } = {}) {
  const entries = Array.isArray(tabs?.tabs) ? tabs.tabs : [];
  return entries.filter((tab) => tab && tab.id === targetId
    && (chartId === undefined || tab.chart_id === chartId)
    && (url === undefined || tab.url === url));
}

/** Return the single tab whose ID equals `targetId`; distinguish a missing target from an ambiguous one. */
export function findExactTarget(tabs, { targetId, chartId, url } = {}, label = 'exact chart target') {
  const byId = exactTargetMatches(tabs, { targetId });
  if (tabs?.success !== true || byId.length === 0) throw new Error(`${label} is missing`);
  if (byId.length > 1) throw new Error(`${label} is not unique`);
  const tab = byId[0];
  if ((chartId !== undefined && tab.chart_id !== chartId) || (url !== undefined && tab.url !== url)) {
    throw new Error(`${label} does not match authority`);
  }
  return tab;
}
