import { jsonResult } from './_format.js';
import { buildObserverContract } from '../release/identity.js';

export function registerReleaseTools(server) {
  server.tool(
    'tv_observer_contract',
    'Return the immutable tv-observer-v1 capability, release, and lifecycle contract',
    {},
    async () => jsonResult(buildObserverContract()),
  );
}
