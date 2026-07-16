import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
const RELEASE_METADATA_PATH = fileURLToPath(new URL('./release-metadata.json', import.meta.url));
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
    expectedCommit: release.expectedCommit,
    observedCommit: release.observedCommit,
    releaseCommit: release.observedCommit,
    releaseCommitSource: release.source,
    releaseCommitMatch: release.commitMatch,
    releaseDirty: release.dirty,
    releaseReady: release.observedCommit !== null && release.commitMatch && !release.dirty,
    manifest: observerCapabilityManifest,
  };
}

export function resolveReleaseCommit({
  env = process.env,
  cwd = PROJECT_ROOT,
  execFileSyncImpl = execFileSync,
  readFileSyncImpl = readFileSync,
  metadataPath = RELEASE_METADATA_PATH,
} = {}) {
  const configured = typeof env.TRADINGVIEW_MCP_RELEASE_COMMIT === 'string'
    ? env.TRADINGVIEW_MCP_RELEASE_COMMIT.trim()
    : '';
  if (configured && !COMMIT_PATTERN.test(configured)) {
    throw new Error('TRADINGVIEW_MCP_RELEASE_COMMIT must be a lowercase 40-character commit');
  }
  const expectedCommit = configured || null;

  const gitIdentity = readGitIdentity({ cwd, execFileSyncImpl });
  if (gitIdentity) {
    return releaseIdentity({
      expectedCommit,
      observedCommit: gitIdentity.commit,
      source: 'git',
      dirty: gitIdentity.dirty,
    });
  }

  const packagedCommit = readPackagedCommit({ readFileSyncImpl, metadataPath });
  if (packagedCommit) {
    return releaseIdentity({
      expectedCommit,
      observedCommit: packagedCommit,
      source: 'packaged',
      dirty: false,
    });
  }

  return releaseIdentity({
    expectedCommit,
    observedCommit: null,
    source: 'unavailable',
    dirty: false,
  });
}

function releaseIdentity({ expectedCommit, observedCommit, source, dirty }) {
  return {
    commit: observedCommit,
    source,
    expectedCommit,
    observedCommit,
    commitMatch: expectedCommit === null ? observedCommit !== null : expectedCommit === observedCommit,
    dirty,
  };
}

function readGitIdentity({ cwd, execFileSyncImpl }) {
  let commit;
  try {
    commit = String(execFileSyncImpl('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
      maxBuffer: 1_024,
    })).trim();
  } catch {
    return null;
  }
  if (!COMMIT_PATTERN.test(commit)) return null;

  let dirty = false;
  try {
    execFileSyncImpl('git', ['diff', '--quiet', 'HEAD', '--'], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 1_000,
    });
  } catch {
    dirty = true;
  }
  return { commit, dirty };
}

function readPackagedCommit({ readFileSyncImpl, metadataPath }) {
  try {
    const raw = readFileSyncImpl(metadataPath, 'utf8');
    const parsed = JSON.parse(raw);
    return COMMIT_PATTERN.test(parsed?.commit) ? parsed.commit : null;
  } catch {
    return null;
  }
}
