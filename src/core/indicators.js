/**
 * Core indicator settings logic.
 */
import { evaluate as _evaluate, safeString } from '../connection.js';
import { focus as _focusPane } from './pane.js';
import { switchTab as _switchTab } from './tab.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

const SUPPORTED_SCOPED_ACTIONS = new Set(['apply_indicator', 'update_indicator_settings']);

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    focusPane: deps?.focusPane || _focusPane,
    switchTab: deps?.switchTab || _switchTab,
  };
}

function _parseObject(value, name) {
  const parsed = value ? (typeof value === 'string' ? JSON.parse(value) : value) : undefined;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a non-empty object`);
  }
  if (Object.keys(parsed).length === 0) throw new Error(`${name} must be a non-empty object`);
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
          return { id: item.id, name: item.name || item.title || ${safeString(indicator_name)}, inputs: inputs };
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
          resolve({ id: added.id, name: added.name || added.title || ${safeString(indicator_name)}, inputs: inputs });
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
      return { id: ${safeString(entity_id)}, previous: previous, inputs: updated };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return result;
}

export async function setInputs({ entity_id, inputs: inputsRaw, _deps }) {
  const { evaluate } = _resolve(_deps);
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object, e.g. { length: 50 }');
  }

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
      var actualVisible = study.isVisible();
      return { visible: actualVisible };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, visible: result.visible };
}

export async function applyScopedPlanItem({
  profile_id,
  tab_index,
  pane_index,
  indicator_name,
  expected_settings: expectedSettingsRaw,
  action = 'apply_indicator',
  _deps,
}) {
  const scope = _requireScopedRequest({ profile_id, tab_index, pane_index, indicator_name });
  if (!SUPPORTED_SCOPED_ACTIONS.has(action)) throw new Error(`unsupported scoped indicator action: ${action}`);
  const expectedSettings = _parseObject(expectedSettingsRaw, 'expected_settings');

  const focusResult = await _selectScopedChart({ ...scope, _deps });
  const existingStudy = await _getStudyByName({ indicator_name: scope.indicator_name, _deps });
  let previousSettings = existingStudy ? _settingsFromInputValues(existingStudy.inputs) : {};
  let appliedStudy;

  if (action === 'apply_indicator') {
    appliedStudy = await _applyIndicator({
      indicator_name: scope.indicator_name,
      expected_settings: expectedSettings,
      _deps,
    });
  } else {
    if (!existingStudy) throw new Error(`indicator not found for update: ${scope.indicator_name}`);
    appliedStudy = await _updateIndicatorSettings({
      entity_id: existingStudy.id,
      expected_settings: expectedSettings,
      _deps,
    });
    previousSettings = appliedStudy.previous || previousSettings;
  }

  const newSettings = _settingsFromInputValues(appliedStudy.inputs);
  return {
    success: true,
    profile_id: scope.profile_id,
    tab_index: scope.tab_index,
    pane_index: scope.pane_index,
    indicator_name: scope.indicator_name,
    action,
    applied: true,
    entity_id: appliedStudy.id || null,
    previous_settings: previousSettings,
    new_settings: newSettings,
    focus: focusResult,
    message: 'scoped indicator plan item applied',
  };
}

export async function updateScopedSettings(args) {
  return applyScopedPlanItem({ ...args, action: 'update_indicator_settings' });
}
