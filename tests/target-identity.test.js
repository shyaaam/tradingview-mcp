import assert from 'node:assert/strict';
import test from 'node:test';

import { exactTargetMatches, findExactTarget } from '../src/core/target-identity.js';

const tab = (index, id, extra = {}) => ({ index, id, chart_id: `chart-${id}`, url: `https://www.tradingview.com/chart/chart-${id}/`, ...extra });

test('a target is found by ID after another slot closes a tab ahead of it and its position shifts', () => {
  const before = { success: true, tabs: [tab(0, 'a'), tab(1, 'b')] };
  assert.equal(findExactTarget(before, { targetId: 'b' }).index, 1);
  const after = { success: true, tabs: [tab(0, 'b')] };
  const found = findExactTarget(after, { targetId: 'b', chartId: 'chart-b', url: 'https://www.tradingview.com/chart/chart-b/' });
  assert.equal(found.id, 'b');
  assert.equal(found.index, 0, 'the live position changed; matching must not depend on it');
});

test('missing and ambiguous targets are reported distinctly', () => {
  assert.throws(() => findExactTarget({ success: true, tabs: [tab(0, 'a')] }, { targetId: 'b' }, 'exact chart target'), /exact chart target is missing/u);
  assert.throws(() => findExactTarget({ success: true, tabs: [tab(0, 'a'), tab(1, 'a')] }, { targetId: 'a' }, 'exact chart target'), /exact chart target is not unique/u);
  assert.throws(() => findExactTarget({ success: false, tabs: [tab(0, 'a')] }, { targetId: 'a' }), /is missing/u);
});

test('chart or URL that differs from authority is rejected even when the ID matches', () => {
  const tabs = { success: true, tabs: [tab(0, 'a')] };
  assert.throws(() => findExactTarget(tabs, { targetId: 'a', chartId: 'other' }), /does not match authority/u);
  assert.throws(() => findExactTarget(tabs, { targetId: 'a', url: 'https://www.tradingview.com/chart/other/' }), /does not match authority/u);
  assert.deepEqual(exactTargetMatches(tabs, { targetId: 'a', chartId: 'other' }), []);
  assert.equal(exactTargetMatches({ tabs: [null, undefined, tab(0, 'a')] }, { targetId: 'a' }).length, 1);
});
