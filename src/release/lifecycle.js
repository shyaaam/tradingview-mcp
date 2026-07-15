import { observerCapabilityManifest } from './manifest.js';

const DEFAULT_SHUTDOWN_GRACE_MS = observerCapabilityManifest.lifecycle.shutdownGraceMs;

export function installStdioLifecycle({
  processLike = process,
  close,
  shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
} = {}) {
  if (typeof close !== 'function') throw new TypeError('close must be a function');

  let closing = null;
  const listeners = [];

  const shutdown = (reason = 'requested') => {
    if (closing !== null) return closing;
    closing = withTimeout(Promise.resolve().then(() => close(reason)), shutdownGraceMs)
      .then(() => {
        processLike.exitCode = 0;
        return { reason, clean: true };
      })
      .catch((error) => {
        processLike.exitCode = 1;
        return { reason, clean: false, error: error instanceof Error ? error.message : String(error) };
      })
      .finally(dispose);
    return closing;
  };

  function listen(emitter, event, reason) {
    if (!emitter || typeof emitter.once !== 'function') return;
    const handler = () => { void shutdown(reason); };
    emitter.once(event, handler);
    listeners.push(() => emitter.removeListener?.(event, handler));
  }

  function dispose() {
    for (const remove of listeners.splice(0)) remove();
  }

  listen(processLike, 'SIGINT', 'SIGINT');
  listen(processLike, 'SIGTERM', 'SIGTERM');
  listen(processLike, 'SIGHUP', 'SIGHUP');
  listen(processLike.stdin, 'end', 'stdin-end');

  return { shutdown, dispose };
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`stdio shutdown exceeded ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}
