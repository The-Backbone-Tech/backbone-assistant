import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { CoreLink } from '../src/composition/core.ts';
import { ConnectorService, type ConnectorCore } from '../src/connectors/service.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, freshHome, value } from './helpers.ts';

export async function pauseFixture(t: TestContext) {
  const home = freshHome(), person = freshDir('connector-pause-'), log = join(person, 'calls.jsonl');
  const config = { command: process.execPath, args: [join(import.meta.dirname, 'fake-mcp-server.ts')], env: { FAKE_MCP_LOG: log, FAKE_MCP_HANG_DRAFT: 'unknown' } };
  writeFileSync(join(person, '.claude.json'), JSON.stringify({ mcpServers: { notes: config, other: config } }));
  const link = await CoreLink.open({ home });
  t.after(() => link.close());
  const options = { home, env: () => defaultToolEnv({ HOME: person, PATH: process.env.PATH }), link: async () => link, callTimeoutMs: 250 };
  let service = new ConnectorService(options);
  t.after(() => service.close());
  const sign = async (name: string, id = 'claude-code:notes') => {
    const shown = service.toolView(id, name)!;
    return value(await service.set(id, { seal: shown.seal, tool: { name, standing: { stamp: shown.stamp } } }));
  };
  for (const id of ['claude-code:notes', 'claude-code:other']) {
    assert.equal(value(await service.refresh(id)).problem, undefined, 'fixture tool listing must succeed before enabling'); value(await service.set(id, { enabled: true }));
    for (const name of ['lost_note', 'draft_note', 'search', 'plain']) value(await service.set(id, { tool: { name, enabled: true } }));
    value(await service.set(id, { egress: true, seal: service.doorSeal(id)! }));
    for (const name of ['lost_note', 'draft_note', 'plain']) await sign(name, id);
  }
  let seq = 0;
  const core = { readObserved: async ({ perform }: { perform: () => Promise<unknown> }) => { await perform(); return { outcome: 'READ' }; } } as unknown as ConnectorCore;
  return {
    home, person, link, options, sign, get service() { return service; },
    async reopen() { await service.close(); service = new ConnectorService(options); await service.ready(); },
    call(name: string, args: Record<string, unknown> = {}, turnId?: string, id = 'claude-code:notes') {
      const tool = service.offered().find(t => t.serverId === id && t.tool === name)!;
      return service.call(tool, args, core, { threadId: 'thread', turnId: turnId ?? `turn-${++seq}`, seq: ++seq }, new AbortController().signal);
    },
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { tool: string; args: Record<string, unknown> }) : [],
    held: () => service.list().held,
  };
}
