import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import { enableConnector } from '../src/testing/connectors.ts';
// A whole turn on Pi under the person's standing signature for one tool: the engine's call goes out
// once with nobody asked, the engine is told what the server did, the record says it went out on
// the signature, and nothing waits in Needs you. Ending the signature makes the next call wait.
// Giving one is not a method of the api, and a closing host gives none.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { type Message, startScriptedModel, type ScriptedModel, type Step } from '../src/testing/scripted-model.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, idle, open, settings, value } from './helpers.ts';

const server = join(import.meta.dirname, 'fake-mcp-server.ts');
const words = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join(''));
let model: ScriptedModel;
/** Draft a note named by the request, then say what the tool answered. */
function script(messages: Message[]): Step {
  const at = messages.findLastIndex((m) => m.role === 'user');
  const result = messages.slice(at + 1).find((m) => m.role === 'tool');
  if (!result) return { calls: [{ name: 'mcp__notes__draft_note', args: { text: words(messages[at]).includes('second') ? 'second' : 'first' } }] };
  return { text: `The tool said: ${words(result)}` };
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

test('a Pi turn under a standing signature sends its call once with nobody asked; without the signature the next call waits', { timeout: TEST_HANG_MS * 2 }, async () => {
  const personHome = freshDir('backbone-person-');
  const log = join(personHome, 'calls.jsonl');
  writeFileSync(join(personHome, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [server], env: { FAKE_MCP_LOG: log } } } }));
  const { host } = open(undefined, { harness: 'harness-pi', connectors: { env: defaultToolEnv({ HOME: personHome, PATH: process.env.PATH }), sources: ['claude-code'] } });
  const id = 'claude-code:notes';
  const listed = value(await host.call('connectors.refresh', { serverId: id }));
  value(await enableConnector(host, id));
  for (const t of listed.tools) value(await enableConnector(host, id, t.name));
  const drafts = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string; args: unknown }) : []).filter((c) => c.tool === 'draft_note').map((c) => c.args);
  const tool = async () => (await host.call('connectors.list', {})).servers.find((s) => s.id === id)!.tools.find((t) => t.name === 'draft_note')!;

  // Only the person signs, in the app's main process: the api refuses, whatever it is handed.
  const overApi = await host.call('connectors.set', { serverId: id, tool: { name: 'draft_note', standing: {} as never } });
  assert.equal(overApi.ok, false);
  assert.match(overApi.ok ? '' : overApi.detail, /Only the person signs/);
  value(await host.openConnectorDoor(id, host.connectorDoorSeal(id)!));
  // What main shows the person and what their click signs come from one reading; a click on what was shown before a change signs nothing.
  const shown = host.connectorToolView(id, 'draft_note')!;
  assert.equal((await host.signConnectorTool(id, 'draft_note', shown.seal, 'the-tool-as-shown-before-it-changed', false)).ok, false);
  value(await host.signConnectorTool(id, 'draft_note', shown.seal, shown.stamp, false));
  assert.ok((await tool()).standing, 'the view shows the signature');

  const p = value(await host.call('projects.create', { name: 'Launch', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Draft the first note.', attachments: [], settings, clientKey: 'k1' }));
  const turn = (await idle(host, sent.threadId)).turns[0];
  assert.equal(turn.status, 'done');
  assert.deepEqual(drafts(), [{ text: 'first' }], 'the call reached the server, once');
  assert.match(turn.answer?.text ?? '', /The tool said: Sent to notes\./, 'the engine was told what happened, not that it waits');
  assert.ok(turn.work?.steps.some((s) => /On your standing signature for draft_note on notes: Sent to notes\./.test(s.label)), 'the turn\'s work says on whose word it went');
  const view = await host.call('connectors.list', {});
  assert.deepEqual(view.held.map((h) => [h.tool, h.state, h.standing, h.statement]), [['draft_note', 'sent', true, 'Call draft_note on notes with exactly: {"text":"first"}']]);
  assert.deepEqual((await host.call('work.now', { projectId: p.id })).needsYou.filter((n) => n.kind === 'connector'), [], 'nothing waits for the person');

  // Ending a signature only takes authority away, so the api does it; the next call waits and is not sent.
  value(await host.call('connectors.set', { serverId: id, tool: { name: 'draft_note', standing: false } }));
  assert.equal((await tool()).standing, undefined);
  value(await host.call('turns.send', { projectId: p.id, threadId: sent.threadId, text: 'Draft the second note.', attachments: [], settings, clientKey: 'k2' }));
  const later = (await idle(host, sent.threadId)).turns.at(-1)!;
  assert.equal(later.status, 'done');
  assert.match(later.answer?.text ?? '', /Held for the person, not sent/);
  assert.deepEqual(drafts(), [{ text: 'first' }], 'the second draft did not reach the server');
  const after = await host.call('connectors.list', {});
  assert.deepEqual(after.held.map((h) => [h.state, h.standing]).sort(), [['sent', true], ['waiting', undefined]]);
  assert.equal((await host.call('work.now', { projectId: p.id })).needsYou.filter((n) => n.kind === 'connector').length, 1);

  // A dialog answered after the host began closing signs nothing.
  host.close();
  const late = await host.signConnectorTool(id, 'draft_note', 'seal', 'definition', false);
  assert.equal(late.ok, false);
  assert.match((late as { detail: string }).detail, /closing/);
});
