import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  SERVER_NAME,
  SERVER_VERSION,
  buildObserverContract,
  resolveReleaseCommit,
} from '../src/release/identity.js';
import { installStdioLifecycle } from '../src/release/lifecycle.js';
import {
  observerCapabilityManifest,
  observerManifestCanonicalJson,
  observerManifestHash,
} from '../src/release/manifest.js';
import { registerReleaseTools } from '../src/tools/release.js';
import { registerHealthTools } from '../src/tools/health.js';
import { registerTabTools } from '../src/tools/tab.js';
import { registerPaneTools } from '../src/tools/pane.js';
import { registerChartTools } from '../src/tools/chart.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

test('package, runtime pin, server, and observer contract share one version authority', async () => {
  const pinnedNode = (await readFile(new URL('../docs/runtime/node-version.txt', import.meta.url), 'utf8')).trim();
  assert.equal(SERVER_NAME, 'tradingview-mcp');
  assert.equal(SERVER_VERSION, packageJson.version);
  assert.equal(packageJson.version, '2.0.0');
  assert.equal(packageJson.engines.node, pinnedNode);
  assert.equal(process.versions.node, pinnedNode);
  assert.equal(buildObserverContract({ env: { TRADINGVIEW_MCP_RELEASE_COMMIT: COMMIT } }).serverVersion, packageJson.version);
});

test('observer manifest is canonical, immutable, and uniquely classified', () => {
  assert.match(observerManifestHash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(observerManifestCanonicalJson).contractId, 'tv-observer-v1');
  assert.equal(Object.isFrozen(observerCapabilityManifest), true);

  const names = observerCapabilityManifest.capabilities.map((capability) => capability.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names, [
    'tv_observer_contract',
    'tv_health_check',
    'tv_launch',
    'tab_list',
    'tab_new',
    'tab_switch',
    'pane_list',
    'chart_get_state',
    'chart_set_symbol',
    'chart_set_timeframe',
  ]);

  for (const capability of observerCapabilityManifest.capabilities) {
    assert.equal(capability.inputSchema.type, 'object');
    assert.equal(capability.resultSchema.type, 'object');
    assert.match(capability.classification, /^(read_only|bootstrap_mutation|browser_focus_mutation|chart_mutation)$/);
  }
});

test('every observer capability is registered by the MCP tool groups', () => {
  const registered = new Set();
  const fakeServer = { tool: (name) => { registered.add(name); } };
  registerReleaseTools(fakeServer);
  registerHealthTools(fakeServer);
  registerTabTools(fakeServer);
  registerPaneTools(fakeServer);
  registerChartTools(fakeServer);

  for (const capability of observerCapabilityManifest.capabilities) {
    assert.equal(registered.has(capability.name), true, `missing MCP tool: ${capability.name}`);
  }
});

test('release commit is machine-readable and fails closed on invalid configuration', () => {
  assert.deepEqual(
    resolveReleaseCommit({ env: { TRADINGVIEW_MCP_RELEASE_COMMIT: COMMIT } }),
    { commit: COMMIT, source: 'environment' },
  );
  assert.throws(
    () => resolveReleaseCommit({ env: { TRADINGVIEW_MCP_RELEASE_COMMIT: 'not-a-commit' } }),
    /40-character commit/,
  );
  assert.deepEqual(
    resolveReleaseCommit({ env: {}, execFileSyncImpl: () => { throw new Error('no git'); } }),
    { commit: null, source: 'unavailable' },
  );
});

test('stdio lifecycle closes once on repeated shutdown requests', async () => {
  const processLike = new EventEmitter();
  processLike.stdin = new EventEmitter();
  processLike.exitCode = undefined;
  let closes = 0;
  const lifecycle = installStdioLifecycle({
    processLike,
    shutdownGraceMs: 100,
    close: async () => { closes += 1; },
  });

  const [first, second] = await Promise.all([
    lifecycle.shutdown('test'),
    lifecycle.shutdown('duplicate'),
  ]);
  assert.equal(closes, 1);
  assert.equal(first.clean, true);
  assert.deepEqual(second, first);
  assert.equal(processLike.exitCode, 0);
});

test('stdio lifecycle responds to stdin closure and removes signal listeners', async () => {
  const processLike = new EventEmitter();
  processLike.stdin = new EventEmitter();
  processLike.exitCode = undefined;
  let closes = 0;
  const lifecycle = installStdioLifecycle({
    processLike,
    shutdownGraceMs: 100,
    close: async () => { closes += 1; },
  });
  processLike.stdin.emit('end');
  await lifecycle.shutdown('duplicate-after-stdin');
  assert.equal(closes, 1);
  assert.equal(processLike.listenerCount('SIGTERM'), 0);
  assert.equal(processLike.stdin.listenerCount('end'), 0);
});

test('stdio lifecycle fails closed when cleanup exceeds the grace period', async () => {
  const processLike = new EventEmitter();
  processLike.stdin = new EventEmitter();
  processLike.exitCode = undefined;
  const lifecycle = installStdioLifecycle({
    processLike,
    shutdownGraceMs: 5,
    close: () => new Promise(() => {}),
  });
  const result = await lifecycle.shutdown('timeout-test');
  assert.equal(result.clean, false);
  assert.match(result.error, /shutdown exceeded/);
  assert.equal(processLike.exitCode, 1);
});
