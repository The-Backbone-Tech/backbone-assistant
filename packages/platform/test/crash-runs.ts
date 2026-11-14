// Child process for the restart tests of background runs: a goal run, a trigger's run or a schedule's
// run on a turn whose words are `ask`. With BACKBONE_CRASH_AT the host kills itself at that point of
// the turn's write; otherwise the test kills this process while the turn's model call is held. The
// ids are printed once the run's turn exists.
import { createHost } from '../src/composition/host.ts';

const [home, kind, ask] = process.argv.slice(2);
const settings = { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' } as const;
const host = createHost({ home, schedules: { tickMs: 25 }, triggers: { debounceMs: 50 } });
const must = <T>(r: { ok: true; value: T } | { ok: false; detail: string }) => { if (!r.ok) throw new Error(r.detail); return r.value; };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
await host.resumeInterrupted();
const project = must(await host.call('projects.create', { name: 'P', kind: 'folder' }));
const say = (ids: Record<string, string>) => console.log(JSON.stringify({ project: project.id, ...ids }));

if (kind === 'goal') {
  const sent = must(await host.call('turns.send', { projectId: project.id, text: 'Hello', attachments: [], settings, clientKey: 'first' }));
  while (must(await host.call('threads.get', { id: sent.threadId })).summary.running) await pause(10);
  must(await host.call('goals.set', { threadId: sent.threadId, text: ask, baseVersion: 0 }));
  must(await host.call('goals.run', { threadId: sent.threadId, budget: 3 }));
  say({ thread: sent.threadId });
} else if (kind === 'trigger') {
  const made = must(await host.call('triggers.create', { kind: 'webhook', projectId: project.id, text: ask, settings, clientKey: 'hook' }));
  const r = await fetch(made.trigger.url!, { method: 'POST', body: '{"note":"go"}', headers: { 'content-type': 'application/json', authorization: `Bearer ${made.secret}` } });
  if (r.status !== 202) throw new Error(`the webhook answered ${r.status}`);
  for (;;) {
    const run = (await host.call('triggers.get', {})).runs[0];
    if (run?.turnId) { say({ trigger: made.trigger.id, run: run.id, thread: run.threadId! }); break; }
    await pause(10);
  }
} else {
  const s = must(await host.call('schedules.create', { projectId: project.id, text: ask, when: 'every day at 9:00', settings, clientKey: 'schedule' }));
  const run = must(await host.call('schedules.run', { id: s.id, clientKey: 'now' }));
  say({ schedule: s.id, run: run.id, thread: run.threadId! });
}
await pause(20_000);
console.error('the run finished without being killed');
