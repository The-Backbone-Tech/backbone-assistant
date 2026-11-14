import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { CoreLink } from '../src/composition/core.ts';
import { ConnectorService, type ConnectorCore } from '../src/connectors/service.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, freshHome, value } from './helpers.ts';
export const approvalServer = 'claude-code:records';
export async function approvalFixture(t: TestContext, tools = ['send_note', 'draft_note', 'archive_note'], configure?: (person: string, entry: { command: string; args: string[]; env: Record<string, string> }) => unknown) {
  const home = freshHome(), person = freshDir('connector-approval-'), log = join(person, 'calls.jsonl'), control = join(person, 'tools.json');
  writeFileSync(control, JSON.stringify(tools.map(name => ({ name, description: 'Local fake action.', inputSchema: { type: 'object', additionalProperties: true }, annotations: { readOnlyHint: false, ...(name === 'archive_note' ? { destructiveHint: true } : {}) } }))));
  const entry = { command: process.execPath, args: [join(import.meta.dirname, 'fake-mcp-kind-server.ts')], env: { FAKE_KIND_CONTROL: control, FAKE_KIND_LOG: log, FAKE_KIND_HANG_ARG: 'unknown' } };
  writeFileSync(join(person, '.claude.json'), JSON.stringify({ mcpServers: { records: configure?.(person, entry) ?? entry } }));
  const link = await CoreLink.open({ home }); t.after(() => link.close());
  const options = { home, env: () => defaultToolEnv({ HOME: person, PATH: process.env.PATH }), link: async () => link, callTimeoutMs: 250 };
  let service = new ConnectorService(options); t.after(() => service.close());
  assert.equal(value(await service.refresh(approvalServer)).problem, undefined, 'fixture tool listing must succeed before enabling'); value(await service.set(approvalServer, { enabled: true }));
  for (const name of tools) value(await service.set(approvalServer, { tool: { name, enabled: true } }));
  value(await service.set(approvalServer, { egress: true, seal: service.doorSeal(approvalServer)! }));
  const file = join(home, 'connectors/mcp.json'); let n = 0;
  return { home, person, link, options, file, control, get service() { return service; },
    read: () => JSON.parse(readFileSync(file, 'utf8')),
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
    call(name: string, args: Record<string, unknown> = {}, turnId?: string) { return service.call(service.offered().find(t => t.tool === name)!, args, {} as ConnectorCore, { threadId: 'approval', turnId: turnId ?? `approval-${++n}`, seq: ++n }, new AbortController().signal); },
    sign(name: string, blockedToo?: boolean) { const shown = service.toolView(approvalServer, name)!; return service.set(approvalServer, { seal: shown.seal, tool: { name, standing: { stamp: shown.stamp, ...(blockedToo === undefined ? {} : { blockedToo }) } } }); },
    async signLegacy(name: string, blockedToo?: boolean) {
      // Exercise the released product give crossing and digest, then its exact unversioned local shape.
      const call = link.call.bind(link), definition = JSON.parse(readFileSync(file, 'utf8')).servers[approvalServer].tools[name].definition;
      link.call = (async (...a: Parameters<typeof call>) => { if (String(a[1]).includes('give_connector_signature')) a[2] = [a[2]![0], a[2]![1], definition]; return call(...a); }) as typeof call;
      try { value(await this.sign(name, blockedToo)); } finally { link.call = call; }
      const stored = JSON.parse(readFileSync(file, 'utf8')), signature = stored.servers[approvalServer].tools[name].standing;
      delete signature.coverageVersion; delete signature.signedDefinition; writeFileSync(file, JSON.stringify(stored));
    },
    async reopen() { await service.close(); service = new ConnectorService(options); await service.ready(); },
  };
}
