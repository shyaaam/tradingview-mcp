import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { z } from 'zod';

import {
  chartRuntimeTargetLifecycleTrace,
  RUNTIME_STATE_EXPRESSION,
  selectChromeErrorCode,
} from '../src/core/chart-runtime-target-lifecycle.js';
import { observerToolDefinitions } from '../src/release/observer-schema.js';

const INPUT = {
  profile_id: 'profile-disposable',
  target_id: 'target-original',
  target_url: 'https://www.tradingview.com/chart/SJ0J0zgb/',
};

function target(id = INPUT.target_id, url = INPUT.target_url) {
  return { id, type: 'page', url, title: id };
}

function lifecycleDeps({ stateAtSample = () => ({ manager: [target()], browser: [target()], runtimeUrl: INPUT.target_url }) } = {}) {
  let clock = 0;
  let sample = 0;
  let current = stateAtSample(0);
  const fetch = async (url) => {
    if (url.endsWith('/json/version')) return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://browser' }) };
    if (!url.endsWith('/json/list')) throw new Error(`unexpected URL: ${url}`);
    current = stateAtSample(sample);
    sample += 1;
    return { ok: true, json: async () => current.manager };
  };
  const browser = {
    Target: {
      getTargets: async () => ({ targetInfos: current.browser }),
      getTargetInfo: async ({ targetId }) => {
        const found = current.browser.find((entry) => entry.id === targetId);
        if (!found) throw new Error('target not found');
        return { targetInfo: { ...found, attached: true } };
      },
    },
    Page: {
      getNavigationHistory: async () => current.navigationHistory || {
        currentIndex: 0,
        entries: [{ url: current.runtimeUrl, title: 'current', transitionType: 'typed' }],
      },
    },
    close: async () => {},
  };
  return {
    withExactRawTarget: async (_input, operation) => operation({
      cdpUrl: 'http://127.0.0.1:8080/api/profiles/profile-disposable/cdp',
      client: browser,
      evaluate: async () => current.runtimeSnapshot || ({ current_url: current.runtimeUrl, document_ready_state: 'complete' }),
    }),
    connectBrowser: async () => browser,
    fetch,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
}

test('trace records Manager, browser Target APIs, and exact runtime without adoption', async () => {
  const result = await chartRuntimeTargetLifecycleTrace({ ...INPUT, duration_ms: 35_000, poll_interval_ms: 500 }, lifecycleDeps());
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.trace_classification, 'STABLE_EXACT_TARGET');
  assert.equal(result.samples.length, 71);
  assert.equal(result.samples[0].manager_view.exact_target_present, true);
  assert.equal(result.samples[0].browser_view.target_info.success, true);
  assert.equal(result.samples[0].runtime_view.current_url, INPUT.target_url);
  assert.equal(result.auto_adoption_performed, false);
  assert.equal(result.mutations_performed, false);
});

test('same target becoming about:blank is distinguished from replacement', async () => {
  const result = await chartRuntimeTargetLifecycleTrace({ ...INPUT, duration_ms: 35_000, poll_interval_ms: 500 }, lifecycleDeps({
    stateAtSample: (sample) => sample === 0
      ? { manager: [target()], browser: [target()], runtimeUrl: INPUT.target_url }
      : { manager: [target(INPUT.target_id, 'about:blank')], browser: [target(INPUT.target_id, 'about:blank')], runtimeUrl: 'about:blank' },
  }));
  assert.equal(result.trace_classification, 'SAME_TARGET_BECAME_BLANK');
  assert.equal(result.samples.some((sample) => sample.classification === 'SAME_TARGET_BECAME_BLANK'), true);
});

test('exact target metadata with Chrome network error gets separate navigation disposition', async () => {
  const result = await chartRuntimeTargetLifecycleTrace({ ...INPUT, duration_ms: 35_000, poll_interval_ms: 500 }, lifecycleDeps({
    stateAtSample: () => ({
      manager: [target()],
      browser: [target()],
      runtimeUrl: 'chrome-error://chromewebdata/',
      runtimeSnapshot: {
        current_url: 'chrome-error://chromewebdata/',
        document_ready_state: 'complete',
        document_title: 'This site can\'t be reached',
        runtime_scheme: 'chrome-error',
        chrome_error_page: true,
        chrome_error_code: 'ERR_PROXY_CONNECTION_FAILED',
        chrome_error_code_source: 'structured',
        error_heading_summary: 'This site can\'t be reached',
        navigator_online: true,
        navigation_timing: { available: true, type: 'navigate', duration_ms: 12, response_end_ms: 8, dom_content_loaded_ms: 10, load_event_end_ms: 12, redirect_count: 0 },
      },
    }),
  }));
  assert.equal(result.trace_classification, 'RUNTIME_URL_MISMATCH');
  assert.equal(result.samples[0].runtime_view.navigation_disposition, 'CHROME_NETWORK_ERROR');
  assert.equal(result.samples[0].runtime_view.chrome_error_code, 'ERR_PROXY_CONNECTION_FAILED');
  assert.equal(result.samples[0].runtime_view.chrome_error_code_source, 'structured');
});

test('new exact target is reported as replacement and never adopted', async () => {
  const result = await chartRuntimeTargetLifecycleTrace({ ...INPUT, duration_ms: 35_000, poll_interval_ms: 500 }, lifecycleDeps({
    stateAtSample: (sample) => sample === 0
      ? { manager: [target()], browser: [target()], runtimeUrl: INPUT.target_url }
      : { manager: [target('target-replacement')], browser: [target('target-replacement')], runtimeUrl: INPUT.target_url },
  }));
  assert.equal(result.trace_classification, 'TARGET_REPLACED');
  assert.equal(result.auto_adoption_performed, false);
});

test('Manager and browser target views are recorded independently', async () => {
  const result = await chartRuntimeTargetLifecycleTrace({ ...INPUT, duration_ms: 35_000, poll_interval_ms: 500 }, lifecycleDeps({
    stateAtSample: () => ({ manager: [target()], browser: [target(INPUT.target_id, 'about:blank')], runtimeUrl: INPUT.target_url }),
  }));
  assert.equal(result.trace_classification, 'MANAGER_BROWSER_DISAGREEMENT');
  assert.deepEqual(result.samples[0].manager_view.exact_target_ids, [INPUT.target_id]);
  assert.deepEqual(result.samples[0].browser_view.exact_target_ids, []);
});

test('Chrome error code extraction prefers structured data, then selector, then body regex', () => {
  assert.deepEqual(selectChromeErrorCode({
    structuredCode: 'ERR_PROXY_CONNECTION_FAILED',
    selectorCode: 'ERR_NAME_NOT_RESOLVED',
    bodyText: 'ERR_CONNECTION_RESET',
  }), { code: 'ERR_PROXY_CONNECTION_FAILED', source: 'structured' });
  assert.deepEqual(selectChromeErrorCode({
    selectorCode: 'Error code: ERR_NAME_NOT_RESOLVED',
    bodyText: 'ERR_CONNECTION_RESET',
  }), { code: 'ERR_NAME_NOT_RESOLVED', source: 'selector' });
  assert.deepEqual(selectChromeErrorCode({
    bodyText: 'Details: DNS_PROBE_FINISHED_NXDOMAIN. private=do-not-return',
  }), { code: 'DNS_PROBE_FINISHED_NXDOMAIN', source: 'body_regex' });
});

test('navigation provenance is sanitized and about:blank stays distinct', async () => {
  const result = await chartRuntimeTargetLifecycleTrace({ ...INPUT, duration_ms: 35_000, poll_interval_ms: 500 }, lifecycleDeps({
    stateAtSample: () => ({
      manager: [target()],
      browser: [target()],
      runtimeUrl: 'about:blank',
      navigationHistory: {
        currentIndex: 1,
        entries: [
          { url: 'https://unrelated.example/private-token', title: 'unrelated' },
          { url: 'about:blank', title: 'blank', transitionType: 'auto_toplevel' },
        ],
      },
    }),
  }));
  const runtime = result.samples[0].runtime_view;
  assert.equal(runtime.navigation_disposition, 'DOCUMENT_ABOUT_BLANK');
  assert.equal(runtime.navigation_history.available, true);
  assert.equal(runtime.navigation_history.entry_count, 2);
  assert.equal(runtime.navigation_history.current_index, 1);
  assert.equal(runtime.navigation_history.current_entry_url_matches_expected, false);
  assert.equal(runtime.navigation_history.current_entry_scheme, 'about');
  assert.equal(runtime.navigation_history.current_entry_transition_type, 'auto_toplevel');
  assert.doesNotMatch(JSON.stringify(runtime), /unrelated|private-token/iu);
});

test('Page.getNavigationHistory unavailable remains read-only evidence', async () => {
  const deps = lifecycleDeps();
  deps.withExactRawTarget = async (_input, operation) => operation({
    cdpUrl: 'http://127.0.0.1:8080/api/profiles/profile-disposable/cdp',
    client: { Page: {} },
    evaluate: async () => ({ current_url: INPUT.target_url, document_ready_state: 'complete' }),
  });
  const result = await chartRuntimeTargetLifecycleTrace({ ...INPUT, duration_ms: 35_000, poll_interval_ms: 500 }, deps);
  assert.equal(result.trace_classification, 'STABLE_EXACT_TARGET');
  assert.equal(result.samples[0].runtime_view.navigation_history.available, false);
  assert.match(result.samples[0].runtime_view.navigation_history.error, /unavailable/iu);
});

test('trace contract is read-only and source contains no recovery or mutation path', async () => {
  const source = await readFile(new URL('../src/core/chart-runtime-target-lifecycle.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Function(`return ${RUNTIME_STATE_EXPRESSION}`));
  for (const forbidden of [/getBoundClient/iu, /recoverDisconnectedSession/iu, /\.click\s*\(/u, /Page\.navigate/iu, /\.reload\s*\(/u, /Target\.createTarget/iu, /Target\.closeTarget/iu, /saveExisting/iu, /\.focus\s*\(/u, /setSymbol/iu, /setResolution/iu, /createStudy/iu, /removeEntity/iu, /align/iu]) {
    assert.doesNotMatch(source, forbidden);
  }
  assert.equal(observerToolDefinitions.chart_runtime_target_lifecycle_trace_v1.classification, 'read_only');
  const result = await chartRuntimeTargetLifecycleTrace({ ...INPUT, duration_ms: 35_000, poll_interval_ms: 500 }, lifecycleDeps());
  assert.doesNotThrow(() => z.object(observerToolDefinitions.chart_runtime_target_lifecycle_trace_v1.outputSchema).parse(result));
});
