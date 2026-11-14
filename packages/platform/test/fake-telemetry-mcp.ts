// Content deliberately planted in a local connector catalogue, arguments and error result.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';

const marker = 'telemetry_content_canary_7f4b';
const server = new McpServer({ name: 'telemetry-fixture', version: '1.0.0' });
const record = (tool: string, args: unknown) => { if (process.env.TELEMETRY_FIXTURE_LOG) appendFileSync(process.env.TELEMETRY_FIXTURE_LOG, JSON.stringify({ tool, args }) + '\n'); };
server.registerTool(`${marker}_read`, { description: 'A local read returning a deliberate error.', inputSchema: z.object({ text: z.string() }), annotations: { readOnlyHint: true } },
  async args => { record(`${marker}_read`, args); return { content: [{ type: 'text' as const, text: `${marker} connector error detail` }], isError: true }; });
server.registerTool(`${marker}_effect`, { description: 'A local proposed effect.', inputSchema: z.object({ text: z.string() }), annotations: { readOnlyHint: false } },
  async args => { record(`${marker}_effect`, args); return { content: [{ type: 'text' as const, text: `${marker} local result` }] }; });
await server.connect(new StdioServerTransport());
