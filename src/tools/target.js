import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/target.js';

export function registerTargetTools(server) {
  server.tool('tab_target_readiness_check', 'Verify whether a CDP target is actually ready for registry/live monitoring', {
    target_id: z.string().optional().describe('Optional CDP target ID from tab_list.'),
    expected_symbol: z.string().optional().describe('Expected TradingView symbol (optional, compared case-insensitively after whitespace removal).'),
    expected_timeframe: z.string().optional().describe('Expected TradingView timeframe/resolution (optional, compared case-insensitively after whitespace removal).'),
    max_wait_ms: z.coerce.number().optional().describe('Maximum time to poll before returning ready=false (default 10000)'),
    poll_interval_ms: z.coerce.number().optional().describe('Polling interval in milliseconds (default 500)'),
  }, async ({ target_id, expected_symbol, expected_timeframe, max_wait_ms, poll_interval_ms }) => {
    try {
      return jsonResult(await core.targetReadinessCheck({
        target_id,
        expected_symbol,
        expected_timeframe,
        max_wait_ms,
        poll_interval_ms,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
