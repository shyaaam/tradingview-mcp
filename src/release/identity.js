import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  OBSERVER_CONTRACT_ID,
  OBSERVER_MANIFEST_SCHEMA_VERSION,
  observerCapabilityManifest,
  observerManifestHash,
} from './manifest.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');
const PROJECT_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export const SERVER_NAME = 'tradingview-mcp';
export const SERVER_VERSION = packageJson.version;

export function buildObserverContract(options = {}) {
  const release = resolveReleaseCommit(options);
  return {
    contractId: OBSERVER_CONTRACT_ID,
    schemaVersion: OBSERVER_MANIFEST_SCHEMA_VERSION,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    nodeVersion: process.versions.node,
    manifestHash: observerManifestHash,
    releaseCommit: release.commit,
    releaseCommitSource: release.source,
    releaseReady: release.commit !== null,
    manifest: observerCapabilityManifest,
  };
}

export function resolveReleaseCommit({
  env = process.env,
  cwd = PROJECT_ROOT,
  execFileSyncImpl = execFileSync,
} = {}) {
  const configured = env.TRADINGVIEW_MCP_RELEASE_COMMIT?.trim();
  if (configured !== undefined && configured !== '') {
    if (!COMMIT_PATTERN.test(configured)) {
      throw new Error('TRADINGVIEW_MCP_RELEASE_COMMIT must be a lowercase 40-character commit');
    }
    return { commit: configured, source: 'environment' };
  }

  try {
    const discovered = String(execFileSyncImpl('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
      maxBuffer: 1_024,
    })).trim();
    if (COMMIT_PATTERN.test(discovered)) return { commit: discovered, source: 'git' };
  } catch {
    // Packaged installs may not contain .git metadata. The observer must then supply the commit.
  }
  return { commit: null, source: 'unavailable' };
}
