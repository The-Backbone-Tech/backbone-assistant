// Child process for the task-board kill tests: a chat with one card on its board, and the pool started.
// With BACKBONE_CRASH_AT the host kills itself at that point of the worker's write; on Pi the test kills
// this process while the worker's model call is held. The ids are written before the worker starts.
import { createHost } from '../src/composition/host.ts';

const [home, brief] = process.argv.slice(2);
const settings = { permission: 'ask', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' } as const;
const host = createHost({ home });
const must = <T>(r: { ok: true; value: T } | { ok: false; detail: string }) => { if (!r.ok) throw new Error(r.detail); return r.value; };
const project = must(await host.call('projects.create', { name: 'P', kind: 'folder' }));
const sent = must(await host.call('turns.send', { projectId: project.id, text: 'Hello', attachments: [], settings, clientKey: 'first' }));
for (;;) {
  if (!must(await host.call('threads.get', { id: sent.threadId })).summary.running) break;
  await new Promise((r) => setTimeout(r, 10));
}
const card = must(await host.call('board.add', { threadId: sent.threadId, title: 'The card', brief, clientKey: 'card' }));
console.log(JSON.stringify({ parent: sent.threadId, project: project.id, card: card.id }));
await host.resumeInterrupted();
await new Promise((r) => setTimeout(r, 20_000));
console.error('the worker finished without being killed');
