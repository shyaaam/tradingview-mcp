import { jsonResult } from './_format.js';
import { openBootstrapChartTarget, resolveExactRunningProfile } from '../core/chart-target-open.js';
import { registerObserverTool } from '../release/observer-schema.js';

export function registerChartTargetOpenTool(server) {
  registerObserverTool(
    server,
    'tv_observer_resolve_profile_name_v1',
    'Resolve one exact running CloakBrowser profile name to its current ephemeral Manager UUID; never persist the UUID',
    async ({ profile_name }) => {
      try {
        const profile = await resolveExactRunningProfile(profile_name);
        return jsonResult({
          success: true,
          profile_name: profile.profileName,
          profile_id: profile.profileId,
          status: profile.status,
        });
      } catch (error) {
        return jsonResult({ success: false, error: error.message }, true);
      }
    },
  );

  registerObserverTool(
    server,
    'tv_observer_open_bootstrap_chart_target_v1',
    'Resolve an exact running CloakBrowser profile name and open one generic TradingView chart for fresh-account bootstrap',
    async (input) => {
      try { return jsonResult(await openBootstrapChartTarget(input)); }
      catch (error) { return jsonResult({ success: false, error: error.message }, true); }
    },
  );
}
