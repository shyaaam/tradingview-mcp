import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { getObserverSession } from '../src/core/observer-session.js';
import { hydrateChartTarget, normalizeChartUrl } from '../src/core/chart-target-hydration.js';
import { invalidateObserverSession } from '../src/connection.js';

const origins = ['https://www.tradingview.com'];
const profileId = 'profile-hydration-test';
const savedChartId = 'AbCd12';
const authorityId = `chart-target-authority-v1:${'a'.repeat(64)}`;
const authorityHash = 'b'.repeat(64);

function startFakeManager({ initialTarget = null, loginAfterCreate = false, relativeCdpUrl = false } = {}) {
  let target = initialTarget;
  let createCount = 0;
  const server = http.createServer((request, response) => {
    const body = (value) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.url === '/api/profiles') {
      const cdpUrl = relativeCdpUrl
        ? `/api/profiles/${profileId}/cdp/`
        : `http://127.0.0.1:${server.address().port}/cdp`;
      return body([{ id: profileId, status: 'running', cdp_url: cdpUrl }]);
    }
    if (request.url?.endsWith('/cdp/json/version')) return body({ Browser: 'fake', webSocketDebuggerUrl: 'ws://fake-browser' });
    if (request.url?.endsWith('/cdp/json/list')) return body(target ? [target] : []);
    if (request.url?.includes('/cdp/json/new?')) {
      createCount += 1;
      target = loginAfterCreate
        ? { id: 'target-login', type: 'page', url: 'https://www.tradingview.com/accounts/signin/' }
        : { id: 'target-created', type: 'page', url: 'https://www.tradingview.com/chart/AbCd12/' };
      return body(target);
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/api`,
    recordCreate() { createCount += 1; },
    setTarget(value) { target = value; },
    get createCount() { return createCount; },
  })));
}

async function runHydration(options = {}) {
  const fake = await startFakeManager(options);
  const previousBaseUrl = process.env.CLOAK_BROWSER_BASE_URL;
  process.env.CLOAK_BROWSER_BASE_URL = fake.baseUrl;
  try {
    return { fake, result: await hydrateChartTarget({
      profile_id: profileId,
      authority_id: authorityId,
      authority_hash: authorityHash,
      chart_url: 'https://www.tradingview.com/chart/AbCd12',
      saved_chart_id: savedChartId,
      allowed_origins: origins,
    }) };
  } finally {
    await invalidateObserverSession();
    if (previousBaseUrl === undefined) delete process.env.CLOAK_BROWSER_BASE_URL;
    else process.env.CLOAK_BROWSER_BASE_URL = previousBaseUrl;
    await new Promise((resolve) => fake.server.close(resolve));
  }
}

test('normalizes exact authorized saved-chart URL', () => {
  assert.equal(normalizeChartUrl('https://www.tradingview.com/chart/AbCd12', origins, 'AbCd12'), 'https://www.tradingview.com/chart/AbCd12/');
});

test('rejects unsupported origin', () => {
  assert.throws(() => normalizeChartUrl('https://evil.example/chart/AbCd12/', origins, 'AbCd12'), /origin is not authorized/);
});

test('rejects saved-chart mismatch and broad paths', () => {
  assert.throws(() => normalizeChartUrl('https://www.tradingview.com/chart/Other/', origins, 'AbCd12'), /does not match/);
  assert.throws(() => normalizeChartUrl('https://www.tradingview.com/markets/', origins, 'AbCd12'), /does not match/);
});

test('rejects credentials and fragments', () => {
  assert.throws(() => normalizeChartUrl('https://user@www.tradingview.com/chart/AbCd12/', origins, 'AbCd12'), /without credentials/);
  assert.throws(() => normalizeChartUrl('https://www.tradingview.com/chart/AbCd12/#x', origins, 'AbCd12'), /without credentials/);
});

test('reuses one exact existing target and binds observer session', async () => {
  const { fake, result } = await runHydration({
    initialTarget: { id: 'target-existing', type: 'page', url: 'https://www.tradingview.com/chart/AbCd12/' },
  });
  assert.equal(result.state, 'existing-identical');
  assert.equal(result.navigation_performed, false);
  assert.equal(result.target_id, 'target-existing');
  assert.equal(fake.createCount, 0);
  assert.equal(getObserverSession(), null);
});

test('creates missing exact target once and replays without navigation', async () => {
  const fake = await startFakeManager();
  const previousBaseUrl = process.env.CLOAK_BROWSER_BASE_URL;
  process.env.CLOAK_BROWSER_BASE_URL = fake.baseUrl;
  try {
    const createTarget = async ({ chartUrl }) => {
      fake.recordCreate();
      const created = { id: 'target-created', type: 'page', url: chartUrl };
      fake.setTarget(created);
      return created;
    };
    const first = await hydrateChartTarget({
      profile_id: profileId,
      authority_id: authorityId,
      authority_hash: authorityHash,
      chart_url: 'https://www.tradingview.com/chart/AbCd12',
      saved_chart_id: savedChartId,
      allowed_origins: origins,
      _deps: { createTarget },
    });
    const second = await hydrateChartTarget({
      profile_id: profileId,
      authority_id: authorityId,
      authority_hash: authorityHash,
      chart_url: 'https://www.tradingview.com/chart/AbCd12',
      saved_chart_id: savedChartId,
      allowed_origins: origins,
    });
    assert.equal(first.state, 'hydrated');
    assert.equal(first.navigation_performed, true);
    assert.equal(second.state, 'existing-identical');
    assert.equal(second.target_id, first.target_id);
    assert.equal(fake.createCount, 1);
  } finally {
    await invalidateObserverSession();
    if (previousBaseUrl === undefined) delete process.env.CLOAK_BROWSER_BASE_URL;
    else process.env.CLOAK_BROWSER_BASE_URL = previousBaseUrl;
    await new Promise((resolve) => fake.server.close(resolve));
  }
});

test('resolves relative Manager CDP endpoint during hydration', async () => {
  const { fake, result } = await runHydration({
    relativeCdpUrl: true,
    initialTarget: { id: 'target-relative', type: 'page', url: 'https://www.tradingview.com/chart/AbCd12/' },
  });
  assert.equal(result.state, 'existing-identical');
  assert.equal(result.navigation_performed, false);
  assert.equal(result.target_id, 'target-relative');
  assert.equal(fake.createCount, 0);
});

test('fails closed when missing target resolves to login', async () => {
  const fake = await startFakeManager();
  const previousBaseUrl = process.env.CLOAK_BROWSER_BASE_URL;
  process.env.CLOAK_BROWSER_BASE_URL = fake.baseUrl;
  try {
    await assert.rejects(
      () => hydrateChartTarget({
        profile_id: profileId,
        authority_id: authorityId,
        authority_hash: authorityHash,
        chart_url: 'https://www.tradingview.com/chart/AbCd12',
        saved_chart_id: savedChartId,
        allowed_origins: origins,
        _deps: {
          createTarget: async () => {
            fake.recordCreate();
            const created = { id: 'target-login', type: 'page', url: 'https://www.tradingview.com/accounts/signin/' };
            fake.setTarget(created);
            return created;
          },
        },
      }),
      /requires authenticated browser state/,
    );
  } finally {
    await invalidateObserverSession();
    if (previousBaseUrl === undefined) delete process.env.CLOAK_BROWSER_BASE_URL;
    else process.env.CLOAK_BROWSER_BASE_URL = previousBaseUrl;
    await new Promise((resolve) => fake.server.close(resolve));
  }
});
