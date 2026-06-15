import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/indicators.js';

export function registerIndicatorTools(server) {
  server.tool('indicator_set_inputs', 'Change indicator/study input values (e.g., length, source, period)', {
    entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
    inputs: z.string().describe('JSON string of input overrides, e.g. \'{"length": 50, "source": "close"}\'. Keys are input IDs, values are the new values.'),
  }, async ({ entity_id, inputs }) => {
    try { return jsonResult(await core.setInputs({ entity_id, inputs })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('indicator_toggle_visibility', 'Show or hide an indicator/study on the chart', {
    entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
    visible: z.coerce.boolean().describe('true to show, false to hide'),
  }, async ({ entity_id, visible }) => {
    try { return jsonResult(await core.toggleVisibility({ entity_id, visible })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('indicator_apply_scoped', 'Apply an indicator to a scoped tab/pane and return scoped evidence, including previous/new settings when TradingView exposes them', {
    profile_id: z.string().describe('Runtime/browser profile id supplied by the orchestrator'),
    tab_index: z.coerce.number().int().nonnegative().describe('TradingView chart tab index'),
    pane_index: z.coerce.number().int().nonnegative().describe('TradingView pane index'),
    indicator_name: z.string().describe('TradingView-recognized study name/title to apply, including custom/private confluence indicators'),
    expected_settings: z.string().describe('JSON object of expected custom indicator settings/inputs, e.g. \'{"length":14}\''),
  }, async ({ profile_id, tab_index, pane_index, indicator_name, expected_settings }) => {
    try {
      return jsonResult(await core.applyScopedPlanItem({
        profile_id,
        tab_index,
        pane_index,
        indicator_name,
        expected_settings,
        action: 'apply_indicator',
      }));
    } catch (err) {
      return jsonResult({
        success: false,
        profile_id,
        tab_index,
        pane_index,
        indicator_name,
        action: 'apply_indicator',
        applied: false,
        error: err.message,
      }, true);
    }
  });

  server.tool('indicator_update_settings_scoped', 'Update indicator settings on a scoped tab/pane and return scoped evidence, including previous/new settings when TradingView exposes them', {
    profile_id: z.string().describe('Runtime/browser profile id supplied by the orchestrator'),
    tab_index: z.coerce.number().int().nonnegative().describe('TradingView chart tab index'),
    pane_index: z.coerce.number().int().nonnegative().describe('TradingView pane index'),
    indicator_name: z.string().describe('Existing indicator/study name/title to update, including custom/private confluence indicators'),
    expected_settings: z.string().describe('JSON object of expected custom indicator settings/inputs, e.g. \'{"length":14}\''),
  }, async ({ profile_id, tab_index, pane_index, indicator_name, expected_settings }) => {
    try {
      return jsonResult(await core.updateScopedSettings({
        profile_id,
        tab_index,
        pane_index,
        indicator_name,
        expected_settings,
      }));
    } catch (err) {
      return jsonResult({
        success: false,
        profile_id,
        tab_index,
        pane_index,
        indicator_name,
        action: 'update_indicator_settings',
        applied: false,
        error: err.message,
      }, true);
    }
  });
}
