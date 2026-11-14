// Fake client config and the platform's fake MCP server; no machine config, seal or lock fixtures.
import { toolWorld } from '@backbone-next/platform/testing/tools';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './journey';

export function connectorWorld() {
  const world = toolWorld({ seed: false });
  writeFileSync(world.files.claude, JSON.stringify({ mcpServers: { notes: {
    command: process.execPath, args: [join(repoRoot, 'packages/platform/test/fake-mcp-server.ts')], env: { NOTES_VALUE: 'first-account' },
  } } }));
  return world;
}
