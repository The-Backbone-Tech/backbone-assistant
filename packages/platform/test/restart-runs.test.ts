import { waitFor } from '../../../scripts/lib/test-hang.ts';
// Background runs across a crash. When a host opens a home whose goal run, trigger run or scheduled
// run was going when its process died, the turn the kill cut short is carried on once work resumes:
// one that finishes lets the run go on; one that cannot is marked interrupted (never "stopped by
// you"), with a Resume, and a write it may have made stays UNKNOWN and is never resent. Opening alone
// starts no turn of a goal run. (Cards on a task board: task-board.test.ts.)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { CHILD_START_HANG_MS, observeChild } from '../../../scripts/lib/test-child.ts';
import type { GoalRun, Proactivity, Thread, TriggerRun, Triggers } from '../src/api.ts';
import { CoreLink } from '../src/composition/core.ts';
import { createHost, hostClosed } from '../src/composition/host.ts';
import { readJson, writeJson } from '../src/stub/fsx.ts';
import { startScriptedModel, type Message, type ScriptedModel, type Step } from '../src/testing/scripted-model.ts';
import { freshHome, open, value } from './helpers.ts';

const words = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Judges' verdicts per goal, in order; the last repeats. */
const verdicts = new Map<string, string[]>();
function answering(messages: Message[]): Step {
  const asked = words(messages[messages.findLastIndex((m) => m.role === 'user')]);
  const goal = /completion criterion:\s*(.+)/.exec(asked)?.[1]?.trim();
  if (goal && /Goal check/.test(asked)) { const q = verdicts.get(goal) ?? ['MET: done']; return { text: q.length > 1 ? q.shift()! : q[0] }; }
  return { text: 'Worked on it.' };
}

/** Model calls whose words carry `Held:`; the first since `heldOnPi` is held until the file's end (its host is killed). */
let heldCalls = 0;
let reached: () => void = () => {};
let release: () => void = () => {};
const held = new Promise<void>((r) => (release = r));

let model: ScriptedModel;
before(async () => {
  model = await startScriptedModel('scripted-model', answering, {
    async before(messages) {
      if (!messages.some((m) => m.role === 'user' && /Held:/.test(words(m)))) return;
      if (++heldCalls === 1) { reached(); await held; }
    },
  });
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  release();
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  await model.close();
});

/** A host in a process of its own, running `kind` on `ask`, killed at its crash point or once `kill` resolves. */
function killed(home: string, kind: 'goal' | 'trigger' | 'schedule', ask: string, env: Record<string, string>, kill?: Promise<void>) {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-runs.ts'), home, kind, ask], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = observeChild(child, `restart ${kind} host`);
  return new Promise<void>((resolve, reject) => {
    let timedOut = false;
    // This head has no test-hang helper. Use the shared generous three-minute child bound:
    // a hang detector under parallel load, never an assertion about startup speed.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CHILD_START_HANG_MS);
    void kill?.then(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    child.once('error', error => { clearTimeout(timer); reject(output.diagnostic(`could not start: ${error.message}`)); });
    // close drains both pipes, retaining the product failure that prevented the model hold.
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (!timedOut && signal === 'SIGKILL') resolve();
      else reject(output.diagnostic(timedOut ? 'timed out before the injected crash or held model call' : `was not killed at the expected point (code ${code}, signal ${signal})`));
    });
  });
}
const crashAtWrite = { BACKBONE_HARNESS: 'harness-stub', BACKBONE_CRASH_AT: 'write.begun', BACKBONE_CRASH_OCCURRENCE: '1' };
const heldOnPi = () => { heldCalls = 0; const at = new Promise<void>((r) => (reached = r)); return { env: { BACKBONE_HARNESS: 'harness-pi' }, at }; };

type H = ReturnType<typeof open>['host'];
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  let seen: T | undefined;
  await waitFor(async()=>{seen=await read();return ok(seen);},what,{diagnostic:()=>JSON.stringify(seen)});
  return seen!;
}
const goalThread = async (host: H) => (await host.call('threads.list', {}))[0].id;
const thread = async (host: H, id: string): Promise<Thread> => value(await host.call('threads.get', { id }));
const goalSettled = (host: H, id: string) => until(() => thread(host, id), (t) => !!t.goalRun && t.goalRun.status !== 'running' && !t.summary.running, 'the goal run to settle');
const triggerRun = async (host: H): Promise<TriggerRun> => ((await host.call('triggers.get', {})) as Triggers).runs.at(-1)!;
const settledRun = (r: { outcome: string }) => !['starting', 'running'].includes(r.outcome);
async function writeEffects(home: string) {
  const link = await CoreLink.open({ home });
  try {
    const { rows } = await link.read(link.system(), "SELECT id FROM app.effects WHERE operation = 'workspace.write_document'");
    return rows.length;
  } finally { await link.release(); }
}

test('a goal run whose turn a kill cut mid-write is marked interrupted, its write UNKNOWN and never resent', async () => {
  const home = freshHome();
  await killed(home, 'goal', 'Write an editable brief for the launch', crashAtWrite);
  const { host } = open(home);
  const id = await goalThread(host);
  const t = await goalSettled(host, id);
  const run = t.goalRun as GoalRun;
  assert.equal(run.status, 'interrupted');
  assert.match(run.detail ?? '', /app stopped/i);
  assert.match(run.detail ?? '', /UNKNOWN/);
  assert.doesNotMatch(run.detail ?? '', /by you/i);
  const work = t.turns.at(-1)!;
  assert.deepEqual([work.interrupted, work.effects.map((e) => e.outcome)], [true, ['UNKNOWN']]);
  await sleep(300);
  assert.equal((await thread(host, id)).turns.length, 2, 'no turn starts on its own');
  // Resume: the run goes on only past what the person can settle; the UNKNOWN still holds it, and nothing is resent.
  value(await host.call('goals.resume', { threadId: id }));
  const after = await goalSettled(host, id);
  assert.equal(after.goalRun!.status, 'blocked');
  assert.match(after.goalRun!.detail ?? '', /unknown/i);
  assert.equal(after.turns.length, 2);
  assert.equal(await writeEffects(home), 1, 'one write in all');
});

test('a goal run whose model call a kill cut short carries on after the restart, to its check', async () => {
  const home = freshHome();
  const goal = 'Held: outline the launch';
  verdicts.set(goal, ['MET: the outline is there']);
  const hold = heldOnPi();
  await killed(home, 'goal', goal, hold.env, hold.at);
  const { host } = open(home, { harness: 'harness-pi' });
  const id = await goalThread(host);
  // Right after opening, the run reads 'interrupted' until resuming carries it on: wait past that.
  const t = await until(() => thread(host, id), (x) => !!x.goalRun && !['running', 'interrupted'].includes(x.goalRun.status) && !x.summary.running, 'the goal run to carry on and settle');
  assert.equal(t.goalRun!.status, 'met');
  const work = t.turns.find((x) => x.user.text.startsWith('Work toward the goal'))!;
  assert.deepEqual([work.interrupted, work.status], [true, 'done'], 'the same turn, carried on');
  assert.equal(t.turns.filter((x) => x.user.text.startsWith('Work toward the goal')).length, 1, 'no second turn of work');
});

test('opening a home starts no turn of a goal run; resuming work does', async () => {
  const home = freshHome();
  const goal = 'Name the owners';
  verdicts.set(goal, ['NOT MET: owners are missing', 'MET: every step has an owner']);
  let id: string;
  {
    const host = createHost({ home, harness: 'harness-pi' });
    try {
      await host.resumeInterrupted();
      const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
      const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Start', attachments: [], settings: { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: 's' }));
      id = sent.threadId;
      await until(() => thread(host, id), (t) => !t.summary.running, 'the first turn');
      value(await host.call('goals.set', { threadId: id, text: goal, baseVersion: 0 }));
      value(await host.call('goals.run', { threadId: id, budget: 1 }));
      await until(() => thread(host, id), (t) => t.goalRun?.status === 'budget' && !t.summary.running, 'the budget to be spent');
    } finally {
      host.close();
      await hostClosed(home);
    }
  }
  // As a kill would leave it: the check said not met, and the next turn of work was not admitted yet.
  const runs = readJson<Record<string, GoalRun>>(join(home, 'goal-runs.json'), {});
  Object.assign(runs[id], { status: 'running', budget: 2 });
  delete runs[id].detail;
  writeJson(join(home, 'goal-runs.json'), runs);
  const host = createHost({ home, harness: 'harness-pi' });
  try {
    const turns = (await thread(host, id)).turns.length;
    await sleep(500);
    assert.equal((await thread(host, id)).turns.length, turns, 'opening started nothing');
    await host.resumeInterrupted();
    const t = await goalSettled(host, id);
    assert.equal(t.goalRun!.status, 'met');
    assert.equal(t.turns.length, turns + 2, 'one turn of work and its check');
  } finally {
    host.close();
    await hostClosed(home);
  }
});

test('a trigger run whose turn a kill cut mid-write is marked interrupted for the brief; while its write is UNKNOWN it does not resume', async () => {
  const home = freshHome();
  await killed(home, 'trigger', 'Write an editable brief for the launch', crashAtWrite);
  const { host } = open(home, { triggers: { debounceMs: 50 }, schedules: { tickMs: 25 } });
  const run = await until(() => triggerRun(host), (r) => !!r && settledRun(r), 'the trigger run to settle');
  assert.equal(run.outcome, 'interrupted');
  assert.match(run.summary, /app stopped/i);
  assert.match(run.summary, /UNKNOWN/);
  value(await host.call('brief.put', { time: '00:00' }));
  const pending = (await until(() => host.call('schedules.get', {}) as Promise<Proactivity>, (p) => !!p.brief.latest, 'the brief')).brief.latest!.items;
  assert.ok(pending.some((i) => i.runId === run.id), 'the interrupted run waits in the brief');
  // As a goal run does: a second write could land while the first is unknown, so nothing starts.
  const refused = await host.call('triggers.resume', { runId: run.id, clientKey: 'r' });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.detail, /UNKNOWN/);
  await sleep(300);
  assert.equal(((await host.call('triggers.get', {})) as Triggers).runs.length, 1, 'nothing reran');
  assert.equal(await writeEffects(home), 1, 'one write in all');
});

test('a trigger run a kill cut short with no write in doubt resumes once, in its chat, told not to redo what was done', async () => {
  const home = freshHome();
  // Killed once the write is proposed and before it is dispatched: recovery settles it, and nothing is UNKNOWN.
  await killed(home, 'trigger', 'Write an editable brief for the launch', { ...crashAtWrite, BACKBONE_CRASH_AT: 'write.proposed' });
  const { host } = open(home, { triggers: { debounceMs: 50 }, schedules: { tickMs: 25 } });
  const run = await until(() => triggerRun(host), (r) => !!r && settledRun(r), 'the trigger run to settle');
  const cut = (await thread(host, run.threadId!)).turns.find((t) => t.id === run.turnId)!;
  assert.equal(run.outcome, 'interrupted', `${cut.status}: ${cut.answer?.text}`);
  assert.deepEqual(cut.effects.filter((e) => e.outcome === 'UNKNOWN'), [], 'no write in doubt');
  assert.doesNotMatch(run.summary, /UNKNOWN/);
  const again = value(await host.call('triggers.resume', { runId: run.id, clientKey: 'r' }));
  const twice = value(await host.call('triggers.resume', { runId: run.id, clientKey: 'r' }));
  assert.equal(twice.id, again.id, 'one resume per key');
  const other = await host.call('triggers.resume', { runId: run.id, clientKey: 'other' });
  assert.equal(other.ok, false, 'a run resumes once');
  const done = await until(() => host.call('triggers.get', {}) as Promise<Triggers>, (s) => s.runs.length === 2 && s.runs.every(settledRun), 'the resumed run');
  const resumed = done.runs.find((r) => r.id === again.id)!;
  assert.equal(resumed.threadId, run.threadId, 'in the same chat');
  assert.equal(done.runs.find((r) => r.id === run.id)!.resumedBy, resumed.id);
  const asked = (await thread(host, resumed.threadId!)).turns.find((t) => t.id === resumed.turnId)!.user.text;
  assert.match(asked, /interrupted/i);
  assert.match(asked, /do not redo/i);
  const notCut = await host.call('triggers.resume', { runId: resumed.id, clientKey: 'x' });
  assert.equal(notCut.ok, false, 'only an interrupted run resumes');
});

test('a trigger run whose model call a kill cut short carries on after the restart and finishes', async () => {
  const home = freshHome();
  const hold = heldOnPi();
  await killed(home, 'trigger', 'Held: look at what came in.', hold.env, hold.at);
  const { host } = open(home, { harness: 'harness-pi', triggers: { debounceMs: 50 }, schedules: { tickMs: 25 } });
  const run = await until(() => triggerRun(host), (r) => !!r && settledRun(r), 'the trigger run to settle');
  assert.equal(run.outcome, 'done');
  assert.equal(((await host.call('triggers.get', {})) as Triggers).runs.length, 1);
  const turn = (await thread(host, run.threadId!)).turns.find((t) => t.id === run.turnId)!;
  assert.deepEqual([turn.interrupted, turn.status], [true, 'done']);
});

test('a scheduled run whose turn a kill cut mid-write is marked interrupted, not stopped', async () => {
  const home = freshHome();
  await killed(home, 'schedule', 'Write an editable brief for the launch', crashAtWrite);
  const { host } = open(home, { schedules: { tickMs: 25 } });
  // The run the kill cut is the one with a turn; a due run the reopened host skips beside it has none.
  const cutOf = (s: Proactivity) => s.runs.find((r) => r.turnId);
  const p = await until(() => host.call('schedules.get', {}) as Promise<Proactivity>, (s) => !!cutOf(s) && settledRun(cutOf(s)!), 'the scheduled run to settle');
  assert.equal(cutOf(p)!.outcome, 'interrupted');
  assert.match(cutOf(p)!.summary, /UNKNOWN/);
  assert.equal(await writeEffects(home), 1);
});
