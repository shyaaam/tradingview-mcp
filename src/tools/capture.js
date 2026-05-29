import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/capture.js';

export function registerCaptureTools(server) {
  server.tool('capture_screenshot', 'Take a screenshot of the TradingView chart', {
    region: z.string().optional().describe('Region to capture: full, chart, strategy_tester (default full)'),
    filename: z.string().optional().describe('Custom filename (without extension)'),
    method: z.string().optional().describe('Capture method: cdp (Page.captureScreenshot) or api (chartWidgetCollection.takeScreenshot) (default cdp)'),
    target_id: z.string().optional().describe('Optional CDP target ID from tab_list. Captures this exact TradingView chart target.'),
  }, async ({ region, filename, method, target_id }) => {
    try { return jsonResult(await core.captureScreenshot({ region, filename, method, target_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
