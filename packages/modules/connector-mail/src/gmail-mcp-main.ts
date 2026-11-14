#!/usr/bin/env node
// backbone-fake-gmail-mcp: the fake Gmail MCP server over stdio (src/gmail-mcp.ts). No key, no
// account, no network; it never sends.
//   node src/gmail-mcp-main.ts [--state <file>] [--fault <kind[@tool][#nth]>]...
// Env, used when the flag is absent: BACKBONE_FAKE_GMAIL_STATE, BACKBONE_FAKE_GMAIL_FAULTS (comma-separated).
// stdout carries MCP messages only; everything else goes to stderr.
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createFakeGmail, parseFaults } from './gmail-mcp.ts';

const { values } = parseArgs({
  options: {
    state: { type: 'string', default: process.env.BACKBONE_FAKE_GMAIL_STATE },
    fault: { type: 'string', multiple: true },
  },
});

let faults;
try {
  faults = parseFaults(values.fault?.length ? values.fault.join(',') : process.env.BACKBONE_FAKE_GMAIL_FAULTS);
} catch (e) {
  process.stderr.write(`backbone-fake-gmail-mcp: ${(e as Error).message}\n`);
  process.exit(2);
}

const factory = createFakeGmail({ stateFile: values.state, faults });
const handle = serveStdio(factory, { onerror: (e) => process.stderr.write(`backbone-fake-gmail-mcp: ${e.message}\n`) });
const close = async () => {
  await handle.close().catch(() => {});
  process.exit(0);
};
process.stdin.on('end', close);
process.on('SIGINT', close);
process.on('SIGTERM', close);
