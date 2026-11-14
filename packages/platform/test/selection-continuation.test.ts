import { TEST_HANG_MS, waitFor } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
// Exercise actual model destinations: continuing a selected task must not silently switch to the
// home's default or lose its constraints. Reopen/fork use the real persisted thread history.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test, type TestContext } from 'node:test';
import type { TaskNeeds, TurnSelection } from '../src/api.ts';
import type { ModelRoute } from '../src/ports/harness.ts';
import { continuedSelection, pinnedRoute, shownOf, withNamedModel } from '../src/selection/pin.ts';
import { hostClosed } from '../src/composition/host.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import { pollUntil, freshHome, idle, open, settings, value  } from './helpers.ts';

const chats = (model: { requests: { body: string }[] }) => model.requests.filter((request) => request.body.includes('"messages"'));
const localTask: TaskNeeds = { needs: ['model', 'files'], network: false, spend: 'none' };
const onlineTask: TaskNeeds = { needs: ['model', 'files'], network: true, spend: 'metered' };
async function closedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function setup(t: TestContext, local: boolean) {
  const a = await startScriptedModel('configured-a', () => ({ text: 'Completed on A.' }));
  const b = await startScriptedModel('configured-b', () => ({ text: 'Completed on B.' }));
  const chosen = await startScriptedModel('local-qwen', (messages) => ({ text: messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes('Goal check.')) ? 'MET: the work completed locally.' : 'Completed locally.' }));
  const original = { endpoint: process.env.BACKBONE_MODEL_ENDPOINT, model: process.env.BACKBONE_MODEL_ID };
  const configure = (model: typeof a) => { process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model; };
  configure(a);
  const home = freshHome();
  const options = { harness: 'harness-pi' as const, localModels: { ports: { ollama: local ? Number(new URL(chosen.url).port) : await closedPort(), lmstudio: await closedPort(), llamacpp: await closedPort(), vllm: await closedPort() }, timeoutMs: 1000 } };
  let host = open(home, options).host;
  t.after(async () => {
    host.close();
    await hostClosed(home);
    await Promise.all([a.close(), b.close(), chosen.close()]);
    if (original.endpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = original.endpoint;
    if (original.model === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = original.model;
  });
  if (local) value(await host.call('settings.model.put', { change: { route: 'local', provider: 'other', baseUrl: chosen.url, model: chosen.model } }));
  const projectId = value(await host.call('projects.create', { name: 'Continuation', kind: 'folder' })).id;
  return {
    a, b, chosen, projectId, configure,
    get host() { return host; },
    async reopen() { host.close(); await hostClosed(home); host = open(home, options).host; },
    async select(task: TaskNeeds, clientKey: string, threadId?: string) {
      // This test compares Pi routes; an unrelated signed-in native engine is not a candidate.
      const path = process.env.PATH;
      process.env.PATH = '/nonexistent';
      try { return value(await host.call('solutions.run', { projectId, threadId, task, text: 'Answer this task.', settings, clientKey })); }
      finally { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; }
    },
    async send(threadId: string | undefined, clientKey: string) {
      const sent = value(await host.call('turns.send', { projectId, threadId, text: 'Continue this work.', attachments: [], settings, clientKey }));
      return { sent, turn: (await idle(host, sent.threadId)).turns.find((turn) => turn.id === sent.turnId)! };
    },
  };
}

test('a restricted selected task keeps its local route on follow-up, reopen, fork and retry', { timeout: TEST_HANG_MS * 2 }, async (t) => {
  const p = await setup(t, true);
  const selected = await p.select(localTask, 'selected-local');
  assert.ok(selected.started, selected.detail);
  const threadId = selected.started.threadId;
  const original = (await idle(p.host, threadId)).turns[0];
  assert.equal(original.selection?.pinned.baseUrl, p.chosen.url);
  assert.equal(chats(p.a).length, 0);
  const followed = await p.send(threadId, 'follow-local');
  assert.equal(followed.turn.status, 'done');
  assert.equal(chats(p.a).length, 0, 'the configured route must not receive a restricted follow-up');
  assert.deepEqual(followed.turn.selection?.task, localTask);
  assert.deepEqual(followed.turn.selection?.ran, original.selection?.pinned);
  await p.reopen();
  p.configure(p.b);
  const reopened = await p.send(threadId, 'after-reopen');
  assert.equal(reopened.turn.status, 'done');
  assert.equal(reopened.turn.selection?.ran?.baseUrl, p.chosen.url);
  const fork = value(await p.host.call('threads.fork', { id: threadId, turnId: original.id, clientKey: 'fork-local' }));
  const forked = await p.send(fork.id, 'fork-follow');
  assert.equal(forked.turn.selection?.ran?.baseUrl, p.chosen.url);
  const beforeRetry = chats(p.chosen).length;
  const retry = await p.send(fork.id, 'fork-follow');
  assert.deepEqual(retry.sent, forked.sent);
  assert.equal(chats(p.chosen).length, beforeRetry, 'a retried key starts no additional call');
  assert.equal(chats(p.a).length + chats(p.b).length, 0);
  assert.equal(chats(p.chosen).length, 4, 'first turn, follow-up, reopened follow-up and fork');
});

test('a moved selected route refuses continuation; an ordinary chat and explicit new selection can use the new route', { timeout: TEST_HANG_MS * 2 }, async (t) => {
  const p = await setup(t, false);
  const selected = await p.select(onlineTask, 'selected-a');
  assert.ok(selected.started, selected.detail);
  const threadId = selected.started.threadId;
  const original = (await idle(p.host, threadId)).turns[0];
  assert.equal(original.selection?.ran?.baseUrl, p.a.url);
  p.configure(p.b);
  const continued = await p.send(threadId, 'moved-follow');
  assert.equal(continued.turn.status, 'refused');
  assert.equal(continued.turn.selection?.pinned.baseUrl, p.a.url);
  assert.equal(continued.turn.selection?.ran, undefined, 'a refused continuation must not inherit an earlier execution receipt');
  assert.equal(chats(p.b).length, 0, 'a moved default is not silently substituted');
  assert.equal(value(await p.host.call('threads.get', { id: threadId })).turns[0].selection?.ran?.baseUrl, p.a.url, 'the prior execution receipt stays intact');
  const ordinary = await p.send(undefined, 'ordinary-b');
  assert.equal(ordinary.turn.status, 'done');
  assert.equal(ordinary.turn.selection, undefined, 'an unselected chat keeps ordinary routing');
  assert.equal(chats(p.b).length, 1);
  const reselected = await p.select(onlineTask, 'selected-b', threadId);
  assert.ok(reselected.started, reselected.detail);
  const changed = (await idle(p.host, threadId)).turns.at(-1)!;
  assert.equal(changed.selection?.ran?.baseUrl, p.b.url, 'an explicit new choice replaces the old route');
  const followed = await p.send(threadId, 'follow-b');
  assert.equal(followed.turn.status, 'done');
  assert.equal(followed.turn.selection?.ran?.baseUrl, p.b.url);
  assert.equal(chats(p.b).length, 3);
});

test('goal work and its automatic judge keep a selected task on its constrained local route', { timeout: TEST_HANG_MS * 2 }, async (t) => {
  const p = await setup(t, true);
  const selected = await p.select(localTask, 'selected-goal');
  assert.ok(selected.started, selected.detail);
  const threadId = selected.started.threadId;
  await idle(p.host, threadId);
  value(await p.host.call('goals.set', { threadId, text: 'Complete this local task.', baseVersion: 0 }));
  value(await p.host.call('goals.run', { threadId, budget: 2 }));
  let thread = value(await p.host.call('threads.get', { id: threadId }));
  await pollUntil(async active => {
    while (active() && (thread.goalRun?.status !== 'met')) {
       await new Promise((resolve) => setTimeout(resolve, 10));
       thread = value(await p.host.call('threads.get', { id: threadId }));
     }
  }, "packages/platform/test/selection-continuation.test.ts:128 polling state");
  assert.equal(thread.goalRun?.status, 'met');
  assert.equal(thread.turns.length, 3, 'selected turn, goal work and automatic judge');
  assert.ok(thread.turns.at(-1)?.judge, 'the final turn actually judged the goal');
  for (const turn of thread.turns) {
    assert.deepEqual(turn.selection?.task, localTask);
    assert.equal(turn.selection?.ran?.baseUrl, p.chosen.url);
  }
  assert.equal(chats(p.a).length + chats(p.b).length, 0, 'neither automatic work nor its judge reaches the configured route');
  assert.equal(chats(p.chosen).length, 3);
});

test('selection retains attached source identity/version and delivers its name to the chosen model; retry keeps the same turn', { timeout: TEST_HANG_MS * 2 }, async (t) => {
  const p = await setup(t, true);
  const source = value(await p.host.call('material.attach', { projectId: p.projectId, name: 'selected-source.md', mediaType: 'text/markdown', base64: Buffer.from('Source for the selected task.').toString('base64') }));
  const args = { projectId: p.projectId, text: 'Review the attached source.', task: localTask, settings, clientKey: 'selected-attachment', attachments: [source.id] };
  const selected = value(await p.host.call('solutions.run', args));
  assert.ok(selected.started, selected.detail);
  const turn = (await idle(p.host, selected.started.threadId)).turns[0];
  assert.equal(turn.status, 'done');
  assert.deepEqual(turn.user.attachments, [{ materialId: source.id, name: source.name, version: source.current }]);
  assert.ok(chats(p.chosen).some((request) => request.body.includes('selected-source.md')), 'the actual chosen model receives the attachment context');
  assert.equal(chats(p.a).length + chats(p.b).length, 0);
  const before = chats(p.chosen).length;
  const retry = value(await p.host.call('solutions.run', { ...args, attachments: [] }));
  assert.deepEqual(retry.started, selected.started, 'a repeated key answers its original turn, without replacing its sources');
  assert.equal(chats(p.chosen).length, before);
  assert.deepEqual(value(await p.host.call('threads.get', { id: selected.started.threadId })).turns[0].user.attachments, turn.user.attachments);
});

test('selection refuses missing, foreign-project and withdrawn attachments before starting a model', { timeout: TEST_HANG_MS * 2 }, async (t) => {
  const p = await setup(t, true);
  const other = value(await p.host.call('projects.create', { name: 'Other project', kind: 'folder' }));
  const attach = async (projectId: string, name: string) => value(await p.host.call('material.attach', { projectId, name, mediaType: 'text/markdown', base64: Buffer.from('Private source.').toString('base64') }));
  const foreign = await attach(other.id, 'foreign.md');
  const withdrawn = await attach(p.projectId, 'withdrawn.md');
  value(await p.host.call('material.lifecycle', { id: withdrawn.id, version: withdrawn.current, state: 'withdrawn', lifecycle: withdrawn.lifecycle ?? 0 }));
  for (const [key, id, detail] of [['missing', 'no-such-material', /active project/], ['foreign', foreign.id, /active project/], ['withdrawn', withdrawn.id, /withdrawn/]] as const) {
    const receipt = await p.host.call('solutions.run', { projectId: p.projectId, text: 'Review this source.', task: localTask, settings, clientKey: `bad-attachment-${key}`, attachments: [id] });
    assert.equal(receipt.ok, false, key);
    assert.match(receipt.ok ? '' : receipt.detail, detail, key);
  }
  assert.equal(chats(p.chosen).length + chats(p.a).length + chats(p.b).length, 0, 'invalid source sets start no model request');
  assert.equal((await p.host.call('threads.list', {})).length, 0, 'invalid source sets create no replacement chat');
});

// ---- Counterexamples from the two reviews of 0c19d07 (backbone/evidence/reviews-20261105/) ------------

/** The configured route becomes A with a key: a route that may cost, which a no-spend task's history may not reach. */
const keyedA = async (p: Awaited<ReturnType<typeof setup>>) => {
  value(await p.host.call('settings.model.put', { change: { route: 'local', clear: true } }));
  return value(await p.host.call('settings.model.put', { change: { route: 'own', provider: 'openai-compatible', key: 'test-key-not-real', model: 'configured-a', baseUrl: p.a.url } }));
};
const until = async (check: () => Promise<boolean>) => waitFor(check, 'selected task goal reaches its asserted state');

test('a follow-up continues the choice as a copy: no receipt until it runs, no options, so its key never replays as a selection', { timeout: TEST_HANG_MS * 2 }, async (t) => {
  const p = await setup(t, true);
  const selected = await p.select(localTask, 'copy-selected');
  assert.ok(selected.started, selected.detail);
  const threadId = selected.started.threadId;
  await idle(p.host, threadId);
  const followed = await p.send(threadId, 'copy-follow');
  assert.equal(followed.turn.selection?.options, undefined, 'only the turn solutions.run started answers a repeated key with its options');
  assert.equal(followed.turn.selection?.ran?.baseUrl, p.chosen.url, 'its own receipt, written when its request left');
  const before = chats(p.chosen).length;
  const reused = await p.host.call('solutions.run', { projectId: p.projectId, threadId, task: localTask, text: 'Answer this task.', settings, clientKey: 'copy-follow' });
  assert.equal(reused.ok, false, 'a key an ordinary follow-up used is not "already started" by a selection');
  if (!reused.ok) assert.match(reused.detail, /did not choose/);
  assert.equal(chats(p.chosen).length, before);
});

test('a goal run records its own choice: a later, unrelated choice in the chat moves neither its work nor its judge', { timeout: TEST_HANG_MS * 2 }, async (t) => {
  const p = await setup(t, false);
  const selected = await p.select(onlineTask, 'goal-on-a');
  assert.ok(selected.started, selected.detail);
  const threadId = selected.started.threadId;
  await idle(p.host, threadId);
  value(await p.host.call('goals.set', { threadId, text: 'Complete this task.', baseVersion: 0 }));
  const run = value(await p.host.call('goals.run', { threadId, budget: 2 }));
  value(await p.host.call('goals.pause', { threadId }));
  assert.equal(run.selection?.pinned.baseUrl, p.a.url, 'the run records the choice it was started from');
  await idle(p.host, threadId);
  // The person makes an unrelated choice in the same chat, on another route.
  p.configure(p.b);
  const reselected = await p.select(onlineTask, 'reselect-b', threadId);
  assert.ok(reselected.started, reselected.detail);
  await idle(p.host, threadId);
  assert.equal(chats(p.b).length, 1);
  value(await p.host.call('goals.resume', { threadId }));
  let thread = value(await p.host.call('threads.get', { id: threadId }));
  await until(async () => (thread = value(await p.host.call('threads.get', { id: threadId }))).goalRun?.status !== 'running');
  const judge = thread.turns.at(-1)!;
  assert.ok(judge.judge, 'the resumed run checked its goal');
  assert.equal(judge.selection?.pinned.baseUrl, p.a.url, 'its judge keeps the run\'s recorded route, not the later choice');
  assert.equal(judge.status, 'refused', 'that route moved, so the check did not run on another');
  assert.equal(judge.selection?.ran, undefined);
  assert.equal(thread.goalRun?.status, 'blocked');
  assert.equal(chats(p.b).length, 1, 'the later choice\'s route received nothing of the goal run');
  assert.equal(chats(p.a).length, 2, 'the first selected turn and the goal\'s work, both on the recorded route');
  // The goal's own turns never become the chat's choice: the person's next follow-up continues their latest explicit one.
  const followed = await p.send(threadId, 'after-goal');
  assert.equal(followed.turn.status, 'done', followed.turn.answer?.text ?? '');
  assert.equal(followed.turn.selection?.pinned.baseUrl, p.b.url);
  assert.equal(chats(p.b).length, 2);
});

test('a goal run started without settings keeps the settings it started with, whatever the chat\'s later turns use', { timeout: TEST_HANG_MS * 2 }, async (t) => {
  const p = await setup(t, true);
  const selected = await p.select(localTask, 'goal-settings');
  assert.ok(selected.started, selected.detail);
  const threadId = selected.started.threadId;
  await idle(p.host, threadId);
  value(await p.host.call('goals.set', { threadId, text: 'Complete this local task.', baseVersion: 0 }));
  const run = value(await p.host.call('goals.run', { threadId, budget: 2 }));
  value(await p.host.call('goals.pause', { threadId }));
  assert.deepEqual(run.settings, settings, 'pinned when allowed');
  await idle(p.host, threadId);
  const later = { ...settings, model: 'gpt-b', effort: 5 as const };
  value(await p.host.call('turns.send', { projectId: p.projectId, threadId, text: 'Something else.', attachments: [], settings: later, clientKey: 'later-settings' }));
  await idle(p.host, threadId);
  value(await p.host.call('goals.resume', { threadId }));
  let thread = value(await p.host.call('threads.get', { id: threadId }));
  await until(async () => (thread = value(await p.host.call('threads.get', { id: threadId }))).goalRun?.status !== 'running');
  const judge = thread.turns.at(-1)!;
  assert.ok(judge.judge);
  assert.deepEqual(judge.user.settings, settings, 'its check runs with the settings the run started with');
});

test('a restricted task\'s history never leaves on a route outside its limits: a schedule, a goal run and a later unrestricted choice are refused with the reason', { timeout: TEST_HANG_MS * 2 }, async (t) => {
  const p = await setup(t, true);
  const first = await p.send(undefined, 'before-choice');
  const threadId = first.sent.threadId;
  const schedule = value(await p.host.call('schedules.create', { projectId: p.projectId, threadId, text: 'Check in on this.', when: 'every day at 9:00', settings, clientKey: 'daily-check' }));
  const selected = await p.select(localTask, 'later-choice', threadId);
  assert.ok(selected.started, selected.detail);
  await idle(p.host, threadId);
  await keyedA(p);
  const before = chats(p.a).length;
  // A schedule allowed before the choice adopts none, so it would run on the configured route: refused, with why.
  const ran = value(await p.host.call('schedules.run', { id: schedule.id, clientKey: 'now' }));
  const runOf = async () => (await p.host.call('schedules.get', {})).runs.find((r) => r.id === ran.id)!;
  await until(async () => !['starting', 'running'].includes((await runOf()).outcome));
  assert.match((await runOf()).summary, /may cost.*this chat holds that task's work/);
  // A child the person starts carries its parent's work, so it is held to the same limits.
  const child = await p.host.call('children.start', { parentThreadId: threadId, text: 'Look into this.', role: 'worker', clientKey: 'restricted-child' });
  assert.ok(child.ok, JSON.stringify(child));
  const childTurn = (await idle(p.host, child.value.threadId)).turns.find((x) => x.id === child.value.turnId)!;
  assert.equal(childTurn.status, 'refused');
  assert.match(childTurn.answer?.text ?? '', /this chat holds that task's work/);
  assert.equal(chats(p.a).length, before, 'the may-cost route received none of the restricted history');
  // H1's saved route was explicitly cleared. Its pinned task must refuse until that saved choice returns.
  const held = await p.send(threadId, 'saved-choice-moved');
  assert.equal(held.turn.status, 'refused');
  assert.equal(chats(p.a).length, before);
  value(await p.host.call('settings.model.put', { change: { route: 'local', provider: 'other', baseUrl: p.chosen.url, model: p.chosen.model } }));
  const followed = await p.send(threadId, 'still-local');
  assert.equal(followed.turn.status, 'done');
  assert.equal(followed.turn.selection?.ran?.baseUrl, p.chosen.url);
});

test('a goal run that recorded no choice pauses rather than carry a restricted history to the configured route', { timeout: TEST_HANG_MS * 2 }, async (t) => {
  const p = await setup(t, true);
  const first = await p.send(undefined, 'unchosen');
  const threadId = first.sent.threadId;
  value(await p.host.call('goals.set', { threadId, text: 'Complete this task.', baseVersion: 0 }));
  const run = value(await p.host.call('goals.run', { threadId, budget: 2 }));
  value(await p.host.call('goals.pause', { threadId }));
  assert.equal(run.selection, undefined, 'allowed before any choice: it records none');
  await idle(p.host, threadId);
  const selected = await p.select(localTask, 'restricting', threadId);
  assert.ok(selected.started, selected.detail);
  await idle(p.host, threadId);
  await keyedA(p);
  const before = chats(p.a).length;
  value(await p.host.call('goals.resume', { threadId }));
  let thread = value(await p.host.call('threads.get', { id: threadId }));
  await until(async () => (thread = value(await p.host.call('threads.get', { id: threadId }))).goalRun?.status !== 'running');
  assert.notEqual(thread.goalRun?.status, 'met');
  assert.match(thread.goalRun?.detail ?? '', /may cost.*this chat holds that task's work/);
  assert.equal(chats(p.a).length, before, 'nothing of the restricted history reached the configured route');
});

test('a write shown one route runs on it or not at all: a moved choice refuses a send and a goal run before any request', { timeout: TEST_HANG_MS * 2 }, async (t) => {
  const p = await setup(t, true);
  const selected = await p.select(localTask, 'shown-selected');
  assert.ok(selected.started, selected.detail);
  const threadId = selected.started.threadId;
  const thread = await idle(p.host, threadId);
  const shown = shownOf(continuedSelection(thread.turns));
  const before = chats(p.chosen).length;
  for (const continues of [null, { ...shown!, pinned: { ...shown!.pinned, model: 'another' } }]) {
    const refused = await p.host.call('turns.send', { projectId: p.projectId, threadId, text: 'Continue.', attachments: [], settings, clientKey: `stale-${continues ? 'other' : 'none'}`, continues });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.detail, /changed since you were shown it/);
  }
  value(await p.host.call('goals.set', { threadId, text: 'Complete this local task.', baseVersion: 0 }));
  const goal = await p.host.call('goals.run', { threadId, budget: 1, continues: null });
  assert.equal(goal.ok, false, 'a goal run shown no route does not start on one');
  assert.equal(chats(p.chosen).length + chats(p.a).length, before, 'nothing was sent');
  const allowed = value(await p.host.call('turns.send', { projectId: p.projectId, threadId, text: 'Continue.', attachments: [], settings, clientKey: 'shown-same', continues: shown }));
  const turn = (await idle(p.host, threadId)).turns.find((x) => x.id === allowed.turnId)!;
  assert.equal(turn.status, 'done');
  assert.equal(turn.selection?.ran?.baseUrl, p.chosen.url);
});

test('a follow-up continues the latest explicit choice, never a goal run\'s own turn', () => {
  const pick = (routeId: string, origin?: 'goal-run'): TurnSelection => ({ task: localTask, routeId, reasons: [], pinned: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: routeId, label: routeId }, ...(origin ? { origin } : {}) });
  const turn = (selection?: TurnSelection) => ({ selection }) as never;
  assert.equal(continuedSelection([turn(pick('a')), turn(pick('b')), turn(pick('a', 'goal-run'))])?.routeId, 'b');
  assert.equal(continuedSelection([turn(pick('a', 'goal-run'))]), undefined);
});

test('a model named explicitly is kept: a native engine runs it on the chosen route; a route that cannot run it starts nothing', () => {
  const native: TurnSelection = { task: onlineTask, routeId: 'native:codex', reasons: ['chosen'], pinned: { kind: 'native', provider: 'codex', baseUrl: '', model: 'gpt-a', label: 'Codex · gpt-a' }, ran: { kind: 'native', provider: 'codex', baseUrl: '', model: 'gpt-a', label: 'Codex · gpt-a' } };
  const configured: ModelRoute = { kind: 'native', provider: 'codex', baseUrl: '', model: 'gpt-a', label: 'Codex · gpt-a', credential: null };
  const same = withNamedModel(native, 'gpt-a', false);
  assert.ok('selection' in same && same.selection === native, 'the same model changes nothing');
  const kept = withNamedModel(native, 'gpt-b', false);
  assert.ok('selection' in kept);
  assert.equal(kept.selection.pinned.model, 'gpt-b');
  assert.equal(kept.selection.pinned.label, 'Codex · gpt-b');
  const runs = pinnedRoute(kept.selection, configured);
  assert.ok('route' in runs, 'the chosen engine runs the named model');
  assert.equal(runs.route.model, 'gpt-b', 'the model that goes out is the one named, not the configured default');
  // The engine's own default moving does not move a turn's model; another engine or account still refuses.
  assert.ok('route' in pinnedRoute(native, { ...configured, model: 'gpt-c', label: 'Codex · gpt-c' }));
  assert.ok('refused' in pinnedRoute(native, { ...configured, provider: 'openai' }));
  const local: TurnSelection = { task: localTask, routeId: 'local:ollama:qwen', reasons: [], pinned: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen', label: 'Ollama · qwen' } };
  const refused = withNamedModel(local, 'big', true);
  assert.ok('refused' in refused && /cannot run big/.test(refused.refused));
  assert.ok('selection' in withNamedModel(local, 'configured-a', false), 'settings that name no model the engine runs leave the choice as it is');
});
