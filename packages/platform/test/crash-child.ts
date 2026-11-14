// Child process for the parallel-work kill tests: a parent thread starts one child and the host kills
// itself at BACKBONE_CRASH_AT during the child's write. On Pi the parent turn starts the child itself.
import { createHost } from '../src/composition/host.ts';

const [home] = process.argv.slice(2);
const pi = process.env.BACKBONE_HARNESS === 'harness-pi';
const settings = { permission: 'ask', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' } as const;
const host = createHost({ home });
const must = <T>(r: { ok: true; value: T } | { ok: false; detail: string }) => { if (!r.ok) throw new Error(r.detail); return r.value; };
const project = must(await host.call('projects.create', { name: 'P', kind: 'folder' }));
const sent = must(await host.call('turns.send', { projectId: project.id, text: pi ? 'Delegate the brief' : 'Hello', attachments: [], settings, clientKey: 'first' }));
// Written before the child starts, so the test knows the ids however soon the kill comes.
const report = (child: string) => console.log(JSON.stringify({ parent: sent.threadId, child, project: project.id }));
if (pi) {
  report('');
} else {
  for (;;) {
    const t = must(await host.call('threads.get', { id: sent.threadId }));
    if (!t.summary.running) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  // The id is not known until the receipt, and the write may kill first: it is fixed by a pre-chosen title.
  const started = host.call('children.start', { parentThreadId: sent.threadId, text: 'Write an editable brief', role: 'worker', clientKey: 'crash' });
  for (;;) {
    const kids = must(await host.call('threads.get', { id: sent.threadId })).children ?? [];
    if (kids[0]) { report(kids[0].threadId); break; }
    await new Promise((r) => setTimeout(r, 1));
  }
  await started;
}
await new Promise((r) => setTimeout(r, 20_000));
console.error('the turn finished without crashing');
