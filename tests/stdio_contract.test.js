import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { observerCapabilityManifest } from '../src/release/manifest.js';
import { closeClientStrict } from '../src/connection.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COMMIT = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })).trim();

function deadline(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

test('stdio client completes initialize, contract call, and bounded shutdown', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/server.js'],
    cwd: ROOT,
    env: {
      ...process.env,
      TRADINGVIEW_MCP_RELEASE_COMMIT: COMMIT,
    },
    stderr: 'pipe',
  });
  let stderrBytes = 0;
  transport.stderr?.on('data', (chunk) => {
    stderrBytes += Buffer.byteLength(chunk);
  });

  const client = new Client({ name: 'tv-observer-contract-test', version: '1.0.0' });
  await deadline(client.connect(transport), observerCapabilityManifest.lifecycle.startupHandshakeTimeoutMs, 'MCP initialize');

  const tools = await deadline(client.listTools(), observerCapabilityManifest.lifecycle.defaultCallTimeoutMs, 'tools/list');
  assert.equal(tools.tools.some((tool) => tool.name === 'tv_observer_contract'), true);
  for (const capability of observerCapabilityManifest.capabilities) {
    const tool = tools.tools.find((candidate) => candidate.name === capability.name);
    assert.ok(tool, `live MCP registration missing ${capability.name}`);
    assert.deepEqual(tool.inputSchema, capability.inputSchema, `${capability.name} input schema drift`);
    assert.deepEqual(tool.outputSchema, capability.resultSchema, `${capability.name} output schema drift`);
  }

  const response = await deadline(
    client.callTool({ name: 'tv_observer_contract', arguments: {} }),
    observerCapabilityManifest.lifecycle.defaultCallTimeoutMs,
    'tv_observer_contract',
  );
  const text = response.content.find((entry) => entry.type === 'text')?.text;
  assert.equal(typeof text, 'string');
  const contract = JSON.parse(text);
  assert.equal(contract.contractId, 'tv-observer-v1');
  assert.equal(contract.releaseCommit, COMMIT);
  assert.equal(contract.expectedCommit, COMMIT);
  assert.equal(contract.observedCommit, COMMIT);
  assert.equal(contract.releaseCommitSource, 'git');
  assert.equal(contract.releaseCommitMatch, true);
  assert.equal(contract.releaseReady, !contract.releaseDirty);
  assert.match(contract.manifestHash, /^[0-9a-f]{64}$/);

  await deadline(client.close(), observerCapabilityManifest.lifecycle.shutdownGraceMs, 'MCP close');
  await transport.close();
  transport.stderr?.destroy();
  assert.ok(stderrBytes <= observerCapabilityManifest.lifecycle.maxCapturedStderrBytes);
});

test('stdio health response preserves complete session reclaim evidence', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['tests/fixtures/health-evidence-stdio.js'],
    cwd: ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'health-evidence-stdio-test', version: '1.0.0' });
  await deadline(client.connect(transport), 500, 'health fixture initialize');

  const response = await deadline(
    client.callTool({ name: 'tv_health_check', arguments: {} }),
    500,
    'health fixture call',
  );
  const text = response.content.find((entry) => entry.type === 'text')?.text;
  assert.equal(typeof text, 'string');
  const health = JSON.parse(text);
  assert.deepEqual({
    session_state: health.session_state,
    disconnect_popup_count: health.disconnect_popup_count,
    exact_connect_count: health.exact_connect_count,
    reclaim_attempted: health.reclaim_attempted,
    reclaim_succeeded: health.reclaim_succeeded,
    reclaim_click_count: health.reclaim_click_count,
  }, {
    session_state: 'reclaimed',
    disconnect_popup_count: 1,
    exact_connect_count: 1,
    reclaim_attempted: true,
    reclaim_succeeded: true,
    reclaim_click_count: 1,
  });
  assert.deepEqual(response.structuredContent, health);

  await client.close();
  await transport.close();
});

test('closing stdio terminates the server process without an orphan', async () => {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      TRADINGVIEW_MCP_RELEASE_COMMIT: COMMIT,
    },
    shell: false,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderrBytes = 0;
  child.stderr.on('data', (chunk) => {
    stderrBytes += Buffer.byteLength(chunk);
  });

  try {
    await deadline(once(child.stderr, 'data'), observerCapabilityManifest.lifecycle.startupHandshakeTimeoutMs, 'server startup event');
    child.stdin.end();
    const [code, signal] = await deadline(
      once(child, 'close'),
      observerCapabilityManifest.lifecycle.shutdownGraceMs,
      'server process close',
    );
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.ok(stderrBytes <= observerCapabilityManifest.lifecycle.maxCapturedStderrBytes);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('hung shutdown force-exits child after graceful deadline', async () => {
  const child = spawn(process.execPath, ['tests/fixtures/hanging-lifecycle.js'], {
    cwd: ROOT,
    shell: false,
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  try {
    child.stdin.end();
    const [code, signal] = await deadline(once(child, 'close'), 500, 'forced shutdown');
    assert.equal(code, 1);
    assert.equal(signal, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('client disconnect during in-flight call still force-exits hung server cleanup', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['tests/fixtures/inflight-lifecycle.js'],
    cwd: ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'inflight-shutdown-test', version: '1.0.0' });
  await deadline(client.connect(transport), 500, 'in-flight fixture connect');
  const pid = transport.pid;
  assert.ok(pid, 'in-flight fixture exposes child pid');
  const pending = client.callTool({ name: 'slow', arguments: {} }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  await client.close();
  void pending;

  await deadline(waitForProcessExit(pid), 500, 'in-flight forced shutdown');
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('strict observer client cleanup propagates close failure and closes once', async () => {
  let closeCount = 0;
  await closeClientStrict({ close: async () => { closeCount += 1; } });
  assert.equal(closeCount, 1);
  await assert.rejects(
    closeClientStrict({ close: async () => { throw new Error('CDP close failed'); } }),
    /CDP close failed/,
  );
});

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`process ${pid} still alive`);
}

test.after(() => {
  // Node's test worker keeps its IPC poller alive after the SDK's stdio
  // transport closes. Preserve the runner's failure status while releasing it.
  const exitCode = process.exitCode ?? 0;
  setImmediate(() => process.exit(exitCode));
});
