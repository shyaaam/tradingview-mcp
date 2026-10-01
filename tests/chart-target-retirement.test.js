import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import WebSocket from 'ws';

import { retireSavedChartTarget } from '../src/core/chart-target-retirement.js';
import { savedChartLayoutMarker } from '../src/core/saved-chart-authority.js';
import { observerToolDefinitions } from '../src/release/observer-schema.js';

const ACCOUNT_HASH = createHash('sha256').update('observer-account', 'utf8').digest('hex');
const RECONCILIATION_KEY = 'a'.repeat(64);
const AUTHORITY = Object.freeze(makeAuthority());
const MARKER = savedChartLayoutMarker(AUTHORITY.capture_slot_id, AUTHORITY.reconciliation_key);
const OTHER_MARKER = savedChartLayoutMarker('v5-capture-slot-a', 'b'.repeat(64));
const LAYOUTS = Object.freeze([
  { layout_id: '206000778', name: OTHER_MARKER },
  { layout_id: '206146606', name: MARKER },
]);
const ROUTE_UID = 'NCJIp2ky';
const ROUTE = `https://www.tradingview.com/chart/${ROUTE_UID}/`;
const INPUT = AUTHORITY;

function fixture(initialTargets = [
  { id: 'target-a', type: 'page', url: ROUTE, webSocketDebuggerUrl: 'ws://local/devtools/page/target-b' },
  { id: 'target-b', type: 'page', url: ROUTE, webSocketDebuggerUrl: 'ws://local/devtools/page/target-a' },
  { id: 'anchor', type: 'page', url: 'about:blank' },
]) {
  let targets = initialTargets.map((target) => ({ ...target }));
  const calls = {
    close: [], fetch: [], inspectedTargetIds: [], attachedTargetIds: [], detachedSessionIds: [],
    browserWebSocketUrls: [], browserCloseCount: 0,
    closeAcknowledged: true,
    missingTargetOnAttach: null,
    keepMissingTargetListed: false,
    jsonListCallCount: 0,
    removeTargetOnJsonListCall: null,
    addPageOnJsonListCall: null,
    profileCdpUrl: 'http://manager.test/profiles/current-profile/cdp',
    browserWebSocketUrl: 'ws://manager.test/profiles/current-profile/cdp',
  };
  const fetch = async (url) => {
    calls.fetch.push(url);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/json/version')) return ok({ webSocketDebuggerUrl: calls.browserWebSocketUrl });
    if (parsed.pathname.endsWith('/json/list')) {
      calls.jsonListCallCount += 1;
      if (calls.jsonListCallCount === calls.removeTargetOnJsonListCall) {
        targets = targets.filter((target) => target.id !== 'target-b');
      }
      if (calls.jsonListCallCount === calls.addPageOnJsonListCall) {
        targets.push({ id: 'unexpected-page', type: 'page', url: 'about:blank' });
      }
      return ok(targets.map((target) => ({ ...target })));
    }
    throw new Error(`Unexpected fixture URL: ${parsed.pathname}`);
  };
  const targetBySessionId = new Map();
  const browser = {
    Target: {
      attachToTarget: async ({ targetId, flatten }) => {
        assert.equal(flatten, true);
        calls.attachedTargetIds.push(targetId);
        if (calls.missingTargetOnAttach === targetId) {
          if (!calls.keepMissingTargetListed) {
            targets = targets.filter((target) => target.id !== targetId);
            calls.missingTargetOnAttach = null;
          }
          throw new Error('Browser CDP command failed: No target with given id found');
        }
        assert.ok(targets.some((target) => target.id === targetId));
        const sessionId = `session-${targetId}`;
        targetBySessionId.set(sessionId, targetId);
        return { sessionId };
      },
      detachFromTarget: async ({ sessionId }) => {
        calls.detachedSessionIds.push(sessionId);
        targetBySessionId.delete(sessionId);
        return {};
      },
      closeTarget: async ({ targetId }) => {
        calls.close.push(targetId);
        if (calls.closeAcknowledged) targets = targets.filter((target) => target.id !== targetId);
        return { success: calls.closeAcknowledged };
      },
    },
    send: async (method, _params, sessionId) => {
      assert.equal(method, 'Runtime.evaluate');
      const targetId = targetBySessionId.get(sessionId);
      const target = targets.find((entry) => entry.id === targetId);
      assert.ok(target);
      calls.inspectedTargetIds.push(target.id);
      const isA = target.id === 'target-a';
      return { result: { type: 'object', value: {
        current_url: target.url,
        account_subject_sha256: ACCOUNT_HASH,
        active_saved_layout_id: isA ? '206000778' : '206146606',
        active_saved_layout_name: isA ? OTHER_MARKER : MARKER,
        layouts: LAYOUTS,
      } } };
    },
    close: async () => { calls.browserCloseCount += 1; },
  };
  return {
    fetch,
    connectBrowser: async (url) => {
      calls.browserWebSocketUrls.push(url);
      return browser;
    },
    calls,
    resolveExactRunningProfile: async (name) => {
      assert.equal(name, 'tv-observer-1');
      return {
        profileId: 'current-profile',
        cdpUrl: calls.profileCdpUrl,
      };
    },
  };
}

function ok(value) {
  return new Response(JSON.stringify(value), { status: 200 });
}

function setLocalCdpEndpoint(deps, port) {
  const endpoint = `127.0.0.1:${port}/profiles/current-profile/cdp`;
  deps.calls.profileCdpUrl = `http://${endpoint}`;
  deps.calls.browserWebSocketUrl = `ws://${endpoint}`;
  delete deps.connectBrowser;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function makeAuthority(overrides = {}) {
  const value = {
    profile_name: 'tv-observer-1',
    capture_slot_id: 'v5-capture-slot-b',
    layout_code: 's',
    saved_layout_id: '206146606',
    reconciliation_key: RECONCILIATION_KEY,
    allowed_origins: ['https://www.tradingview.com'],
    ...overrides,
  };
  const authorityHash = createHash('sha256').update(JSON.stringify({
    allowedOrigins: value.allowed_origins,
    captureSlotId: value.capture_slot_id,
    layoutCode: value.layout_code,
    profileId: value.profile_name,
    savedLayoutId: value.saved_layout_id,
    schemaVersion: 'v5-capture-slot-authority-v3',
  }), 'utf8').digest('hex');
  return {
    ...value,
    authority_id: `v5-capture-slot:${authorityHash}`,
    authority_hash: authorityHash,
  };
}

function retire(input = INPUT, dependencies = {}) {
  return retireSavedChartTarget(input, { reviewedAuthority: AUTHORITY, ...dependencies });
}

test('closes exact server layout through target ID despite shared route and swapped page sockets', async () => {
  const deps = fixture();
  const result = await retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' });
  assert.equal(result.action, 'closed');
  assert.equal(result.chart_target_id, 'target-b');
  assert.equal(result.saved_layout_id, '206146606');
  assert.equal(result.account_subject_sha256, ACCOUNT_HASH);
  assert.equal(result.remaining_chart_targets, 1);
  assert.equal(result.mutations_performed, true);
  assert.deepEqual(deps.calls.close, ['target-b']);
  assert.deepEqual(deps.calls.inspectedTargetIds, ['target-a', 'target-b', 'target-a', 'target-b', 'target-a']);
  assert.deepEqual(deps.calls.attachedTargetIds, deps.calls.inspectedTargetIds);
  assert.deepEqual(deps.calls.browserWebSocketUrls, ['ws://manager.test/profiles/current-profile/cdp']);
  assert.equal(deps.calls.browserCloseCount, 1);
});

test('fails closed when expected marker is active under a different server layout ID', async () => {
  const deps = fixture();
  deps.readTargetIdentity = async (target) => ({
    href: target.url,
    account_subject_sha256: ACCOUNT_HASH,
    saved_layout_id: '206128986',
    saved_layout_name: MARKER,
    layouts: LAYOUTS,
  });
  await assert.rejects(
    retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' }),
    /conflicts with exact saved-layout authority identity/u,
  );
  assert.deepEqual(deps.calls.close, []);
});

test('fails closed when authenticated inventory does not map exact marker to saved layout ID', async () => {
  const deps = fixture();
  deps.readTargetIdentity = async (target) => ({
    href: target.url,
    account_subject_sha256: ACCOUNT_HASH,
    saved_layout_id: target.id === 'target-a' ? '206000778' : '206146606',
    saved_layout_name: target.id === 'target-a' ? OTHER_MARKER : MARKER,
    layouts: [{ layout_id: '206128986', name: MARKER }],
  });
  await assert.rejects(
    retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' }),
    /marker and server ID are missing or ambiguous/u,
  );
  assert.deepEqual(deps.calls.close, []);
});

test('re-reads exact target identity and page inventory immediately before close', async () => {
  const deps = fixture();
  let readCount = 0;
  deps.readTargetIdentity = async (target) => {
    readCount += 1;
    return {
      href: target.url,
      account_subject_sha256: ACCOUNT_HASH,
      saved_layout_id: target.id === 'target-a' ? '206000778' : '206146606',
      saved_layout_name: target.id === 'target-a' ? OTHER_MARKER : MARKER,
      layouts: readCount === 1 ? LAYOUTS : [{ layout_id: '206000778', name: 'changed' }],
    };
  };
  await assert.rejects(
    retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' }),
    /marker and server ID are missing or ambiguous/u,
  );
  assert.deepEqual(deps.calls.close, []);
});

test('reports already closed when no page has exact saved-layout metaInfo identity', async () => {
  const deps = fixture([
    { id: 'target-a', type: 'page', url: ROUTE },
    { id: 'anchor', type: 'page', url: 'about:blank' },
  ]);
  const result = await retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' });
  assert.equal(result.action, 'already-closed');
  assert.equal(result.chart_target_id, null);
  assert.equal(result.account_subject_sha256, ACCOUNT_HASH);
  assert.equal(result.mutations_performed, false);
  assert.deepEqual(deps.calls.close, []);
  assert.deepEqual(deps.calls.inspectedTargetIds, ['target-a']);
});

test('re-reads profile inventory when listed chart target disappears before CDP identity attach', async () => {
  const deps = fixture();
  deps.calls.missingTargetOnAttach = 'target-b';
  const result = await retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' });
  assert.equal(result.action, 'already-closed');
  assert.equal(result.chart_target_id, null);
  assert.equal(result.remaining_chart_targets, 1);
  assert.equal(result.mutations_performed, false);
  assert.deepEqual(deps.calls.close, []);
  assert.deepEqual(deps.calls.attachedTargetIds, ['target-a', 'target-b', 'target-a']);
  assert.equal(deps.calls.fetch.filter((url) => url.endsWith('/json/list')).length, 2);
});

test('reports already closed when exact target disappears before pre-close verification', async () => {
  const deps = fixture();
  deps.calls.removeTargetOnJsonListCall = 2;
  const result = await retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' });
  assert.equal(result.action, 'already-closed');
  assert.equal(result.chart_target_id, null);
  assert.equal(result.mutations_performed, false);
  assert.deepEqual(deps.calls.close, []);
  assert.deepEqual(deps.calls.inspectedTargetIds, ['target-a', 'target-b', 'target-a']);
});

test('fails closed when exact target disappears while another profile page is added', async () => {
  const deps = fixture();
  deps.calls.removeTargetOnJsonListCall = 2;
  deps.calls.addPageOnJsonListCall = 2;
  await assert.rejects(
    retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' }),
    /page inventory changed before exact saved-layout retirement/u,
  );
  assert.deepEqual(deps.calls.close, []);
});

test('fails closed when CDP says target is missing but fresh profile inventory still lists it', async () => {
  const deps = fixture();
  deps.calls.missingTargetOnAttach = 'target-a';
  deps.calls.keepMissingTargetListed = true;
  await assert.rejects(
    retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test' }),
    /target remained in the current profile inventory/u,
  );
  assert.deepEqual(deps.calls.close, []);
});

test('refuses to close the final browser page', async () => {
  const lastPage = fixture([{ id: 'target-b', type: 'page', url: ROUTE }]);
  await assert.rejects(
    retire(INPUT, { ...lastPage, managerBaseUrl: 'http://manager.test' }),
    /last browser page/u,
  );
  assert.deepEqual(lastPage.calls.close, []);

});

test('retirement requires positive close acknowledgement and exact profile CDP authority', async () => {
  const unacknowledged = fixture();
  unacknowledged.calls.closeAcknowledged = false;
  await assert.rejects(
    retire(INPUT, { ...unacknowledged, managerBaseUrl: 'http://manager.test' }),
    /close was not acknowledged/u,
  );
  assert.deepEqual(unacknowledged.calls.close, ['target-b']);

  const wrongEndpoint = fixture();
  wrongEndpoint.calls.browserWebSocketUrl = 'ws://other.test/profiles/current-profile/cdp';
  await assert.rejects(
    retire(INPUT, { ...wrongEndpoint, managerBaseUrl: 'http://manager.test' }),
    /outside exact Manager profile authority/u,
  );
  assert.deepEqual(wrongEndpoint.calls.close, []);
});

test('aborts a stalled exact-profile CDP WebSocket handshake within its deadline', async () => {
  const server = createServer();
  const sockets = new Set();
  server.on('upgrade', (_request, socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const port = await listen(server);
  const deps = fixture();
  setLocalCdpEndpoint(deps, port);
  try {
    await assert.rejects(
      retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test', timeoutMs: 300 }),
      /WebSocket handshake exceeded bounded \d+ms deadline/u,
    );
    assert.deepEqual(deps.calls.close, []);
  } finally {
    for (const socket of sockets) socket.destroy();
    await close(server);
  }
});

test('rejects oversized CDP frames at WebSocket transport before identity parsing or close', async () => {
  const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString('utf8'));
      if (request.method === 'Target.attachToTarget') {
        socket.send(JSON.stringify({ id: request.id, result: { sessionId: 'session-target-a' } }));
      } else if (request.method === 'Runtime.evaluate') {
        socket.send(JSON.stringify({
          id: request.id,
          result: { result: { type: 'object', value: { padding: 'x'.repeat(140 * 1024) } } },
        }));
      }
    });
  });
  const port = server.address().port;
  const deps = fixture();
  setLocalCdpEndpoint(deps, port);
  try {
    await assert.rejects(
      retire(INPUT, { ...deps, managerBaseUrl: 'http://manager.test', timeoutMs: 2_000 }),
      /frame exceeds bounded 131072-byte transport limit/u,
    );
    assert.deepEqual(deps.calls.close, []);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await close(server);
  }
});

test('retirement rejects caller-minted or cross-slot authority before profile access', async () => {
  const deps = fixture();
  await assert.rejects(
    retire(makeAuthority({ capture_slot_id: 'v5-capture-slot-a' }), { ...deps, managerBaseUrl: 'http://manager.test' }),
    /differs from the per-worker reviewed/u,
  );
  assert.deepEqual(deps.calls.fetch, []);
  assert.deepEqual(deps.calls.close, []);
});

test('retirement contract requires stable saved-layout authority', () => {
  const definition = observerToolDefinitions.tv_observer_retire_saved_chart_v2;
  assert.deepEqual(Object.keys(definition.inputSchema).sort(), [
    'allowed_origins', 'authority_hash', 'authority_id', 'capture_slot_id',
    'layout_code', 'profile_name', 'reconciliation_key', 'saved_layout_id',
  ].sort());
  assert.deepEqual(definition.outputSchema.retirement_version.safeParse('saved-chart-retirement-v2'), {
    success: true,
    data: 'saved-chart-retirement-v2',
  });
});
