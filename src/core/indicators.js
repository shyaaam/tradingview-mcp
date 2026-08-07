/**
 * Core indicator settings logic.
 */
import { evaluate as _evaluate, safeString } from '../connection.js';
import { focus as _focusPane, indicatorSignatures as _indicatorSignatures } from './pane.js';
import { switchTab as _switchTab, list as _listTabs } from './tab.js';
import { getObserverSession } from './observer-session.js';
import { resolveCloakManagerBaseUrl } from './cloak.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const CHART_COLLECTION = 'window.TradingViewApi._chartWidgetCollection';

const SUPPORTED_SCOPED_ACTIONS = new Set(['apply_indicator', 'update_indicator_settings', 'remove_indicator']);

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    focusPane: deps?.focusPane || _focusPane,
    indicatorSignatures: deps?.indicatorSignatures || _indicatorSignatures,
    switchTab: deps?.switchTab || _switchTab,
    listTabs: deps?.listTabs || _listTabs,
    verifyMutationAuthority: deps?.verifyMutationAuthority || (deps ? async () => {} : _verifyMutationAuthority),
  };
}

function _parseObject(value, name, { allowEmpty = false } = {}) {
  const parsed = value ? (typeof value === 'string' ? JSON.parse(value) : value) : undefined;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be an object`);
  }
  if (!allowEmpty && Object.keys(parsed).length === 0) throw new Error(`${name} must be a non-empty object`);
  return parsed;
}

function _requireScopedRequest({ profile_id, tab_index, pane_index, indicator_name, expected_chart_target_id, expected_chart_id, expected_layout_id, expected_pane_signature, expected_entity_id }, allowMissingAuthority = false) {
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
  if (!allowMissingAuthority && (!expected_chart_target_id || typeof expected_chart_target_id !== 'string' || !expected_chart_target_id.trim())) throw new Error('expected_chart_target_id is required');
  if (!allowMissingAuthority && (!expected_chart_id || typeof expected_chart_id !== 'string' || !expected_chart_id.trim())) throw new Error('expected_chart_id is required');
  if (!allowMissingAuthority && (!expected_layout_id || typeof expected_layout_id !== 'string' || !expected_layout_id.trim())) throw new Error('expected_layout_id is required');
  if (!allowMissingAuthority && (!expected_pane_signature || !/^[0-9a-f]{64}$/i.test(String(expected_pane_signature)))) throw new Error('expected_pane_signature must be a SHA-256 hash');
  if (expected_entity_id !== undefined && (typeof expected_entity_id !== 'string' || !expected_entity_id.trim())) throw new Error('expected_entity_id must be non-empty when supplied');
  return { profile_id: profile_id.trim(), tab_index: tabIndex, pane_index: paneIndex, indicator_name: indicator_name.trim(), ...(expected_chart_target_id === undefined ? {} : { expected_chart_target_id: expected_chart_target_id.trim() }), ...(expected_chart_id === undefined ? {} : { expected_chart_id: expected_chart_id.trim() }), ...(expected_layout_id === undefined ? {} : { expected_layout_id: expected_layout_id.trim() }), ...(expected_pane_signature === undefined ? {} : { expected_pane_signature: String(expected_pane_signature).toLowerCase() }), ...(expected_entity_id === undefined ? {} : { expected_entity_id: expected_entity_id.trim() }) };
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
      var matches = [];
      for (var i = 0; i < studies.length; i++) {
        var item = studies[i] || {};
        var name = String(item.name || item.title || '').toLowerCase();
        if (name === ${safeString(indicator_name.toLowerCase())}) {
          var study = chart.getStudyById(item.id);
          var inputs = study && study.getInputValues ? study.getInputValues() : [];
          matches.push({ id: item.id, name: item.name || item.title || ${safeString(indicator_name)}, inputs: inputs, values: item.values || item.description || null });
        }
      }
      if (matches.length > 1) return { error: 'scoped indicator mutation found duplicate matching studies: ' + ${safeString(indicator_name)} };
      if (matches.length === 1) return matches[0];
      return null;
    })()
  `);
  return result || null;
}

async function _applyIndicator({ indicator_name, expected_settings, _deps }) {
  const { evaluate } = _resolve(_deps);
  const expectedSettingsJson = JSON.stringify(expected_settings);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var collection = ${CHART_COLLECTION};
      var charts = collection && typeof collection.getAll === 'function' ? collection.getAll() : [];
      var canonicalWidget = charts[0];
      var canonicalModel = canonicalWidget && typeof canonicalWidget.model === 'function'
        ? canonicalWidget.model().model()
        : null;
      var canonicalSources = canonicalModel && typeof canonicalModel.dataSources === 'function'
        ? canonicalModel.dataSources()
        : [];
      var canonicalMatches = canonicalSources.filter(function(source) {
        if (!source || typeof source.metaInfo !== 'function') return false;
        var meta = source.metaInfo();
        var name = String(meta && (meta.description || meta.shortDescription || '')).trim();
        return name.toLowerCase() === ${safeString(indicator_name.trim().toLowerCase())};
      });
      if (canonicalMatches.length !== 1) {
        return { error: 'scoped indicator add requires exactly one canonical pane indicator: ' + ${safeString(indicator_name)} };
      }
      var canonicalMeta = canonicalMatches[0].metaInfo();
      var canonicalInputs = typeof canonicalMatches[0].inputs === 'function'
        ? canonicalMatches[0].inputs()
        : {};
      if (!canonicalInputs || typeof canonicalInputs !== 'object' || Array.isArray(canonicalInputs)) {
        return { error: 'scoped indicator add canonical inputs are unavailable: ' + ${safeString(indicator_name)} };
      }
      var expectedSettings = ${expectedSettingsJson};
      var inputs = Object.assign({}, canonicalInputs);
      Object.keys(expectedSettings).forEach(function(key) {
        var value = expectedSettings[key];
        if (value && typeof value === 'object' && !Array.isArray(value)
          && Object.prototype.hasOwnProperty.call(value, 'v')
          && Object.keys(value).every(function(field) { return field === 'f' || field === 't' || field === 'v'; })) {
          inputs[key] = value.v;
        } else {
          inputs[key] = value;
        }
      });
      var targetModel = chart && chart._chartWidget && typeof chart._chartWidget.model === 'function'
        ? chart._chartWidget.model().model()
        : null;
      if (!targetModel || typeof targetModel.insertStudyWithParams !== 'function') {
        return { error: 'scoped indicator add target study insertion is unavailable' };
      }
      var before = chart.getAllStudies ? chart.getAllStudies().map(function(s) { return s.id; }) : [];
      var insertion = targetModel.insertStudyWithParams({
        studyMetaInfo: canonicalMeta,
        inputs: inputs,
        forceOverlay: canonicalMeta.is_price_study === true,
      });
      if (!insertion || !insertion.startPromise) {
        return { error: 'scoped indicator add did not return an insertion handle' };
      }
      return Promise.resolve(insertion.startPromise).then(function() {
        return Promise.resolve(insertion.study).then(function() {
          return new Promise(function(resolve) {
            setTimeout(function() {
              var after = chart.getAllStudies ? chart.getAllStudies() : [];
              var addedStudies = after.filter(function(study) {
                return study && typeof study.id === 'string' && study.id.length > 0 && before.indexOf(study.id) === -1;
              });
              if (addedStudies.length !== 1) return resolve({ error: 'scoped indicator add did not produce exactly one identifiable study' });
              var added = addedStudies[0];
              var addedName = String(added.name || added.title || '').trim();
              if (addedName.toLowerCase() !== ${safeString(indicator_name.trim().toLowerCase())}) {
                return resolve({ error: 'scoped indicator add resolved an unexpected study name' });
              }
              var study = chart.getStudyById(added.id);
              var inputValues = study && study.getInputValues ? study.getInputValues() : [];
              resolve({ id: added.id, name: added.name || added.title || ${safeString(indicator_name)}, inputs: inputValues, values: added.values || added.description || null });
            }, 1200);
          });
        });
      }).catch(function(error) {
        return { error: String(error && error.message ? error.message : error) };
      });
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return result;
}

async function _updateIndicatorSettings({ entity_id, indicator_name, expected_settings, _deps }) {
  const { evaluate } = _resolve(_deps);
  const settingsJson = JSON.stringify(expected_settings);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var underlyingStudy = typeof study.study === 'function' ? study.study() : null;
      var inputProperties = underlyingStudy && typeof underlyingStudy.properties === 'function'
        ? underlyingStudy.properties()?.childs?.()?.inputs?.childs?.()
        : null;
      var inputMetadata = {};
      try {
        var metadata = underlyingStudy && typeof underlyingStudy.metaInfo === 'function' ? underlyingStudy.metaInfo() : null;
        (metadata?.inputs || []).forEach(function(input) { if (input && input.id) inputMetadata[input.id] = input; });
      } catch (_) {}
      function propertyValue(key, value) {
        var metadata = inputMetadata[key];
        if (metadata?.type !== 'color' || typeof value !== 'number' || !Number.isFinite(value)) return value;
        var integer = value >>> 0;
        var alpha = ((integer >>> 24) & 255) / 255;
        var alphaText = alpha === 1 ? '1' : String(Number(alpha.toFixed(6)));
        return 'rgba(' + (integer & 255) + ',' + ((integer >>> 8) & 255) + ',' + ((integer >>> 16) & 255) + ',' + alphaText + ')';
      }
      function apiColorValue(value) {
        if (typeof value !== 'string') return value;
        var rgba = value.match(/^rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([0-9.]+))?\\s*\\)$/i);
        if (rgba) {
          var alpha = rgba[4] === undefined ? 255 : Math.round(Number(rgba[4]) * 255);
          return ((((alpha & 255) << 24) >>> 0) + ((Number(rgba[3]) & 255) << 16) + ((Number(rgba[2]) & 255) << 8) + (Number(rgba[1]) & 255)) >>> 0;
        }
        var hex = value.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
        if (hex) {
          var rgb = hex[1];
          var alpha = hex[2] === undefined ? 255 : parseInt(hex[2], 16);
          return ((((alpha & 255) << 24) >>> 0) + parseInt(rgb.slice(0, 2), 16) + (parseInt(rgb.slice(2, 4), 16) << 8) + (parseInt(rgb.slice(4, 6), 16) << 16)) >>> 0;
        }
        return value;
      }
      var currentInputs = study.getInputValues ? study.getInputValues() : [];
      var targetInputValuesAvailable = Array.isArray(currentInputs) && currentInputs.length > 0;
      var previous = {};
      var rawOverrides = ${settingsJson};
      var overrides = {};
      Object.keys(rawOverrides).forEach(function(key) {
        var value = rawOverrides[key];
        overrides[key] = value && typeof value === 'object' && !Array.isArray(value)
          && Object.prototype.hasOwnProperty.call(value, 'v')
          && Object.keys(value).every(function(field) { return field === 'f' || field === 't' || field === 'v'; })
          ? value.v
          : value;
      });
      var missing = Object.keys(overrides).filter(function(key) {
        return !Array.isArray(currentInputs) || !currentInputs.some(function(input) { return input && input.id === key; });
      });
      var usePublicInputSetter = targetInputValuesAvailable && missing.length === 0;
      if (missing.length > 0) {
        var collection = ${CHART_COLLECTION};
        var charts = collection && typeof collection.getAll === 'function' ? collection.getAll() : [];
        var canonicalWidget = charts[0];
        var canonicalModel = canonicalWidget && typeof canonicalWidget.model === 'function'
          ? canonicalWidget.model().model()
          : null;
        var sources = canonicalModel && typeof canonicalModel.dataSources === 'function'
          ? canonicalModel.dataSources()
          : [];
        var canonicalMatches = sources.filter(function(source) {
          if (!source || typeof source.metaInfo !== 'function') return false;
          var meta = source.metaInfo();
          var name = String(meta && (meta.description || meta.shortDescription || '')).trim();
          return name.toLowerCase() === ${safeString(indicator_name.trim().toLowerCase())};
        });
        if (canonicalMatches.length !== 1 || typeof canonicalMatches[0].inputs !== 'function') {
          return { error: 'scoped indicator update canonical inputs unavailable: ' + ${safeString(indicator_name)} };
        }
        var canonicalInputs = canonicalMatches[0].inputs();
        if (!canonicalInputs || typeof canonicalInputs !== 'object' || Array.isArray(canonicalInputs)) {
          return { error: 'scoped indicator update canonical inputs unavailable: ' + ${safeString(indicator_name)} };
        }
        currentInputs = Object.keys(canonicalInputs)
          .filter(function(key) { return key.indexOf('in_') === 0 || key.indexOf('__') === 0; })
          .map(function(key) {
            var value = canonicalInputs[key];
            return {
              id: key,
              value: value && typeof value === 'object' && !Array.isArray(value)
                && Object.prototype.hasOwnProperty.call(value, 'v')
                && Object.keys(value).every(function(field) { return field === 'f' || field === 't' || field === 'v'; })
                ? value.v
                : value,
            };
          });
        var restoredMissing = missing.filter(function(key) {
          return !currentInputs.some(function(input) { return input && input.id === key; });
        });
        if (restoredMissing.length > 0) return { error: 'scoped indicator update input(s) not found: ' + restoredMissing.join(',') };
        if (!usePublicInputSetter && !targetInputValuesAvailable && inputProperties && typeof inputProperties === 'object'
          && typeof canonicalMatches[0].properties === 'function') {
          var canonicalPropertyState = canonicalMatches[0].properties()?.state?.()?.inputs;
          if (!canonicalPropertyState || typeof canonicalPropertyState !== 'object') {
            return { error: 'scoped indicator update canonical property state unavailable: ' + ${safeString(indicator_name)} };
          }
          Object.keys(canonicalPropertyState).forEach(function(key) {
            if (key === 'first_visible_bar_time' || key === 'last_visible_bar_time' || key === 'subscribeRealtime') return;
            if (inputProperties[key] && typeof inputProperties[key].setValue === 'function') {
              inputProperties[key].setValue(canonicalPropertyState[key]);
            }
          });
        }
      }
      if (usePublicInputSetter) {
        for (var i = 0; i < currentInputs.length; i++) {
          if (overrides.hasOwnProperty(currentInputs[i].id)) {
            previous[currentInputs[i].id] = currentInputs[i].value;
            currentInputs[i].value = propertyValue(currentInputs[i].id, overrides[currentInputs[i].id]);
          }
        }
        study.setInputValues(currentInputs);
      } else {
        // A partially corrupted TradingView study can expose no public input
        // values even though its underlying property nodes remain repairable.
        // The public setter intentionally ignores IDs absent from
        // getInputValues(), so restore only verified override IDs through the
        // study's own input property collection.
        if (!inputProperties || typeof inputProperties !== 'object') {
          return { error: 'scoped indicator update target input properties unavailable: ' + ${safeString(indicator_name)} };
        }
        var missingInputProperties = Object.keys(overrides).filter(function(key) {
          return !inputProperties[key] || typeof inputProperties[key].setValue !== 'function';
        });
        if (missingInputProperties.length > 0) {
          return { error: 'scoped indicator update input(s) not found: ' + missingInputProperties.join(',') };
        }
        Object.keys(overrides).forEach(function(key) {
          var property = inputProperties[key];
          var priorValue = property.value();
          previous[key] = priorValue && typeof priorValue === 'object' && Object.prototype.hasOwnProperty.call(priorValue, 'v')
            ? priorValue.v
            : priorValue;
          property.setValue(propertyValue(key, overrides[key]));
        });
      }
      var updated = study.getInputValues ? study.getInputValues() : currentInputs;
      if (!Array.isArray(updated) || updated.length === 0) {
        var rawInputs = {};
        try { rawInputs = underlyingStudy?.inputs?.({ asObject: true }) || {}; } catch (_) {}
        if (!rawInputs || Object.keys(rawInputs).length === 0) {
          try { rawInputs = underlyingStudy?.inputs?.({ asObject: true, valuesAsIsFromProperties: true }) || {}; } catch (_) {}
        }
        updated = Object.keys(rawInputs).map(function(key) {
          var value = rawInputs[key];
          if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'v')) value = value.v;
          if (inputMetadata[key]?.type === 'color') value = apiColorValue(value);
          return { id: key, value: value };
        });
      }
      var studies = chart.getAllStudies ? chart.getAllStudies() : [];
      var studyMeta = null;
      for (var i = 0; i < studies.length; i++) {
        if (studies[i] && studies[i].id === ${safeString(entity_id)}) { studyMeta = studies[i]; break; }
      }
      var mismatched = Object.keys(overrides).filter(function(key) {
        var readback = updated.find(function(input) { return input && input.id === key; });
        return !readback || JSON.stringify(readback.value) !== JSON.stringify(overrides[key]);
      });
      if (mismatched.length > 0) return { error: 'scoped indicator update readback mismatch: ' + mismatched.join(',') };
      return { id: ${safeString(entity_id)}, previous: previous, inputs: updated, values: studyMeta ? (studyMeta.values || studyMeta.description || null) : null };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return result;
}

async function _removeIndicator({ entity_id, _deps }) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      if (!chart || typeof chart.removeEntity !== 'function') return { error: 'scoped indicator removal API is unavailable' };
      var study = chart.getStudyById ? chart.getStudyById(${safeString(entity_id)}) : null;
      if (!study) return { error: 'scoped indicator removal target is unavailable' };
      chart.removeEntity(${safeString(entity_id)});
      return { id: ${safeString(entity_id)}, removed: true };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  if (result?.removed !== true || result.id !== entity_id) throw new Error('scoped indicator removal readback failed');
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

export async function applyScopedPlanItem({ profile_id, tab_index, pane_index, indicator_name, expected_chart_target_id, expected_chart_id, expected_layout_id, expected_pane_signature, expected_entity_id, expected_settings: expectedSettingsRaw, action = 'apply_indicator', _deps }) {
  const scope = _requireScopedRequest({ profile_id, tab_index, pane_index, indicator_name, expected_chart_target_id, expected_chart_id, expected_layout_id, expected_pane_signature, expected_entity_id }, _deps !== undefined);
  if (!SUPPORTED_SCOPED_ACTIONS.has(action)) throw new Error(`unsupported scoped indicator action: ${action}`);
  if (action === 'remove_indicator' && scope.expected_entity_id === undefined) throw new Error('scoped indicator removal requires expected_entity_id');
  const expectedSettings = action === 'remove_indicator'
    ? {}
    : _parseObject(expectedSettingsRaw, 'expected_settings', { allowEmpty: action === 'apply_indicator' });
  await _resolve(_deps).verifyMutationAuthority(scope, { action, _deps });
  const focusResult = await _selectScopedChart({ ...scope, _deps });
  const existingStudy = await _getStudyByName({ indicator_name: scope.indicator_name, _deps });
  if (existingStudy?.error) throw new Error(existingStudy.error);
  if (existingStudy && scope.expected_entity_id !== undefined && existingStudy.id !== scope.expected_entity_id) {
    throw new Error('scoped indicator mutation entity ID does not match reviewed entity');
  }
  if (action === 'apply_indicator' && existingStudy) {
    throw new Error(`scoped indicator add found an existing matching study: ${scope.indicator_name}`);
  }
  const previousEvidence = existingStudy ? _settingsEvidenceFromStudy(existingStudy) : { settings: {}, source: 'absent', unavailable_reason: null };
  let appliedStudy;
  if (action === 'apply_indicator') {
    appliedStudy = await _applyIndicator({ indicator_name: scope.indicator_name, expected_settings: expectedSettings, _deps });
  } else if (action === 'update_indicator_settings') {
    if (!existingStudy) throw new Error(`indicator not found for update: ${scope.indicator_name}`);
    appliedStudy = await _updateIndicatorSettings({ entity_id: existingStudy.id, indicator_name: scope.indicator_name, expected_settings: expectedSettings, _deps });
    if (appliedStudy.previous && Object.keys(appliedStudy.previous).length > 0) {
      previousEvidence.settings = appliedStudy.previous;
      previousEvidence.source = 'input_values';
      previousEvidence.unavailable_reason = null;
    }
  } else {
    if (!existingStudy) throw new Error(`indicator not found for removal: ${scope.indicator_name}`);
    appliedStudy = await _removeIndicator({ entity_id: existingStudy.id, _deps });
  }
  const newEvidence = _settingsEvidenceFromStudy(appliedStudy);
  const { indicatorSignatures } = _resolve(_deps);
  const postInventory = await indicatorSignatures({ _deps });
  const postPane = postInventory.panes.find((pane) => pane.index === scope.pane_index);
  if (!postPane) throw new Error(`scoped indicator mutation pane ${scope.pane_index} missing from post-mutation inventory`);
  const matchingIndicators = postPane.indicators.filter((indicator) => indicator.indicator_name.toLowerCase() === scope.indicator_name.toLowerCase());
  if (action === 'remove_indicator') {
    if (matchingIndicators.length !== 0) throw new Error(`scoped indicator removal did not remove ${scope.indicator_name}`);
  } else if (matchingIndicators.length !== 1) {
    throw new Error(`scoped indicator mutation did not produce exactly one post-mutation ${scope.indicator_name} indicator`);
  }
  const postIndicator = matchingIndicators[0] || null;
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
    post_mutation_signature: postPane.signature,
    post_mutation_indicator: postIndicator,
    post_mutation_indicator_count: postPane.indicators.length,
    focus: focusResult,
    message: 'scoped indicator plan item applied',
  };
}

async function _verifyMutationAuthority(scope, { action, _deps }) {
  const session = getObserverSession();
  if (!session || session.profileId !== scope.profile_id || session.chartTargetId !== scope.expected_chart_target_id) {
    throw new Error('scoped indicator mutation session identity does not match reviewed authority');
  }
  const managerBaseUrl = await resolveCloakManagerBaseUrl();
  if (!managerBaseUrl) throw new Error('scoped indicator mutation Manager is unavailable');
  const response = await fetch(new URL('profiles', `${managerBaseUrl}/`).toString());
  if (!response.ok) throw new Error('scoped indicator mutation Manager identity read failed');
  const payload = await response.json();
  const profiles = Array.isArray(payload) ? payload : payload?.profiles;
  const matches = Array.isArray(profiles) ? profiles.filter((profile) => {
    const id = profile?.id || profile?.profile_id || profile?.profileId;
    return String(id || '') === scope.profile_id;
  }) : [];
  if (matches.length !== 1 || !['running', 'active'].includes(String(matches[0]?.status || matches[0]?.state || '').toLowerCase())) {
    throw new Error('scoped indicator mutation live Manager profile identity is not approved');
  }
  const { evaluate, indicatorSignatures, listTabs } = _resolve(_deps);
  const tabs = await listTabs();
  const tabMatches = tabs.tabs.filter((tab) => tab.index === scope.tab_index && tab.id === scope.expected_chart_target_id);
  if (tabMatches.length !== 1) throw new Error('scoped indicator mutation target tab identity is not unique');
  const tab = tabMatches[0];
  const expectedUrl = `https://www.tradingview.com/chart/${scope.expected_chart_id}/`;
  if (tab.chart_id !== scope.expected_chart_id || tab.url !== expectedUrl) throw new Error('scoped indicator mutation chart identity does not match reviewed authority');
  const chartState = await evaluate(`(function(){var c=window.TradingViewApi&&window.TradingViewApi._chartWidgetCollection; var l=c&&c._layoutType; if(l&&typeof l.value==='function') l=l.value(); return {layout_id:String(l||'')};})()`);
  if (!chartState || chartState.layout_id !== scope.expected_layout_id) throw new Error('scoped indicator mutation layout identity does not match reviewed authority');
  const inventory = await indicatorSignatures({ _deps });
  const pane = inventory.panes.find((entry) => entry.index === scope.pane_index);
  if (!pane || pane.signature !== scope.expected_pane_signature) throw new Error('scoped indicator mutation pre-mutation pane signature does not match reviewed authority');
  const matching = pane.indicators.filter((entry) => entry.indicator_name.toLowerCase() === scope.indicator_name.toLowerCase());
  if (action === 'update_indicator_settings' && matching.length !== 1) throw new Error('scoped indicator update requires exactly one matching target study');
  if (action === 'update_indicator_settings' && scope.expected_entity_id !== undefined && matching[0]?.indicator_id !== scope.expected_entity_id) throw new Error('scoped indicator mutation reviewed entity ID is not present');
  if (action === 'remove_indicator' && matching.length !== 1) throw new Error('scoped indicator removal requires exactly one matching target study');
  if (action === 'remove_indicator' && matching[0]?.indicator_id !== scope.expected_entity_id) throw new Error('scoped indicator removal reviewed entity ID is not present');
  if (action === 'apply_indicator' && matching.length > 1) throw new Error('scoped indicator add refuses duplicate matching studies');
}

export async function updateScopedSettings(args) {
  return applyScopedPlanItem({ ...args, action: 'update_indicator_settings' });
}

export async function removeScopedIndicator(args) {
  return applyScopedPlanItem({ ...args, action: 'remove_indicator' });
}
