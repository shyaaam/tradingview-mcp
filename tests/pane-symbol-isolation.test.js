import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setSymbol } from '../src/core/pane.js';

describe('pane_set_symbol scoped mutation', () => {
  it('uses explicit target chart list and checks sibling stability', async () => {
    const expressions = [];
    const result = await setSymbol({
      index: 2,
      symbol: 'BTCUSDT',
      _deps: {
        focus: async () => undefined,
        evaluateAsync: async (expression) => {
          expressions.push(expression);
          return { success: true, symbol: 'BITSTAMP:BTCUSDT' };
        },
      },
    });

    assert.deepEqual(result, { success: true, index: 2, symbol: 'BTCUSDT' });
    assert.equal(expressions.length, 1);
    assert.match(expressions[0], /linkingGroupIndex\(\)/u);
    assert.match(expressions[0], /groups\.forEach\(function\(group, paneIndex\)/u);
    assert.match(expressions[0], /group\.property\.setValue\(isolationGroup \+ paneIndex\)/u);
    assert.match(expressions[0], /symbolWatchers\.forEach\(function\(entry\)/u);
    assert.match(expressions[0], /entry\.watcher\._listeners = \[\]/u);
    assert.match(expressions[0], /entry\.watcher\._listeners = entry\.listeners/u);
    assert.match(expressions[0], /symbolIntervalChanged/u);
    assert.match(expressions[0], /series\._symbolIntervalChanged\._listeners = \[\]/u);
    assert.match(expressions[0], /symbolProperty\.setValueSilently\(/u);
    assert.match(expressions[0], /series\._applySymbolParamsChanges\(/u);
    assert.doesNotMatch(expressions[0], /chart\._symbolWV\._value =/u);
    assert.match(expressions[0], /linking\.muteGroup\('all', true\)/u);
    assert.match(expressions[0], /synchronizeLinkingGroupSymbols\(\)/u);
    assert.match(expressions[0], /watchedSymbol\.setValueSilently\(beforeSymbols\[paneIndex\]\)/u);
    assert.match(expressions[0], /linking\.muteGroup\('all', false\)/u);
    assert.match(expressions[0], /linking\._updateLinkingGroups\(\)/u);
    assert.match(expressions[0], /refreshLinkingGroups\(\)/u);
    assert.match(expressions[0], /if \(groupsChanged && !effectInvoked\)/u);
    assert.doesNotMatch(expressions[0], /series\.setSymbolParams\(\{ symbol:/u);
    assert.match(expressions[0], /group\.property\.setValue\(group\.value\)/u);
    assert.match(expressions[0], /mainSeries\(\)/u);
    assert.doesNotMatch(expressions[0], /model\.setSymbol\(/u);
    assert.doesNotMatch(expressions[0], /_setSymbolImpl\(/u);
    assert.doesNotMatch(expressions[0], /symbolLock\._value/u);
    assert.match(expressions[0], /siblingDrift/u);
    assert.match(expressions[0], /matchesExpected\(observed\) && !siblingDrift/u);
    assert.match(expressions[0], /finalSiblingDrift/u);
    assert.doesNotMatch(expressions[0], /chart\.setSymbol\(/u);
  });

  it('rejects invalid pane indexes before browser evaluation', async () => {
    await assert.rejects(
      () => setSymbol({ index: -1, symbol: 'BTCUSDT' }),
      /Pane index must be a non-negative integer/u,
    );
  });
});
