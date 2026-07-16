#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { installStdioLifecycle } from '../../src/release/lifecycle.js';

const server = new McpServer({ name: 'inflight-test', version: '1.0.0' });
server.tool('slow', 'Hold request open for disconnect test', {}, async () => new Promise(() => {}));

const transport = new StdioServerTransport();
installStdioLifecycle({
  shutdownGraceMs: 50,
  close: () => new Promise(() => {}),
  forceClose: () => transport.close?.(),
  hardExit: (code) => process.exit(code),
});
await server.connect(transport);
