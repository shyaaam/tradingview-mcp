import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { setObserverSession } from '../../src/core/observer-session.js';
import { registerHealthTools } from '../../src/tools/health.js';

setObserverSession({
  managerBaseUrl: 'http://127.0.0.1:8080/api',
  profileId: 'profile-stdio-test',
  cdpUrl: 'http://127.0.0.1:8080/api/profiles/profile-stdio-test/cdp',
  chartTargetId: 'chart-stdio-test',
  chartTargetUrl: 'https://www.tradingview.com/chart/stdio-test/',
});

const server = new McpServer({ name: 'health-evidence-stdio-test', version: '1.0.0' });
registerHealthTools(server, {
  healthCheck: async () => ({
    success: true,
    cdp_connected: true,
    target_id: 'chart-stdio-test',
    target_url: 'https://www.tradingview.com/chart/stdio-test/',
    target_title: 'stdio fixture',
    chart_symbol: 'BINANCE:BTCUSDT',
    chart_resolution: '5',
    chart_type: 1,
    api_available: true,
    session_state: 'reclaimed',
    disconnect_popup_count: 1,
    exact_connect_count: 1,
    reclaim_attempted: true,
    reclaim_succeeded: true,
    reclaim_click_count: 1,
  }),
});

await server.connect(new StdioServerTransport());
