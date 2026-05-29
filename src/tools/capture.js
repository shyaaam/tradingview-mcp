import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/capture.js';

export function registerCaptureTools(server) {
  server.tool('capture_screenshot', 'Take a screenshot of the TradingView chart', {
    region: z.string().optional().describe('Region to capture: full, chart, strategy_tester (default full)'),
    filename: z.string().optional().describe('Custom filename (without extension)'),
    method: z.string().optional().describe('Capture method: cdp (Page.captureScreenshot) or api (chartWidgetCollection.takeScreenshot) (default cdp)'),
    target_id: z.string().optional().describe('Optional CDP target ID from tab_list. Captures this exact TradingView chart target.'),
    expected_symbol: z.string().optional().describe('Expected symbol for lightweight target verification before capture'),
    expected_timeframe: z.string().optional().describe('Expected timeframe for lightweight target verification before capture'),
    max_attempts: z.number().int().positive().optional().describe('Maximum capture attempts before giving up (default 3)'),
    retry_delay_ms: z.number().int().positive().optional().describe('Delay between capture attempts in milliseconds (default 1000)'),
    verify_chart_state: z.boolean().optional().describe('Verify target chart state before capture (default true)'),
    fail_on_modal: z.boolean().optional().describe('If true, abort without capture when a modal/promo overlay is detected (default false)'),
  }, async ({ region, filename, method, target_id, expected_symbol, expected_timeframe, max_attempts, retry_delay_ms, verify_chart_state, fail_on_modal }) => {
    try {
      return jsonResult(await core.captureScreenshot({
        region,
        filename,
        method,
        target_id,
        expected_symbol,
        expected_timeframe,
        max_attempts,
        retry_delay_ms,
        verify_chart_state,
        fail_on_modal,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
