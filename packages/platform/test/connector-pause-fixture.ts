import assert from 'node:assert/strict';
import type { GmailPreset } from '@backbone-next/connector-mail';
import { enableConnector } from '../src/testing/connectors.ts';
import { acceptAcpTestConfiguration } from '../src/testing/acp.ts';
// Whole-Host Gmail tests: real engines and signing, local MCP and native executable only.
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostClosed } from '../src/composition/host.ts';
import { PIECE_DIRS } from '../src/composition/pieces.ts';
import { pieceDigest, pieceFiles } from '../src/pieces/digest.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, freshHome, idle, open, settings, value } from './helpers.ts';

export type GmailCall = { name: string; args: Record<string, unknown> };
export const send = (body = 'Hello.', to = 'recipient@example.com'): GmailCall => ({ name: 'mcp__gmail-send__send_gmail_message', args: { user_google_email: 'person@example.com', to, subject: 'Hello', body } });
export const draft = (sendNow = false): GmailCall => ({ name: 'mcp__gmail-send__draft_gmail_message', args: { ...send().args, ...(sendNow ? { send: true } : {}) } });

/** Same factory injection seam as engine-swap-codex.ts; no seal, key or lock is fabricated. */
function codexPiece() {
  const dir = freshDir('gmail-codex-piece-');
  for (const rel of pieceFiles(PIECE_DIRS['harness-codex'])) {
    const dest = join(dir, rel); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(join(PIECE_DIRS['harness-codex'], rel), dest);
  }
  symlinkSync(join(PIECE_DIRS['harness-codex'], 'node_modules'), join(dir, 'node_modules'), 'dir');
  copyFileSync(join(dir, 'src/index.ts'), join(dir, 'src/real.ts'));
  writeFileSync(join(dir, 'src/index.ts'), `import { createCodexHarness as real } from './real.ts';\nexport function createCodexHarness(options = {}) { return real({ ...options, command: ${JSON.stringify([process.execPath, join(dir, 'test/fixtures/native.mjs'), 'host-tools'])} }); }\n`);
  const manifest = join(dir, 'backbone.module.json');
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), digest: pieceDigest(dir) }));
  return dir;
}

export async function connectorHost(engine: 'harness-pi' | 'harness-codex' | 'harness-acp', hang = false, neutral = false, configure?: (person: string, log: string) => GmailPreset) {
  const personHome = freshDir('gmail-send-person-'), log = join(personHome, 'calls.jsonl');
  const preset: Pick<GmailPreset, 'name' | 'entry' | 'overrides'> = configure?.(personHome, log) ?? {
    name: neutral ? 'records' : 'gmail-standin', overrides: {} as Record<string, 'read' | 'effect'>,
    entry: { command: process.execPath, args: [join(import.meta.dirname, 'fixtures/connector-pause-mcp.ts')],
      env: { GMAIL_TEST_LOG: log, ...(neutral ? { CONNECTOR_TEST_NEUTRAL: '1' } : {}), ...(hang ? { GMAIL_TEST_HANG_FIRST: '1' } : {}) } },
  };
  writeFileSync(join(personHome, '.claude.json'), JSON.stringify({ mcpServers: { [preset.name]: preset.entry } }));
  let calls: GmailCall[] = [], continuations = 0;
  const model = await startScriptedModel('gmail-send-local', messages => {
    const at = messages.findLastIndex(m => m.role === 'user');
    if (messages.slice(at + 1).some(m => m.role === 'tool')) { continuations++; return { text: 'Finished local Gmail calls.' }; }
    return { calls };
  });
  const previous = { endpoint: process.env.BACKBONE_MODEL_ENDPOINT, model: process.env.BACKBONE_MODEL_ID, codex: process.env.BACKBONE_CODEX_MODEL };
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
  process.env.BACKBONE_CODEX_MODEL = 'test-model';
  const options = { harness: engine, ...(engine === 'harness-codex' ? { pieceDirs: { 'harness-codex': codexPiece() } } : {}), connectors: {
    env: defaultToolEnv({ HOME: personHome, PATH: process.env.PATH }), sources: ['claude-code'] as ('claude-code')[], callTimeoutMs: 500,
  } };
  const home = freshHome();
  if (engine === 'harness-acp') writeFileSync(join(home, 'settings.json'), JSON.stringify({ harness: engine, harnesses: { [engine]: acceptAcpTestConfiguration(home, { acceptsProcessVisibility: true, agent: 'local', command: process.execPath, args: [join(import.meta.dirname, 'fixtures/engine-tools-acp.mjs')], environment: process.platform === 'darwin' ? 'restricted-writes' : 'person-rights' }) } }));
  let host = open(home, options).host;
  const id = `claude-code:${preset.name}`;
  assert.equal(value(await host.call('connectors.refresh', { serverId: id })).problem, undefined, 'fixture tool listing must succeed before enabling');
  value(await enableConnector(host, id));
  const tools = (await host.call('connectors.list', {})).servers.find(s => s.id === id)!.tools;
  for (const tool of tools) {
    // Generic pause tests retain their effect defaults. The Gmail preset uses production
    // annotations/name floors directly, with no parallel classification table or read override.
    if (!configure) value(await host.call('connectors.set', { serverId: id, tool: { name: tool.name, override: 'effect' } }));
    value(await enableConnector(host, id, tool.name));
  }
  value(await host.openConnectorDoor(id, host.connectorDoorSeal(id)!));
  const project = value(await host.call('projects.create', { name: 'Local Gmail sending', kind: 'folder' }));
  let threadId: string | undefined, turn = 0;
  return {
    get host() { return host; }, home, id, project, preset,
    async reopen() { host.close(); await hostClosed(home); host = open(home, options).host; },
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { tool: string; args: Record<string, unknown> }) : [],
    continuations: () => continuations,
    async sign(name = 'send_gmail_message', blockedToo = true) {
      name = neutral ? name.replaceAll('_gmail_', '_record_') : name;
      const shown = host.connectorToolView(id, name)!;
      return host.signConnectorTool(id, name, shown.seal, shown.stamp, blockedToo);
    },
    async run(next: GmailCall[]) {
      next = next.map(c => ({ ...c, name: c.name.replace('mcp__gmail-send__', `mcp__${preset.name}__`).replaceAll(neutral ? '_gmail_' : '___unused___', '_record_') }));
      calls = next;
      const sent = value(await host.call('turns.send', { projectId: project.id, ...(threadId ? { threadId } : {}), text: 'HOST_TOOL_CALLS:' + JSON.stringify(engine === 'harness-codex' ? next.map(c => ({ ...c, name: c.name.replace(/^mcp__/, 'connector__') })) : engine === 'harness-acp' ? next.map(c => ({ ...c, name: 'connector_' + c.name })) : next), attachments: [], settings: { ...settings, permission: 'full', ...(engine === 'harness-codex' ? { model: 'test-model' } : {}) }, clientKey: `gmail-${++turn}` }));
      threadId = sent.threadId;
      // The shared helper polls briefly; whole native turns can need more time under load.
      const thread = await idle(host, threadId);
      return thread.turns.at(-1)!;
    },
    held: async () => (await host.call('connectors.list', {})).held,
    async close() {
      host.close();
      if (previous.endpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = previous.endpoint;
      if (previous.model === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = previous.model;
      if (previous.codex === undefined) delete process.env.BACKBONE_CODEX_MODEL; else process.env.BACKBONE_CODEX_MODEL = previous.codex;
      await model.close();
    },
  };
}
