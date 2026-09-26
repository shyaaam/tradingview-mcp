import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { retireSavedChartTarget } from '../src/core/chart-target-retirement.js';

const INPUT = Object.freeze(makeAuthority());

function fixture(initialTargets = [
  { id: 'target-a', type: 'page', url: 'https://www.tradingview.com/chart/chart-a/' },
  { id: 'target-b', type: 'page', url: 'https://www.tradingview.com/chart/chart-b/' },
]) {
  let targets = initialTargets.map((target) => ({ ...target }));
  const calls = { close: [], fetch: [] };
  const fetch = async (url) => {
    calls.fetch.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === '/profiles') {
      return ok([{ profile_id: 'profile-a', status: 'running', cdp_url: 'http://manager.test/profiles/profile-a/cdp' }]);
    }
    if (parsed.pathname.endsWith('/json/list')) return ok(targets.map((target) => ({ ...target })));
    const closeIndex = parsed.pathname.lastIndexOf('/json/close/');
    if (closeIndex >= 0) {
      const targetId = decodeURIComponent(parsed.pathname.slice(closeIndex + '/json/close/'.length));
      calls.close.push(targetId);
      targets = targets.filter((target) => target.id !== targetId);
      return ok('Target is closing');
    }
    throw new Error(`Unexpected fixture URL: ${parsed.pathname}`);
  };
  return { fetch, calls };
}

function ok(value) {
  return {
    ok: true,
    async json() { return value; },
    async text() { return typeof value === 'string' ? value : JSON.stringify(value); },
  };
}

function makeAuthority(overrides = {}) {
  const base = {
    profile_id: 'profile-a',
    capture_slot_id: 'v5-capture-slot-a',
    layout_code: 's',
    chart_url: 'https://www.tradingview.com/chart/chart-b/',
    saved_chart_id: 'chart-b',
    allowed_origins: ['https://www.tradingview.com'],
  };
  const value = { ...base, ...overrides };
  const authorityHash = createHash('sha256').update(JSON.stringify({
    allowedOrigins: value.allowed_origins,
    captureSlotId: value.capture_slot_id,
    chartId: value.saved_chart_id,
    chartUrl: value.chart_url,
    layoutCode: value.layout_code,
    profileId: value.profile_id,
    schemaVersion: 'v5-capture-slot-authority-v2',
  }), 'utf8').digest('hex');
  return {
    ...value,
    authority_id: `v5-capture-slot:${authorityHash}`,
    authority_hash: authorityHash,
  };
}

function retire(input, dependencies = {}) {
  return retireSavedChartTarget(input, { reviewedAuthority: INPUT, ...dependencies });
}

test('retirement closes exact saved-chart target and preserves every other chart', async () => {
  const deps = fixture();
  const result = await retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' });
  assert.equal(result.action, 'closed');
  assert.equal(result.chart_target_id, 'target-b');
  assert.equal(result.remaining_chart_targets, 1);
  assert.equal(result.mutations_performed, true);
  assert.deepEqual(deps.calls.close, ['target-b']);
});

test('retirement is idempotent when exact saved chart is already absent', async () => {
  const deps = fixture([{ id: 'target-a', type: 'page', url: 'https://www.tradingview.com/chart/chart-a/' }]);
  const result = await retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' });
  assert.equal(result.action, 'already-closed');
  assert.equal(result.chart_target_id, null);
  assert.equal(result.mutations_performed, false);
  assert.deepEqual(deps.calls.close, []);
});

test('retirement refuses to report already-closed when profile has no chart targets', async () => {
  const deps = fixture([]);
  await assert.rejects(
    retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' }),
    /No TradingView chart target/u,
  );
  assert.deepEqual(deps.calls.close, []);
});

test('retirement refuses last, duplicate, wrong-profile, and non-canonical authorities before close', async () => {
  const lastChart = fixture([{ id: 'target-b', type: 'page', url: INPUT.chart_url }]);
  await assert.rejects(
    retire(INPUT, { ...lastChart, managerBaseUrl: 'http://manager.test' }),
    /Cannot retire the last TradingView chart target/u,
  );
  assert.deepEqual(lastChart.calls.close, []);

  const duplicate = fixture([
    { id: 'target-a', type: 'page', url: 'https://www.tradingview.com/chart/chart-a/' },
    { id: 'target-b1', type: 'page', url: INPUT.chart_url },
    { id: 'target-b2', type: 'page', url: INPUT.chart_url },
  ]);
  await assert.rejects(
    retire(INPUT, { ...duplicate, managerBaseUrl: 'http://manager.test' }),
    /ambiguous/u,
  );
  assert.deepEqual(duplicate.calls.close, []);

  const nonCanonical = fixture([
    { id: 'target-a', type: 'page', url: 'https://www.tradingview.com/chart/chart-a/' },
    { id: 'target-b', type: 'page', url: `${INPUT.chart_url}?symbol=OANDA%3AEURUSD` },
  ]);
  await assert.rejects(
    retire(INPUT, { ...nonCanonical, managerBaseUrl: 'http://manager.test' }),
    /differs from exact authority/u,
  );
  assert.deepEqual(nonCanonical.calls.close, []);

  const wrongProfile = fixture();
  wrongProfile.fetch = async (url) => {
    const response = await fixture().fetch(url);
    if (new URL(url).pathname === '/profiles') {
      return ok([{ profile_id: 'different-profile', status: 'running', cdp_url: 'http://manager.test/profiles/different-profile/cdp' }]);
    }
    return response;
  };
  await assert.rejects(
    retire(INPUT, { ...wrongProfile, managerBaseUrl: 'http://manager.test' }),
    /missing or ambiguous/u,
  );
  assert.deepEqual(wrongProfile.calls.close, []);

  await assert.rejects(retire({ ...INPUT, chart_url: 'https://evil.test/chart/chart-b/' }), /not authorized/u);
  await assert.rejects(
    retire({ ...INPUT, authority_hash: 'b'.repeat(64) }),
    /does not match/u,
  );
});

test('retirement rejects query-bearing requested chart URL before Manager or CDP access', async () => {
  const queryUrl = `${INPUT.chart_url}?symbol=OANDA%3AEURUSD`;
  const deps = fixture([
    { id: 'target-a', type: 'page', url: 'https://www.tradingview.com/chart/chart-a/' },
    { id: 'target-b', type: 'page', url: queryUrl },
  ]);
  await assert.rejects(
    retire({ ...INPUT, chart_url: queryUrl }, { ...deps, managerBaseUrl: 'http://manager.test' }),
    /query parameters are not allowed/u,
  );
  assert.deepEqual(deps.calls.fetch, []);
  assert.deepEqual(deps.calls.close, []);
});

test('retirement rejects caller-minted authority that differs from per-worker reviewed identity', async () => {
  const forged = makeAuthority({
    saved_chart_id: 'chart-a',
    chart_url: 'https://www.tradingview.com/chart/chart-a/',
  });
  const deps = fixture();
  await assert.rejects(
    retire(forged, { ...deps, managerBaseUrl: 'http://manager.test' }),
    /differs from the per-worker reviewed/u,
  );
  assert.deepEqual(deps.calls.fetch, []);
  assert.deepEqual(deps.calls.close, []);
});

test('retirement enforces authority from per-worker environment used by production adapter', async () => {
  const previous = process.env.V5_CAPTURE_SLOT_AUTHORITY_JSON;
  process.env.V5_CAPTURE_SLOT_AUTHORITY_JSON = JSON.stringify(INPUT);
  const deps = fixture();
  try {
    const result = await retireSavedChartTarget(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' });
    assert.equal(result.action, 'closed');
    assert.deepEqual(deps.calls.close, ['target-b']);
  } finally {
    if (previous === undefined) delete process.env.V5_CAPTURE_SLOT_AUTHORITY_JSON;
    else process.env.V5_CAPTURE_SLOT_AUTHORITY_JSON = previous;
  }
});

test('malformed page target inventory fails closed before retirement', async () => {
  const deps = fixture();
  const originalFetch = deps.fetch;
  deps.fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith('/json/list')) {
      return ok([
        { id: 'target-a', type: 'page', url: 'https://www.tradingview.com/chart/chart-a/' },
        { type: 'page', url: INPUT.chart_url },
      ]);
    }
    return originalFetch(url, init);
  };
  await assert.rejects(
    retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' }),
    /page target identity is malformed/u,
  );
  assert.deepEqual(deps.calls.close, []);
});

test('retirement rechecks complete chart inventory immediately before exact close', async () => {
  const deps = fixture();
  const originalFetch = deps.fetch;
  let listReads = 0;
  deps.fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith('/json/list')) {
      listReads += 1;
      if (listReads === 2) {
        return ok([
          { id: 'target-a', type: 'page', url: 'https://www.tradingview.com/chart/chart-a/' },
          { id: 'target-b', type: 'page', url: 'https://www.tradingview.com/chart/chart-c/' },
        ]);
      }
    }
    return originalFetch(url, init);
  };
  await assert.rejects(
    retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' }),
    /inventory changed before exact/u,
  );
  assert.deepEqual(deps.calls.close, []);
});

test('retirement applies one end-to-end deadline to Manager fetch and profile-scoped close', async () => {
  const pendingFetch = fixture();
  pendingFetch.fetch = async () => new Promise(() => {});
  const fetchStart = performance.now();
  await assert.rejects(
    retire(INPUT, {
      ...pendingFetch,
      managerBaseUrl: 'http://manager.test',
      timeoutMs: 25,
    }),
    /bounded 25ms deadline/u,
  );
  assert.ok(performance.now() - fetchStart < 500);

  let closeRequested = false;
  const pendingClose = fixture();
  const originalFetch = pendingClose.fetch;
  pendingClose.fetch = async (url, init) => {
    if (new URL(url).pathname.includes('/json/close/')) {
      closeRequested = true;
      return new Promise(() => {});
    }
    return originalFetch(url, init);
  };
  const closeStart = performance.now();
  await assert.rejects(
    retire(INPUT, {
      ...pendingClose,
      managerBaseUrl: 'http://manager.test',
      timeoutMs: 25,
    }),
    /bounded 25ms deadline/u,
  );
  assert.ok(performance.now() - closeStart < 500);
  assert.equal(closeRequested, true);
});
