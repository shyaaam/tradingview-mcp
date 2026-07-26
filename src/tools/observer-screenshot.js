import { jsonResult } from './_format.js';
import { registerObserverTool } from '../release/observer-schema.js';
import * as core from '../core/observer-screenshot.js';

export function registerObserverScreenshotTool(server) {
  registerObserverTool(
    server,
    'tv_observer_capture_screenshot',
    'Capture immutable PNG bytes from the exact active observer pane for Stage 15 review delivery.',
    async ({ ...args }) => {
      try { return jsonResult(await core.captureObserverReviewScreenshot(args)); }
      catch (err) { return jsonResult({ success: false, error: sanitizeError(err) }, true); }
    },
  );
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:account|user|subject)[^.;:]*/gi, 'authenticated identity');
}
