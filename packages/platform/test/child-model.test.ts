// A child's own model and effort (docs/contracts/thread-orchestration.md): named by the person or the
// parent agent, checked at admission against what the engine and route serve, refused by name when
// unknown, with a fallback list tried only at admission and recorded. The default stays the parent's.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startScriptedModel, scriptedStep, type Message, type ScriptedModel, type Step } from '../src/testing/scripted-model.ts';
import { idle, open, settings, value } from './helpers.ts';

const BRIEF = 'Write an editable brief for the launch';
const text = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));

/** "Delegate on M [then F]": start one child on model M with fallback F, wait for it, and say what came back. */
function delegating(messages: Message[]): Step {
  const start = messages.findLastIndex((m) => m.role === 'user');
  const asked = /Delegate on (\S+)(?: then (\S+))?/.exec(text(messages[start]));
  if (!asked) return scriptedStep(messages);
  const results = messages.slice(start + 1).filter((m) => m.role === 'tool').map(text);
  const called = messages.slice(start + 1).flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name);
  if (!called.includes('start_child')) return { calls: [{ name: 'start_child', args: { brief: BRIEF, role: 'worker', model: asked[1], effort: 2, ...(asked[2] ? { fallback: [asked[2]] } : {}) } }] };
  const thread = /thread (\S+)/.exec(results[0] ?? '')?.[1];
  if (!thread) return { text: `Refused: ${results[0]}` };
  if (!called.includes('await_child')) return { calls: [{ name: 'await_child', args: { thread } }] };
  return { text: `Report received: ${results[1]}` };
}

let model: ScriptedModel;
before(async () => {
  model = await startScriptedModel('scripted-model', delegating, { served: ['scripted-model', 'small-model', 'flaky-model'], refuses: ['flaky-model'] });
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  await model.close();
});

/** The models each chat request since `from` was sent to, for the turns whose person words include `words`. */
const ranOn = (words: string, from = 0) => model.requests.slice(from).flatMap((r) => {
  if (!r.body) return [];
  const body = JSON.parse(r.body) as { model?: string; messages?: Message[] };
  return body.messages?.some((m) => m.role === 'user' && text(m).includes(words)) ? [body.model] : [];
});
/** The distinct models in that order, for turns whose number of model calls is the script's business. */
const only = (models: (string | undefined)[]) => [...new Set(models)];
const listings = (from = 0) => model.requests.slice(from).filter((r) => !r.body).length;

async function parent() {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Hello', attachments: [], settings, clientKey: 'first' }));
  await idle(host, sent.threadId);
  return { host, p, threadId: sent.threadId };
}

test('a child on a different model reaches its turn with that model, and keeps it on a later turn', async () => {
  const s = await parent();
  const from = model.requests.length;
  const started = value(await s.host.call('children.start', { parentThreadId: s.threadId, text: 'Write an editable brief', role: 'worker', settings: { model: 'small-model' }, clientKey: 'c' }));
  const kid = await idle(s.host, started.threadId);
  assert.equal(kid.turns[0].status, 'done', kid.turns[0].answer?.text ?? '');
  assert.deepEqual(only(ranOn('Write an editable brief', from)), ['small-model'], 'every model call of the child went to its model');
  assert.match(kid.turns[0].work.harness ?? '', /small-model/);
  assert.deepEqual(kid.child?.model, { asked: ['small-model'], ran: 'small-model', passedOver: [] });
  const view = value(await s.host.call('threads.get', { id: s.threadId })).children![0];
  assert.equal(view.model.ran, 'small-model', 'the card can show the model it ran on');
  // A person's later turn on the child, from a composer still on the parent's model, stays on the child's.
  const later = model.requests.length;
  value(await s.host.call('turns.send', { threadId: started.threadId, projectId: s.p.id, text: 'Say more', attachments: [], settings, clientKey: 'again' }));
  await idle(s.host, started.threadId);
  assert.deepEqual(only(ranOn('Say more', later)), ['small-model']);

  // From the parent agent's start_child, with an effort of its own.
  const { host } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'Q', kind: 'folder' }));
  const agentFrom = model.requests.length;
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Delegate on small-model', attachments: [], settings, clientKey: 'k' }));
  await idle(host, sent.threadId);
  const thread = value(await host.call('threads.get', { id: sent.threadId }));
  assert.equal(thread.turns[0].status, 'done', thread.turns[0].answer?.text ?? '');
  const child = thread.children![0];
  assert.deepEqual([child.startedBy, child.model.ran, child.settings.effort, child.handover?.status], ['agent', 'small-model', 2, 'done']);
  assert.deepEqual(only(ranOn(BRIEF, agentFrom)), ['small-model']);
});

test('an unknown model is refused with the reason, never silently replaced', async () => {
  const s = await parent();
  const from = model.requests.length;
  const refused = await s.host.call('children.start', { parentThreadId: s.threadId, text: 'Write an editable brief', role: 'worker', settings: { model: 'no-such-model' }, clientKey: 'c' });
  assert.deepEqual([refused.ok, !refused.ok && refused.reason], [false, 'INVALID']);
  assert.match(!refused.ok ? refused.detail : '', /no-such-model is not a model this route serves/);
  assert.equal((await s.host.call('threads.list', {})).length, 1, 'nothing was started');
  assert.deepEqual(ranOn('Write an editable brief', from), [], 'no model was called for it');
  const effort = await s.host.call('children.start', { parentThreadId: s.threadId, text: 'Write an editable brief', role: 'worker', settings: { model: 'small-model', effort: 5 }, clientKey: 'd' });
  assert.deepEqual([effort.ok, !effort.ok && effort.reason], [false, 'WIDER_THAN_PARENT'], 'a model of its own does not lift the effort ceiling');

  // The parent agent is told the reason, and no child stands.
  const { host } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'Q', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Delegate on no-such-model', attachments: [], settings, clientKey: 'k' }));
  await idle(host, sent.threadId);
  const thread = value(await host.call('threads.get', { id: sent.threadId }));
  assert.match(thread.turns[0].answer?.text ?? '', /Refused: INVALID: .*no-such-model is not a model this route serves/);
  assert.equal(thread.children, undefined);
});

test('a fallback is used only at admission, and the child\'s record says which one ran', async () => {
  const s = await parent();
  const from = model.requests.length;
  const started = value(await s.host.call('children.start', { parentThreadId: s.threadId, text: 'Write an editable brief', role: 'worker', settings: { model: 'no-such-model' }, fallback: ['small-model'], clientKey: 'c' }));
  const kid = await idle(s.host, started.threadId);
  assert.equal(kid.turns[0].status, 'done', kid.turns[0].answer?.text ?? '');
  assert.deepEqual(kid.child?.model, { asked: ['no-such-model', 'small-model'], ran: 'small-model', passedOver: [{ model: 'no-such-model', detail: 'no-such-model is not a model this route serves.' }] });
  assert.equal(kid.turns[0].user.settings?.model, 'small-model');
  assert.deepEqual(only(ranOn('Write an editable brief', from)), ['small-model']);
  assert.deepEqual(value(await s.host.call('threads.get', { id: s.threadId })).children![0].model, kid.child?.model);

  // A model the route lists but refuses once the turn has begun is not replaced: the turn fails on it.
  const flakyFrom = model.requests.length;
  const flaky = value(await s.host.call('children.start', { parentThreadId: s.threadId, text: 'Write a flaky brief', role: 'worker', settings: { model: 'flaky-model' }, fallback: ['small-model'], clientKey: 'f' }));
  const failed = await idle(s.host, flaky.threadId);
  assert.notEqual(failed.turns[0].status, 'done');
  assert.deepEqual(ranOn('Write a flaky brief', flakyFrom), ['flaky-model'], 'nothing was sent to the fallback after the turn began');
  assert.deepEqual(failed.child?.model, { asked: ['flaky-model', 'small-model'], ran: 'flaky-model', passedOver: [] });
});

test('the default is unchanged: the parent\'s model, with no listing asked of the route', async () => {
  const s = await parent();
  const from = model.requests.length;
  const started = value(await s.host.call('children.start', { parentThreadId: s.threadId, text: 'Write an editable brief', role: 'worker', clientKey: 'c' }));
  const kid = await idle(s.host, started.threadId);
  assert.equal(kid.turns[0].status, 'done', kid.turns[0].answer?.text ?? '');
  assert.equal(kid.child?.settings.model, settings.model);
  assert.equal(kid.child?.model, undefined, 'no choice was made, so none is recorded');
  assert.equal(listings(from), 0);
  assert.deepEqual(only(ranOn('Write an editable brief', from)), ['scripted-model']);
  assert.deepEqual(value(await s.host.call('threads.get', { id: s.threadId })).children![0].model, { asked: ['scripted-model'], ran: 'scripted-model', passedOver: [] });
  // Naming the parent's own model is the default too.
  const same = value(await s.host.call('children.start', { parentThreadId: s.threadId, text: 'Write another brief', role: 'worker', settings: { model: settings.model }, clientKey: 'd' }));
  await idle(s.host, same.threadId);
  assert.equal(listings(from), 0);
});
