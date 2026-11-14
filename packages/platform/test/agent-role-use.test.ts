import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startScriptedModel, type Message, type Step } from '../src/testing/scripted-model.ts';
import { freshHome, idle, open, settings, value } from './helpers.ts';

const text = (m: Message) => typeof m.content === 'string' ? m.content : (m.content ?? []).map(c => c.text ?? '').join('');
export function roleStep(messages: Message[]): Step {
  const index = messages.findLastIndex(m => m.role === 'user');
  const words = text(messages[index]);
  const results = messages.slice(index + 1).filter(m => m.role === 'tool').map(text);
  if (words.includes('ROLE_PROBE')) {
    if (!results.length) return { calls: [{ name: 'list_files', args: {} }] };
    return { text: 'Role evidence collected: ' + results.join('\n') };
  }
  if (words.includes('Use own/researcher')) {
    if (!results.length) return { calls: [{ name: 'start_child', args: { agent: 'own/researcher', role: 'worker', brief: 'Inspect the project' } }] };
    const id = /Started thread (\S+)/.exec(results[0])?.[1];
    if (id && results.length === 1) return { calls: [{ name: 'await_child', args: { thread: id } }] };
    return { text: results.join('\n') };
  }
  return { text: 'Ready.' };
}
const definition = '---\nname: researcher\ndescription: Finds facts\nmodel: role-model\ntools: [Read, Glob]\n---\nROLE_PROBE: cite the evidence.\n';

test('a saved role is reused with its model and enforced tools; replay retains its snapshot', async () => {
  const model = await startScriptedModel('parent-model', roleStep, { served: ['parent-model', 'role-model'] });
  const priorEndpoint = process.env.BACKBONE_MODEL_ENDPOINT, priorModel = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  const home = freshHome();
  try {
    const { host } = open(home, { harness: 'harness-pi' });
    const role = value(await host.call('agents.save', { name: 'researcher', markdown: definition, base: null }));
    const p = value(await host.call('projects.create', { name: 'Role project', kind: 'folder' }));
    const parent = value(await host.call('turns.send', { projectId: p.id, text: 'Use own/researcher', attachments: [], settings, clientKey: 'one' }));
    const first = await idle(host, parent.threadId);
    assert.equal(first.children?.length, 1, first.turns.at(-1)?.answer?.text ?? 'No child was created');
    const kid = await idle(host, first.children![0].threadId);
    assert.equal(kid.child?.agentRole?.digest, role.digest);
    assert.deepEqual(kid.child?.agentRole?.tools, ['Read', 'Glob']);
    assert.equal(kid.child?.settings.model, 'role-model');
    assert.equal(kid.turns[0].status, 'done');
    assert.ok(kid.turns[0].work.steps.some(step => step.kind === 'list'));
    assert.equal((await host.call('material.list', { projectId: p.id })).some(e => e.name === 'forbidden.md'), false);
    value(await host.call('turns.send', { threadId: parent.threadId, projectId: p.id, text: 'Use own/researcher again', attachments: [], settings, clientKey: 'two' }));
    const second = await idle(host, parent.threadId);
    assert.equal(second.children?.length, 2);
    await host.close();
    const reopened = open(home, { harness: 'harness-pi' }).host;
    const replay = value(await reopened.call('threads.get', { id: kid.summary.id }));
    assert.equal(replay.child?.agentRole?.digest, role.digest);
    assert.deepEqual(value(await reopened.call('agents.list', {})).roles.map(r => r.name), ['researcher']);
    const bodies = model.requests.filter(r => r.body).map(r => JSON.parse(r.body));
    const childCalls = bodies.filter(r => r.messages.some((m: Message) => text(m).includes('ROLE_PROBE') && m.role === 'user'));
    assert.ok(childCalls.length >= 4);
    assert.ok(childCalls.every(r => r.model === 'role-model'));
    assert.ok(childCalls.every(r => !(r.tools ?? []).some((t: { function: { name: string } }) => ['workspace_run', 'start_child', 'memory_search'].includes(t.function.name))));
  } finally {
    if (priorEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = priorEndpoint;
    if (priorModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = priorModel;
    await model.close();
  }
});


test('repeating one named helper call after its definition is deleted reuses the admitted snapshot', async () => {
  let active: ReturnType<typeof open>['host'] | undefined;
  let savedDigest = '', deleted = false;
  const model = await startScriptedModel('parent-model', messages => {
    const index = messages.findLastIndex(m => m.role === 'user');
    const words = text(messages[index]);
    const results = messages.slice(index + 1).filter(m => m.role === 'tool').map(text);
    if (words.includes('Use own/researcher twice') && results.length === 1) return { calls: [{ name: 'start_child', args: { agent: 'own/researcher', role: 'worker', brief: 'Inspect the project' } }] };
    return roleStep(messages);
  }, { served: ['parent-model', 'role-model'], before: async messages => {
    const index = messages.findLastIndex(m => m.role === 'user');
    const results = messages.slice(index + 1).filter(m => m.role === 'tool');
    if (!deleted && text(messages[index]).includes('Use own/researcher twice') && results.length === 1) {
      value(await active!.call('agents.delete', { name: 'researcher', base: savedDigest })); deleted = true;
    }
  } });
  const priorEndpoint = process.env.BACKBONE_MODEL_ENDPOINT, priorModel = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  try {
    active = open(freshHome(), { harness: 'harness-pi' }).host;
    savedDigest = value(await active.call('agents.save', { name: 'researcher', markdown: definition, base: null })).digest;
    const p = value(await active.call('projects.create', { name: 'Retry role', kind: 'folder' }));
    const sent = value(await active.call('turns.send', { projectId: p.id, text: 'Use own/researcher twice', attachments: [], settings, clientKey: 'same-call' }));
    const parent = await idle(active, sent.threadId);
    assert.ok(deleted);
    assert.equal(parent.children?.length, 1);
    assert.equal(value(await active.call('agents.list', {})).roles.length, 0);
    const child = await idle(active, parent.children![0].threadId);
    assert.equal(child.child?.agentRole?.digest, savedDigest);
    const started = parent.turns[0].answer?.text?.match(/Started thread (\S+)/g) ?? [];
    assert.equal(started.length, 2);
    assert.equal(started[0], started[1]);
  } finally {
    if (priorEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = priorEndpoint;
    if (priorModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = priorModel;
    await model.close();
  }
});

test('a helper whose saved role denies writing reports refusal and leaves no document or effect', async () => {
  const model = await startScriptedModel('parent-model', messages => {
    const index = messages.findLastIndex(m => m.role === 'user');
    if (text(messages[index]).includes('ROLE_DENY')) return { calls: [{ name: 'write_file', args: { name: 'forbidden.md', content: 'must never land' } }] };
    return roleStep(messages);
  }, { served: ['parent-model', 'role-model'] });
  const priorEndpoint = process.env.BACKBONE_MODEL_ENDPOINT, priorModel = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  try {
    const { host } = open(freshHome(), { harness: 'harness-pi' });
    value(await host.call('agents.save', { name: 'researcher', markdown: definition.replace('ROLE_PROBE', 'ROLE_DENY'), base: null }));
    const p = value(await host.call('projects.create', { name: 'Denied role write', kind: 'folder' }));
    const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Use own/researcher', attachments: [], settings, clientKey: 'denied-write' }));
    const parent = await idle(host, sent.threadId);
    assert.equal(parent.children?.length, 1);
    const child = await idle(host, parent.children![0].threadId);
    assert.equal(child.turns[0].status, 'refused');
    assert.deepEqual(child.turns[0].effects, []);
    assert.equal((await host.call('material.list', { projectId: p.id })).some(entry => entry.name === 'forbidden.md'), false);
  } finally {
    if (priorEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = priorEndpoint;
    if (priorModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = priorModel;
    await model.close();
  }
});
