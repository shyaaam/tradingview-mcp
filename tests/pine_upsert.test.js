import assert from 'node:assert/strict';
import test from 'node:test';

import { applyScopedSavedPine, chartStudyBindsSavedScript, chartStudyIsOwnedPineScript, chartStudyIsPublicPineScript, normalizePineScriptName, pineSourceSha256, pineSourcesEquivalent } from '../src/core/pine.js';

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
