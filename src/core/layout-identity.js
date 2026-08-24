/**
 * Shared legacy workspace-layout identity semantics.
 *
 * This identity is distinct from saved-chart UID. Keep both paths bound to
 * this helper so historical observer identity and scoped-save identity cannot
 * drift apart.
 */

const LAYOUT_ID_ERROR = 'Bound authenticated chart layout identity is missing or ambiguous.';

export function unwrapLegacyLayoutValue(value) {
  let current = value;
  if (typeof current === 'function') current = current();
  if (current && typeof current.value === 'function') current = current.value();
  else if (current && Object.prototype.hasOwnProperty.call(current, 'value')) current = current.value;
  return typeof current === 'string' || typeof current === 'number' ? String(current) : '';
}

export function deriveLegacyLayoutIdFromSources({ collection, active } = {}) {
  const values = [];
  const collectionValue = unwrapLegacyLayoutValue(
    collection && (collection._layoutId || collection.layoutId || collection.layout || (collection._layout && collection._layout.id)),
  );
  const activeValue = unwrapLegacyLayoutValue(active && (active.layoutId || active._layoutId));
  for (const value of [collectionValue, activeValue]) {
    if (value && !values.includes(value)) values.push(value);
  }
  const paneCount = readStablePaneCount(collection);
  if (paneCount === 8 && values.length <= 1) return { layout_id: '8' };
  if (values.length !== 1) return { error: LAYOUT_ID_ERROR };
  return { layout_id: values[0] };
}

function readStablePaneCount(collection) {
  const count = Number(unwrapLegacyLayoutValue(collection && collection.inlineChartsCount));
  if (!Number.isInteger(count) || count < 1) return null;
  try {
    const widgets = collection && typeof collection.getAll === 'function' ? collection.getAll() : null;
    return Array.isArray(widgets) && widgets.length === count ? count : null;
  } catch {
    return null;
  }
}

/** Browser-side source matching deriveLegacyLayoutIdFromSources exactly. */
export const LEGACY_LAYOUT_IDENTITY_HELPER = `
    function readLegacyLayoutValue(value) {
      try {
        if (typeof value === 'function') value = value();
        if (value && typeof value.value === 'function') value = value.value();
        else if (value && Object.prototype.hasOwnProperty.call(value, 'value')) value = value.value;
        return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
      } catch (e) { return ''; }
    }
    function deriveLegacyLayoutId(api) {
      var collection = api && api._chartWidgetCollection;
      var active = api && api._activeChartWidgetWV;
      if (active && typeof active.value === 'function') active = active.value();
      else if (active && Object.prototype.hasOwnProperty.call(active, 'value')) active = active.value;
      var values = [];
      var collectionValue = readLegacyLayoutValue(collection && (collection._layoutId || collection.layoutId || collection.layout || collection._layout && collection._layout.id));
      var activeValue = readLegacyLayoutValue(active && (active.layoutId || active._layoutId));
      if (collectionValue && values.indexOf(collectionValue) === -1) values.push(collectionValue);
      if (activeValue && values.indexOf(activeValue) === -1) values.push(activeValue);
      var paneCount = Number(readLegacyLayoutValue(collection && collection.inlineChartsCount));
      var widgets = null;
      try { widgets = collection && typeof collection.getAll === 'function' ? collection.getAll() : null; } catch (e) { widgets = null; }
      var stablePaneCount = Number.isInteger(paneCount) && paneCount > 0 && Array.isArray(widgets) && widgets.length === paneCount ? paneCount : null;
      if (stablePaneCount === 8 && values.length <= 1) return { layout_id: '8' };
      if (values.length !== 1) return { error: 'Bound authenticated chart layout identity is missing or ambiguous.' };
      return { layout_id: values[0] };
    }
`;
