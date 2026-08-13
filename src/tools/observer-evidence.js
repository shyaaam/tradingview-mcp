import { jsonResult } from './_format.js';
import * as core from '../core/observer-evidence.js';
import { registerObserverTool } from '../release/observer-schema.js';

export function registerObserverEvidenceTools(server) {
  registerObserverTool(server, 'tv_observer_identity', 'Return exact identity evidence for the prepared observer session without exposing raw account identity.', async ({ ...args }) => {
    try { return jsonResult(await core.identity(args)); }
    catch (err) { return jsonResult({ success: false, error: sanitizeError(err) }, true); }
  });
  registerObserverTool(server, 'tv_observer_capture_candle', 'Capture exactly one requested OHLCV candle from the exact prepared chart binding.', async ({ ...args }) => {
    try { return jsonResult(await core.captureCandle(args)); }
    catch (err) { return jsonResult({ success: false, error: sanitizeError(err) }, true); }
  });
  registerObserverTool(server, 'tv_observer_capture_telemetry_ohlcv', 'Capture bounded raw study telemetry and OHLCV candles from the exact prepared chart binding.', async ({ ...args }) => {
    try { return jsonResult(await core.captureTelemetryOhlcv(args)); }
    catch (err) { return jsonResult({ success: false, error: sanitizeError(err) }, true); }
  });
  registerObserverTool(server, 'tv_observer_capture_pane_telemetry_ohlcv', 'Capture bounded OHLCV and optional same-pane study telemetry from one exact pane without focus or mutation.', async ({ ...args }) => {
    try { return jsonResult(await core.capturePaneTelemetryOhlcv(args)); }
    catch (err) { return jsonResult({ success: false, error: sanitizeError(err) }, true); }
  });
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:account|user|subject)[^.;:]*/gi, 'authenticated identity');
}
