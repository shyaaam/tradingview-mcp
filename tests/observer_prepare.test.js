import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { prepare } from '../src/core/observer.js';

const BASE_URL = 'http://127.0.0.1:8080/api';
const PROFILE_ID = 'profile-a';

let originalFetch;
let originalBaseUrl;

beforeEach(() => {
  originalFetch = global.fetch;
  originalBaseUrl = process.env.CLOAK_BROWSER_BASE_URL;
  process.env.CLOAK_BROWSER_BASE_URL = BASE_URL;
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalBaseUrl === undefined) delete process.env.CLOAK_BROWSER_BASE_URL;
  else process.env.CLOAK_BROWSER_BASE_URL = originalBaseUrl;
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
      return response([{ id: 'chart-1', type: 'page', url: 'https://www.tradingview.com/chart/abc' }]);
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
});

test('observer preparation rejects missing profile identity', async () => {
  await assert.rejects(() => prepare({}), /profile_id is required/);
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
