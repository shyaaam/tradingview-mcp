/**
 * Core pane/layout management logic.
 * Controls multi-chart layouts (split panes) in TradingView.
 */
import { createHash } from 'node:crypto';
import { evaluate, evaluateAsync, evaluateBound, getObserverSession, safeString } from '../connection.js';
import { identity as observerIdentity } from './observer-evidence.js';
import { resolveCloakManagerBaseUrl } from './cloak.js';
import { LEGACY_LAYOUT_IDENTITY_HELPER } from './layout-identity.js';
import { list as listTabs } from './tab.js';

const CWC = 'window.TradingViewApi._chartWidgetCollection';
const HASH = /^[0-9a-f]{64}$/i;
export const PANE_INDICATOR_SIGNATURE_SCHEMA_VERSION = 'pane-indicator-signatures-v1';
export const PANE_INDICATOR_MUTATION_INVENTORY_SCHEMA_VERSION = 'pane-indicator-mutation-inventory-v1';
const VOLATILE_INDICATOR_INPUT_KEYS = new Set([
  'first_visible_bar_time',
  'last_visible_bar_time',
  'subscribeRealtime',
]);

export const LAYOUT_NAMES = {
  's': '1 chart',
  '2h': '2 horizontal',
  '2v': '2 vertical',
  '2-1': '2 top, 1 bottom',
  '1-2': '1 top, 2 bottom',
  '3h': '3 horizontal',
  '3v': '3 vertical',
  '3s': '3 custom',
  '4': '2x2 grid',
  '4h': '4 horizontal',
  '4v': '4 vertical',
  '4s': '4 custom',
  '6': '6 charts',
  '8': '8 charts',
  '10': '10 charts',
  '12': '12 charts',
  '14': '14 charts',
  '16': '16 charts',
};

const SCOPED_LAYOUT_STATE_EXPRESSION = `
  (function() {
    function read(value) {
      try {
        if (typeof value === 'function') value = value();
        if (value && typeof value.value === 'function') value = value.value();
        else if (value && Object.prototype.hasOwnProperty.call(value, 'value')) value = value.value;
        return value === null || value === undefined ? null : String(value);
      } catch (e) { return null; }
    }
    var collection = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
    var rawMetaInfo = collection && collection.metaInfo;
    var metaInfo = rawMetaInfo;
    if (typeof metaInfo === 'function') metaInfo = metaInfo();
    if (metaInfo && typeof metaInfo.value === 'function') metaInfo = metaInfo.value();
    else if (metaInfo && Object.prototype.hasOwnProperty.call(metaInfo, 'value')) metaInfo = metaInfo.value;
    var count = read(collection && collection.inlineChartsCount);
    var uid = metaInfo && typeof metaInfo === 'object' ? read(metaInfo.uid) : null;
    return {
      saved_layout_uid: uid,
      pane_count: count === null ? null : Number(count),
    };
  })()
`;

const SCOPED_LAYOUT_MUTATION_EXPRESSION = (layout) => `
  (function() {
    var collection = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
    if (!collection || typeof collection.setLayout !== 'function') {
      return { success: false, error: 'TradingView chart layout mutation is unavailable.' };
    }
    collection.setLayout(${safeString(layout)});
    return { success: true };
  })()
`;

export class ScopedPaneLayoutEffectError extends Error {
  constructor(message, { phase, effectState, layoutInvoked }) {
    super(message);
    this.name = 'ScopedPaneLayoutEffectError';
    this.phase = phase;
    this.effectState = effectState;
    this.layoutInvoked = layoutInvoked;
  }
}

/**
 * List all panes in the current layout with their symbols and index.
 */
export async function list() {
  const result = await evaluate(`
    (function() {
      var cwc = ${CWC};
      var layoutType = cwc._layoutType;
      if (typeof layoutType === 'object' && layoutType && typeof layoutType.value === 'function') layoutType = layoutType.value();
      var count = cwc.inlineChartsCount;
      if (typeof count === 'object' && count && typeof count.value === 'function') count = count.value();

      var all = cwc.getAll();
      var visibleCount = Number(count);
      var panes = [];
      for (var i = 0; i < all.length && i < visibleCount; i++) {
        try {
          var c = all[i];
          var model = c.model ? c.model() : null;
          var mainSeries = model ? model.mainSeries() : null;
          var sym = mainSeries ? mainSeries.symbol() : 'unknown';
          var res = mainSeries ? mainSeries.interval() : null;
          panes.push({ index: i, symbol: sym, resolution: res || null });
        } catch(e) { panes.push({ index: i, error: e.message }); }
      }

      // Check which pane is active
      var activeChart = window.TradingViewApi._activeChartWidgetWV.value();
      var activeIndex = null;
      for (var j = 0; j < all.length && j < visibleCount; j++) {
        try {
          if (all[j].model && activeChart._chartWidget && all[j] === activeChart._chartWidget) { activeIndex = j; break; }
        } catch(e) {}
      }

      return { layout: layoutType, chart_count: count, active_index: activeIndex, panes: panes };
    })()
  `);

  return {
    success: true,
    layout: result.layout,
    layout_name: LAYOUT_NAMES[result.layout] || result.layout,
    chart_count: result.chart_count,
    active_index: result.active_index,
    panes: result.panes,
  };
}

/**
 * Read every pane's indicator inventory without focusing or mutating a pane.
 * Pane zero is the canonical inventory; pane indexes never enter signatures.
 */
export async function indicatorSignatures({ _deps } = {}) {
  const evaluateFn = _deps?.evaluate || evaluate;
  const raw = await evaluateFn(`
    (function() {
      var cwc = ${CWC};
      var count = cwc && cwc.inlineChartsCount;
      if (typeof count === 'object' && count && typeof count.value === 'function') count = count.value();
      var visibleCount = Number(count);
      var all = cwc && typeof cwc.getAll === 'function' ? cwc.getAll() : [];
      if (!Number.isInteger(visibleCount) || visibleCount < 1 || all.length < visibleCount) {
        return { error: 'TradingView pane indicator inventory is unavailable.' };
      }
      var panes = [];
      for (var paneIndex = 0; paneIndex < visibleCount; paneIndex++) {
        var widget = all[paneIndex];
        var model = widget && typeof widget.model === 'function' ? widget.model() : null;
        var chartModel = model && typeof model.model === 'function' ? model.model() : null;
        var sources = chartModel && typeof chartModel.dataSources === 'function'
          ? chartModel.dataSources()
          : null;
        if (!Array.isArray(sources)) {
          return { error: 'TradingView pane indicator inventory is unavailable.' };
        }
        var indicators = [];
        for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
          var source = sources[sourceIndex];
          if (!source || typeof source.metaInfo !== 'function') continue;
          var meta = source.metaInfo();
          if (!meta || typeof meta.id !== 'string' || meta.id.length === 0) continue;
          var entityId = '';
          try {
            if (source && typeof source.id === 'function') entityId = String(source.id() || '').trim();
            if (!entityId && source && source._id !== undefined) entityId = String(source._id || '').trim();
          } catch (error) {
            return { error: 'TradingView pane indicator live entity identity is unavailable.' };
          }
          if (!entityId) return { error: 'TradingView pane indicator live entity identity is unavailable.' };
          if (typeof source.inputs !== 'function') {
            return { error: 'TradingView pane indicator settings are unavailable.' };
          }
          var settings;
          try {
            settings = source.inputs();
            JSON.stringify(settings);
          } catch (error) {
            return { error: 'TradingView pane indicator settings are unavailable.' };
          }
          indicators.push({
            indicator_id: meta.id,
            entity_id: entityId,
            indicator_name: String(meta.description || meta.shortDescription || meta.id),
            is_price_study: meta.is_price_study === true,
            settings: settings,
          });
        }
        panes.push({ index: paneIndex, indicators: indicators });
      }
      return { pane_count: visibleCount, panes: panes };
    })()
  `);
  if (!raw || typeof raw !== 'object' || raw.error) {
    throw new Error(raw?.error || 'TradingView pane indicator inventory is unavailable.');
  }
  const paneCount = Number(raw.pane_count);
  if (!Number.isInteger(paneCount) || paneCount < 1 || !Array.isArray(raw.panes) || raw.panes.length !== paneCount) {
    throw new Error('TradingView pane indicator inventory is incompatible.');
  }
  const panes = raw.panes.map((pane, index) => {
    if (!pane || Number(pane.index) !== index || !Array.isArray(pane.indicators)) {
      throw new Error('TradingView pane indicator inventory is incompatible.');
    }
    const indicators = pane.indicators.map((indicator) => normalizeIndicator(indicator));
    indicators.sort((left, right) => canonicalJson(stableIndicator(left)).localeCompare(canonicalJson(stableIndicator(right))));
    return {
      index,
      signature: derivePaneIndicatorSignature(indicators),
      indicators,
    };
  });
  return {
    success: true,
    schema_version: PANE_INDICATOR_SIGNATURE_SCHEMA_VERSION,
    pane_count: paneCount,
    canonical_pane_index: 0,
    panes,
  };
}

/**
 * Read per-pane identity through the same model used by scoped mutations.
 * This never focuses or mutates a pane. Every source from the authoritative
 * pane inventory is returned, including studies absent from getAllStudies.
 * Addressability is evidence, not an omission filter.
 */
export async function mutationIdentityInventory({ _deps } = {}) {
  const evaluateFn = _deps?.evaluate || evaluate;
  const raw = await evaluateFn(`
    (function() {
      var cwc = ${CWC};
      var count = cwc && cwc.inlineChartsCount;
      if (typeof count === 'object' && count && typeof count.value === 'function') count = count.value();
      var visibleCount = Number(count);
      var all = cwc && typeof cwc.getAll === 'function' ? cwc.getAll() : [];
      if (!Number.isInteger(visibleCount) || visibleCount < 1 || all.length < visibleCount) {
        return { error: 'TradingView pane mutation identity inventory is unavailable.' };
      }
      var activeChart = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV
        && typeof window.TradingViewApi._activeChartWidgetWV.value === 'function'
        ? window.TradingViewApi._activeChartWidgetWV.value()
        : null;
      var publicStudies = activeChart && typeof activeChart.getAllStudies === 'function'
        ? activeChart.getAllStudies()
        : null;
      if (!Array.isArray(publicStudies)) {
        return { error: 'TradingView pane mutation identity inventory is unavailable.' };
      }
      var publicStudyIds = Object.create(null);
      for (var publicStudyIndex = 0; publicStudyIndex < publicStudies.length; publicStudyIndex++) {
        var publicStudy = publicStudies[publicStudyIndex];
        var publicStudyId = publicStudy && typeof publicStudy.id === 'string' ? publicStudy.id.trim() : '';
        if (!publicStudyId || publicStudyIds[publicStudyId]) {
          return { error: 'TradingView pane mutation identity inventory contains duplicate getAllStudies identity.' };
        }
        publicStudyIds[publicStudyId] = true;
      }
      var panes = [];
      for (var paneIndex = 0; paneIndex < visibleCount; paneIndex++) {
        var widget = all[paneIndex];
        var model = widget && typeof widget.model === 'function' ? widget.model() : null;
        var chartModel = model && typeof model.model === 'function' ? model.model() : null;
        var sources = chartModel && typeof chartModel.dataSources === 'function' ? chartModel.dataSources() : null;
        if (!Array.isArray(sources) || !chartModel || typeof chartModel.getStudyById !== 'function'
          || !activeChart) {
          return { error: 'TradingView pane mutation identity inventory is unavailable.' };
        }
        var indicators = [];
        for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
          var source = sources[sourceIndex];
          if (!source || typeof source.metaInfo !== 'function') continue;
          var meta = source.metaInfo();
          if (!meta || typeof meta.id !== 'string' || meta.id.length === 0) continue;
          var entityId = '';
          try {
            if (typeof source.id === 'function') entityId = String(source.id() || '').trim();
            if (!entityId && source._id !== undefined) entityId = String(source._id || '').trim();
          } catch (error) {
            return { error: 'TradingView pane mutation live entity identity is unavailable.' };
          }
          if (!entityId) return { error: 'TradingView pane mutation live entity identity is unavailable.' };
          var resolves = false;
          try {
            var resolvedStudy = chartModel.getStudyById(entityId);
            resolves = resolvedStudy !== null && resolvedStudy !== undefined;
          } catch (error) { resolves = false; }
          if (typeof source.inputs !== 'function') {
            return { error: 'TradingView pane mutation visibility or settings evidence is unavailable.' };
          }
          var settings;
          try {
            settings = source.inputs();
            JSON.stringify(settings);
          } catch (error) {
            return { error: 'TradingView pane indicator settings are unavailable.' };
          }
          var presentInGetAllStudies = publicStudyIds[entityId] === true;
          indicators.push({
            indicator_id: meta.id,
            entity_id: entityId,
            indicator_name: String(meta.description || meta.shortDescription || meta.id),
            is_price_study: meta.is_price_study === true,
            settings: settings,
            get_study_by_id_resolves: resolves,
            present_in_get_all_studies: presentInGetAllStudies,
            mutation_visible: resolves && presentInGetAllStudies,
          });
        }
        panes.push({ index: paneIndex, indicators: indicators });
      }
      return { pane_count: visibleCount, panes: panes };
    })()
  `);
  if (!raw || typeof raw !== 'object' || raw.error) {
    throw new Error(raw?.error || 'TradingView pane mutation identity inventory is unavailable.');
  }
  const paneCount = Number(raw.pane_count);
  if (!Number.isInteger(paneCount) || paneCount < 1 || !Array.isArray(raw.panes) || raw.panes.length !== paneCount) {
    throw new Error('TradingView pane mutation identity inventory is incompatible.');
  }
  const panes = raw.panes.map((pane, index) => {
    if (!pane || Number(pane.index) !== index || !Array.isArray(pane.indicators)) {
      throw new Error('TradingView pane mutation identity inventory is incompatible.');
    }
    const indicators = pane.indicators.map((indicator) => normalizeMutationIndicator(indicator));
    assertUniqueMutationIdentity(indicators, pane.index);
    indicators.sort((left, right) => canonicalJson(stableMutationIndicator(left)).localeCompare(canonicalJson(stableMutationIndicator(right))));
    return {
      index,
      indicators,
    };
  });
  return {
    success: true,
    schema_version: PANE_INDICATOR_MUTATION_INVENTORY_SCHEMA_VERSION,
    pane_count: paneCount,
    canonical_pane_index: 0,
    panes,
  };
}

export function derivePaneIndicatorSignature(indicators) {
  return createHash('sha256')
    .update(canonicalJson({
      schema_version: PANE_INDICATOR_SIGNATURE_SCHEMA_VERSION,
      indicators: indicators.map((indicator) => stableIndicator(indicator)),
    }), 'utf8')
    .digest('hex');
}

/**
 * Derive the Runtime V2 eight-pane parity hash from stable pane signatures.
 * Live entity IDs and pane placement remain outside this hash.
 */
export function derivePaneIndicatorParityHash({ paneCapacity, panes, canonicalPaneIndex = 0 }) {
  if (!Number.isInteger(paneCapacity) || paneCapacity < 1 || paneCapacity > 16
    || !Number.isInteger(canonicalPaneIndex) || canonicalPaneIndex < 0
    || canonicalPaneIndex >= paneCapacity || !Array.isArray(panes) || panes.length !== paneCapacity) {
    throw new Error('TradingView pane indicator parity input is incompatible.');
  }
  const normalizedPanes = panes.map((pane, index) => {
    if (!pane || Number(pane.index) !== index || typeof pane.signature !== 'string'
      || !/^[0-9a-f]{64}$/.test(pane.signature)) {
      throw new Error('TradingView pane indicator parity input is incompatible.');
    }
    return { paneIndex: index, signature: pane.signature };
  });
  return createHash('sha256')
    .update(canonicalJson({
      schemaVersion: 'runtime-v2-indicator-parity-v1',
      paneCapacity,
      canonicalPaneIndex,
      panes: normalizedPanes,
    }), 'utf8')
    .digest('hex');
}

function normalizeIndicator(indicator) {
  if (!indicator || typeof indicator !== 'object' || Array.isArray(indicator)) {
    throw new Error('TradingView pane indicator inventory is incompatible.');
  }
  const id = String(indicator.indicator_id || '').trim();
  const entityId = String(indicator.entity_id || '').trim();
  const name = String(indicator.indicator_name || '').trim();
  if (!id || !entityId || !name || typeof indicator.is_price_study !== 'boolean') {
    throw new Error('TradingView pane indicator inventory is incompatible.');
  }
  return {
    indicator_id: id,
    entity_id: entityId,
    indicator_name: name,
    is_price_study: indicator.is_price_study,
    settings: normalizeJsonValue(indicator.settings, 'indicator settings'),
  };
}

function normalizeMutationIndicator(indicator) {
  const normalized = normalizeIndicator(indicator);
  if (typeof indicator.get_study_by_id_resolves !== 'boolean'
    || typeof indicator.present_in_get_all_studies !== 'boolean'
    || typeof indicator.mutation_visible !== 'boolean'
    || indicator.mutation_visible !== (indicator.get_study_by_id_resolves && indicator.present_in_get_all_studies)) {
    throw new Error('TradingView pane mutation identity inventory is incompatible.');
  }
  return {
    ...normalized,
    get_study_by_id_resolves: indicator.get_study_by_id_resolves,
    present_in_get_all_studies: indicator.present_in_get_all_studies,
    mutation_visible: indicator.mutation_visible,
  };
}

function stableMutationIndicator(indicator) {
  return {
    indicator_id: indicator.indicator_id,
    entity_id: indicator.entity_id,
    indicator_name: indicator.indicator_name,
    is_price_study: indicator.is_price_study,
    settings: indicator.settings,
    get_study_by_id_resolves: indicator.get_study_by_id_resolves,
    present_in_get_all_studies: indicator.present_in_get_all_studies,
    mutation_visible: indicator.mutation_visible,
  };
}

function assertUniqueMutationIdentity(indicators, paneIndex) {
  const indicatorIds = new Set();
  const entityIds = new Set();
  for (const indicator of indicators) {
    if (indicatorIds.has(indicator.indicator_id)) {
      throw new Error(`TradingView pane mutation identity inventory contains duplicate indicator identity on pane ${paneIndex}.`);
    }
    if (entityIds.has(indicator.entity_id)) {
      throw new Error(`TradingView pane mutation identity inventory contains duplicate entity identity on pane ${paneIndex}.`);
    }
    indicatorIds.add(indicator.indicator_id);
    entityIds.add(indicator.entity_id);
  }
}

function stableIndicator(indicator) {
  return {
    indicator_id: indicator.indicator_id,
    indicator_name: indicator.indicator_name,
    is_price_study: indicator.is_price_study,
    settings: indicator.settings,
  };
}

function normalizeJsonValue(value, label) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeJsonValue(entry, label));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !VOLATILE_INDICATOR_INPUT_KEYS.has(key))
        .sort()
        .map((key) => [key, normalizeJsonValue(value[key], `${label}.${key}`)]),
    );
  }
  throw new Error(`${label} is not JSON-compatible.`);
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * Set the chart layout grid.
 * @param {string} layout - Layout code: s, 2h, 2v, 2-1, 1-2, 3h, 3v, 4, 6, 8, etc.
 */
export async function setLayout({ layout }) {
  const code = layout.toLowerCase().replace(/\s+/g, '');

  // Map friendly names to codes
  const aliases = {
    'single': 's', '1': 's', '1x1': 's',
    '2x1': '2h', '1x2': '2v',
    '2x2': '4', 'grid': '4', 'quad': '4',
    '3x1': '3h', '1x3': '3v',
  };
  const resolved = aliases[code] || code;

  if (!LAYOUT_NAMES[resolved]) {
    const available = Object.entries(LAYOUT_NAMES).map(([k, v]) => `  ${k} — ${v}`).join('\n');
    throw new Error(`Unknown layout "${layout}". Available layouts:\n${available}`);
  }

  await evaluateAsync(`${CWC}.setLayout(${safeString(resolved)})`);
  await new Promise(r => setTimeout(r, 500));

  const state = await list();
  return {
    success: true,
    layout: resolved,
    layout_name: LAYOUT_NAMES[resolved],
    chart_count: state.chart_count,
    panes: state.panes,
  };
}

const SCOPED_LAYOUT_TIMEOUT_MS = 10_000;
const SCOPED_LAYOUT_POLL_INTERVAL_MS = 500;
const SCOPED_LAYOUT_MAX_POLL_INTERVAL_MS = 2_000;

function scopedText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function scopedIdentifier(value, name) {
  const normalized = scopedText(value, name);
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) throw new Error(`${name} is invalid.`);
  return normalized;
}

function scopedHash(value, name) {
  const normalized = scopedText(value, name).toLowerCase();
  if (!HASH.test(normalized)) throw new Error(`${name} must be a SHA-256 hash.`);
  return normalized;
}

function scopedCount(value, name) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 16) {
    throw new Error(`${name} must be an integer between 1 and 16.`);
  }
  return count;
}

function normalizeScopedLayoutInput(input = {}) {
  const expected = {
    profileId: scopedIdentifier(input.profile_id, 'profile_id'),
    targetId: scopedIdentifier(input.chart_target_id, 'chart_target_id'),
    chartId: scopedIdentifier(input.expected_chart_id, 'expected_chart_id'),
    accountHash: scopedHash(input.expected_account_subject_sha256, 'expected_account_subject_sha256'),
    savedLayoutUid: scopedIdentifier(input.expected_saved_layout_uid, 'expected_saved_layout_uid'),
    preLayoutId: scopedText(input.expected_pre_layout_id, 'expected_pre_layout_id'),
    prePaneCount: scopedCount(input.expected_pre_pane_count, 'expected_pre_pane_count'),
    desiredLayoutId: scopedText(input.desired_layout_id, 'desired_layout_id'),
    postPaneCount: scopedCount(input.expected_post_pane_count, 'expected_post_pane_count'),
    timeoutMs: Number(input.timeout_ms ?? SCOPED_LAYOUT_TIMEOUT_MS),
    pollIntervalMs: Number(input.poll_interval_ms ?? SCOPED_LAYOUT_POLL_INTERVAL_MS),
  };
  if (!LAYOUT_NAMES[expected.preLayoutId] || !LAYOUT_NAMES[expected.desiredLayoutId]) {
    throw new Error('Scoped pane layout mutation uses an unknown layout identity.');
  }
  if (!Number.isInteger(expected.timeoutMs) || expected.timeoutMs < 1 || expected.timeoutMs > SCOPED_LAYOUT_TIMEOUT_MS) {
    throw new Error(`timeout_ms must be an integer between 1 and ${SCOPED_LAYOUT_TIMEOUT_MS}.`);
  }
  if (!Number.isInteger(expected.pollIntervalMs) || expected.pollIntervalMs < 1 || expected.pollIntervalMs > SCOPED_LAYOUT_MAX_POLL_INTERVAL_MS) {
    throw new Error(`poll_interval_ms must be an integer between 1 and ${SCOPED_LAYOUT_MAX_POLL_INTERVAL_MS}.`);
  }
  return expected;
}

function scopedCanonicalChartUrl(chartId) {
  return `https://www.tradingview.com/chart/${chartId}/`;
}

async function readScopedManagerProfile(profileId, dependencies) {
  let matches;
  if (dependencies.readManagerProfile) {
    const profile = await dependencies.readManagerProfile(profileId);
    matches = profile ? [profile] : [];
  } else {
    const baseUrl = await resolveCloakManagerBaseUrl();
    if (!baseUrl) throw new Error('Scoped pane layout mutation Manager is unavailable.');
    const response = await fetch(new URL('profiles', `${baseUrl}/`).toString());
    if (!response.ok) throw new Error('Scoped pane layout mutation Manager identity read failed.');
    const payload = await response.json();
    const profiles = Array.isArray(payload) ? payload : payload?.profiles;
    matches = Array.isArray(profiles) ? profiles.filter((profile) => {
      const id = profile?.id || profile?.profile_id || profile?.profileId;
      return String(id || '') === profileId;
    }) : [];
  }
  if (matches.length !== 1) throw new Error('Scoped pane layout mutation live Manager profile identity is not unique.');
  const profileIdFromResult = matches[0]?.id || matches[0]?.profile_id || matches[0]?.profileId;
  if (String(profileIdFromResult || '') !== profileId) throw new Error('Scoped pane layout mutation live Manager profile identity does not match.');
  const status = String(matches[0].status || matches[0].state || '').toLowerCase();
  if (!['running', 'active'].includes(status)) throw new Error('Scoped pane layout mutation live Manager profile is not running.');
  return matches[0];
}

async function readScopedState(expected, dependencies) {
  if (dependencies.readState) return dependencies.readState(expected);
  const session = getObserverSession();
  const identity = await observerIdentity({ _deps: { evaluateBound } });
  const raw = await evaluateBound(SCOPED_LAYOUT_STATE_EXPRESSION, { awaitPromise: true });
  return {
    profile_id: session.profileId,
    chart_target_id: session.chartTargetId,
    chart_id: identity.chart_id,
    canonical_url: session.chartTargetUrl,
    workspace_layout_id: identity.layout_id,
    account_subject_sha256: identity.account_subject_sha256,
    saved_layout_uid: raw?.saved_layout_uid,
    pane_count: raw?.pane_count,
  };
}

async function readScopedTabs(dependencies) {
  return dependencies.listTabs ? dependencies.listTabs() : listTabs();
}

function assertScopedSession(expected, dependencies) {
  const session = dependencies.session || getObserverSession();
  const canonicalUrl = scopedCanonicalChartUrl(expected.chartId);
  if (!session
    || session.profileId !== expected.profileId
    || session.chartTargetId !== expected.targetId
    || session.chartTargetUrl !== canonicalUrl) {
    throw new Error('Scoped pane layout mutation session identity does not match reviewed authority.');
  }
  return { session, canonicalUrl };
}

async function assertScopedTarget(expected, canonicalUrl, dependencies) {
  const tabs = await readScopedTabs(dependencies);
  const matches = Array.isArray(tabs?.tabs)
    ? tabs.tabs.filter((tab) => tab?.id === expected.targetId)
    : [];
  if (tabs?.success !== true || matches.length !== 1) {
    throw new Error('Scoped pane layout mutation target identity is not unique.');
  }
  const tab = matches[0];
  if (tab.chart_id !== expected.chartId || tab.url !== canonicalUrl) {
    throw new Error('Scoped pane layout mutation chart identity does not match reviewed authority.');
  }
  return tab;
}

function assertScopedState(state, expected, canonicalUrl, phase) {
  const identityMatches = state
    && state.profile_id === expected.profileId
    && state.chart_target_id === expected.targetId
    && state.chart_id === expected.chartId
    && state.canonical_url === canonicalUrl
    && state.account_subject_sha256 === expected.accountHash
    && state.saved_layout_uid === expected.savedLayoutUid;
  if (!identityMatches) {
    throw new ScopedPaneLayoutEffectError(
      `Scoped pane layout mutation ${phase} identity does not match reviewed authority.`,
      { phase, effectState: phase === 'pre-layout-authority' ? 'blocked' : 'ambiguous', layoutInvoked: phase !== 'pre-layout-authority' },
    );
  }
  return state;
}

export async function setLayoutScoped(input = {}, { _deps = {} } = {}) {
  const expected = normalizeScopedLayoutInput(input);
  const dependencies = _deps || {};
  const { canonicalUrl } = assertScopedSession(expected, dependencies);
  await readScopedManagerProfile(expected.profileId, dependencies);
  await assertScopedTarget(expected, canonicalUrl, dependencies);
  const before = assertScopedState(await readScopedState(expected, dependencies), expected, canonicalUrl, 'pre-layout-authority');
  if (before.workspace_layout_id !== expected.preLayoutId) throw new Error('Scoped pane layout mutation pre-layout identity does not match reviewed authority.');
  if (before.pane_count !== expected.prePaneCount) throw new Error('Scoped pane layout mutation pre-pane count does not match reviewed authority.');

  const invokeLayout = dependencies.invokeLayout || (async (layout) => evaluateBound(SCOPED_LAYOUT_MUTATION_EXPRESSION(layout), { awaitPromise: true }));
  let layoutInvoked = true;
  try {
    const result = await invokeLayout(expected.desiredLayoutId);
    if (result?.success === false) throw new Error(result.error || 'Scoped pane layout mutation was unavailable.');
  } catch (error) {
    throw new ScopedPaneLayoutEffectError(
      error instanceof Error ? error.message : 'Scoped pane layout mutation invocation failed.',
      { phase: 'layout-invocation', effectState: 'ambiguous', layoutInvoked },
    );
  }

  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now || (() => Date.now());
  const deadline = now() + expected.timeoutMs;
  while (now() <= deadline) {
    let after;
    try {
      after = assertScopedState(await readScopedState(expected, dependencies), expected, canonicalUrl, 'post-layout-verification');
    } catch (error) {
      if (error instanceof ScopedPaneLayoutEffectError) throw error;
      throw new ScopedPaneLayoutEffectError(
        error instanceof Error ? error.message : 'Scoped pane layout mutation post-state read failed.',
        { phase: 'post-layout-verification', effectState: 'ambiguous', layoutInvoked },
      );
    }
    if (after.workspace_layout_id === expected.desiredLayoutId && after.pane_count === expected.postPaneCount) {
      return {
        success: true,
        topology_mutation_version: 'pane-set-layout-scoped-v1',
        profile_id: expected.profileId,
        chart_target_id: expected.targetId,
        chart_id: expected.chartId,
        canonical_url: canonicalUrl,
        account_subject_sha256: expected.accountHash,
        saved_layout_uid: expected.savedLayoutUid,
        pre_layout_id: expected.preLayoutId,
        pre_pane_count: expected.prePaneCount,
        desired_layout_id: expected.desiredLayoutId,
        post_layout_id: after.workspace_layout_id,
        post_pane_count: after.pane_count,
        layout_invoked: true,
        mutations_performed: true,
        effect_state: 'confirmed',
      };
    }
    await sleep(Math.min(expected.pollIntervalMs, Math.max(1, deadline - now())));
  }
  throw new ScopedPaneLayoutEffectError(
    'Scoped pane layout mutation post-state was not confirmed.',
    { phase: 'post-layout-verification', effectState: 'ambiguous', layoutInvoked },
  );
}

/**
 * Focus a specific pane by index.
 */
export async function focus({ index }) {
  const idx = Number(index);
  const result = await evaluate(`
    (function() {
      var cwc = ${CWC};
      var all = cwc.getAll();
      if (${idx} >= all.length) return { error: 'Pane index ' + ${idx} + ' out of range (have ' + all.length + ' panes)' };
      var chart = all[${idx}];
      // Click the main div to activate it
      if (chart._mainDiv) chart._mainDiv.click();
      return { focused: ${idx}, total: all.length };
    })()
  `);

  if (result?.error) throw new Error(result.error);
  return { success: true, focused_index: result.focused, total_panes: result.total };
}

/**
 * Set the symbol on a specific pane by index.
 * Works by focusing the pane, then using the active chart's setSymbol.
 */
export const PANE_CAPABILITY_LAYOUTS = Object.freeze({
  1: 's',
  2: '2h',
  4: '4',
  8: '8',
  16: '16',
});

/**
 * Probe one exact TradingView pane capability and restore the prior layout.
 * The probe returns supported=false for a clean subscription/layout mismatch,
 * while unstable state, focus failure, and restoration failure are explicit.
 */
export async function probeLayoutCapability({
  paneCount,
  timeoutMs = 5000,
  pollIntervalMs = 200,
  stablePolls = 2,
  validateFocus = true,
}, operations = {}) {
  const requestedPaneCount = Number(paneCount);
  const requestedLayout = PANE_CAPABILITY_LAYOUTS[requestedPaneCount];
  if (!requestedLayout) throw new Error(`Unsupported capability probe pane count: ${paneCount}`);
  const timeout = Number(timeoutMs);
  const interval = Number(pollIntervalMs);
  const requiredStablePolls = Number(stablePolls);
  if (!Number.isInteger(timeout) || timeout <= 0) throw new Error('timeoutMs must be a positive integer');
  if (!Number.isInteger(interval) || interval <= 0) throw new Error('pollIntervalMs must be a positive integer');
  if (!Number.isInteger(requiredStablePolls) || requiredStablePolls <= 0) throw new Error('stablePolls must be a positive integer');

  const read = operations.list || list;
  const mutateLayout = operations.setLayout || setLayout;
  const focusPane = operations.focus || focus;
  const sleep = operations.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = operations.now || (() => Date.now());

  const before = await read();
  const previousLayout = String(before.layout);
  let observed = before;
  let supported = false;
  let stable = false;
  let focusValidated = !validateFocus;
  let failureReason = null;
  let mutationError = null;
  let restorationAttempted = false;
  let restorationSucceeded = false;
  let restored = null;
  let stableCount = 0;
  let priorSignature = null;
  const observations = [];

  try {
    try {
      await mutateLayout({ layout: requestedLayout });
    } catch (error) {
      mutationError = error instanceof Error ? error.message : String(error);
      failureReason = 'layout_mutation_failed';
    }

    if (mutationError === null) {
      const deadline = now() + timeout;
      while (now() <= deadline) {
        observed = await read();
        const signature = JSON.stringify({
          layout: String(observed.layout),
          chart_count: Number(observed.chart_count),
          pane_indexes: observed.panes.map((pane) => pane.index),
        });
        observations.push({
          layout: String(observed.layout),
          chart_count: Number(observed.chart_count),
          active_index: observed.active_index,
          panes: observed.panes,
        });
        stableCount = signature === priorSignature ? stableCount + 1 : 1;
        priorSignature = signature;
        if (Number(observed.chart_count) === requestedPaneCount && observed.panes.length === requestedPaneCount && stableCount >= requiredStablePolls) {
          stable = true;
          supported = true;
          break;
        }
        await sleep(interval);
      }
      if (!stable) failureReason = 'requested_layout_not_observed';
    }

    if (supported && validateFocus) {
      for (let index = 0; index < requestedPaneCount; index += 1) {
        await focusPane({ index });
        const focused = await read();
        observations.push({
          layout: String(focused.layout),
          chart_count: Number(focused.chart_count),
          active_index: focused.active_index,
          panes: focused.panes,
        });
        if (focused.active_index !== index) {
          supported = false;
          failureReason = 'pane_focus_validation_failed';
          break;
        }
      }
      focusValidated = supported;
    }
  } catch (error) {
    supported = false;
    failureReason = failureReason || 'probe_failed';
    mutationError = mutationError || (error instanceof Error ? error.message : String(error));
  } finally {
    restorationAttempted = true;
    try {
      await mutateLayout({ layout: previousLayout });
      const deadline = now() + timeout;
      while (now() <= deadline) {
        restored = await read();
        if (String(restored.layout) === previousLayout && Number(restored.chart_count) === Number(before.chart_count)) {
          restorationSucceeded = true;
          break;
        }
        await sleep(interval);
      }
    } catch (error) {
      mutationError = mutationError || (error instanceof Error ? error.message : String(error));
    }
    if (!restorationSucceeded) {
      supported = false;
      failureReason = 'layout_restoration_failed';
    }
  }

  return {
    success: true,
    probe_version: 'pane-layout-capability-probe-v1',
    requested_layout: requestedLayout,
    requested_pane_count: requestedPaneCount,
    observed_layout: String(observed.layout),
    observed_pane_count: Number(observed.chart_count),
    supported,
    stable,
    focus_validation_requested: Boolean(validateFocus),
    focus_validated: focusValidated,
    restoration_attempted: restorationAttempted,
    restoration_succeeded: restorationSucceeded,
    failure_reason: failureReason,
    error_detail: mutationError,
    before,
    observed,
    restored,
    observations,
  };
}

export async function setSymbol({ index, symbol, _deps } = {}) {
  const idx = Number(index);
  if (!Number.isSafeInteger(idx) || idx < 0) {
    throw new Error('Pane index must be a non-negative integer.');
  }

  // Focus the target pane first
  await (_deps?.focus ?? focus)({ index: idx });
  await new Promise(r => setTimeout(r, 300));

  // Chart symbol synchronization can be enabled in the saved workspace. The
  // public chart.setSymbol() path therefore changes every linked pane even
  // after focusing one pane. Use the exact chart model setter, which avoids
  // the collection-level symbol observable and keeps this mutation scoped.
  const result = await (_deps?.evaluateAsync ?? evaluateAsync)(`
    (async function() {
      var collection = window.TradingViewApi._chartWidgetCollection;
      var all = collection && typeof collection.getAll === 'function' ? collection.getAll() : [];
      var chart = all[${idx}];
      var expected = String(${safeString(symbol)}).trim().toUpperCase();
      var deadline = Date.now() + 5000;
      function observedSymbol() {
        try {
          var model = chart && typeof chart.model === 'function' ? chart.model() : null;
          var series = model && typeof model.mainSeries === 'function' ? model.mainSeries() : null;
          return series && typeof series.symbol === 'function' ? String(series.symbol() || '').trim() : '';
        } catch (e) {
          return '';
        }
      }
      function matchesExpected(observed) {
        var normalized = observed.toUpperCase();
        return expected.includes(':')
          ? normalized === expected
          : normalized === expected || normalized.endsWith(':' + expected);
      }
      var model = chart && typeof chart.model === 'function' ? chart.model() : null;
      var series = model && typeof model.mainSeries === 'function' ? model.mainSeries() : null;
      if (!chart || !collection || !model || !series || typeof model.setSymbol !== 'function') {
        return { success: false, error: 'Scoped pane symbol mutation is unavailable.' };
      }
      var beforeSymbols = all.map(observedSymbol);
      try {
        model.setSymbol(series, ${safeString(symbol)});
      } catch (error) {
        return { success: false, error: error && error.message ? String(error.message) : 'Scoped pane symbol mutation failed.' };
      }
      while (Date.now() <= deadline) {
        var observed = observedSymbol();
        var afterSymbols = all.map(observedSymbol);
        var siblingDrift = afterSymbols.some(function(value, paneIndex) {
          return paneIndex !== ${idx} && value !== beforeSymbols[paneIndex];
        });
        if (siblingDrift) {
          return {
            success: false,
            error: 'Scoped pane symbol mutation changed another pane.',
            symbol: observed,
            before_symbols: beforeSymbols,
            after_symbols: afterSymbols,
          };
        }
        if (matchesExpected(observed)) return { success: true, symbol: observed };
        await new Promise(function(resolve) { setTimeout(resolve, 200); });
      }
      return {
        success: false,
        error: 'Pane symbol readback did not reach requested symbol.',
        symbol: observedSymbol(),
        before_symbols: beforeSymbols,
        after_symbols: all.map(observedSymbol),
      };
    })()
  `);
  if (!result || result.success !== true) {
    throw new Error(result?.error || 'Pane symbol readback failed.');
  }

  return { success: true, index: idx, symbol };
}
