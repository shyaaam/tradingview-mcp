import { createHash } from 'node:crypto';
import { toJSONSchema, z } from 'zod';

import { OBSERVER_CONTRACT_ID, OBSERVER_MANIFEST_SCHEMA_VERSION } from './constants.js';
import { observerToolDefinitions } from './observer-schema.js';

export { OBSERVER_CONTRACT_ID, OBSERVER_MANIFEST_SCHEMA_VERSION } from './constants.js';

const CAPABILITY_NAMES = [
  'tv_observer_contract',
  'tv_health_check',
  'tv_observer_prepare',
  'tab_list',
  'tab_new',
  'tab_switch',
  'pane_list',
  'chart_get_state',
  'chart_set_symbol',
  'chart_set_timeframe',
];

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
  capabilities: CAPABILITY_NAMES.map((name) => {
    const definition = observerToolDefinitions[name];
    return {
      name,
      classification: definition.classification,
      inputSchema: jsonSchema(definition.inputSchema, { stripRuntimeDefaults: true }),
      resultSchema: jsonSchema(definition.outputSchema),
    };
  }),
});

export const observerManifestCanonicalJson = canonicalJson(observerCapabilityManifest);
export const observerManifestHash = createHash('sha256')
  .update(observerManifestCanonicalJson, 'utf8')
  .digest('hex');

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

function jsonSchema(shape, { stripRuntimeDefaults: strip = false } = {}) {
  if (Object.keys(shape).length === 0) {
    return {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {},
    };
  }
  const schema = toJSONSchema(z.object(shape), { target: 'draft-07' });
  return strip ? removeRuntimeDefaults(schema) : schema;
}

function removeRuntimeDefaults(value) {
  if (Array.isArray(value)) return value.map(removeRuntimeDefaults);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'additionalProperties')
      .map(([key, entry]) => [key, removeRuntimeDefaults(entry)]),
  );
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
