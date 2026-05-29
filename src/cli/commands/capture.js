import { register } from '../router.js';
import * as core from '../../core/capture.js';

function parsePositiveNumber(value) {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

register('screenshot', {
  description: 'Take a screenshot of the chart',
  options: {
    region: { type: 'string', short: 'r', description: 'Region: full, chart, strategy_tester' },
    output: { type: 'string', short: 'o', description: 'Custom filename (without .png)' },
    target_id: { type: 'string', description: 'Optional CDP target ID from tab_list' },
    expected_symbol: { type: 'string', description: 'Expected symbol for lightweight target verification before capture' },
    expected_timeframe: { type: 'string', description: 'Expected timeframe for lightweight target verification before capture' },
    max_attempts: { type: 'string', description: 'Maximum capture attempts before giving up (default 3)' },
    retry_delay_ms: { type: 'string', description: 'Delay between capture attempts in milliseconds (default 1000)' },
    verify_chart_state: { type: 'boolean', description: 'Verify chart state before capture (default true)' },
    fail_on_modal: { type: 'boolean', description: 'Abort without capture when a modal/promo overlay is detected (default false)' },
  },
  handler: (opts) => core.captureScreenshot({
    region: opts.region,
    filename: opts.output,
    target_id: opts.target_id,
    expected_symbol: opts.expected_symbol,
    expected_timeframe: opts.expected_timeframe,
    max_attempts: parsePositiveNumber(opts.max_attempts),
    retry_delay_ms: parsePositiveNumber(opts.retry_delay_ms),
    verify_chart_state: opts.verify_chart_state,
    fail_on_modal: opts.fail_on_modal,
  }),
});
