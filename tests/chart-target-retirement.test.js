import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { retireSavedChartTarget } from '../src/core/chart-target-retirement.js';
import { observerToolDefinitions } from '../src/release/observer-schema.js';

const INPUT = Object.freeze(makeAuthority());

function fixture(initialTargets = [
  { id: 'target-a', type: 'page', url: 'https://www.tradingview.com/chart/chart-a/' },
  { id: 'target-b', type: 'page', url: 'https://www.tradingview.com/chart/chart-b/' },
]) {
  let targets = initialTargets.map((target) => ({ ...target }));
  const calls = {
    close: [], fetch: [], webSocketUrls: [], socketCloseCount: 0, closeAcknowledged: true,
    profileCdpUrl: 'http://manager.test/profiles/profile-a/cdp',
    browserWebSocketUrl: 'ws://manager.test/profiles/profile-a/cdp',
    targetUrlAfterClose: null,
  };
  const fetch = async (url) => {
    calls.fetch.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === '/profiles') {
      return ok([{ profile_id: 'profile-a', status: 'running', cdp_url: calls.profileCdpUrl }]);
    }
    if (parsed.pathname.endsWith('/json/version')) {
      return ok({ webSocketDebuggerUrl: calls.browserWebSocketUrl });
    }
    if (parsed.pathname.endsWith('/json/list')) return ok(targets.map((target) => ({ ...target })));
    throw new Error(`Unexpected fixture URL: ${parsed.pathname}`);
  };
  const createWebSocket = (url) => {
    calls.webSocketUrls.push(url);
    const socket = new EventTarget();
    socket.send = (raw) => {
      const request = JSON.parse(raw);
      assert.equal(request.method, 'Target.closeTarget');
      calls.close.push(request.params.targetId);
      if (calls.closeAcknowledged) {
        if (calls.targetUrlAfterClose !== null) {
          targets = targets.map((target) => target.id === request.params.targetId
            ? { ...target, url: calls.targetUrlAfterClose }
            : target);
        } else {
          targets = targets.filter((target) => target.id !== request.params.targetId);
        }
      }
      queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ id: request.id, result: { success: calls.closeAcknowledged } }),
      })));
    };
    socket.close = () => {
      calls.socketCloseCount += 1;
      socket.dispatchEvent(new Event('close'));
    };
    queueMicrotask(() => socket.dispatchEvent(new Event('open')));
    return socket;
  };
  return { fetch, createWebSocket, calls };
}

function ok(value) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200 });
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
  assert.deepEqual(deps.calls.webSocketUrls, ['ws://manager.test/profiles/profile-a/cdp']);
  assert.ok(deps.calls.socketCloseCount >= 1);
});

test('retirement rejects a browser WebSocket outside the exact Manager profile endpoint', async () => {
  const deps = fixture();
  const originalFetch = deps.fetch;
  deps.fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith('/json/version')) {
      return ok({ webSocketDebuggerUrl: 'ws://other-manager.test/profiles/profile-a/cdp' });
    }
    return originalFetch(url, init);
  };
  await assert.rejects(
    retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' }),
    /outside exact Manager profile authority/u,
  );
  assert.deepEqual(deps.calls.close, []);
  assert.deepEqual(deps.calls.webSocketUrls, []);
});

test('retirement rejects profile A authority redirected to profile B CDP path', async () => {
  const deps = fixture();
  deps.calls.profileCdpUrl = 'http://manager.test/api/profiles/profile-b/cdp';
  deps.calls.browserWebSocketUrl = 'ws://manager.test/api/profiles/profile-b/cdp';
  await assert.rejects(
    retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' }),
    /outside exact Manager profile authority/u,
  );
  assert.deepEqual(deps.calls.close, []);
  assert.deepEqual(deps.calls.webSocketUrls, []);
});

test('retirement requires positive Target.closeTarget acknowledgement', async () => {
  const deps = fixture();
  deps.calls.closeAcknowledged = false;
  await assert.rejects(
    retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' }),
    /close was not acknowledged/u,
  );
  assert.deepEqual(deps.calls.close, ['target-b']);
  assert.equal(deps.calls.socketCloseCount >= 1, true);
});

test('retirement fails if exact target ID remains after navigating away from saved chart', async () => {
  const deps = fixture();
  deps.calls.targetUrlAfterClose = 'about:blank';
  const clock = { now: 0 };
  await assert.rejects(
    retire(INPUT, {
      ...deps,
      managerBaseUrl: 'http://manager.test',
      timeoutMs: 1_000,
      now: () => clock.now,
      sleep: async () => { clock.now += 10; },
    }),
    /target remained open/u,
  );
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

test('bounded Manager and CDP response bodies fail closed before chart close', async (t) => {
  for (const responseKind of ['manager', 'cdp']) {
    await t.test(responseKind, async () => {
      const deps = fixture();
      const originalFetch = deps.fetch;
      deps.fetch = async (url, init) => {
        const pathname = new URL(url).pathname;
        const oversized = responseKind === 'manager'
          ? pathname === '/profiles'
          : pathname.endsWith('/json/list');
        if (oversized) return new Response('x'.repeat(128 * 1024 + 1), { status: 200 });
        return originalFetch(url, init);
      };
      await assert.rejects(
        retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' }),
        /exceeds bounded 131072-byte read limit/u,
      );
      assert.deepEqual(deps.calls.close, []);
    });
  }
});

test('oversized CDP target IDs are rejected before close and output schema caps echoed IDs', async () => {
  const deps = fixture([
    { id: 'target-a', type: 'page', url: 'https://www.tradingview.com/chart/chart-a/' },
    { id: 'x'.repeat(257), type: 'page', url: INPUT.chart_url },
  ]);
  await assert.rejects(
    retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' }),
    /page target identity is malformed/u,
  );
  assert.deepEqual(deps.calls.close, []);

  const targetIdSchema = observerToolDefinitions.tv_observer_retire_saved_chart_v1.outputSchema.chart_target_id;
  assert.equal(targetIdSchema.safeParse('x'.repeat(256)).success, true);
  assert.equal(targetIdSchema.safeParse('x'.repeat(257)).success, false);
  assert.equal(targetIdSchema.safeParse(null).success, true);
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

test('retirement applies one end-to-end deadline to Manager fetch and browser CDP close', async () => {
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

  const pendingClose = fixture();
  let closeRequested = false;
  pendingClose.createWebSocket = () => {
    const socket = new EventTarget();
    socket.send = () => { closeRequested = true; };
    socket.close = () => {
      pendingClose.calls.socketCloseCount += 1;
      socket.dispatchEvent(new Event('close'));
    };
    queueMicrotask(() => socket.dispatchEvent(new Event('open')));
    return socket;
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
  assert.ok(pendingClose.calls.socketCloseCount >= 1);
});
