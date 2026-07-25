import { z } from 'zod';
import { jsonResult } from './_format.js';
import { hydrateChartTarget } from '../core/chart-target-hydration.js';
import { registerObserverTool } from '../release/observer-schema.js';

export function registerChartTargetHydrationTool(server) {
  registerObserverTool(server, 'tv_observer_hydrate_chart_target', 'Hydrate one exact authorized TradingView saved-chart target inside one exact Manager profile', async (input) => {
    try { return jsonResult(await hydrateChartTarget(input)); }
    catch (error) { return jsonResult({ success: false, error: error.message }, true); }
  });
}

export const chartTargetHydrationInputSchema = {
  profile_id: z.string().min(1),
  authority_id: z.string().regex(/^[a-z0-9-]+:[0-9a-f]{64}$/),
  authority_hash: z.string().regex(/^[0-9a-f]{64}$/),
  chart_url: z.string().url(),
  saved_chart_id: z.string().min(1),
  allowed_origins: z.array(z.string().url()).min(1),
};
