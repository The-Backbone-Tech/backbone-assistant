// Child of sidechat-host-recovery.integration.test.ts; the parent kills it during a loopback model call.
import { createHost } from '../src/composition/host.ts';
import type { TurnSettings } from '../src/api.ts';

const home = process.argv[2];
const host = createHost({ home, harness: 'harness-pi' });
const value = <T>(result: { ok: true; value: T } | { ok: false; detail: string }): T => { if (!result.ok) throw new Error(result.detail); return result.value; };
const project = value(await host.call('projects.create', { name: 'Side crash', kind: 'folder' }));
const settings: TurnSettings = { permission: 'ask', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' };
const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Main question', attachments: [], settings, clientKey: 'main' }));
for (;;) {
  const thread = value(await host.call('threads.get', { id: sent.threadId }));
  if (!thread.summary.running) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
process.stdout.write(`${JSON.stringify(sent)}\n`);
await host.call('sidechat.ask', { threadId: sent.threadId, text: 'SIDE HOST CRASH', clientKey: 'side-crash-key' });
throw new Error('The parent was expected to kill this child during side inference.');
