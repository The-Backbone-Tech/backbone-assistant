// Child process for the withdrawal recovery tests: attaches a source, sends one brief request and lets
// the host kill itself at BACKBONE_CRASH_AT. It prints what it started before the kill.
import { createHost } from '../src/composition/host.ts';

const [home] = process.argv.slice(2);
const host = createHost({ home });
const p = await host.call('projects.create', { name: 'P', kind: 'folder' });
if (!p.ok) throw new Error(p.detail);
const attached = await host.call('material.attach', { projectId: p.value.id, name: 'hiring.md', base64: Buffer.from('Kestrel\n').toString('base64'), mediaType: 'text/markdown' });
if (!attached.ok) throw new Error(attached.detail);
console.log(JSON.stringify({ projectId: p.value.id, sourceId: attached.value.id }));
const sent = await host.call('turns.send', { projectId: p.value.id, text: 'Draft a brief for the launch', attachments: [attached.value.id],
  settings: { permission: 'ask', model: 'scripted-model', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'k' });
if (!sent.ok) throw new Error(sent.detail);
console.log(JSON.stringify({ threadId: sent.value.threadId }));
await new Promise((r) => setTimeout(r, 20_000));
console.error('the turn finished without crashing');
