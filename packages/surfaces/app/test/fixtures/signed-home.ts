// Disposable authority created only through the product's Host and local fake MCP server.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHost, hostClosed } from '@backbone-next/platform/composition';
import { enableConnector } from '@backbone-next/platform/testing/connectors';
import type { Receipt } from '@backbone-next/platform';
const value = <T>(r: Receipt<T>): T => { assert.equal(r.ok, true, r.ok ? '' : r.detail); return (r as { ok: true; value: T }).value; };
export async function seedSignedHome(home: string) {
  mkdirSync(join(home, 'connectors'), { recursive: true });
  writeFileSync(join(home, 'connectors', 'servers.json'), JSON.stringify({ mcpServers: { notes: {
    command: process.execPath, args: [resolve(import.meta.dirname, '../../../../platform/test/fake-mcp-server.ts')],
  } } }));
  const host = createHost({ home, harness: 'stub' });
  try {
    const serverId = 'home:notes';
    value(await host.call('connectors.refresh', { serverId }));
    value(await enableConnector(host, serverId));
    value(await enableConnector(host, serverId, 'draft_note'));
    value(await host.openConnectorDoor(serverId, host.connectorDoorSeal(serverId)!));
    const shown = host.connectorToolView(serverId, 'draft_note')!;
    value(await host.signConnectorTool(serverId, 'draft_note', shown.seal, shown.stamp, false));
    const view = await host.call('connectors.list', {});
    assert.ok(view.servers[0].tools.find(t => t.name === 'draft_note')?.standing);
    assert.equal((await host.call('core.signatureStatus', {})).state, 'verified');
    const stored = JSON.parse(readFileSync(join(home, 'connectors', 'mcp.json'), 'utf8'));
    return { ...view, signatureId: stored.servers[serverId].tools.draft_note.standing.id as string };
  } finally { host.close(); await hostClosed(home); }
}
