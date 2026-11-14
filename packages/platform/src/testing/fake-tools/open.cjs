#!/usr/bin/env node
// A stand-in for macOS `open`, for tests: it records its argv and opens nothing.
const fs = require('node:fs');

if (process.env.FAKE_TOOLS_LOG) fs.appendFileSync(process.env.FAKE_TOOLS_LOG, `${JSON.stringify({ tool: 'open', argv: process.argv.slice(2), at: new Date().toISOString() })}\n`);
