import { z } from 'zod';

import { OBSERVER_CONTRACT_ID, OBSERVER_MANIFEST_SCHEMA_VERSION } from './constants.js';
import { requireObserverSession } from '../connection.js';

const emptyInput = Object.freeze({});
const jsonObject = z.record(z.string(), z.unknown());

const tabShape = {
  index: z.number(),
  id: z.string(),
  ws_url: z.string().nullable(),
  title: z.string(),
  url: z.string(),
  chart_id: z.string().nullable(),
};

const tabListOutput = {
  success: z.literal(true),
  tab_count: z.number().int().nonnegative(),
  tabs: z.array(z.object(tabShape)),
};

const observerIdentityOutput = {
  success: z.literal(true),
  profile_id: z.string().min(1),
  chart_target_id: z.string().min(1),
  chart_id: z.string().min(1),
  layout_id: z.string().min(1),
  account_subject_sha256: z.string().regex(/^[0-9a-f]{64}$/),
};

const observerCaptureCandleInput = {
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  source_candle_time: z.string().datetime(),
};

const observerCaptureCandleOutput = {
  success: z.literal(true),
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  source_candle_time: z.string().datetime(),
  captured_at: z.string().datetime(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite(),
  adapter_version: z.string().min(1),
};

const manifestCapabilityShape = {
  name: z.string(),
  classification: z.enum(['read_only', 'bootstrap_mutation', 'browser_focus_mutation', 'chart_mutation']),
  inputSchema: jsonObject,
  resultSchema: jsonObject,
};

const manifestShape = {
  contractId: z.literal(OBSERVER_CONTRACT_ID),
  schemaVersion: z.literal(OBSERVER_MANIFEST_SCHEMA_VERSION),
  transport: z.object({
    kind: z.literal('stdio'),
    protocol: z.literal('mcp'),
    shellAllowed: z.literal(false),
  }),
  lifecycle: z.object({
    startupHandshakeTimeoutMs: z.number().int().positive(),
    defaultCallTimeoutMs: z.number().int().positive(),
    shutdownGraceMs: z.number().int().positive(),
    maxCapturedStderrBytes: z.number().int().positive(),
  }),
  capabilities: z.array(z.object(manifestCapabilityShape)),
};

export const observerToolDefinitions = Object.freeze({
  tv_observer_contract: {
    classification: 'read_only',
    inputSchema: emptyInput,
    outputSchema: {
      contractId: z.literal(OBSERVER_CONTRACT_ID),
      schemaVersion: z.literal(OBSERVER_MANIFEST_SCHEMA_VERSION),
      serverName: z.string(),
      serverVersion: z.string(),
      nodeVersion: z.string(),
      manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
      expectedCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
      observedCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
      releaseCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
      releaseCommitSource: z.enum(['git', 'packaged', 'unavailable']),
      releaseCommitMatch: z.boolean(),
      releaseDirty: z.boolean(),
      releaseReady: z.boolean(),
      manifest: z.object(manifestShape),
    },
  },
  tv_health_check: {
    classification: 'read_only',
    inputSchema: emptyInput,
    outputSchema: {
      success: z.literal(true),
      cdp_connected: z.literal(true),
      target_id: z.string(),
      target_url: z.string(),
      target_title: z.string(),
      chart_symbol: z.string(),
      chart_resolution: z.string(),
      chart_type: z.number().nullable(),
      api_available: z.boolean(),
    },
  },
  tv_observer_prepare: {
    classification: 'bootstrap_mutation',
    inputSchema: {
      profile_id: z.string().min(1).describe('Exact CloakBrowser Manager profile ID; never auto-selected.'),
      restart: z.boolean().optional().describe('Stop and relaunch exact profile before preparation (default false).'),
    },
    outputSchema: {
      success: z.literal(true),
      manager_base_url: z.string(),
      profile_id: z.string(),
      restart_requested: z.boolean(),
      status: z.string(),
      cdp_ready: z.boolean(),
      cdp_url: z.string().nullable(),
      browser: z.string().nullable(),
      user_agent: z.string().nullable(),
      chart_target_id: z.string().nullable(),
      chart_target_url: z.string().nullable(),
    },
  },
  tv_observer_identity: {
    classification: 'read_only',
    inputSchema: emptyInput,
    outputSchema: observerIdentityOutput,
    rejectUnexpectedInput: true,
  },
  tv_observer_capture_candle: {
    classification: 'read_only',
    inputSchema: observerCaptureCandleInput,
    outputSchema: observerCaptureCandleOutput,
  },
  tab_list: {
    classification: 'read_only',
    inputSchema: emptyInput,
    outputSchema: tabListOutput,
  },
  tab_new: {
    classification: 'bootstrap_mutation',
    inputSchema: emptyInput,
    outputSchema: {
      ...tabListOutput,
      action: z.literal('new_tab_opened'),
    },
  },
  tab_switch: {
    classification: 'browser_focus_mutation',
    inputSchema: { index: z.coerce.number().int().nonnegative().describe('Tab index (0-based, from tab_list).') },
    outputSchema: {
      success: z.literal(true),
      action: z.literal('switched'),
      index: z.number().int().nonnegative(),
      tab_id: z.string(),
      chart_id: z.string().nullable(),
    },
  },
  pane_list: {
    classification: 'read_only',
    inputSchema: emptyInput,
    outputSchema: {
      success: z.literal(true),
      layout: z.union([z.string(), z.number()]),
      layout_name: z.string(),
      chart_count: z.number().int().nonnegative(),
      active_index: z.number().int().nonnegative().nullable(),
      panes: z.array(z.object({
        index: z.number().int().nonnegative(),
        symbol: z.string(),
        resolution: z.union([z.string(), z.number(), z.null()]),
        error: z.string().optional(),
      })),
    },
  },
  chart_get_state: {
    classification: 'read_only',
    inputSchema: emptyInput,
    outputSchema: {
      success: z.literal(true),
      symbol: z.string(),
      resolution: z.string(),
      chartType: z.number(),
      studies: z.array(z.object({ id: z.string(), name: z.string() })),
    },
  },
  chart_set_symbol: {
    classification: 'chart_mutation',
    inputSchema: { symbol: z.string().min(1).describe('Symbol to set (e.g., BTCUSD, AAPL, ES1!, NYMEX:CL1!).') },
    outputSchema: {
      success: z.literal(true),
      symbol: z.string(),
      chart_ready: z.boolean(),
    },
  },
  chart_set_timeframe: {
    classification: 'chart_mutation',
    inputSchema: { timeframe: z.string().min(1).describe('Timeframe (e.g., 1, 5, 15, 60, D, W, M).') },
    outputSchema: {
      success: z.literal(true),
      timeframe: z.string(),
      chart_ready: z.boolean(),
    },
  },
});

export function registerObserverTool(server, name, description, handler) {
  const definition = observerToolDefinitions[name];
  if (!definition) throw new Error(`Unknown observer capability: ${name}`);
  const guardedHandler = async (args, extra) => {
    if (definition.rejectUnexpectedInput && args && Object.keys(args).length > 0) {
      throw new Error(`${name} accepts no input arguments.`);
    }
    if (name !== 'tv_observer_contract' && name !== 'tv_observer_prepare') {
      requireObserverSession();
    }
    return handler(args, extra);
  };
  if (typeof server.registerTool !== 'function') {
    return server.tool(name, description, definition.inputSchema, guardedHandler);
  }
  return server.registerTool(name, {
    description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
  }, guardedHandler);
}
