import { createHash } from 'node:crypto';

export const OBSERVER_CONTRACT_ID = 'tv-observer-v1';
export const OBSERVER_MANIFEST_SCHEMA_VERSION = 1;

const JSON_OBJECT_RESULT = Object.freeze({
  type: 'object',
  additionalProperties: true,
});

export const observerCapabilityManifest = deepFreeze({
  contractId: OBSERVER_CONTRACT_ID,
  schemaVersion: OBSERVER_MANIFEST_SCHEMA_VERSION,
  transport: {
    kind: 'stdio',
    protocol: 'mcp',
    shellAllowed: false,
  },
  lifecycle: {
    startupHandshakeTimeoutMs: 5_000,
    defaultCallTimeoutMs: 15_000,
    shutdownGraceMs: 2_000,
    maxCapturedStderrBytes: 65_536,
  },
  capabilities: [
    capability('tv_observer_contract', 'read_only', emptyObject(), {
      type: 'object',
      required: [
        'contractId',
        'schemaVersion',
        'serverName',
        'serverVersion',
        'nodeVersion',
        'manifestHash',
        'releaseCommit',
        'releaseCommitSource',
        'releaseReady',
        'manifest',
      ],
      properties: {
        contractId: { const: OBSERVER_CONTRACT_ID },
        schemaVersion: { const: OBSERVER_MANIFEST_SCHEMA_VERSION },
        serverName: { type: 'string' },
        serverVersion: { type: 'string' },
        nodeVersion: { type: 'string' },
        manifestHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        releaseCommit: { anyOf: [{ type: 'string', pattern: '^[0-9a-f]{40}$' }, { type: 'null' }] },
        releaseCommitSource: { enum: ['environment', 'git', 'unavailable'] },
        releaseReady: { type: 'boolean' },
        manifest: { type: 'object' },
      },
      additionalProperties: false,
    }),
    capability('tv_health_check', 'read_only', emptyObject(), JSON_OBJECT_RESULT),
    capability('tv_launch', 'bootstrap_mutation', {
      type: 'object',
      properties: {
        port: { type: 'number' },
        kill_existing: { type: 'boolean' },
      },
      additionalProperties: false,
    }, JSON_OBJECT_RESULT),
    capability('tab_list', 'read_only', emptyObject(), JSON_OBJECT_RESULT),
    capability('tab_new', 'bootstrap_mutation', emptyObject(), JSON_OBJECT_RESULT),
    capability('tab_switch', 'browser_focus_mutation', {
      type: 'object',
      required: ['index'],
      properties: { index: { type: 'number', minimum: 0 } },
      additionalProperties: false,
    }, JSON_OBJECT_RESULT),
    capability('pane_list', 'read_only', emptyObject(), JSON_OBJECT_RESULT),
    capability('chart_get_state', 'read_only', emptyObject(), JSON_OBJECT_RESULT),
    capability('chart_set_symbol', 'chart_mutation', {
      type: 'object',
      required: ['symbol'],
      properties: { symbol: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    }, JSON_OBJECT_RESULT),
    capability('chart_set_timeframe', 'chart_mutation', {
      type: 'object',
      required: ['timeframe'],
      properties: { timeframe: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    }, JSON_OBJECT_RESULT),
  ],
});

export const observerManifestCanonicalJson = canonicalJson(observerCapabilityManifest);
export const observerManifestHash = createHash('sha256')
  .update(observerManifestCanonicalJson, 'utf8')
  .digest('hex');

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

function capability(name, classification, inputSchema, resultSchema) {
  return { name, classification, inputSchema, resultSchema };
}

function emptyObject() {
  return { type: 'object', properties: {}, additionalProperties: false };
}

function normalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('manifest contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, normalize(entryValue)]),
    );
  }
  throw new TypeError(`manifest contains unsupported value type: ${typeof value}`);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
