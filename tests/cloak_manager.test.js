import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { launch } from '../src/core/health.js';
import {
  launchCloakProfile,
  resolveCdpBaseUrl,
  resolveCloakManagerBaseUrl,
  resolveCloakProfileId,
} from '../src/core/cloak.js';

const ENV_KEYS = [
  'CLOAK_BROWSER_BASE_URL',
  'CLOAK_BROWSER_PROFILE_ID',
  'CLOAK_PROFILE_ID',
  'CDP_BASE_URL',
  'CDP_HOST',
  'CDP_PORT',
];

function snapshotEnv() {
  const snapshot = new Map();
  for (const key of ENV_KEYS) {
    snapshot.set(key, process.env[key]);
  }
  return snapshot;
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    const value = snapshot.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('CloakBrowser manager routing', () => {
  let originalFetch;
  let envSnapshot;

  beforeEach(() => {
    originalFetch = global.fetch;
    envSnapshot = snapshotEnv();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    restoreEnv(envSnapshot);
  });

  it('derives cdp base url from manager profile', async () => {
    process.env.CLOAK_BROWSER_BASE_URL = 'http://127.0.0.1:8080/api';
    process.env.CLOAK_BROWSER_PROFILE_ID = 'profile-a';

    await assert.doesNotReject(resolveCloakProfileId());
    assert.equal(
      await resolveCdpBaseUrl(),
      'http://127.0.0.1:8080/api/profiles/profile-a/cdp'
    );
  });

  it('auto-discovers local manager base url without env', async () => {
    global.fetch = async (input) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:8080/api/profiles') {
        return new Response(JSON.stringify([{ id: 'profile-a', status: 'running' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    assert.equal(await resolveCloakManagerBaseUrl(), 'http://127.0.0.1:8080/api');
  });

  it('tv_launch bypasses manager when CDP_BASE_URL is set', async () => {
    process.env.CDP_BASE_URL = 'http://127.0.0.1:9222';
    process.env.CLOAK_BROWSER_BASE_URL = 'http://127.0.0.1:8080/api';

    const calls = [];
    global.fetch = async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method || 'GET' });
      if (url === 'http://127.0.0.1:9222/json/version') {
        return new Response(
          JSON.stringify({
            Browser: 'Chrome/146.0.0.0',
            'User-Agent': 'test-agent',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url === 'http://127.0.0.1:9222/json/list') {
        return new Response(
          JSON.stringify([
            {
              id: 'target-1',
              type: 'page',
              url: 'https://www.tradingview.com/chart/',
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const result = await launch({ kill_existing: false });

    assert.equal(result.success, true);
    assert.equal(result.direct_cdp, true);
    assert.equal(result.cdp_ready, true);
    assert.equal(result.cdp_url, 'http://127.0.0.1:9222');
    assert.ok(calls.some((call) => call.url === 'http://127.0.0.1:9222/json/version'));
    assert.ok(calls.every((call) => !call.url.includes(':8080/api/profiles')));
  });

  it('launches via manager endpoint and reads cdp readiness', async () => {
    process.env.CLOAK_BROWSER_BASE_URL = 'http://127.0.0.1:8080/api';
    process.env.CLOAK_BROWSER_PROFILE_ID = 'profile-a';

    const calls = [];
    global.fetch = async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method || 'GET' });
      if (url.endsWith('/profiles/profile-a/launch')) {
        return new Response(
          JSON.stringify({
            status: 'running',
            cdp_url: 'http://127.0.0.1:8080/api/profiles/profile-a/cdp',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.endsWith('/json/version')) {
        return new Response(
          JSON.stringify({
            Browser: 'Chrome/146.0.0.0',
            'User-Agent': 'test-agent',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const result = await launch({ kill_existing: false });

    assert.equal(result.success, true);
    assert.equal(result.profile_id, 'profile-a');
    assert.equal(result.cdp_ready, true);
    assert.ok(calls.some((call) => call.url.endsWith('/profiles/profile-a/launch')));
    assert.ok(calls.some((call) => call.url.endsWith('/json/version')));
  });

  it('launchCloakProfile posts only to manager', async () => {
    process.env.CLOAK_BROWSER_BASE_URL = 'http://127.0.0.1:8080/api';
    process.env.CLOAK_BROWSER_PROFILE_ID = 'profile-a';

    const calls = [];
    global.fetch = async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method || 'GET' });
      if (url.endsWith('/profiles/profile-a/launch')) {
        return new Response(
          JSON.stringify({ status: 'running', cdp_url: 'http://127.0.0.1:8080/api/profiles/profile-a/cdp' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await launchCloakProfile({ killExisting: false });

    assert.equal(result.profile_id, 'profile-a');
    assert.ok(calls.every((call) => call.url.includes('/api/profiles/profile-a/')));
  });
});
