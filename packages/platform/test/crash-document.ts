// Controlled native-port crash fixture. Source seeding is test setup, not an app capability claim.
import { randomUUID } from 'node:crypto';
import { createHost } from '../src/composition/host.ts';
import { MaterialStore } from '../src/stub/material.ts';
import type { MaterialEntry } from '../src/api.ts';

const [home, piece, staleTarget, mode] = process.argv.slice(2);
const host = createHost({ home, harness: 'harness-codex', pieceDirs: { 'harness-codex': piece } });
if (mode === 'resume-existing') {
  await host.resumeInterrupted();
  setTimeout(() => { console.error('Recovery did not reach its crash cut.'); host.close(); process.exitCode = 1; }, 15_000);
} else {
const project = await host.call('projects.create', { name: 'Recovery fixture', kind: 'folder' });
if (!project.ok) throw new Error(project.detail);
const material = new MaterialStore(home, {}, () => {});
let source: MaterialEntry;
const twoOriginals = mode === 'pending-two-originals';
if (mode === 'pending-original' || twoOriginals) {
  const attached = await host.call('material.attach', { projectId: project.value.id, name: 'source.md', base64: Buffer.from('person source v1').toString('base64'), mediaType: 'text/markdown' });
  if (!attached.ok) throw new Error(attached.detail);
  source = attached.value;
} else source = material.create(project.value.id, 'source.md', 'text/markdown', Buffer.from('person source v1'), 'working', 'person', randomUUID(), 'managed');
let second: MaterialEntry | undefined;
if (twoOriginals) {
  const attached = await host.call('material.attach', { projectId: project.value.id, name: 'second.md', base64: Buffer.from('Second immutable source.').toString('base64'), mediaType: 'text/markdown' });
  if (!attached.ok) throw new Error(attached.detail);
  second = attached.value;
  // The controlled producer invokes the public API only after it has read and checkpointed both originals.
  Object.assign(globalThis, { withdrawFirstForFixture: async () => {
    const withdrawn = await host.call('material.lifecycle', { id: source.id, version: 1, state: 'withdrawn', lifecycle: 0 });
    if (!withdrawn.ok) throw new Error(withdrawn.detail);
  } });
}
const pending = mode === 'pending' || mode === 'pending-original' || mode === 'pending-new' || twoOriginals;
if (staleTarget && !twoOriginals && mode !== 'pending-new') {
  const target = material.create(project.value.id, staleTarget, 'text/markdown', Buffer.from('Original target.'), 'working', 'agent', randomUUID(), 'managed');
  if (!pending) {
    const saved = await material.save(target.id, 'Person version two.', 1);
    if (!saved.ok) throw new Error(saved.detail);
  }
}
console.log(JSON.stringify({ projectId: project.value.id, sourceId: source.id, ...(second ? { secondId: second.id } : {}) }));
const sent = await host.call('turns.send', { projectId: project.value.id, text: staleTarget ? JSON.stringify({ name: staleTarget, staleTarget: !pending, checkpoint: true, ...(twoOriginals ? { twoWithdrawals: true } : {}) }) : 'Create the managed decision note from this source.', attachments: [source.id, ...(second ? [second.id] : [])],
  settings: { permission: 'full', model: 'controlled', effort: 4, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'controlled-original' });
if (!sent.ok) throw new Error(sent.detail);
console.log(JSON.stringify(sent.value));
setTimeout(() => { console.error('The controlled fixture did not reach its crash cut.'); host.close(); process.exitCode = 1; }, 15_000);

}
