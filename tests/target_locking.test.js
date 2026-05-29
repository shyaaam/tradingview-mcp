/**
 * Unit/static tests for Chrome CDP target-locking support.
 * These tests do not require a live TradingView/CDP session.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCdpConfig } from '../src/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function withEnv(values, fn) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

describe('CDP config', () => {
  it('defaults to localhost:9222', () => {
    withEnv({ CDP_HOST: undefined, CDP_PORT: undefined }, () => {
      assert.deepEqual(getCdpConfig(), { host: 'localhost', port: 9222 });
    });
  });

  it('uses CDP_HOST and CDP_PORT from environment', () => {
    withEnv({ CDP_HOST: '127.0.0.1', CDP_PORT: '9333' }, () => {
      assert.deepEqual(getCdpConfig(), { host: '127.0.0.1', port: 9333 });
    });
  });

  it('rejects invalid CDP_PORT values', () => {
    withEnv({ CDP_PORT: 'not-a-port' }, () => {
      assert.throws(() => getCdpConfig(), /CDP_PORT must be a valid TCP port/);
    });
  });
});

describe('target_id read-tool wiring', () => {
  it('connection layer maintains target-scoped clients', () => {
    const source = read('src/connection.js');
    assert.match(source, /clientsByTargetId = new Map\(\)/);
    assert.match(source, /target_id/);
    assert.match(source, /targetId/);
    assert.match(source, /setDefaultTargetId/);
    assert.match(source, /activateTarget/);
  });

  it('tab core uses shared CDP config helpers instead of hardcoded host and port', () => {
    const source = read('src/core/tab.js');
    assert.match(source, /listCdpTargets/);
    assert.match(source, /activateTarget/);
    assert.doesNotMatch(source, /const CDP_HOST = 'localhost'/);
    assert.doesNotMatch(source, /const CDP_PORT = 9222/);
  });

  it('first read-only MCP tools expose target_id', () => {
    const files = [
      'src/tools/chart.js',
      'src/tools/data.js',
      'src/tools/capture.js',
      'src/tools/replay.js',
      'src/tools/tab.js',
    ];
    for (const file of files) {
      assert.match(read(file), /target_id/, `${file} should mention target_id`);
    }
  });

  it('target-aware core reads pass target_id into CDP evaluation/client calls', () => {
    assert.match(read('src/core/chart.js'), /evaluate\([\s\S]*\{ target_id \}\)/);
    assert.match(read('src/core/data.js'), /evaluate\([\s\S]*\{ target_id \}\)/);
    assert.match(read('src/core/capture.js'), /getClient\(\{ target_id \}\)/);
    assert.match(read('src/core/replay.js'), /getReplayApi\(\{ target_id \}\)/);
  });
});
