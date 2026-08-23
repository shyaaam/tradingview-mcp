import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePineScriptName, pineSourceSha256 } from '../src/core/pine.js';

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
