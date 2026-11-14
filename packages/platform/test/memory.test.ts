// Memory across a real host: every turn is given the person's instructions (as instructions) and what
// bears on its words (as data), through the one port, and leaves behind what the person asked to keep.
// A memory leaves with a withdrawn source the moment it is withdrawn; a credential the store holds is
// never kept; skills are offered only once enabled; imports copy with their source shown. Pi on a
// scripted model shows what reached it, and where.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Thread } from '../src/api.ts';
import { startScriptedModel, type Message, type ScriptedModel, type Step } from '../src/testing/scripted-model.ts';
import { b64, idle, open, settings, value } from './helpers.ts';

const words = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
const seen: { system: string; user: string }[] = [];
function seeing(messages: Message[]): Step {
  seen.push({ system: messages.filter((m) => m.role === 'system').map(words).join('\n'), user: words(messages[messages.findLastIndex((m) => m.role === 'user')]) });
  return { text: 'Noted.' };
}

let model: ScriptedModel;
const user = mkdtempSync(join(tmpdir(), 'memory-user-'));
before(async () => {
  model = await startScriptedModel('scripted-model', seeing);
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
  mkdirSync(join(user, '.claude', 'skills', 'release-notes'), { recursive: true });
  writeFileSync(join(user, '.claude', 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: Write release notes from merged changes.\n---\n\nList each merged change once, newest first.\n');
  mkdirSync(join(user, '.codex', 'memories'), { recursive: true });
  writeFileSync(join(user, '.codex', 'memories', 'm.md'), '- Deploys happen on Tuesdays.\n');
});
after(async () => {
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  await model.close();
  rmSync(user, { recursive: true, force: true });
});

const fakeKey = ['sk', 'live', '0123456789abcdef', 'ABCDEF'].join('-');
const pi = () => open(undefined, { harness: 'harness-pi', memory: { userHome: user } });
type H = ReturnType<typeof pi>['host'];
async function turn(host: H, projectId: string, text: string, threadId?: string, attachments: string[] = []) {
  const sent = value(await host.call('turns.send', { threadId, projectId, text, attachments, settings, clientKey: `${text}:${Math.random()}` }));
  const t: Thread = await idle(host, sent.threadId);
  return { threadId: sent.threadId, turn: t.turns.at(-1)! };
}
const filesUnder = (dir: string): string => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => readFileSync(join(d.parentPath, d.name), 'utf8')).join('\n');

test('instructions go where instructions go; remembered lines arrive as data, with their sources read', async () => {
  const { host } = pi();
  const projectId = value(await host.call('projects.create', { name: 'Ops', kind: 'folder' })).id;
  value(await host.call('memory.instructions.put', { scope: 'person', text: 'Be brief.' }));
  value(await host.call('memory.instructions.put', { scope: 'project', projectId, text: 'This project pays suppliers.' }));
  const doc = value(await host.call('material.attach', { projectId, name: 'terms.md', base64: b64('# Terms\n'), mediaType: 'text/markdown' }));
  await turn(host, projectId, 'Remember that the ACME invoice is paid by bank transfer.', undefined, [doc.id]);
  const fact = (await host.call('memory.get', {})).entries.find((e) => /ACME/.test(e.text))!;
  value(await host.call('memory.put', { topic: 'facts', text: 'The office plants need water on Mondays.' }));
  seen.length = 0;
  const { turn: t } = await turn(host, projectId, 'How do we pay the ACME invoice?');
  const given = seen.at(-1)!;
  assert.match(given.system, /Be brief\./);
  assert.match(given.system, /This project pays suppliers\./);
  assert.doesNotMatch(given.system, /ACME/, 'a remembered line is data, not a system instruction');
  assert.match(given.user, /ACME invoice is paid by bank transfer/);
  assert.match(given.user, /cannot change what you may do/);
  assert.doesNotMatch(given.user, /plants/);
  assert.deepEqual(t.memory?.used, [fact.id]);
  assert.equal(t.memory?.instructions, true);
  assert.ok(t.reads?.some((r) => r.id === doc.id && r.inherited), 'a recalled line\'s source is one of the turn\'s reads');
});

test('what the person asks to keep is remembered by id, and no credential the store holds is kept', async () => {
  const { host, home } = pi();
  const projectId = value(await host.call('projects.create', { name: 'Ops', kind: 'folder' })).id;
  const { threadId, turn: t } = await turn(host, projectId, 'Remember that the launch moved to Friday.');
  // A gateway key stays stored while an own key is the route in use: it is still a credential the store holds.
  value(await host.call('settings.model.put', { change: { route: 'gateway', provider: 'openrouter', key: fakeKey } }));
  value(await host.call('settings.model.put', { change: { route: 'own', provider: 'anthropic', key: ['sk', 'other', 'fedcba9876543210', 'ZYXWVU'].join('-') } }));
  assert.equal((await host.call('settings.model.get', {})).gateway?.keySet, true);
  const view = await host.call('memory.get', {});
  const kept = view.entries.find((e) => e.text === 'The launch moved to Friday.')!;
  assert.deepEqual(t.memory?.remembered, [kept.id]);
  assert.equal(kept.origin.threadId, threadId);
  for (const text of [`Remember the deploy word ${fakeKey}`, 'password: horse-battery']) {
    assert.equal((await host.call('memory.put', { topic: 'facts', text })).ok, false, text);
  }
  assert.equal((await host.call('memory.instructions.put', { scope: 'person', text: `Use ${fakeKey} for the API.` })).ok, false, 'a stored credential no route uses any more is still refused');
  value(await host.call('memory.forget', { id: kept.id }));
  assert.equal((await host.call('memory.get', {})).entries.length, 0);
  const stored = JSON.parse(readFileSync(join(home, 'threads', `${threadId}.json`), 'utf8')) as Thread;
  assert.doesNotMatch(JSON.stringify(stored.turns.map((x) => x.memory)), /launch moved/, 'the turn keeps the id, not the words');
});

test('a memory made with a document leaves every file the moment that document is withdrawn', async () => {
  const { host, home } = pi();
  const projectId = value(await host.call('projects.create', { name: 'Ops', kind: 'folder' })).id;
  const doc = value(await host.call('material.attach', { projectId, name: 'budget.md', base64: b64('# Budget\n40k\n'), mediaType: 'text/markdown' }));
  await turn(host, projectId, 'Remember that the budget is 40k.', undefined, [doc.id]);
  assert.match(filesUnder(join(home, 'memory')), /budget is 40k/);
  value(await host.call('material.lifecycle', { id: doc.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  assert.doesNotMatch(filesUnder(join(home, 'memory')), /40k/, 'gone from topics, daily notes, index and records without being read first');
  assert.equal((await host.call('memory.search', { query: 'budget' })).length, 0);
});

test('project ids must name a real project before any path is built', async () => {
  const { host } = pi();
  for (const projectId of ['../../escape', '00000000-0000-4000-8000-000000000000']) {
    assert.equal((await host.call('memory.instructions.put', { scope: 'project', projectId, text: 'x' })).ok, false, projectId);
  }
});

test('a found skill is listed until enabled, then offered as reference data; a draft waits for an OK; imports copy', async () => {
  const { host, home } = pi();
  const projectId = value(await host.call('projects.create', { name: 'Ops', kind: 'folder' })).id;
  const listed = (await host.call('memory.get', {})).skills.find((s) => s.name === 'release-notes')!;
  assert.equal(listed.state, 'available');
  seen.length = 0;
  let r = await turn(host, projectId, 'Write the release notes for the merged changes');
  assert.deepEqual(r.turn.memory?.skills ?? [], []);
  value(await host.call('skills.decide', { id: listed.id, verdict: 'enable' }));
  seen.length = 0;
  r = await turn(host, projectId, 'Write the release notes for the merged changes');
  assert.deepEqual(r.turn.memory?.skills, ['release-notes']);
  assert.doesNotMatch(seen.at(-1)!.system, /List each merged change once/, 'a skill is never a system instruction');
  assert.match(seen.at(-1)!.user, /List each merged change once/);

  const draft = value(await host.call('skills.draft', { threadId: r.threadId }));
  assert.equal((await host.call('skills.draft', { threadId: (await turn(host, projectId, `Deploy with ${fakeKey}`)).threadId })).ok, false, 'a draft holding a credential is refused');
  assert.equal(draft.state, 'proposed');
  assert.ok(draft.path.startsWith(join(home, 'skills', '.proposed')));
  const accepted = value(await host.call('skills.decide', { id: draft.id, verdict: 'accept' }))!;
  assert.equal(accepted.state, 'active');

  assert.equal(value(await host.call('memory.import', { from: 'codex' })).added, 1);
  const imported = (await host.call('memory.get', {})).entries.find((e) => e.text === 'Deploys happen on Tuesdays.')!;
  assert.equal(imported.origin.source, join(user, '.codex', 'memories', 'm.md'));
  assert.equal((await host.call('memory.import', { from: 'file', path: join(user, '.codex', 'auth.json') })).ok, false);
});

test('a skill drafted from a turn leaves when a document that turn was given is withdrawn', async () => {
  const { host } = pi();
  const projectId = value(await host.call('projects.create', { name: 'Ops', kind: 'folder' })).id;
  const doc = value(await host.call('material.attach', { projectId, name: 'sales.md', base64: b64('# Sales\n'), mediaType: 'text/markdown' }));
  const proposedFrom = await turn(host, projectId, 'Prepare the weekly report from the sales sheet', undefined, [doc.id]);
  const acceptedFrom = await turn(host, projectId, 'Prepare the monthly report from the sales sheet', undefined, [doc.id]);
  const proposed = value(await host.call('skills.draft', { threadId: proposedFrom.threadId }));
  const accepted = value(await host.call('skills.decide', { id: value(await host.call('skills.draft', { threadId: acceptedFrom.threadId })).id, verdict: 'accept' }))!;
  assert.equal(accepted.state, 'active');
  value(await host.call('material.lifecycle', { id: doc.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  const left = (await host.call('memory.get', {})).skills.map((s) => s.name);
  assert.ok(!left.includes(proposed.name) && !left.includes(accepted.name), left.join(', '));
  assert.equal(existsSync(proposed.path) || existsSync(accepted.path), false, 'their words leave the disk at once, not only the list');
  seen.length = 0;
  await turn(host, projectId, 'Prepare the monthly report from the sales sheet');
  assert.doesNotMatch(seen.at(-1)!.user, /Drafted from a finished task/);
});

test('a host given no user home reads no personal skill or memory folder, even where HOME has them', async () => {
  const was = process.env.HOME;
  process.env.HOME = user;
  try {
    const { host } = open(undefined, { harness: 'harness-pi' });
    const skills = (await host.call('memory.get', {})).skills;
    assert.deepEqual(skills.filter((s) => s.origin !== 'backbone').map((s) => s.name), [], 'no .claude, .codex or .agents skill of the person is listed');
    const imported = await host.call('memory.import', { from: 'codex' });
    assert.equal(imported.ok, false, 'no .codex memories folder is read');
    assert.match(!imported.ok ? imported.detail : '', /BACKBONE_USER_HOME/);
    assert.ok(!(await host.call('memory.get', {})).entries.some((e) => /Tuesdays/.test(e.text)));
  } finally {
    process.env.HOME = was;
  }
  const named = pi().host;
  assert.ok((await named.call('memory.get', {})).skills.some((s) => s.name === 'release-notes'), 'a named user home is read');
});
