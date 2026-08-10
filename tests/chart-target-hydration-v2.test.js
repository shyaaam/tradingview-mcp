import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  CHART_RUNTIME_HYDRATION_V2_EXPRESSION,
  hydrateChartTargetV2,
} from '../src/core/chart-target-hydration-v2.js';
import { observerToolDefinitions } from '../src/release/observer-schema.js';

const PROFILE_ID = 'profile-v2';
const TARGET_URL = 'https://www.tradingview.com/chart/SJ0J0zgb/';
const AUTHORITY_ID = `chart-target-authority-v2:${'a'.repeat(64)}`;
const AUTHORITY_HASH = 'b'.repeat(64);
const CHART_ID = 'SJ0J0zgb';

function response(value) {
  return { ok: true, status: 200, json: async () => value };
}

function runtime(overrides = {}) {
  return {
    runtime_url: TARGET_URL,
    document_ready_state: 'complete',
    document_title: 'TradingView',
    chrome_error_page: false,
    login_state: 'absent',
    challenge_state: 'absent',
    ...overrides,
  };
}

function makeHarness({ targets = [], runtimeSnapshot = runtime(), navigate = {} } = {}) {
  const state = {
    targets: [...targets],
    runtimeSnapshot,
    navigate,
  };
  const calls = {
    createTarget: 0,
    navigate: 0,
    pageEnable: 0,
    networkEnable: 0,
    close: 0,
  };
  let clock = 0;
  const listeners = {};
  const browser = {
    Target: {
      createTarget: async ({ url }) => {
        calls.createTarget += 1;
        assert.equal(url, 'about:blank');
        state.targets = [{ id: 'target-new', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://target-new' }];
        return { targetId: 'target-new' };
      },
    },
    close: async () => {},
  };
  const client = {
    Runtime: {
      enable: async () => {},
      evaluate: async ({ expression }) => {
        calls.expression = expression;
        return { result: { value: state.runtimeSnapshot } };
      },
    },
    Page: {
      enable: async () => { calls.pageEnable += 1; },
      navigate: async ({ url }) => {
        calls.navigate += 1;
        const request = listeners.requestWillBeSent;
        request?.({ requestId: 'request-1', type: 'Document', frameId: 'frame-1', loaderId: 'loader-1' });
        if (state.navigate.failure) listeners.loadingFailed?.({
          requestId: 'request-1', type: 'Document', frameId: 'frame-1', loaderId: 'loader-1',
          errorText: 'net::ERR_PROXY_CONNECTION_FAILED', canceled: false,
          blockedReason: 'inspector', corsErrorStatus: { corsError: 'cors', failedParameter: 'url' },
        });
        if (state.navigate.subresourceFailure) listeners.loadingFailed?.({
          requestId: 'image-1', type: 'Image', frameId: 'frame-1', loaderId: 'loader-1',
          errorText: 'net::ERR_BLOCKED_BY_CLIENT', canceled: false,
        });
        state.targets[0].url = url;
        state.runtimeSnapshot = state.navigate.runtime || runtime();
        return { frameId: 'frame-1', loaderId: 'loader-1', isDownload: false, errorText: state.navigate.errorText };
      },
    },
    Network: {
      enable: async () => { calls.networkEnable += 1; },
      requestWillBeSent: (handler) => { listeners.requestWillBeSent = handler; },
      responseReceived: (handler) => {
        listeners.responseReceived = handler;
        handler({ requestId: 'request-1', type: 'Document', response: { status: 200, mimeType: 'text/html', protocol: 'h2' } });
      },
      loadingFailed: (handler) => { listeners.loadingFailed = handler; },
    },
    close: async () => { calls.close += 1; },
  };
  const deps = {
    managerBaseUrl: 'http://manager.test/api',
    fetch: async (url) => {
      if (url.endsWith('/profiles')) return response([{ id: PROFILE_ID, status: 'running', cdp_url: '/api/profiles/profile-v2/cdp/' }]);
      if (url.endsWith('/json/version')) return response({ webSocketDebuggerUrl: 'ws://browser' });
      if (url.endsWith('/json/list')) return response(state.targets);
      throw new Error(`unexpected URL: ${url}`);
    },
    connectBrowser: async () => browser,
    connect: async () => client,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  return { deps, calls, state };
}

function input(overrides = {}) {
  return {
    profile_id: PROFILE_ID,
    authority_id: AUTHORITY_ID,
    authority_hash: AUTHORITY_HASH,
    chart_url: TARGET_URL,
    saved_chart_id: CHART_ID,
    allowed_origins: ['https://www.tradingview.com'],
    ...overrides,
  };
}

function exactTarget(id = 'target-existing') {
  return { id, type: 'page', url: TARGET_URL, webSocketDebuggerUrl: `ws://${id}` };
}

test('existing exact renderer is verified without navigation', async () => {
  const harness = makeHarness({ targets: [exactTarget()] });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'existing-renderer-verified');
  assert.equal(result.renderer_verified, true);
  assert.equal(result.navigation_performed, false);
  assert.equal(result.mutations_performed, false);
  assert.equal(harness.calls.navigate, 0);
  z.object(observerToolDefinitions.tv_observer_hydrate_chart_target_v2.outputSchema).parse(result);
});

test('existing exact metadata with Chrome error blocks without navigation', async () => {
  const harness = makeHarness({ targets: [exactTarget()], runtimeSnapshot: runtime({ runtime_url: 'chrome-error://chromewebdata/', chrome_error_page: true }) });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'blocked-chrome-error-document');
  assert.equal(result.navigation_performed, false);
  assert.equal(harness.calls.navigate, 0);
});

test('duplicate exact targets block before CDP navigation', async () => {
  const harness = makeHarness({ targets: [exactTarget('one'), exactTarget('two')] });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'blocked-target-ambiguous');
  assert.equal(harness.calls.navigate, 0);
  assert.equal(harness.calls.createTarget, 0);
});

test('missing target creates one about:blank target and navigates exactly once', async () => {
  const harness = makeHarness({ targets: [] });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'renderer-verified');
  assert.equal(result.renderer_verified, true);
  assert.equal(result.target_created, true);
  assert.equal(result.navigation_performed, true);
  assert.equal(harness.calls.createTarget, 1);
  assert.equal(harness.calls.navigate, 1);
  assert.equal(harness.calls.pageEnable, 1);
  assert.equal(harness.calls.networkEnable, 1);
  assert.equal(result.page_navigate.error_text, null);
  assert.equal(result.main_document_network.request_id, 'request-1');
});

test('Page.navigate error is a structured blocked result', async () => {
  const harness = makeHarness({ targets: [], navigate: { errorText: 'net::ERR_PROXY_CONNECTION_FAILED', runtime: runtime({ runtime_url: 'about:blank' }) } });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'blocked-page-navigate-error');
  assert.equal(result.page_navigate.error_text, 'net::ERR_PROXY_CONNECTION_FAILED');
  assert.equal(harness.calls.navigate, 1);
});

test('correlated main-document loading failure blocks and is sanitized', async () => {
  const harness = makeHarness({ targets: [], navigate: { failure: true, runtime: runtime({ runtime_url: 'chrome-error://chromewebdata/', chrome_error_page: true }) } });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'blocked-main-document-network-failure');
  assert.equal(result.main_document_network.error_text, 'net::ERR_PROXY_CONNECTION_FAILED');
  assert.equal(result.main_document_network.request_id, 'request-1');
  assert.equal(result.main_document_network.response.status, 200);
  assert.doesNotMatch(JSON.stringify(result), /cookie|authorization|header|body/iu);
});

test('subresource loading failure does not fail renderer verification', async () => {
  const harness = makeHarness({ targets: [], navigate: { subresourceFailure: true } });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'renderer-verified');
  assert.equal(result.renderer_verified, true);
  assert.equal(result.main_document_network.error_text, null);
});

test('login redirect and timeout remain blocked', async () => {
  const login = makeHarness({ targets: [], navigate: { runtime: runtime({ runtime_url: 'https://www.tradingview.com/accounts/signin/', login_state: 'present' }) } });
  const loginResult = await hydrateChartTargetV2(input(), login.deps);
  assert.equal(loginResult.state, 'blocked-login-required');

  const timeout = makeHarness({ targets: [], navigate: { runtime: runtime({ document_ready_state: 'loading' }) } });
  const timeoutResult = await hydrateChartTargetV2(input(), timeout.deps);
  assert.equal(timeoutResult.state, 'blocked-timeout');
});

test('v2 source has no recovery, fallback, or second navigation path', async () => {
  assert.doesNotMatch(CHART_RUNTIME_HYDRATION_V2_EXPRESSION, /getBoundClient|recoverDisconnectedSession|\.click\s*\(|reload|Target\.createTarget|Target\.closeTarget|save|focus|createStudy|removeEntity|setSymbol|setResolution/iu);
  assert.equal(observerToolDefinitions.tv_observer_hydrate_chart_target_v2.classification, 'bootstrap_mutation');
});
