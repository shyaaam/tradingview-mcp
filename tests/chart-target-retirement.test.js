import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

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
  { id: 'target-a', type: 'page', url: ROUTE },
  { id: 'target-b', type: 'page', url: ROUTE },
  { id: 'anchor', type: 'page', url: 'about:blank' },
]) {
  let targets = initialTargets.map((target) => ({ ...target }));
  const calls = {
    close: [], fetch: [], inspectedTargetIds: [], webSocketUrls: [], socketCloseCount: 0,
    closeAcknowledged: true,
    profileCdpUrl: 'http://manager.test/profiles/current-profile/cdp',
    browserWebSocketUrl: 'ws://manager.test/profiles/current-profile/cdp',
  };
  const fetch = async (url) => {
    calls.fetch.push(url);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/json/version')) return ok({ webSocketDebuggerUrl: calls.browserWebSocketUrl });
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
      if (calls.closeAcknowledged) targets = targets.filter((target) => target.id !== request.params.targetId);
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
  const readTargetIdentity = async (target) => {
    calls.inspectedTargetIds.push(target.id);
    return {
      href: target.url,
      account_subject_sha256: ACCOUNT_HASH,
      saved_layout_id: target.id === 'target-a' ? '206000778' : '206146606',
      saved_layout_name: target.id === 'target-a' ? OTHER_MARKER : MARKER,
      layouts: LAYOUTS,
    };
  };
  return {
    fetch,
    createWebSocket,
    readTargetIdentity,
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

test('closes exact saved-layout metaInfo ID and marker despite shared route UID', async () => {
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
  assert.deepEqual(deps.calls.webSocketUrls, ['ws://manager.test/profiles/current-profile/cdp']);
  assert.ok(deps.calls.socketCloseCount >= 1);
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
  const definition = observerToolDefinitions.tv_observer_retire_saved_chart_v1;
  assert.deepEqual(Object.keys(definition.inputSchema).sort(), [
    'allowed_origins', 'authority_hash', 'authority_id', 'capture_slot_id',
    'layout_code', 'profile_name', 'reconciliation_key', 'saved_layout_id',
  ].sort());
  assert.deepEqual(definition.outputSchema.retirement_version.safeParse('saved-layout-retirement-v1'), {
    success: true,
    data: 'saved-layout-retirement-v1',
  });
});
