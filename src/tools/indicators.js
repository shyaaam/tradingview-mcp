import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/indicators.js';
import { registerObserverTool } from '../release/observer-schema.js';

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

  registerObserverTool(server, 'pane_indicator_signatures', 'Read exact scoped pane indicator signatures and normalized settings without focus or mutation', async (input) => {
    try { return jsonResult(await core.readScopedIndicatorSignatures(input)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  registerObserverTool(server, 'pane_indicator_mutation_inventory', 'Read exact scoped pane indicator mutation identities without focus or mutation', async (input) => {
    try { return jsonResult(await core.readScopedIndicatorMutationInventory(input)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  registerObserverTool(server, 'indicator_apply_scoped', 'Apply one indicator only after exact profile, chart, tab, pane, and signature fences', async (input) => {
    try { return jsonResult(await core.applyScopedIndicator(input)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  registerObserverTool(server, 'indicator_update_settings_scoped', 'Update one exact indicator entity only after exact identity and signature fences', async (input) => {
    try { return jsonResult(await core.updateScopedIndicatorSettings(input)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  registerObserverTool(server, 'indicator_remove_scoped', 'Remove one exact indicator entity only after exact identity and signature fences', async (input) => {
    try { return jsonResult(await core.removeScopedIndicator(input)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
