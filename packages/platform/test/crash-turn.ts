// Child process for the kill-during-dispatch test on Pi: sends one brief request and lets the
// host kill itself at BACKBONE_CRASH_AT. It prints the thread it started before the kill.
import { createHost } from '../src/composition/host.ts';

const [home] = process.argv.slice(2);
const host = createHost({ home });
const p = await host.call('projects.create', { name: 'P', kind: 'folder' });
if (!p.ok) throw new Error(p.detail);
const sent = await host.call('turns.send', {
  projectId: p.value.id,
  text: 'Draft a brief for the launch',
  attachments: [],
  settings: { permission: 'ask', model: 'scripted-model', effort: 3, runsOn: 'this-computer', mode: 'chat' },
  clientKey: 'k',
});
if (!sent.ok) throw new Error(sent.detail);
console.log(JSON.stringify({ threadId: sent.value.threadId, projectId: p.value.id }));
await new Promise((r) => setTimeout(r, 20_000));
console.error('the turn finished without crashing');
