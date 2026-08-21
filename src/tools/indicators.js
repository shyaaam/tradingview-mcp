import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/indicators.js';
import { registerObserverTool } from '../release/observer-schema.js';

export function registerIndicatorTools(server) {
  registerObserverTool(server, 'indicator_apply_blueprint_scoped', 'Apply one exact approved desired-state indicator to a blank or partially reconstructed chart pane with exact pre/post signature fences', async ({ profile_id, tab_index, pane_index, indicator_id, indicator_name, expected_is_price_study, expected_chart_target_id, expected_chart_id, expected_layout_id, expected_pane_signature, expected_post_pane_signature, expected_settings }) => {
    try {
      return jsonResult(await core.applyScopedBlueprintIndicator({
        profile_id,
        tab_index,
        pane_index,
        indicator_id,
        indicator_name,
        expected_is_price_study,
        expected_chart_target_id,
        expected_chart_id,
        expected_layout_id,
        expected_pane_signature,
        expected_post_pane_signature,
        expected_settings,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

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

  registerObserverTool(server, 'indicator_apply_scoped', 'Apply an indicator to a scoped tab/pane and return scoped evidence, including previous/new settings when TradingView exposes them', async ({ profile_id, tab_index, pane_index, indicator_name, expected_chart_target_id, expected_chart_id, expected_layout_id, expected_pane_signature, expected_entity_id, expected_settings }) => {
    try { return jsonResult(await core.applyScopedPlanItem({ profile_id, tab_index, pane_index, indicator_name, expected_chart_target_id, expected_chart_id, expected_layout_id, expected_pane_signature, ...(expected_entity_id === undefined ? {} : { expected_entity_id }), expected_settings, action: 'apply_indicator' })); }
    catch (err) { return jsonResult({ success: false, profile_id, tab_index, pane_index, indicator_name, action: 'apply_indicator', applied: false, error: err.message }, true); }
  });

  registerObserverTool(server, 'indicator_update_settings_scoped', 'Update indicator settings on a scoped tab/pane and return scoped evidence, including previous/new settings when TradingView exposes them', async ({ profile_id, tab_index, pane_index, indicator_name, expected_chart_target_id, expected_chart_id, expected_layout_id, expected_pane_signature, expected_entity_id, expected_settings }) => {
    try { return jsonResult(await core.updateScopedSettings({ profile_id, tab_index, pane_index, indicator_name, expected_chart_target_id, expected_chart_id, expected_layout_id, expected_pane_signature, ...(expected_entity_id === undefined ? {} : { expected_entity_id }), expected_settings })); }
    catch (err) { return jsonResult({ success: false, profile_id, tab_index, pane_index, indicator_name, action: 'update_indicator_settings', applied: false, error: err.message }, true); }
  });

  registerObserverTool(server, 'indicator_remove_scoped', 'Remove one exact indicator from a scoped tab/pane and return post-mutation evidence', async ({ profile_id, tab_index, pane_index, indicator_name, expected_chart_target_id, expected_chart_id, expected_layout_id, expected_pane_signature, expected_entity_id }) => {
    try { return jsonResult(await core.removeScopedIndicator({ profile_id, tab_index, pane_index, indicator_name, expected_chart_target_id, expected_chart_id, expected_layout_id, expected_pane_signature, expected_entity_id })); }
    catch (err) { return jsonResult({ success: false, profile_id, tab_index, pane_index, indicator_name, action: 'remove_indicator', applied: false, error: err.message }, true); }
  });
}
