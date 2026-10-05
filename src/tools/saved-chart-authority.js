import { jsonResult } from './_format.js';
import { preflightSavedChartAuthority, ensureSavedChartAuthority, hydrateSavedChartLayout } from '../core/saved-chart-authority.js';
import { registerObserverTool } from '../release/observer-schema.js';

export function registerSavedChartAuthorityTools(server) {
  registerObserverTool(
    server,
    'tv_observer_hydrate_saved_layout_v1',
    'Hydrate one exact current-account saved-layout ID into a disposable TradingView target and verify marker plus runtime readback',
    async ({ profile_name, capture_slot_id, reconciliation_key, saved_layout_id }) => {
      try {
        return jsonResult(await hydrateSavedChartLayout({
          profileName: profile_name,
          captureSlotId: capture_slot_id,
          reconciliationKey: reconciliation_key,
          savedLayoutId: saved_layout_id,
        }));
      } catch (error) {
        return jsonResult({ success: false, error: error.message }, true);
      }
    },
  );

  registerObserverTool(
    server,
    'tv_observer_saved_chart_authority_preflight_v1',
    'Read exact-account saved layouts and verify deterministic observer-chart creation is available; performs no saved-chart mutation',
    async ({ profile_name, expected_profile_id, capture_slot_id, reconciliation_key }) => {
      try {
        return jsonResult(await preflightSavedChartAuthority({
          profileName: profile_name,
          expectedProfileId: expected_profile_id,
          captureSlotId: capture_slot_id,
          reconciliationKey: reconciliation_key,
        }));
      } catch (error) {
        return jsonResult({ success: false, error: error.message }, true);
      }
    },
  );

  registerObserverTool(
    server,
    'tv_observer_ensure_saved_chart_authority_v1',
    'Create one deterministically named new observer-owned saved chart after a durable one-shot claim, or discover its exact saved authority without retrying creation',
    async ({ profile_name, expected_profile_id, capture_slot_id, reconciliation_key, expected_account_subject_sha256, create_if_absent }) => {
      try {
        return jsonResult(await ensureSavedChartAuthority({
          profileName: profile_name,
          expectedProfileId: expected_profile_id,
          captureSlotId: capture_slot_id,
          reconciliationKey: reconciliation_key,
          expectedAccountSubjectSha256: expected_account_subject_sha256,
          createIfAbsent: create_if_absent,
        }));
      } catch (error) {
        return jsonResult({ success: false, error: error.message }, true);
      }
    },
  );
}
