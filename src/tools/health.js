import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/health.js';
import * as observer from '../core/observer.js';
import { registerObserverTool } from '../release/observer-schema.js';

export function registerHealthTools(server, dependencies = {}) {
  const healthCheck = dependencies.healthCheck || core.healthCheck;
  registerObserverTool(server, 'tv_health_check', 'Check CDP connection to TradingView and return current chart state', async () => {
    try { return jsonResult(await healthCheck()); }
    catch (err) {
      const diagnostics = err?.details && typeof err.details === 'object'
        ? { diagnostics: err.details }
        : {};
      return jsonResult({ success: false, error: err.message, ...diagnostics, hint: 'TradingView is not attached through CloakBrowser Manager. Use tv_launch to attach the managed profile.' }, true);
    }
  });

  registerObserverTool(server, 'tv_observer_prepare', 'Prepare one explicit CloakBrowser Manager profile without local fallback or implicit profile selection', async ({ profile_id, restart }) => {
    try { return jsonResult(await observer.prepare({ profile_id, restart })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_discover', 'Report which known TradingView API paths are available and their methods', {}, async () => {
    try { return jsonResult(await core.discover()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_ui_state', 'Get current UI state: which panels are open, what buttons are visible/enabled/disabled', {}, async () => {
    try { return jsonResult(await core.uiState()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_launch', 'Launch or attach TradingView through CloakBrowser Manager when configured, otherwise fall back to local TradingView launch. Auto-detects install location on Mac, Windows, and Linux.', {
    port: z.coerce.number().optional().describe('CDP port (default 9222)'),
    kill_existing: z.coerce.boolean().optional().describe('Kill existing TradingView instances first (default true)'),
  }, async ({ port, kill_existing }) => {
    try { return jsonResult(await core.launch({ port, kill_existing })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
