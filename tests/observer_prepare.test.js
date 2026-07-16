import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { prepare } from '../src/core/observer.js';
import { list as listTabs } from '../src/core/tab.js';
import { getObserverSession, invalidateObserverSession, requireObserverSession } from '../src/connection.js';
import { resolveCdpBaseUrl, resolveCloakProfileId } from '../src/core/cloak.js';
import { registerObserverTool } from '../src/release/observer-schema.js';

const BASE_URL = 'http://127.0.0.1:8080/api';
const PROFILE_ID = 'profile-a';

let originalFetch;
let originalBaseUrl;
let originalCdpBaseUrl;
let originalProfileId;

beforeEach(() => {
  originalFetch = global.fetch;
  originalBaseUrl = process.env.CLOAK_BROWSER_BASE_URL;
  originalCdpBaseUrl = process.env.CDP_BASE_URL;
  originalProfileId = process.env.CLOAK_BROWSER_PROFILE_ID;
  process.env.CLOAK_BROWSER_BASE_URL = BASE_URL;
});

afterEach(async () => {
  global.fetch = originalFetch;
  if (originalBaseUrl === undefined) delete process.env.CLOAK_BROWSER_BASE_URL;
  else process.env.CLOAK_BROWSER_BASE_URL = originalBaseUrl;
  if (originalCdpBaseUrl === undefined) delete process.env.CDP_BASE_URL;
  else process.env.CDP_BASE_URL = originalCdpBaseUrl;
  if (originalProfileId === undefined) delete process.env.CLOAK_BROWSER_PROFILE_ID;
  else process.env.CLOAK_BROWSER_PROFILE_ID = originalProfileId;
  await invalidateObserverSession();
});

test('observer preparation requires exact profile and never stops by default', async () => {
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method || 'GET' });
    if (url === `${BASE_URL}/profiles`) {
      return response([{ id: PROFILE_ID, status: 'running', cdp_url: `/api/profiles/${PROFILE_ID}/cdp` }, { id: 'other', status: 'running' }]);
    }
    if (url === `${BASE_URL}/profiles/${PROFILE_ID}/cdp/json/version`) {
      return response({ Browser: 'Chrome/146.0.0.0', 'User-Agent': 'test-agent' });
    }
    if (url === `${BASE_URL}/profiles/${PROFILE_ID}/cdp/json/list`) {
      return response([{ id: 'chart-1', type: 'page', title: 'TradingView', url: 'https://www.tradingview.com/chart/abc' }]);
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await prepare({ profile_id: PROFILE_ID });
  assert.deepEqual(result, {
    success: true,
    manager_base_url: BASE_URL,
    profile_id: PROFILE_ID,
    restart_requested: false,
    status: 'running',
    cdp_ready: true,
    cdp_url: `${BASE_URL}/profiles/${PROFILE_ID}/cdp`,
    browser: 'Chrome/146.0.0.0',
    user_agent: 'test-agent',
    chart_target_id: 'chart-1',
    chart_target_url: 'https://www.tradingview.com/chart/abc',
  });
  assert.equal(calls.some((call) => call.url.endsWith('/stop')), false);
  assert.equal(calls.some((call) => call.url.endsWith('/launch')), false);
  assert.equal(calls.every((call) => call.url.includes(`/profiles/${PROFILE_ID}`) || call.url.endsWith('/profiles')), true);

  assert.deepEqual(getObserverSession(), {
    managerBaseUrl: BASE_URL,
    profileId: PROFILE_ID,
    cdpUrl: `${BASE_URL}/profiles/${PROFILE_ID}/cdp`,
    chartTargetId: 'chart-1',
    chartTargetUrl: 'https://www.tradingview.com/chart/abc',
  });
  process.env.CDP_BASE_URL = 'http://127.0.0.1:9222';
  process.env.CLOAK_BROWSER_PROFILE_ID = 'profile-b';
  assert.equal(await resolveCdpBaseUrl(), `${BASE_URL}/profiles/${PROFILE_ID}/cdp`);
  assert.equal(await resolveCloakProfileId(), PROFILE_ID);
  const readback = await listTabs();
  assert.equal(readback.tab_count, 1);
});

test('observer preparation rejects missing profile identity', async () => {
  await assert.rejects(() => prepare({}), /profile_id is required/);
});

test('observer session is required before admitted tool work', () => {
  assert.throws(() => requireObserverSession(), /Observer session is not prepared/);
});

test('registered admitted tool rejects before observer preparation', async () => {
  const handlers = new Map();
  registerObserverTool({
    registerTool(name, _definition, handler) {
      handlers.set(name, handler);
    },
  }, 'tv_health_check', 'test health', async () => ({ success: true }));

  await assert.rejects(
    () => handlers.get('tv_health_check')({}, {}),
    /Observer session is not prepared/,
  );
});

test('observer preparation launches exact stopped profile without fallback', async () => {
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method || 'GET' });
    if (url === `${BASE_URL}/profiles`) return response([{ id: PROFILE_ID, status: 'stopped' }]);
    if (url === `${BASE_URL}/profiles/${PROFILE_ID}/launch`) {
      return response({ status: 'running', cdp_url: `${BASE_URL}/profiles/${PROFILE_ID}/cdp` });
    }
    if (url === `${BASE_URL}/profiles/${PROFILE_ID}/cdp/json/version`) {
      return response({ Browser: 'Chrome/146.0.0.0', 'User-Agent': 'test-agent' });
    }
    if (url === `${BASE_URL}/profiles/${PROFILE_ID}/cdp/json/list`) {
      return response([{ id: 'chart-1', type: 'page', url: 'https://www.tradingview.com/chart/abc' }]);
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await prepare({ profile_id: PROFILE_ID });
  assert.equal(result.profile_id, PROFILE_ID);
  assert.equal(calls.some((call) => call.url.endsWith(`/profiles/${PROFILE_ID}/launch`)), true);
  assert.equal(calls.some((call) => call.url.endsWith('/stop')), false);
});

function response(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
