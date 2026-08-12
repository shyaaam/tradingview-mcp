/**
 * Core indicator settings logic.
 */
import { evaluate as _evaluate, safeString } from '../connection.js';
import { focus as _focusPane } from './pane.js';
import { switchTab as _switchTab } from './tab.js';
import { list as _listTabs } from './tab.js';
import { indicatorSignatures as _indicatorSignatures, mutationIdentityInventory as _mutationIdentityInventory } from './pane.js';
import { getObserverSession } from './observer-session.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

const SUPPORTED_SCOPED_ACTIONS = new Set(['apply_indicator', 'update_indicator_settings']);

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    focusPane: deps?.focusPane || _focusPane,
    switchTab: deps?.switchTab || _switchTab,
  };
}

function _parseObject(value, name, { allowEmpty = false } = {}) {
  const parsed = value ? (typeof value === 'string' ? JSON.parse(value) : value) : undefined;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a non-empty object`);
  }
  if (!allowEmpty && Object.keys(parsed).length === 0) throw new Error(`${name} must be a non-empty object`);
  return parsed;
}

function _requireScopedRequest({ profile_id, tab_index, pane_index, indicator_name }) {
  if (!profile_id || typeof profile_id !== 'string' || !profile_id.trim()) {
    throw new Error('profile_id is required for scoped indicator mutation');
  }
  if (!indicator_name || typeof indicator_name !== 'string' || !indicator_name.trim()) {
    throw new Error('indicator_name is required');
  }
  const tabIndex = Number(tab_index);
  const paneIndex = Number(pane_index);
  if (!Number.isInteger(tabIndex) || tabIndex < 0) throw new Error('tab_index must be a non-negative integer');
  if (!Number.isInteger(paneIndex) || paneIndex < 0) throw new Error('pane_index must be a non-negative integer');
  return { profile_id: profile_id.trim(), tab_index: tabIndex, pane_index: paneIndex, indicator_name: indicator_name.trim() };
}

function _settingsFromInputValues(inputValues) {
  const settings = {};
  for (const input of inputValues || []) {
    if (!input || typeof input !== 'object') continue;
    if (input.id == null) continue;
    settings[String(input.id)] = input.value;
  }
  return settings;
}

function _valuesFromDisplayedValues(values) {
  if (!values || typeof values !== 'object') return {};
  if (Array.isArray(values)) {
    return Object.fromEntries(
      values
        .filter(item => item && typeof item === 'object' && item.title != null)
        .map(item => [String(item.title), item.value]),
    );
  }
  return { ...values };
}

function _settingsEvidenceFromStudy(study) {
  const inputSettings = _settingsFromInputValues(study?.inputs || []);
  if (Object.keys(inputSettings).length > 0) {
    return { settings: inputSettings, source: 'input_values', unavailable_reason: null };
  }
  const displayedValues = _valuesFromDisplayedValues(study?.values);
  if (Object.keys(displayedValues).length > 0) {
    return { settings: { values: displayedValues }, source: 'displayed_values', unavailable_reason: null };
  }
  return {
    settings: {},
    source: 'unavailable',
    unavailable_reason: 'study did not expose input values or displayed values',
  };
}

async function _selectScopedChart({ tab_index, pane_index, _deps }) {
  const { focusPane, switchTab } = _resolve(_deps);
  await switchTab({ index: tab_index });
  const focusResult = await focusPane({ index: pane_index });
  return focusResult || { success: true, focused_index: pane_index };
}

async function _getStudyByName({ indicator_name, _deps }) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = chart.getAllStudies ? chart.getAllStudies() : [];
      for (var i = 0; i < studies.length; i++) {
        var item = studies[i] || {};
        var name = String(item.name || item.title || '').toLowerCase();
        if (name === ${safeString(indicator_name.toLowerCase())}) {
          var study = chart.getStudyById(item.id);
          var inputs = study && study.getInputValues ? study.getInputValues() : [];
          return { id: item.id, name: item.name || item.title || ${safeString(indicator_name)}, inputs: inputs, values: item.values || item.description || null };
        }
      }
      return null;
    })()
  `);
  return result || null;
}

async function _applyIndicator({ indicator_name, expected_settings, _deps }) {
  const { evaluate } = _resolve(_deps);
  const inputArr = Object.entries(expected_settings).map(([id, value]) => ({ id, value }));
  const inputArrJson = JSON.stringify(inputArr);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var before = chart.getAllStudies ? chart.getAllStudies().map(function(s) { return s.id; }) : [];
      chart.createStudy(${safeString(indicator_name)}, false, false, ${inputArrJson});
      return new Promise(function(resolve) {
        setTimeout(function() {
          var after = chart.getAllStudies ? chart.getAllStudies() : [];
          var added = null;
          for (var i = 0; i < after.length; i++) {
            if (before.indexOf(after[i].id) === -1) { added = after[i]; break; }
          }
          if (!added) return resolve({ error: 'indicator was not added' });
          var study = chart.getStudyById(added.id);
          var inputs = study && study.getInputValues ? study.getInputValues() : [];
          resolve({ id: added.id, name: added.name || added.title || ${safeString(indicator_name)}, inputs: inputs, values: added.values || added.description || null });
        }, 1200);
      });
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return result;
}

async function _updateIndicatorSettings({ entity_id, expected_settings, _deps }) {
  const { evaluate } = _resolve(_deps);
  const settingsJson = JSON.stringify(expected_settings);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var currentInputs = study.getInputValues ? study.getInputValues() : [];
      var previous = {};
      var overrides = ${settingsJson};
      for (var i = 0; i < currentInputs.length; i++) {
        if (overrides.hasOwnProperty(currentInputs[i].id)) {
          previous[currentInputs[i].id] = currentInputs[i].value;
          currentInputs[i].value = overrides[currentInputs[i].id];
        }
      }
      study.setInputValues(currentInputs);
      var updated = study.getInputValues ? study.getInputValues() : currentInputs;
      var studies = chart.getAllStudies ? chart.getAllStudies() : [];
      var studyMeta = null;
      for (var i = 0; i < studies.length; i++) {
        if (studies[i] && studies[i].id === ${safeString(entity_id)}) { studyMeta = studies[i]; break; }
      }
      return { id: ${safeString(entity_id)}, previous: previous, inputs: updated, values: studyMeta ? (studyMeta.values || studyMeta.description || null) : null };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return result;
}

export async function setInputs({ entity_id, inputs: inputsRaw, _deps }) {
  const { evaluate } = _resolve(_deps);
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) throw new Error('inputs must be a non-empty object, e.g. { length: 50 }');
  const inputsJson = JSON.stringify(inputs);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var currentInputs = study.getInputValues();
      var overrides = ${inputsJson};
      var updatedKeys = {};
      for (var i = 0; i < currentInputs.length; i++) {
        if (overrides.hasOwnProperty(currentInputs[i].id)) {
          currentInputs[i].value = overrides[currentInputs[i].id];
          updatedKeys[currentInputs[i].id] = overrides[currentInputs[i].id];
        }
      }
      study.setInputValues(currentInputs);
      return { updated_inputs: updatedKeys };
    })()
  `);
  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, updated_inputs: result.updated_inputs };
}

export async function toggleVisibility({ entity_id, visible, _deps }) {
  const { evaluate } = _resolve(_deps);
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (typeof visible !== 'boolean') throw new Error('visible must be a boolean (true or false)');
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      study.setVisible(${visible});
      return { visible: study.isVisible() };
    })()
  `);
  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, visible: result.visible };
}

export async function applyScopedPlanItem({ profile_id, tab_index, pane_index, indicator_name, expected_settings: expectedSettingsRaw, action = 'apply_indicator', _deps }) {
  const scope = _requireScopedRequest({ profile_id, tab_index, pane_index, indicator_name });
  if (!SUPPORTED_SCOPED_ACTIONS.has(action)) throw new Error(`unsupported scoped indicator action: ${action}`);
  const expectedSettings = _parseObject(expectedSettingsRaw, 'expected_settings');
  const focusResult = await _selectScopedChart({ ...scope, _deps });
  const existingStudy = await _getStudyByName({ indicator_name: scope.indicator_name, _deps });
  const previousEvidence = existingStudy ? _settingsEvidenceFromStudy(existingStudy) : { settings: {}, source: 'absent', unavailable_reason: null };
  let appliedStudy;
  if (action === 'apply_indicator') {
    appliedStudy = await _applyIndicator({ indicator_name: scope.indicator_name, expected_settings: expectedSettings, _deps });
  } else {
    if (!existingStudy) throw new Error(`indicator not found for update: ${scope.indicator_name}`);
    appliedStudy = await _updateIndicatorSettings({ entity_id: existingStudy.id, expected_settings: expectedSettings, _deps });
    if (appliedStudy.previous && Object.keys(appliedStudy.previous).length > 0) {
      previousEvidence.settings = appliedStudy.previous;
      previousEvidence.source = 'input_values';
      previousEvidence.unavailable_reason = null;
    }
  }
  const newEvidence = _settingsEvidenceFromStudy(appliedStudy);
  const unavailableReasons = {};
  if (previousEvidence.unavailable_reason) unavailableReasons.previous_settings = previousEvidence.unavailable_reason;
  if (newEvidence.unavailable_reason) unavailableReasons.new_settings = newEvidence.unavailable_reason;
  return {
    success: true,
    profile_id: scope.profile_id,
    tab_index: scope.tab_index,
    pane_index: scope.pane_index,
    indicator_name: scope.indicator_name,
    action,
    applied: true,
    entity_id: appliedStudy.id || null,
    previous_settings: previousEvidence.settings,
    new_settings: newEvidence.settings,
    previous_settings_source: previousEvidence.source,
    new_settings_source: newEvidence.source,
    settings_unavailable_reason: unavailableReasons,
    focus: focusResult,
    message: 'scoped indicator plan item applied',
  };
}

export async function updateScopedSettings(args) {
  return applyScopedPlanItem({ ...args, action: 'update_indicator_settings' });
}

const HASH = /^[0-9a-f]{64}$/i;

function normalizeObserverIndicatorFence(input = {}, { mutation = false, entity = false } = {}) {
  const text = (value, name) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
    return value.trim();
  };
  const index = (value, name) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
    return number;
  };
  const signature = input.expected_pane_signature === undefined
    ? undefined
    : text(input.expected_pane_signature, 'expected_pane_signature');
  if (mutation && (!signature || !HASH.test(signature))) throw new Error('expected_pane_signature must be a SHA-256 hash');
  if (!mutation && signature !== undefined && !HASH.test(signature)) throw new Error('expected_pane_signature must be a SHA-256 hash');
  if (entity) text(input.expected_entity_id, 'expected_entity_id');
  return {
    profile_id: text(input.profile_id, 'profile_id'),
    expected_chart_target_id: text(input.expected_chart_target_id, 'expected_chart_target_id'),
    expected_chart_id: text(input.expected_chart_id, 'expected_chart_id'),
    expected_layout_id: text(input.expected_layout_id, 'expected_layout_id'),
    tab_index: index(input.tab_index, 'tab_index'),
    pane_index: index(input.pane_index, 'pane_index'),
    ...(input.expected_pane_signature === undefined ? {} : { expected_pane_signature: signature.toLowerCase() }),
    ...(input.expected_entity_id === undefined ? {} : { expected_entity_id: text(input.expected_entity_id, 'expected_entity_id') }),
  };
}

async function verifyObserverIndicatorFence(scope, _deps) {
  const session = _deps?.session || getObserverSession();
  if (!session
    || session.profileId !== scope.profile_id
    || session.chartTargetId !== scope.expected_chart_target_id
    || session.chartTargetUrl !== `https://www.tradingview.com/chart/${scope.expected_chart_id}/`) {
    throw new Error('scoped indicator observer identity does not match exact profile/chart authority');
  }
  const listTabs = _deps?.listTabs || _listTabs;
  const tabs = await listTabs();
  const matches = Array.isArray(tabs?.tabs)
    ? tabs.tabs.filter((tab) => tab?.index === scope.tab_index && tab?.id === scope.expected_chart_target_id)
    : [];
  if (tabs?.success !== true || matches.length !== 1) throw new Error('scoped indicator exact tab target is not unique');
  const tab = matches[0];
  if (tab.chart_id !== scope.expected_chart_id || tab.url !== session.chartTargetUrl) {
    throw new Error('scoped indicator exact chart target does not match authority');
  }
  const evaluate = _deps?.evaluate || _evaluate;
  const layout = await evaluate(`
    (function() {
      var cwc = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
      var layout = cwc && cwc._layoutType;
      if (layout && typeof layout.value === 'function') layout = layout.value();
      return { layout_id: layout == null ? '' : String(layout) };
    })()
  `);
  if (!layout || layout.layout_id !== scope.expected_layout_id) {
    throw new Error('scoped indicator exact pane layout does not match authority');
  }
}

function scopedPane(inventory, paneIndex) {
  const pane = inventory?.panes?.find((entry) => entry.index === paneIndex);
  if (!pane) throw new Error(`scoped indicator pane ${paneIndex} is unavailable`);
  return pane;
}

function matchingIndicators(pane, name) {
  return pane.indicators.filter((indicator) => indicator.indicator_name.toLowerCase() === name.toLowerCase());
}

export async function readScopedIndicatorSignatures(input = {}, { _deps } = {}) {
  const scope = normalizeObserverIndicatorFence(input);
  await verifyObserverIndicatorFence(scope, _deps);
  const inventory = await (_deps?.indicatorSignatures || _indicatorSignatures)({ _deps });
  scopedPane(inventory, scope.pane_index);
  return {
    ...inventory,
    profile_id: scope.profile_id,
    chart_target_id: scope.expected_chart_target_id,
    chart_id: scope.expected_chart_id,
    tab_index: scope.tab_index,
    pane_index: scope.pane_index,
  };
}

export async function readScopedIndicatorMutationInventory(input = {}, { _deps } = {}) {
  const scope = normalizeObserverIndicatorFence(input);
  await verifyObserverIndicatorFence(scope, _deps);
  const inventory = await (_deps?.mutationIdentityInventory || _mutationIdentityInventory)({ _deps });
  scopedPane(inventory, scope.pane_index);
  return {
    ...inventory,
    profile_id: scope.profile_id,
    chart_target_id: scope.expected_chart_target_id,
    chart_id: scope.expected_chart_id,
    tab_index: scope.tab_index,
    pane_index: scope.pane_index,
  };
}

async function runObserverIndicatorMutation(input, action, { _deps } = {}) {
  const scope = normalizeObserverIndicatorFence(input, {
    mutation: true,
    entity: action !== 'apply_indicator',
  });
  const indicatorName = typeof input.indicator_name === 'string' && input.indicator_name.trim();
  if (!indicatorName) throw new Error('indicator_name is required');
  const expectedSettings = action === 'remove_indicator'
    ? {}
    : _parseObject(input.expected_settings, 'expected_settings', { allowEmpty: action === 'apply_indicator' });

  await verifyObserverIndicatorFence(scope, _deps);
  const readSignatures = _deps?.indicatorSignatures || _indicatorSignatures;
  const before = await readSignatures({ _deps });
  const beforePane = scopedPane(before, scope.pane_index);
  if (beforePane.signature !== scope.expected_pane_signature) {
    throw new Error('scoped indicator pre-mutation pane signature does not match authority');
  }
  const matching = matchingIndicators(beforePane, indicatorName);
  if (action === 'apply_indicator' && matching.length !== 0) {
    throw new Error('scoped indicator apply refuses an existing matching indicator');
  }
  if (action !== 'apply_indicator') {
    if (matching.length !== 1) throw new Error(`scoped indicator ${action === 'remove_indicator' ? 'remove' : 'update'} requires exactly one matching indicator`);
    if (matching[0].entity_id !== scope.expected_entity_id) throw new Error('scoped indicator expected entity ID does not match authority');
  }

  const focusResult = await _selectScopedChart({ tab_index: scope.tab_index, pane_index: scope.pane_index, _deps });
  const existing = await _getStudyByName({ indicator_name: indicatorName, _deps });
  if (existing?.error) throw new Error(existing.error);
  if (action !== 'apply_indicator' && (!existing || existing.id !== scope.expected_entity_id)) {
    throw new Error('scoped indicator live entity ID does not match authority');
  }
  if (action === 'apply_indicator' && existing) throw new Error('scoped indicator apply found an existing live indicator');

  let effect;
  if (action === 'apply_indicator') effect = await _applyIndicator({ indicator_name: indicatorName, expected_settings: expectedSettings, _deps });
  else if (action === 'update_indicator_settings') effect = await _updateIndicatorSettings({ entity_id: scope.expected_entity_id, expected_settings: expectedSettings, _deps });
  else effect = await _removeScopedEntity({ entity_id: scope.expected_entity_id, _deps });

  const after = await readSignatures({ _deps });
  const afterPane = scopedPane(after, scope.pane_index);
  const afterMatching = matchingIndicators(afterPane, indicatorName);
  if (action === 'remove_indicator' && afterMatching.length !== 0) throw new Error('scoped indicator removal post-readback still contains target');
  if (action !== 'remove_indicator' && afterMatching.length !== 1) throw new Error('scoped indicator mutation post-readback is ambiguous');
  if (action !== 'remove_indicator' && action !== 'apply_indicator' && afterMatching[0].entity_id !== scope.expected_entity_id) throw new Error('scoped indicator update post-readback entity ID changed');
  return {
    success: true,
    profile_id: scope.profile_id,
    chart_target_id: scope.expected_chart_target_id,
    chart_id: scope.expected_chart_id,
    tab_index: scope.tab_index,
    pane_index: scope.pane_index,
    indicator_name: indicatorName,
    action,
    entity_id: afterMatching[0]?.entity_id || effect?.id || null,
    pre_mutation_signature: beforePane.signature,
    post_mutation_signature: afterPane.signature,
    post_mutation_indicator_count: afterPane.indicators.length,
    mutations_performed: true,
    focus: focusResult,
  };
}

async function _removeScopedEntity({ entity_id, _deps }) {
  const evaluate = _deps?.evaluate || _evaluate;
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      if (!chart || typeof chart.removeEntity !== 'function') return { error: 'scoped indicator removal API is unavailable' };
      if (!chart.getStudyById || !chart.getStudyById(${safeString(entity_id)})) return { error: 'scoped indicator removal target is unavailable' };
      chart.removeEntity(${safeString(entity_id)});
      return { id: ${safeString(entity_id)}, removed: true };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  if (result?.removed !== true || result.id !== entity_id) throw new Error('scoped indicator removal readback failed');
  return result;
}

export async function applyScopedIndicator(input = {}, options = {}) {
  return runObserverIndicatorMutation(input, 'apply_indicator', options);
}

export async function updateScopedIndicatorSettings(input = {}, options = {}) {
  return runObserverIndicatorMutation(input, 'update_indicator_settings', options);
}

export async function removeScopedIndicator(input = {}, options = {}) {
  return runObserverIndicatorMutation(input, 'remove_indicator', options);
}
