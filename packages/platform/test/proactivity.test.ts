// Proactivity: schedules, the heartbeat and the daily brief, on a real host with a scripted model and
// a clock the test moves. Each run is a turn on the one turn path; what was missed while closed is
// caught up once; the heartbeat stays quiet unless something needs the person, and that waits for
// the one daily brief unless it is a security or money emergency, which is told at once and counted.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { ApiEvent, Proactivity, ScheduleRun } from '../src/api.ts';
import { startScriptedModel, scriptedStep, type Message, type ScriptedModel, type Step } from '../src/testing/scripted-model.ts';
import { pollUntil, freshHome, open, settings, value  } from './helpers.ts';

const words = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
function answering(messages: Message[]): Step {
  const asked = words(messages[messages.findLastIndex((m) => m.role === 'user')]);
  if (/Heartbeat check/.test(asked)) {
    if (/nothing to see/.test(asked)) return { text: 'All clear. HEARTBEAT_OK' };
    if (/leaked key/.test(asked)) return { text: 'URGENT-SECURITY: an API key was pasted into a shared note.' };
    return { text: 'The ACME invoice is overdue and needs your decision.' };
  }
  if (/Work toward the goal: (.+)/.test(asked)) return { text: `Progress on: ${/Work toward the goal: (.+)/.exec(asked)?.[1] ?? ''}` };
  if (/^Summarise/.test(asked)) return { text: 'Summary written.\nSecond line.' };
  return scriptedStep(messages);
}

let model: ScriptedModel;
before(async () => {
  model = await startScriptedModel('scripted-model', answering);
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  await model.close();
});

const local = (h: number, m = 0, day = 2) => new Date(2026, 10, day, h, m).getTime();
const full = { ...settings, permission: 'full' as const };
function clocked(home = freshHome(), start = local(8, 0)) {
  const clock = { t: start };
  const opened = open(home, { harness: 'harness-pi', schedules: { now: () => clock.t, tickMs: 25 } });
  return { ...opened, clock };
}
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  return await pollUntil(async active => {
    while (active()) {
      const v = await read();
      if (ok(v)) return v;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timed out waiting for ${what}`);
  }, "packages/platform/test/proactivity.test.ts until");
}
type H = ReturnType<typeof open>['host'];
const state = (host: H) => host.call('schedules.get', {}) as Promise<Proactivity>;
const settled = (host: H, n = 1) => until(() => state(host), (s) => s.runs.filter((r) => !['starting', 'running'].includes(r.outcome)).length >= n, `${n} settled runs`);
const project = async (host: H) => value(await host.call('projects.create', { name: 'Ops', kind: 'folder' })).id;

test('words for when are read back, or refused plainly', async () => {
  const { host } = clocked();
  const read = value(await host.call('schedules.parse', { when: 'every weekday at 9am' }));
  assert.equal(read.summary, 'Weekdays at 09:00');
  assert.equal(read.nextAt, new Date(local(9, 0)).toISOString());
  const wrong = await host.call('schedules.parse', { when: 'whenever' });
  assert.equal(wrong.ok, false);
});

test('a schedule runs when due, as a turn in its own chat, and names its next time', async () => {
  const { host, clock } = clocked();
  const projectId = await project(host);
  const s = value(await host.call('schedules.create', { projectId, text: 'Summarise the inbox', when: 'every day at 9:00', settings: full, clientKey: 'daily' }));
  assert.equal(s.nextAt, new Date(local(9, 0)).toISOString());
  assert.equal(s.threadId, null);
  const again = value(await host.call('schedules.create', { projectId, text: 'Summarise the inbox', when: 'every day at 9:00', settings: full, clientKey: 'daily' }));
  assert.equal(again.id, s.id, 'a retried create names the same schedule');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await state(host)).runs.length, 0, 'nothing runs before it is due');

  clock.t = local(9, 0);
  const done = await settled(host);
  const run = done.runs[0];
  assert.equal(run.outcome, 'done');
  assert.match(run.summary, /Summary written/);
  const made = done.schedules.find((x) => x.id === s.id)!;
  assert.ok(made.threadId);
  assert.equal(run.threadId, made.threadId);
  assert.equal(made.nextAt, new Date(local(9, 0, 3)).toISOString());
  const thread = value(await host.call('threads.get', { id: made.threadId! }));
  assert.equal(thread.turns.length, 1);
  assert.equal(thread.turns[0].user.text, 'Summarise the inbox');
});

test('runs missed while the app was closed are caught up once, then the schedule goes on', async () => {
  const home = freshHome();
  const first = clocked(home, local(8, 0));
  const projectId = await project(first.host);
  value(await first.host.call('schedules.create', { projectId, text: 'Summarise the inbox', when: 'every hour', settings: full, clientKey: 'hourly' }));
  first.host.close();
  await new Promise((r) => setTimeout(r, 50));
  const second = clocked(home, local(13, 30));
  const done = await settled(second.host);
  await new Promise((r) => setTimeout(r, 150));
  const after = await state(second.host);
  assert.equal(after.runs.length, 1, 'one run stands for all that were missed');
  assert.equal(done.runs[0].caughtUp, 5);
  assert.equal(after.schedules[0].nextAt, new Date(local(14, 0)).toISOString());
});

test('a goal schedule works toward the chat goal; a paused one waits; a deleted one is gone', async () => {
  const { host, clock } = clocked();
  const projectId = await project(host);
  const sent = value(await host.call('turns.send', { projectId, text: 'Summarise the plan', attachments: [], settings: full, clientKey: 'first' }));
  await until(() => host.call('threads.get', { id: sent.threadId }), (r) => r.ok && !r.value.summary.running, 'first turn');
  value(await host.call('goals.set', { threadId: sent.threadId, text: 'Ship the launch plan', baseVersion: 0 }));
  const s = value(await host.call('schedules.create', { projectId, threadId: sent.threadId, text: '', when: 'every day at 9:00', settings: full, clientKey: 'goal' }));
  const paused = value(await host.call('schedules.update', { id: s.id, patch: { paused: true }, baseVersion: s.version }));
  clock.t = local(9, 0);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await state(host)).runs.length, 0, 'a paused schedule does not run');
  const stale = await host.call('schedules.update', { id: s.id, patch: { paused: false }, baseVersion: s.version });
  assert.equal(stale.ok, false, 'a change made on an old version is refused');
  value(await host.call('schedules.update', { id: s.id, patch: { paused: false }, baseVersion: paused.version }));
  const done = await settled(host);
  assert.match(done.runs[0].summary, /Progress on: Ship the launch plan/);
  value(await host.call('schedules.delete', { id: s.id }));
  assert.equal((await state(host)).schedules.length, 0);
});

test('the heartbeat stays quiet, holds what needs you for the one daily brief, and tells an emergency at once', async () => {
  const { host, clock } = clocked(undefined, local(8, 10));
  const projectId = await project(host);
  const events: ApiEvent[] = [];
  host.on((e) => events.push(e));
  value(await host.call('brief.put', { time: '09:25' }));
  const hours = { start: '08:00', end: '20:00' };
  const beat = value(await host.call('heartbeat.put', { enabled: true, projectId, everyMinutes: 30, hours, check: 'nothing to see', settings: full }))!;
  assert.equal(beat.kind, 'heartbeat');
  assert.equal(beat.summary, 'Every 30 minutes, 08:00–20:00');
  assert.equal(beat.nextAt, new Date(local(8, 30)).toISOString(), 'a heartbeat keeps to the clock from the start of its hours');

  clock.t = local(8, 40);
  let s = await settled(host);
  assert.equal(s.runs[0].outcome, 'quiet');
  assert.equal(s.brief.latest, null);

  value(await host.call('heartbeat.put', { enabled: true, projectId, everyMinutes: 30, hours, check: 'look at invoices', settings: full }));
  clock.t = local(9, 20);
  s = await settled(host, 2);
  assert.equal(s.runs[0].outcome, 'needs-you');
  assert.equal(events.filter((e) => e.urgent).length, 0, 'what needs you waits for the brief');
  assert.equal(s.interruptions.briefs, 0);

  clock.t = local(9, 25);
  s = await until(() => state(host), (x) => !!x.brief.latest, 'the daily brief');
  const brief = s.brief.latest!;
  assert.equal(brief.items.length, 1);
  assert.match(brief.items[0].title, /ACME invoice/);
  assert.equal(brief.items[0].threadId, s.runs[0].threadId);
  assert.equal(s.interruptions.briefs, 1);
  clock.t = local(9, 26);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal((await state(host)).interruptions.briefs, 1, 'at most one brief a day');
  const handled = value(await host.call('brief.done', { id: brief.items[0].id }));
  assert.equal(handled.items[0].done, true);

  value(await host.call('heartbeat.put', { enabled: true, projectId, everyMinutes: 30, hours, check: 'leaked key watch', settings: full }));
  clock.t = local(9, 45);
  s = await until(() => state(host), (x) => x.runs[0]?.outcome === 'emergency', 'an emergency');
  assert.equal(s.interruptions.emergencies.length, 1);
  assert.equal(s.interruptions.emergencies[0].kind, 'security');
  assert.ok(events.some((e) => e.topic === 'schedules' && /API key/.test(e.urgent ?? '')));

  clock.t = local(20, 30);
  await new Promise((r) => setTimeout(r, 120));
  const quietHours = await state(host);
  assert.equal(quietHours.runs.filter((r: ScheduleRun) => r.kind === 'heartbeat').length, 3, 'nothing runs outside active hours');
  assert.equal(quietHours.heartbeat!.nextAt, new Date(local(8, 0, 3)).toISOString());

  assert.equal(value(await host.call('heartbeat.put', { enabled: false, projectId, everyMinutes: 30, hours, check: '', settings: full })), null);
  assert.equal((await state(host)).heartbeat, null);
});

test('running a schedule now is idempotent by its key', async () => {
  const { host } = clocked();
  const projectId = await project(host);
  const s = value(await host.call('schedules.create', { projectId, text: 'Summarise the inbox', when: 'every monday at 7', settings: full, clientKey: 'weekly' }));
  const a = value(await host.call('schedules.run', { id: s.id, clientKey: 'now-1' }));
  const b = value(await host.call('schedules.run', { id: s.id, clientKey: 'now-1' }));
  assert.equal(a.id, b.id);
  const done = await settled(host);
  assert.equal(done.runs.length, 1);
  assert.equal(done.schedules[0].nextAt, s.nextAt, 'running now leaves the schedule as it was');
});

test('a host waits for a tick in flight at close: housekeeping started before close never recreates a removed home', async () => {
  const { createProactivity } = await import('../src/composition/proactivity.ts');
  const { freshDir } = await import('./helpers.ts');
  let finishDaily!: () => void;
  let dailyCalls = 0;
  const daily = () => { dailyCalls++; return new Promise<void>((resolve) => { finishDaily = resolve; }); };
  let closing = false;
  const p = createProactivity({
    home: freshDir('proactivity-close-'), threads: new Map(), now: Date.now, tickMs: 3_600_000, readOnly: false, ready: Promise.resolve(),
    closing: () => closing, projectExists: () => false, admit: async () => { throw new Error('no admission here'); }, emit: () => {}, daily, material: { load: () => null },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(dailyCalls, 1, 'the first tick reached the daily housekeeping');
  closing = true;
  p.close();
  let idle = false;
  const waiting = p.whenIdle().then(() => { idle = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(idle, false, 'close does not report idle while housekeeping still runs');
  finishDaily();
  await waiting;
  assert.equal(idle, true);
});

test('a schedule admitted while the host closes starts no worker: no model call after close begins', async () => {
  const { withHomeLock } = await import('../src/composition/home-lock.ts');
  const { hostClosed } = await import('../src/composition/host.ts');
  const { host, home, clock } = clocked();
  const projectId = await project(host);
  value(await host.call('schedules.create', { projectId, text: 'Summarise the inbox', when: 'every day at 9:00', settings: full, clientKey: 'closing' }));
  // Hold the home lock, so the due run waits at admission.
  let release!: () => void;
  const holding = new Promise<void>((resolve) => { release = resolve; });
  let held!: () => void;
  const taken = new Promise<void>((resolve) => { held = resolve; });
  const lock = withHomeLock(home, async () => { held(); await holding; });
  await taken;
  clock.t = local(9, 0);
  await until(() => state(host), (s) => s.runs.some((r) => r.outcome === 'starting'), 'a run waiting at admission');
  const asked = () => model.requests.filter((r) => r.body.includes('Summarise the inbox')).length;
  const before = asked();
  host.close();
  release();
  await lock;
  await hostClosed(home);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(asked(), before, 'nothing admitted after close began reaches the model');
});
