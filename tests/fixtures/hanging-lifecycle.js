#!/usr/bin/env node

import { installStdioLifecycle } from '../../src/release/lifecycle.js';

installStdioLifecycle({
  shutdownGraceMs: 50,
  close: () => new Promise(() => {}),
  forceClose: () => {},
  hardExit: (code) => process.exit(code),
});

process.stdin.resume();
