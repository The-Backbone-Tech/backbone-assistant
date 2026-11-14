import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseAgentRole, readAgentRoles, saveAgentRole, deleteAgentRole } from '../src/memory/agent-roles.ts';
import { restrictRoleTools } from '../src/composition/agent-role-tools.ts';
import { assertHomeWriteAdmission, withHomeLock } from '../src/composition/home-lock.ts';
import { freshHome } from './helpers.ts';
import type { ToolHost } from '../src/ports/harness.ts';

const definition = '---\nname: researcher\ndescription: Finds dates\nmodel: inherit\ntools: [Read, Glob]\n---\nFind dates and cite evidence.\n';

test('Claude subagent Markdown survives saving and stale edits preserve human changes', async () => {
  const home = freshHome();
  const role = await withHomeLock(home, async () => saveAgentRole(home, 'researcher', definition, null, []));
  assert.equal(readAgentRoles(home, [])[0].instructions, 'Find dates and cite evidence.');
  const path = join(home, '.agent-roles', 'researcher.md');
  assert.equal(readFileSync(path, 'utf8'), definition);
  await withHomeLock(home, async () => {
    assertHomeWriteAdmission(home, join(home, '.agent-roles'));
    writeFileSync(path, definition.replace('cite evidence', 'keep human edits'));
  });
  await assert.rejects(withHomeLock(home, async () => saveAgentRole(home, 'researcher', definition, role.digest, [])), /changed/i);
  await assert.rejects(withHomeLock(home, async () => deleteAgentRole(home, 'researcher', role.digest)), /changed/i);
  const current = readAgentRoles(home, [])[0];
  assert.match(current.instructions, /human edits/);
  await withHomeLock(home, async () => deleteAgentRole(home, current.name, current.digest));
  assert.deepEqual(readAgentRoles(home, []), []);
});

test('definitions reject credential fields, widening options, duplicate keys and traversal', () => {
  for (const text of [definition.replace('inherit', 'secret-canary'), definition.replace('model: inherit', 'permissionMode: bypassPermissions'), definition.replace('name: researcher', 'name: researcher\nname: other'), definition.replace('researcher', '../escape')]) {
    assert.throws(() => parseAgentRole(text, ['secret-canary']));
  }
  assert.throws(() => parseAgentRole(definition.replace('Read, Glob', 'UnknownTool'), []));
  assert.equal(parseAgentRole(definition.replace('tools: [Read, Glob]\n', ''), []).tools, undefined);
  assert.deepEqual(parseAgentRole(definition.replace('[Read, Glob]', '[]'), []).tools, []);
});

test('role tools intersect the host, refuse disallowed calls and never mint missing tools', async () => {
  let writes = 0, reads = 0;
  const inner: ToolHost = { list: async () => [], read: async () => { reads++; return null; }, write: async () => { writes++; return { outcome: 'DONE', name: 'x', version: 1 }; }, runWorkspace: async () => 'ran' };
  const narrowed = restrictRoleTools(inner, ['Read']);
  await narrowed.read('x');
  assert.equal((await narrowed.write('x', 'words', new AbortController().signal)).outcome, 'REFUSED');
  assert.equal(narrowed.runWorkspace, undefined);
  assert.equal(narrowed.callConnector, undefined);
  assert.equal(reads, 1); assert.equal(writes, 0);
  assert.equal(restrictRoleTools(inner, ['Read', 'Write']).startChild, undefined);
  const unavailable = restrictRoleTools({ list: inner.list, read: inner.read, write: inner.write }, ['Bash', 'connectors']);
  assert.equal(unavailable.runWorkspace, undefined);
  assert.equal(unavailable.callConnector, undefined);
  await assert.rejects(restrictRoleTools(inner, []).read('x'));
  await assert.rejects(restrictRoleTools(inner, []).list());
  assert.equal(reads, 1);
});


test('a native or agent-owned route refuses a tool-limited role before starting any engine', async () => {
  const { runHarnessTurn } = await import('../src/composition/harness-turn.ts');
  const { MaterialStore } = await import('../src/stub/material.ts');
  for (const kind of ['native', 'agent'] as const) {
    const home = freshHome();
    let started = false, writes = 0;
    const turn: import('../src/api.ts').Turn = { id: 'turn', side: false, user: { text: 'Inspect', attachments: [], at: '' }, work: { startedAt: '', harness: 'fake', steps: [] }, effects: [], status: 'running' };
    await runHarnessTurn({
      material: new MaterialStore(home, {}, () => {}), projectId: 'project',
      gateway: { read: async () => { throw new Error('No reads in this test'); }, write: async () => { writes++; return undefined; } },
      writeDelayMs: 0, signal: new AbortController().signal, threadId: 'thread',
      harness: { specificationVersion: 'v1', id: 'fake', label: 'fake', start: () => { started = true; throw new Error('Unexpected engine start'); } },
      route: { kind, provider: 'codex', baseUrl: '', model: 'fake', label: 'fake', credential: null },
      credential: async () => '', history: [], resumed: false, progress() {}, tell: () => ({ roleTools: [] }),
    }, turn, []);
    assert.equal(started, false); assert.equal(writes, 0); assert.equal(turn.status, 'refused');
  }
});

test('creating a role never replaces an existing definition that is too large to read', async () => {
  const home = freshHome();
  await withHomeLock(home, async () => saveAgentRole(home, 'researcher', definition, null, []));
  const path = join(home, '.agent-roles', 'researcher.md');
  const human = definition + 'A'.repeat(33_000);
  await withHomeLock(home, async () => { assertHomeWriteAdmission(home, join(home, '.agent-roles')); writeFileSync(path, human); });
  await assert.rejects(withHomeLock(home, async () => saveAgentRole(home, 'researcher', definition, null, [])));
  assert.equal(readFileSync(path, 'utf8'), human);
});

test('a role refusal also preserves an independent producer failure', async () => {
  const { runHarnessTurn } = await import('../src/composition/harness-turn.ts');
  const { MaterialStore } = await import('../src/stub/material.ts');
  const home = freshHome(), signal = new AbortController().signal, failure = 'Controlled transport failure';
  const turn: import('../src/api.ts').Turn = { id: 'turn', side: false, user: { text: 'Inspect', attachments: [], at: '' }, work: { startedAt: '', harness: 'fake', steps: [] }, effects: [], status: 'running' };
  await runHarnessTurn({ material: new MaterialStore(home, {}, () => {}), projectId: 'project',
    gateway: { read: async () => { throw new Error('Unexpected read'); }, write: async () => { throw new Error('Unexpected write'); } },
    writeDelayMs: 0, signal, threadId: 'thread', credential: async () => '', history: [], resumed: false, progress() {}, tell: () => ({ roleTools: [] }),
    route: { kind: 'endpoint', provider: 'openai', baseUrl: '', model: 'fake', label: 'fake', credential: null },
    harness: { specificationVersion: 'v1', id: 'fake', label: 'fake', start(_request, context) {
      return { events: (async function* () {})(), stop() {}, steer() {}, outcome: (async () => {
        await context.tools.write('no.md', 'must not land', signal);
        return { status: 'failed' as const, answer: '', error: failure, usage: { input: 0, output: 0 } };
      })() };
    } },
  }, turn, []);
  assert.notEqual(turn.status, 'done');
  assert.equal(turn.failure?.detail, failure);
  assert.ok(turn.answer?.text.includes(failure));
  assert.deepEqual(turn.effects, []);
});
