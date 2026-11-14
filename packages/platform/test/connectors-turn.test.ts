import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import { enableConnector } from '../src/testing/connectors.ts';
// A turn on Pi calls the person's own MCP tools through the host's one crossing: a read comes back
// as a source of the project, recorded before the engine has it and withdrawable like any original;
// an effect is held for the person and never reaches the server.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { type Message, startScriptedModel, type ScriptedModel, type Step } from '../src/testing/scripted-model.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, idle, open, settings, value } from './helpers.ts';

const server = join(import.meta.dirname, 'fake-mcp-server.ts');
let model: ScriptedModel;
/** Search, then ask to delete what it found, then answer. */
function script(messages: Message[]): Step {
  const last = messages.filter((m) => m.role === 'user').at(-1);
  if (typeof last?.content === 'string' && last.content.startsWith('And now?')) return { text: 'Nothing more.' };
  const results = messages.filter((m) => m.role === 'tool').length;
  if (results === 0) return { calls: [{ name: 'mcp__notes__search', args: { q: 'launch' } }] };
  if (results === 1) return { calls: [{ name: 'mcp__notes__delete_note', args: { id: 'n1' } }] };
  return { text: 'Found a note about the launch; the delete is waiting for you.' };
}
before(async () => {
  model = await startScriptedModel('scripted-model', script);
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  await model.close();
});

test('a Pi turn reads through a connector as a recorded, withdrawable source, and its effect is held unsent', { timeout: TEST_HANG_MS * 2 }, async () => {
  const personHome = freshDir('backbone-person-');
  const log = join(personHome, 'calls.jsonl');
  writeFileSync(join(personHome, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [server], env: { FAKE_MCP_LOG: log } } } }));
  const { host } = open(undefined, { harness: 'harness-pi', connectors: { env: defaultToolEnv({ HOME: personHome, PATH: process.env.PATH }), sources: ['claude-code'] } });
  const listed = value(await host.call('connectors.refresh', { serverId: 'claude-code:notes' }));
  value(await enableConnector(host, 'claude-code:notes'));
  for (const t of listed.tools) value(await enableConnector(host, 'claude-code:notes', t.name));

  const p = value(await host.call('projects.create', { name: 'Launch', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'What do my notes say about the launch? Tidy up after.', attachments: [], settings, clientKey: 'k1' }));
  const turn = (await idle(host, sent.threadId)).turns[0];
  assert.equal(turn.status, 'done');

  const read = (await host.call('material.list', { projectId: p.id, includeHidden: true })).find((e) => e.name.startsWith('From notes · search'));
  assert.ok(read, 'the answer is a source of the project');
  assert.equal(read.fromServer?.tool, 'search', 'and it is marked as the server\'s answer, so a later read stays untrusted');
  assert.ok(turn.reads?.some((r) => r.id === read.id), 'the turn read it, on disk with the turn');
  const text = value(await host.call('material.read', { id: read.id })).text ?? '';
  const envelope=JSON.parse(text);
  assert.deepEqual({kind:envelope.kind,version:envelope.version,server:envelope.server,tool:envelope.tool,args:envelope.args},
    {kind:'mcp-observation',version:'1',server:'notes',tool:'search',args:{q:'launch'}});
  assert.equal(envelope.result.outcome,'READ');assert.equal(envelope.result.status,'complete');
  assert.equal(read.observation?.state,'registered','the retained original has its typed native registration');
  assert.match(text, /note about launch/);

  const view = await host.call('connectors.list', {});
  assert.deepEqual(view.held.map((h) => [h.tool, h.state, h.statement]), [['delete_note', 'waiting', 'Call delete_note on notes with exactly: {"id":"n1"}']]);
  // Now lists it as needing the person, in the project it came from, pointing at its thread.
  const now = await host.call('work.now', { projectId: p.id });
  const waiting = now.needsYou.filter((n) => n.kind === 'connector');
  assert.deepEqual(waiting.map((n) => [n.threadId, n.title]), [[sent.threadId, 'notes: delete_note']]);
  assert.match(waiting[0].detail, /Settings › Connected tools/);
  const reached = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { tool: string }).tool) : [];
  assert.deepEqual(reached, ['search'], 'the read reached the server; the delete did not');

  // Withdrawn like any original: the answer that came from it is no longer given to later work.
  value(await host.call('material.lifecycle', { id: read.id, version: read.current, state: 'withdrawn', lifecycle: read.lifecycle ?? 0 }));
  const before = model.requests.length;
  value(await host.call('turns.send', { projectId: p.id, threadId: sent.threadId, text: 'And now?', attachments: [], settings, clientKey: 'k2' }));
  await idle(host, sent.threadId);
  const given = model.requests.slice(before).map((r) => r.body).join('\n');
  assert.match(given, /And now\?/);
  assert.doesNotMatch(given, /Found a note about the launch/, 'the answer that read it is left out');
});
