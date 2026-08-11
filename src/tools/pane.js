import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pane.js';
import { registerObserverTool } from '../release/observer-schema.js';

export function registerPaneTools(server) {
  registerObserverTool(server, 'pane_list', 'List all chart panes in the current layout with their symbols and active state', async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  registerObserverTool(server, 'pane_indicator_signatures', 'Read canonical indicator identity and normalized settings for every chart pane without focusing or mutating panes', async () => {
    try { return jsonResult(await core.indicatorSignatures()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  registerObserverTool(server, 'pane_indicator_mutation_inventory', 'Read per-pane study identity and exact getAllStudies mutation visibility without focusing or mutating panes', async () => {
    try { return jsonResult(await core.mutationIdentityInventory()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  registerObserverTool(server, 'pane_probe_layout_capability', 'Probe one exact TradingView pane layout capability and restore the prior layout', async ({ pane_count, timeout_ms, poll_interval_ms, stable_polls, validate_focus }) => {
    try {
      return jsonResult(await core.probeLayoutCapability({
        paneCount: pane_count,
        timeoutMs: timeout_ms,
        pollIntervalMs: poll_interval_ms,
        stablePolls: stable_polls,
        validateFocus: validate_focus,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  registerObserverTool(server, 'pane_set_layout_scoped_v1', 'Set one exact existing chart layout with profile, target, account, saved-layout, and pane-count fences', async (input) => {
    try {
      return jsonResult(await core.setLayoutScoped(input));
    } catch (err) {
      const layoutInvoked = err?.layoutInvoked === true;
      return jsonResult({
        success: false,
        profile_id: input?.profile_id || null,
        chart_target_id: input?.chart_target_id || null,
        layout_invoked: layoutInvoked,
        mutations_performed: layoutInvoked,
        effect_phase: err?.phase || 'pre-layout-authority',
        effect_state: err?.effectState || 'blocked',
        error: err instanceof Error ? err.message : 'Scoped pane layout mutation failed.',
      }, true);
    }
  });

  server.tool('pane_set_layout', 'Change the chart grid layout (e.g., single, 2x2, 2h, 3v)', {
    layout: z.string().describe('Layout code: s (single), 2h, 2v, 2-1, 1-2, 3h, 3v, 4 (2x2), 6, 8. Also accepts: single, 2x1, 1x2, 2x2, quad'),
  }, async ({ layout }) => {
    try { return jsonResult(await core.setLayout({ layout })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pane_focus', 'Focus a specific chart pane by index (0-based)', {
    index: z.coerce.number().describe('Pane index (0-based, from pane_list)'),
  }, async ({ index }) => {
    try { return jsonResult(await core.focus({ index })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pane_set_symbol', 'Set the symbol on a specific pane by index', {
    index: z.coerce.number().describe('Pane index (0-based)'),
    symbol: z.string().describe('Symbol to set (e.g., NQ1!, ES1!, AAPL)'),
  }, async ({ index, symbol }) => {
    try { return jsonResult(await core.setSymbol({ index, symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
