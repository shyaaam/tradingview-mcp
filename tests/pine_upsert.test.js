import assert from 'node:assert/strict';
import test from 'node:test';

import { applyScopedSavedPine, chartStudyBindsOwnedSavedScript, chartStudyBindsSavedScript, chartStudyIsOwnedPineScript, chartStudyIsPublicPineScript, normalizePineScriptName, pineSourceSha256, pineSourcesEquivalent } from '../src/core/pine.js';

test('pine named-upsert request normalizes exact names and hashes source', () => {
  assert.equal(normalizePineScriptName('  Repo BOS  '), 'Repo BOS');
  assert.equal(
    pineSourceSha256('//@version=6\nindicator("Repo BOS")'),
    '83253dceb779dd4de1521dc1ac74e0a1975b17f43e295444f7d89f04c2605693',
  );
});

test('pine named-upsert rejects ambiguous names', () => {
  assert.throws(() => normalizePineScriptName(''), /must be non-empty/u);
  assert.throws(() => normalizePineScriptName('bad\nname'), /forbidden/u);
  assert.throws(() => pineSourceSha256(''), /source must be non-empty/u);
});

test('pine named-upsert accepts only exact saved-script chart bindings', () => {
  assert.equal(chartStudyBindsSavedScript({ indicator_id: 'script-1' }, 'script-1'), true);
  assert.equal(chartStudyBindsSavedScript({ indicator_id: 'Script$USER;script-1@tv-scripting' }, 'USER;script-1'), true);
  assert.equal(chartStudyBindsSavedScript({ indicator_id: 'Script$PRIV;script-1@tv-scripting' }, 'script-1'), true);
  assert.equal(chartStudyBindsSavedScript({ indicator_id: 'Script$PUB;script-1@tv-scripting' }, 'script-1'), true);
  assert.equal(chartStudyBindsSavedScript({ indicator_id: 'script-2' }, 'script-1'), false);
  assert.equal(chartStudyBindsSavedScript({ indicator_id: '' }, 'script-1'), false);
});

test('pine named-upsert identifies owned-script conflicts separately from public duplicates', () => {
  assert.equal(chartStudyIsOwnedPineScript({ indicator_id: 'Script$USER;script-1@tv-scripting' }), true);
  assert.equal(chartStudyIsOwnedPineScript({ indicator_id: 'PRIV;script-1' }), true);
  assert.equal(chartStudyIsOwnedPineScript({ indicator_id: 'Script$PUB;script-1@tv-scripting' }), false);
  assert.equal(chartStudyIsOwnedPineScript({ indicator_id: 'STD;Pivot Points Standard' }), false);
  assert.equal(chartStudyIsOwnedPineScript({ indicator_id: '' }), false);
  assert.equal(chartStudyIsPublicPineScript({ indicator_id: 'Script$PUB;script-1@tv-scripting' }), true);
  assert.equal(chartStudyIsPublicPineScript({ indicator_id: 'PUB;script-1' }), true);
  assert.equal(chartStudyIsPublicPineScript({ indicator_id: 'Script$USER;script-1@tv-scripting' }), false);
});

test('scoped saved-Pine binding accepts USER and PRIV but rejects PUB', () => {
  assert.equal(chartStudyBindsOwnedSavedScript({ indicator_id: 'Script$USER;script-1@tv-scripting' }, 'USER;script-1'), true);
  assert.equal(chartStudyBindsOwnedSavedScript({ indicator_id: 'Script$PRIV;script-1@tv-scripting' }, 'PRIV;script-1'), true);
  assert.equal(chartStudyBindsOwnedSavedScript({ indicator_id: 'Script$PUB;script-1@tv-scripting' }, 'PUB;script-1'), false);
  assert.equal(chartStudyBindsOwnedSavedScript({ indicator_id: 'Script$USER;script-1@tv-scripting' }, 'PUB;script-1'), false);
  assert.equal(chartStudyBindsSavedScript({ indicator_id: 'Script$PUB;script-1@tv-scripting' }, 'PUB;script-1'), true);
});

test('pine named-upsert treats TradingView newline normalization as equivalent', () => {
  const source = '//@version=6\nindicator("Repo BOS")\nplot(close)';
  assert.equal(pineSourcesEquivalent(source, source.replaceAll('\n', '\r\n')), true);
  assert.equal(pineSourcesEquivalent(source, `${source}\nplot(open)`), false);
});

test('scoped saved-Pine apply fails closed before source access without identity fences', async () => {
  await assert.rejects(
    applyScopedSavedPine({
      profile_id: 'profile-1',
      tab_index: 0,
      pane_index: 1,
      name: 'Repo VMC',
      source: '//@version=6\nindicator("Repo VMC")',
    }),
    /expected_chart_target_id is required/u,
  );
});

function scopedApplyFixture({ chartStudies = [], savedScriptId = 'USER;repo-vmc' } = {}) {
  const source = '//@version=6\nindicator("Repo VMC")\nplot(close)';
  const state = {
    chartStudies: chartStudies.map((study) => ({ ...study })),
    evaluateCalls: [],
    evaluateAsyncCalls: [],
    switchedTabs: [],
    focusedPanes: [],
    authorityScopes: [],
  };
  const deps = {
    async verifyMutationAuthority(scope) {
      state.authorityScopes.push({ ...scope });
    },
    async switchTab(input) {
      state.switchedTabs.push(input.index);
      return { success: true, action: 'switched', index: input.index };
    },
    async focusPane(input) {
      state.focusedPanes.push(input.index);
      return { success: true, focused_index: input.index, total: 8 };
    },
    async sleep() {},
    async evaluateAsync(expression) {
      state.evaluateAsyncCalls.push(expression);
      if (expression.includes('pine-facade/list/?filter=saved')) {
        return { scripts: [{ scriptName: 'Repo VMC', scriptIdPart: savedScriptId, version: 1 }] };
      }
      if (expression.includes('pine-facade/get/')) return { source };
      if (expression.includes("chart.createStudy({ type: 'pine'")) {
        state.chartStudies = [{ id: 'study-repo-vmc', indicator_id: 'Script$USER;repo-vmc@tv-scripting' }];
        return { success: true };
      }
      throw new Error(`unexpected evaluateAsync expression: ${expression.slice(0, 80)}`);
    },
    async evaluate(expression) {
      state.evaluateCalls.push(expression);
      if (expression.includes('dataSources()')) return state.chartStudies;
      throw new Error(`unexpected evaluate expression: ${expression.slice(0, 80)}`);
    },
    async indicatorSignatures() {
      return {
        panes: Array.from({ length: 8 }, (_, index) => ({
          index,
          signature: index === 2 ? 'b'.repeat(64) : 'a'.repeat(64),
          indicators: index === 2 ? [{
            indicator_id: 'Script$USER;repo-vmc@tv-scripting',
            entity_id: 'study-repo-vmc',
            indicator_name: 'Repo VMC',
            is_price_study: false,
            settings: {},
          }] : [],
        })),
      };
    },
  };
  return { source, state, deps };
}

test('scoped saved-Pine apply creates exact owned binding with injected browser dependencies', async () => {
  const fixture = scopedApplyFixture();
  const result = await applyScopedSavedPine({
    profile_id: 'profile-a',
    tab_index: 1,
    pane_index: 2,
    name: 'Repo VMC',
    source: fixture.source,
    expected_chart_target_id: 'target-a',
    expected_chart_id: 'chart-a',
    expected_layout_id: '8',
    expected_pane_signature: 'a'.repeat(64),
    _deps: fixture.deps,
  });

  assert.equal(result.action, 'created');
  assert.equal(result.source_bound, true);
  assert.equal(result.saved_script_id, 'USER;repo-vmc');
  assert.equal(result.chart_indicator_id, 'Script$USER;repo-vmc@tv-scripting');
  assert.equal(result.post_mutation_signature, 'b'.repeat(64));
  assert.deepEqual(fixture.state.switchedTabs, [1]);
  assert.deepEqual(fixture.state.focusedPanes, [2]);
  assert.equal(fixture.state.authorityScopes.length, 2);
  assert.ok(fixture.state.evaluateAsyncCalls.some((expression) => expression.includes("chart.createStudy({ type: 'pine'")));
});

test('scoped saved-Pine apply rejects public chart binding before telemetry readback', async () => {
  const fixture = scopedApplyFixture({
    chartStudies: [{ id: 'public-study', indicator_id: 'Script$PUB;repo-vmc@tv-scripting' }],
  });
  await assert.rejects(
    applyScopedSavedPine({
      profile_id: 'profile-a',
      tab_index: 1,
      pane_index: 2,
      name: 'Repo VMC',
      source: fixture.source,
      expected_chart_target_id: 'target-a',
      expected_chart_id: 'chart-a',
      expected_layout_id: '8',
      expected_pane_signature: 'a'.repeat(64),
      _deps: fixture.deps,
    }),
    /existing chart study Repo VMC is not exact saved Pine/u,
  );
  assert.equal(fixture.state.evaluateAsyncCalls.some((expression) => expression.includes("chart.createStudy({ type: 'pine'")), false);
});

test('scoped saved-Pine apply rejects public saved-script identity', async () => {
  const fixture = scopedApplyFixture({ savedScriptId: 'PUB;repo-vmc' });
  await assert.rejects(
    applyScopedSavedPine({
      profile_id: 'profile-a',
      tab_index: 1,
      pane_index: 2,
      name: 'Repo VMC',
      source: fixture.source,
      expected_chart_target_id: 'target-a',
      expected_chart_id: 'chart-a',
      expected_layout_id: '8',
      expected_pane_signature: 'a'.repeat(64),
      _deps: fixture.deps,
    }),
    /PINE_APPLY_SCOPED_SAVED_SCRIPT_NOT_OWNED/u,
  );
});
