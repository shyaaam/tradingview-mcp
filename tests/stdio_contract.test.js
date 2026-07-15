import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { observerCapabilityManifest } from '../src/release/manifest.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

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
  assert.equal(contract.releaseCommitSource, 'environment');
  assert.equal(contract.releaseReady, true);
  assert.match(contract.manifestHash, /^[0-9a-f]{64}$/);

  await deadline(client.close(), observerCapabilityManifest.lifecycle.shutdownGraceMs, 'MCP close');
  assert.ok(stderrBytes <= observerCapabilityManifest.lifecycle.maxCapturedStderrBytes);
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
