import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
    runtimeSequence: null,
  };
  const calls = {
    createTarget: 0,
    navigate: 0,
    pageEnable: 0,
    networkEnable: 0,
    runtimeEnable: 0,
    evaluate: 0,
    evaluationOrder: [],
    verificationWebSockets: [],
    close: 0,
  };
  let clock = 0;
  let sleepCount = 0;
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
      enable: async () => { calls.runtimeEnable += 1; calls.evaluationOrder.push('runtime-enable'); },
      evaluate: async ({ expression }) => {
        calls.evaluate += 1;
        calls.evaluationOrder.push('runtime-evaluate');
        calls.expression = expression;
        if (Array.isArray(state.navigate.evaluationSequence)) {
          const next = state.navigate.evaluationSequence.length > 0
            ? state.navigate.evaluationSequence.shift()
            : state.navigate.evaluationFallback;
          if (next instanceof Error) throw next;
          if (next !== undefined) return next;
        }
        const value = state.runtimeSequence?.length > 0
          ? state.runtimeSequence.shift()
          : state.runtimeSnapshot;
        return { result: { value } };
      },
    },
    Page: {
      enable: async () => { calls.pageEnable += 1; },
      navigate: async ({ url }) => {
        calls.navigate += 1;
        if (state.navigate.runtimeSequence) state.runtimeSequence = [...state.navigate.runtimeSequence];
        else state.runtimeSnapshot = state.navigate.runtime || runtime();
        const events = state.navigate.events || [
          { name: 'requestWillBeSent', value: { requestId: 'request-1', type: 'Document', frameId: 'frame-1', loaderId: 'loader-1' } },
          { name: 'responseReceived', value: { requestId: 'request-1', type: 'Document', response: { status: 200, mimeType: 'text/html', protocol: 'h2' } } },
        ];
        for (const event of events) listeners[event.name]?.(event.value);
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
        return { frameId: 'frame-1', loaderId: 'loader-1', isDownload: false, errorText: state.navigate.errorText };
      },
      getFrameTree: async () => ({
        frameTree: state.navigate.frameTree || {
          frame: {
            id: 'frame-1',
            loaderId: 'loader-1',
            url: state.targets[0]?.url || TARGET_URL,
            childFrames: [{ id: 'iframe-1', url: 'https://unrelated.example/private' }],
          },
        },
      }),
    },
    Network: {
      enable: async () => { calls.networkEnable += 1; },
      requestWillBeSent: (handler) => { listeners.requestWillBeSent = handler; },
      responseReceived: (handler) => { listeners.responseReceived = handler; },
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
    connect: async (webSocketDebuggerUrl) => {
      calls.verificationWebSockets.push(webSocketDebuggerUrl);
      return client;
    },
    sleep: async (ms) => {
      clock += ms;
      for (const event of state.navigate.sleepEvents?.[sleepCount] || []) listeners[event.name]?.(event.value);
      sleepCount += 1;
    },
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

test('existing exact metadata with about:blank blocks without navigation', async () => {
  const harness = makeHarness({ targets: [exactTarget()], runtimeSnapshot: runtime({ runtime_url: 'about:blank' }) });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'blocked-runtime-url-mismatch');
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

test('new target polls transient unavailable, blank, loading, then verifies exact renderer', async () => {
  const harness = makeHarness({
    targets: [],
    navigate: {
      runtimeSequence: [
        {},
        runtime({ runtime_url: 'about:blank', document_ready_state: 'complete' }),
        runtime({ document_ready_state: 'loading' }),
        runtime({ document_ready_state: 'interactive' }),
      ],
    },
  });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'renderer-verified');
  assert.equal(result.renderer_verified, true);
  assert.equal(harness.calls.navigate, 1);
  assert.equal(harness.calls.createTarget, 1);
});

test('initial runtime unavailable and blank remain pending before Chrome error terminal state', async () => {
  const harness = makeHarness({
    targets: [],
    navigate: {
      runtimeSequence: [
        {},
        runtime({ runtime_url: 'about:blank' }),
        runtime({ runtime_url: 'chrome-error://chromewebdata/', chrome_error_page: true }),
      ],
    },
  });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'blocked-chrome-error-document');
  assert.equal(harness.calls.navigate, 1);
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

test('late main-document failure refreshes selected request evidence on next poll', async () => {
  const harness = makeHarness({
    targets: [],
    navigate: {
      runtimeSequence: [runtime({ document_ready_state: 'loading' }), runtime({ document_ready_state: 'loading' })],
      events: [
        { name: 'requestWillBeSent', value: { requestId: 'top', type: 'Document', frameId: 'frame-1', loaderId: 'loader-1' } },
      ],
      sleepEvents: [[{
        name: 'loadingFailed',
        value: { requestId: 'top', type: 'Document', frameId: 'frame-1', loaderId: 'loader-1', errorText: 'net::ERR_PROXY_CONNECTION_FAILED', canceled: false },
      }]],
    },
  });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'blocked-main-document-network-failure');
  assert.equal(result.main_document_network.request_id, 'top');
  assert.equal(result.main_document_network.error_text, 'net::ERR_PROXY_CONNECTION_FAILED');
});

test('late main-document response refreshes selected request evidence', async () => {
  const harness = makeHarness({
    targets: [],
    navigate: {
      runtimeSequence: [runtime({ document_ready_state: 'loading' }), runtime({ document_ready_state: 'interactive' })],
      events: [
        { name: 'requestWillBeSent', value: { requestId: 'top', type: 'Document', frameId: 'frame-1', loaderId: 'loader-1' } },
      ],
      sleepEvents: [[{
        name: 'responseReceived',
        value: { requestId: 'top', type: 'Document', response: { status: 200, mimeType: 'text/html', protocol: 'h2' } },
      }]],
    },
  });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'renderer-verified');
  assert.equal(result.main_document_network.request_id, 'top');
  assert.deepEqual(result.main_document_network.response, { status: 200, mime_type: 'text/html', protocol: 'h2' });
});

test('late iframe Document failure cannot overwrite selected main request', async () => {
  const harness = makeHarness({
    targets: [],
    navigate: {
      runtimeSequence: [runtime({ document_ready_state: 'loading' }), runtime({ document_ready_state: 'interactive' })],
      events: [
        { name: 'requestWillBeSent', value: { requestId: 'top', type: 'Document', frameId: 'frame-1', loaderId: 'loader-1' } },
      ],
      sleepEvents: [[
        { name: 'requestWillBeSent', value: { requestId: 'iframe', type: 'Document', frameId: 'frame-iframe', loaderId: 'loader-iframe' } },
        { name: 'loadingFailed', value: { requestId: 'iframe', type: 'Document', frameId: 'frame-iframe', loaderId: 'loader-iframe', errorText: 'net::ERR_FAILED' } },
      ]],
    },
  });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'renderer-verified');
  assert.equal(result.main_document_network.request_id, 'top');
  assert.equal(result.main_document_network.error_text, null);
});

test('iframe Document failure does not block top-level renderer', async () => {
  const harness = makeHarness({
    targets: [],
    navigate: {
      events: [
        { name: 'requestWillBeSent', value: { requestId: 'top', type: 'Document', frameId: 'frame-1', loaderId: 'loader-1' } },
        { name: 'responseReceived', value: { requestId: 'top', type: 'Document', response: { status: 200, mimeType: 'text/html', protocol: 'h2' } } },
        { name: 'requestWillBeSent', value: { requestId: 'iframe', type: 'Document', frameId: 'frame-iframe', loaderId: 'loader-iframe' } },
        { name: 'loadingFailed', value: { requestId: 'iframe', type: 'Document', frameId: 'frame-iframe', loaderId: 'loader-iframe', errorText: 'net::ERR_FAILED' } },
      ],
    },
  });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'renderer-verified');
  assert.equal(result.main_document_network.request_id, 'top');
  assert.equal(result.main_document_network.error_text, null);
});

test('iframe failure arriving before top-level request never becomes authoritative', async () => {
  const harness = makeHarness({
    targets: [],
    navigate: {
      events: [
        { name: 'requestWillBeSent', value: { requestId: 'iframe', type: 'Document', frameId: 'frame-iframe', loaderId: 'loader-iframe' } },
        { name: 'loadingFailed', value: { requestId: 'iframe', type: 'Document', frameId: 'frame-iframe', loaderId: 'loader-iframe', errorText: 'net::ERR_FAILED' } },
        { name: 'requestWillBeSent', value: { requestId: 'top', type: 'Document', frameId: 'frame-1', loaderId: 'loader-1' } },
        { name: 'responseReceived', value: { requestId: 'top', type: 'Document', response: { status: 200, mimeType: 'text/html', protocol: 'h2' } } },
      ],
    },
  });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'renderer-verified');
  assert.equal(result.main_document_network.request_id, 'top');
});

test('later subframe Document failure cannot overwrite selected top-level request', async () => {
  const harness = makeHarness({
    targets: [],
    navigate: {
      events: [
        { name: 'requestWillBeSent', value: { requestId: 'top', type: 'Document', frameId: 'frame-1', loaderId: 'loader-1' } },
        { name: 'responseReceived', value: { requestId: 'top', type: 'Document', response: { status: 200, mimeType: 'text/html', protocol: 'h2' } } },
        { name: 'requestWillBeSent', value: { requestId: 'iframe', type: 'Document', frameId: 'frame-iframe', loaderId: 'loader-iframe' } },
        { name: 'loadingFailed', value: { requestId: 'iframe', type: 'Document', frameId: 'frame-iframe', loaderId: 'loader-iframe', errorText: 'net::ERR_FAILED' } },
      ],
    },
  });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'renderer-verified');
  assert.equal(result.main_document_network.request_id, 'top');
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

test('persistent Runtime.evaluate protocol failure is explicit, not generic timeout', async () => {
  const failure = new Error('Runtime.evaluate transport failed at secret page https://private.example/token');
  const harness = makeHarness({
    targets: [],
    navigate: { evaluationSequence: [failure], evaluationFallback: failure },
  });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'blocked-runtime-evaluation-unavailable');
  assert.equal(result.runtime_evaluation.status, 'protocol-error');
  assert.match(result.runtime_evaluation.error_text, /Runtime\.evaluate transport failed/iu);
  assert.doesNotMatch(JSON.stringify(result), /private\.example|token|at\s+.+/iu);
  assert.ok(harness.calls.evaluationOrder.indexOf('runtime-enable') < harness.calls.evaluationOrder.indexOf('runtime-evaluate'));
  assert.ok(harness.calls.close > 0);
});

test('Runtime.evaluate exceptionDetails is explicit and sanitized', async () => {
  const exception = {
    exceptionDetails: {
      text: 'Uncaught ReferenceError',
      exception: {
        className: 'ReferenceError',
        description: 'ReferenceError: privateToken is not defined at https://private.example/app.js:1:2',
      },
    },
  };
  const harness = makeHarness({
    targets: [],
    navigate: { evaluationSequence: [exception], evaluationFallback: exception },
  });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'blocked-runtime-evaluation-unavailable');
  assert.equal(result.runtime_evaluation.status, 'exception');
  assert.equal(result.runtime_evaluation.exception_class, 'ReferenceError');
  assert.match(result.runtime_evaluation.exception_description, /ReferenceError/iu);
  assert.doesNotMatch(JSON.stringify(result), /private\.example|privateToken|at\s+.+/iu);
});

test('strict verifier enables Runtime before evaluating and uses fresh current-target connection', async () => {
  const harness = makeHarness({ targets: [] });
  let navigationConnection = true;
  const originalConnect = harness.deps.connect;
  harness.deps.connect = async (webSocketDebuggerUrl) => {
    const client = await originalConnect(webSocketDebuggerUrl);
    if (navigationConnection) {
      navigationConnection = false;
      client.Runtime.evaluate = async () => { throw new Error('pre-navigation client must not verify renderer'); };
    }
    return client;
  };
  const freshClient = {
    Runtime: {
      enable: async () => {},
      evaluate: async () => ({ result: { value: runtime({ document_ready_state: 'interactive' }) } }),
    },
    Page: {
      getFrameTree: async () => ({ frameTree: { frame: { id: 'frame-1', loaderId: 'loader-1', url: TARGET_URL } } }),
    },
    close: async () => {},
  };
  const verifiedSockets = [];
  harness.deps.verifyConnect = async (webSocketDebuggerUrl) => {
    verifiedSockets.push(webSocketDebuggerUrl);
    return freshClient;
  };
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'renderer-verified');
  assert.deepEqual(verifiedSockets, ['ws://target-new']);
  assert.equal(result.runtime_evaluation.connection_source, 'fresh-current-target');
});

test('same target with refreshed debugger websocket is re-read without target adoption', async () => {
  const harness = makeHarness({ targets: [] });
  const originalFetch = harness.deps.fetch;
  let listCount = 0;
  harness.deps.fetch = async (url) => {
    const result = await originalFetch(url);
    if (!url.endsWith('/json/list')) return result;
    listCount += 1;
    const targets = await result.json();
    if (listCount >= 3 && targets[0]) targets[0].webSocketDebuggerUrl = 'ws://refreshed-current-target';
    return { ...result, json: async () => targets };
  };
  const verifiedSockets = [];
  harness.deps.verifyConnect = async (webSocketDebuggerUrl) => {
    verifiedSockets.push(webSocketDebuggerUrl);
    return {
      Runtime: {
        enable: async () => {},
        evaluate: async () => ({ result: { value: runtime({ document_ready_state: 'interactive' }) } }),
      },
      Page: {
        getFrameTree: async () => ({ frameTree: { frame: { id: 'frame-1', loaderId: 'loader-1', url: TARGET_URL } } }),
      },
      close: async () => {},
    };
  };
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'renderer-verified');
  assert.equal(result.target_id, 'target-new');
  assert.deepEqual(verifiedSockets, ['ws://refreshed-current-target']);
});

test('missing target after navigation blocks without adopting or creating another target', async () => {
  const harness = makeHarness({ targets: [] });
  const originalFetch = harness.deps.fetch;
  let listCount = 0;
  harness.deps.fetch = async (url) => {
    const result = await originalFetch(url);
    if (!url.endsWith('/json/list')) return result;
    listCount += 1;
    if (listCount >= 3) return { ...result, json: async () => [] };
    return result;
  };
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'blocked-target-missing');
  assert.equal(result.target_created, true);
  assert.equal(harness.calls.createTarget, 1);
  assert.equal(harness.calls.navigate, 1);
});

test('frame-tree evidence contains only sanitized main-frame provenance', async () => {
  const harness = makeHarness({
    targets: [],
    navigate: {
      frameTree: {
        frame: {
          id: 'frame-main',
          loaderId: 'loader-main',
          url: TARGET_URL,
          childFrames: [{ id: 'child', url: 'https://unrelated.example/private' }],
        },
      },
    },
  });
  const result = await hydrateChartTargetV2(input(), harness.deps);
  assert.equal(result.state, 'renderer-verified');
  assert.deepEqual(result.frame_tree, {
    status: 'available',
    main_frame_id: 'frame-main',
    loader_id: 'loader-main',
    url: TARGET_URL,
    url_matches_expected: true,
    mime_type: null,
    scheme: 'https',
    origin_matches_expected: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /unrelated\.example|child/iu);
});

test('v2 full module has no hidden recovery, binding, fallback, or second navigation path', async () => {
  const source = await readFile(new URL('../src/core/chart-target-hydration-v2.js', import.meta.url), 'utf8');
  assert.doesNotMatch(CHART_RUNTIME_HYDRATION_V2_EXPRESSION, /getBoundClient|recoverDisconnectedSession|\.click\s*\(|reload|Target\.createTarget|Target\.closeTarget|save|focus|createStudy|removeEntity|setSymbol|setResolution/iu);
  for (const forbidden of [/getBoundClient/iu, /recoverDisconnectedSession/iu, /bindObserverSession/iu, /\.click\s*\(/u, /\.reload\s*\(/u, /Target\.closeTarget/iu, /\b(?:save|saveExisting)\b/iu, /chart.*mutation/iu, /pane.*mutation/iu, /\.focus\s*\(/u]) {
    assert.doesNotMatch(source, forbidden);
  }
  assert.equal((source.match(/client\.Page\.navigate\s*\(/gu) || []).length, 1);
  assert.equal((source.match(/browserClient\.Target\.createTarget\s*\(/gu) || []).length, 1);
  assert.match(source, /createBlankTarget[\s\S]*url: 'about:blank'/u);
  assert.equal(observerToolDefinitions.tv_observer_hydrate_chart_target_v2.classification, 'bootstrap_mutation');
});
