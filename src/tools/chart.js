import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/chart.js';
import { registerObserverTool } from '../release/observer-schema.js';

function errorResult(error) {
  const result = { success: false, error: error.message };
  if (error && typeof error === 'object' && error.name === 'ScopedSaveEffectError') {
    result.save_invoked = error.saveInvoked;
    result.effect_state = error.effectState;
    result.effect_phase = error.phase;
    result.save_callback_confirmed = error.saveCallbackConfirmed;
  }
  if (error && typeof error === 'object' && error.name === 'SaveCapabilityProbeError') {
    result.probe_evidence = error.probeEvidence;
  }
  return jsonResult(result, true);
}

export function registerChartTools(server) {
  registerObserverTool(server, 'chart_get_state', 'Get current chart state (symbol, timeframe, chart type, indicators)', async () => {
    try { return jsonResult(await core.getState()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  registerObserverTool(server, 'chart_save_existing_scoped', 'Save the exact existing chart/layout after strict target, authority, and parity checks', async (input) => {
    try { return jsonResult(await core.saveExistingChartScoped(input)); }
    catch (err) { return errorResult(err); }
  });

  registerObserverTool(server, 'chart_save_existing_capability_probe', 'Read-only probe of exact existing-chart save capability and layout identity; never invokes save', async (input) => {
    try { return jsonResult(await core.probeExistingChartSaveCapability(input)); }
    catch (err) { return errorResult(err); }
  });

  registerObserverTool(server, 'chart_set_symbol', 'Change the chart symbol', async ({ symbol }) => {
    try { return jsonResult(await core.setSymbol({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  registerObserverTool(server, 'chart_set_timeframe', 'Change the chart timeframe/resolution', async ({ timeframe }) => {
    try { return jsonResult(await core.setTimeframe({ timeframe })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_type', 'Change chart type', {
    chart_type: z.string().describe('Chart type: Bars(0), Candles(1), Line(2), Area(3), Renko(4), Kagi(5), PointAndFigure(6), LineBreak(7), HeikinAshi(8), HollowCandles(9) — pass name or number'),
  }, async ({ chart_type }) => {
    try { return jsonResult(await core.setType({ chart_type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_manage_indicator', 'Add or remove an indicator/study on the chart', {
    action: z.enum(['add', 'remove']).describe('Action: add or remove'),
    indicator: z.string().describe('Full indicator name: "Relative Strength Index", "MACD", "Volume", "Moving Average", "Bollinger Bands", "Moving Average Exponential". Short names like RSI/EMA do NOT work.'),
    entity_id: z.string().optional().describe('Entity ID to remove (from chart_get_state). Required for remove.'),
    inputs: z.string().optional().describe('JSON string of input overrides for the indicator (e.g., \'{"length": 20}\')'),
  }, async ({ action, indicator, entity_id, inputs }) => {
    try { return jsonResult(await core.manageIndicator({ action, indicator, entity_id, inputs })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_get_visible_range', 'Get the visible date range (unix timestamps) and bars range on the chart', {}, async () => {
    try { return jsonResult(await core.getVisibleRange()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_visible_range', 'Zoom the chart to a specific date range (unix timestamps)', {
    from: z.coerce.number().describe('Start of range (unix timestamp in seconds)'),
    to: z.coerce.number().describe('End of range (unix timestamp in seconds)'),
  }, async ({ from, to }) => {
    try { return jsonResult(await core.setVisibleRange({ from, to })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_scroll_to_date', 'Jump the chart view to center on a specific date', {
    date: z.string().describe('ISO date string (e.g., "2024-01-15") or unix timestamp as a string'),
  }, async ({ date }) => {
    try { return jsonResult(await core.scrollToDate({ date })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('symbol_info', 'Get detailed metadata about the current symbol (name, exchange, type, description)', {}, async () => {
    try { return jsonResult(await core.symbolInfo()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('symbol_search', 'Search for symbols by name or keyword', {
    query: z.string().describe('Search query (e.g., "AAPL", "crude oil", "ES")'),
    type: z.string().optional().describe('Filter by type (e.g., "stock", "futures", "crypto", "forex")'),
  }, async ({ query, type }) => {
    try { return jsonResult(await core.symbolSearch({ query, type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
