// Try the platform alone, headless: the `api` port the app calls, backed by the real core in a
// temporary data home, with the stub harness (it calls no model, so no key and no network).
//   node packages/platform/examples/try-platform.mjs
// The data home's embedded PostgreSQL listens on 127.0.0.1: a sandbox that blocks local listening
// fails at step 2 with `listen EPERM`. Everything it made is removed at the end, database included.
// Exit 0 means every step behaved as described; any mismatch exits 1.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost, removeDataHome } from '@backbone-next/platform/composition';
import { plaintextKeys } from '@backbone-next/platform/keys';

const home = mkdtempSync(join(tmpdir(), 'backbone-try-platform-'));
const say = (step, text) => console.log(`${step}. ${text}`);
const value = (r) => {
  if (!r.ok) throw new Error(`refused: ${r.reason}: ${r.detail}`);
  return r.value;
};
const b64 = (s) => Buffer.from(s).toString('base64');
let host;

try {
  // A throwaway home: its keys stay in plain text by this explicit choice (the app keeps a real
  // home's keys in the Keychain, and refuses a home like this one).
  host = createHost({ home, harness: 'harness-stub', keys: plaintextKeys() });
  const project = value(await host.call('projects.create', { name: 'Q4 review', kind: 'folder' }));
  say(1, `Project "${project.name}" created in a fresh data home.`);

  const note = value(await host.call('material.attach', { projectId: project.id, name: 'note.md', base64: b64('# Revenue\nUp 4%.\n'), mediaType: 'text/markdown' }));
  const settings = { permission: 'ask', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' };
  const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Write an editable brief from these', attachments: [note.id], settings, clientKey: 'try-1' }));
  say(2, `Attached ${note.name} as an original and sent a turn (thread ${sent.threadId.slice(0, 8)}…).`);

  let thread;
  for (let i = 0; i < 500; i++) {
    thread = value(await host.call('threads.get', { id: sent.threadId }));
    if (!thread.summary.running) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const turn = thread.turns[0];
  assert.equal(turn.status, 'done', JSON.stringify(turn.refusal ?? turn.status));
  say(3, `Turn ${turn.status} on "${turn.work.harness}", ${turn.work.steps.length} work steps.`);

  const write = turn.effects.find((e) => e.target === 'brief.md');
  assert.equal(write?.outcome, 'DONE', JSON.stringify(turn.effects));
  say(4, `Its write went through the core's gateway: ${write.kind} ${write.target}, outcome ${write.outcome}.`);

  const brief = (await host.call('material.list', { projectId: project.id })).find((m) => m.name === 'brief.md');
  assert.equal(brief?.class, 'working', JSON.stringify(brief));
  const saved = value(await host.call('material.save', { id: brief.id, text: '# Brief\nShip Friday.\n', baseVersion: brief.current }));
  assert.equal(saved.class, 'accepted');
  say(5, `brief.md was a working copy (v${brief.current}); the person's Save made it accepted (v${saved.current}).`);

  const stale = await host.call('material.save', { id: brief.id, text: '# Brief\nOld base.\n', baseVersion: brief.current });
  assert.equal(stale.ok, false, 'a save on a stale base was accepted');
  say(6, `A save against the old version is refused (${stale.reason}); nothing is overwritten.`);
  console.log('OK: project, attachment, turn, gateway write, Save and refusal all behaved as documented.');
} catch (error) {
  console.error(`FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  host?.close();
  await removeDataHome(home).catch(() => {});
}
