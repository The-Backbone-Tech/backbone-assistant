// The harness slot's real replacement, on one data home: Pi → the installed Codex client → Pi.
// A person's saved version, an interrupted write left UNKNOWN and the thread must all survive each
// swap, and the same assertions must hold on both engines. Spends the signed-in client's quota.
//
//   node packages/platform/examples/swap-engines.ts [codex model]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Receipt, TurnSettings } from '../src/api.ts';
import { CoreLink } from '../src/composition/core.ts';
import { createHost, type Host, removeDataHome } from '../src/composition/host.ts';
import { freshDataHome } from '../src/testing/data-home.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';

const codexModel = process.argv[2] ?? 'gpt-6.1-terra';
const scripted = await startScriptedModel();
const pi = { BACKBONE_MODEL_ENDPOINT: scripted.url, BACKBONE_MODEL_ID: scripted.model };
Object.assign(process.env, pi);
const home = freshDataHome('swap');
const value = <T>(r: Receipt<T>): T => { if (!r.ok) throw new Error(r.detail); return r.value; };
const settled = async (host: Host, id: string) => {
  for (;;) {
    const thread = value(await host.call('threads.get', { id }));
    if (!thread.summary.running) return thread;
    await new Promise((r) => setTimeout(r, 250));
  }
};
const closed = async (host: Host) => { host.close(); await CoreLink.whenClosed(home); };

try {
  // An interrupted write, killed mid-dispatch: its outcome is truly unknown.
  const child = spawn(process.execPath, [join(import.meta.dirname, '../test/crash-turn.ts'), home], {
    env: { ...process.env, BACKBONE_HARNESS: 'harness-pi', BACKBONE_CRASH_AT: 'write.begun' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.on('data', (b: Buffer) => (out += b));
  await new Promise((r) => child.on('exit', r));
  const interrupted = JSON.parse(out.trim().split('\n').at(-1)!) as { threadId: string; projectId: string };

  // Pi: continuing work and a person's edit.
  let host = createHost({ home, harness: 'harness-pi' });
  await new Promise((r) => setTimeout(r, 7000));
  const unknown = async (h: Host) => {
    const turn = (await settled(h, interrupted.threadId)).turns[0];
    assert.equal(turn.effects[0].outcome, 'UNKNOWN');
    assert.equal((await h.call('material.list', { projectId: interrupted.projectId })).filter((m) => m.name === 'brief.md').length, 0);
  };
  await unknown(host);
  const piSettings: TurnSettings = { permission: 'ask', model: scripted.model, effort: 3, runsOn: 'this-computer', mode: 'chat' };
  const p = value(await host.call('projects.create', { name: 'Work', kind: 'folder' }));
  const note = value(await host.call('material.attach', { projectId: p.id, name: 'note.md', base64: Buffer.from('# Q3\nRevenue up 4%.\n').toString('base64'), mediaType: 'text/markdown' }));
  const first = value(await host.call('turns.send', { projectId: p.id, text: 'Write an editable brief from this', attachments: [note.id], settings: piSettings, clientKey: 'one' }));
  await settled(host, first.threadId);
  const brief = (await host.call('material.list', { projectId: p.id })).find((m) => m.name === 'brief.md')!;
  value(await host.call('material.save', { id: brief.id, text: '# Brief\n\nThe person decided: launch on Friday 14.\n', baseVersion: 1 }));
  const kept = async (h: Host) => {
    const entry = (await h.call('material.list', { projectId: p.id })).find((m) => m.name === 'brief.md')!;
    assert.deepEqual([entry.id, entry.current], [brief.id, 2]);
    assert.match(value(await h.call('material.read', { id: entry.id })).text!, /launch on Friday 14/);
    await unknown(h);
  };
  await kept(host);
  await closed(host);

  // Replaced by the installed Codex client on the same home: the same thread continues.
  delete process.env.BACKBONE_MODEL_ENDPOINT; delete process.env.BACKBONE_MODEL_ID;
  host = createHost({ home, harness: 'harness-codex' });
  await kept(host);
  value(await host.call('settings.model.put', { change: { route: 'native', provider: 'codex', model: codexModel } }));
  const native = value(await host.call('turns.send', { threadId: first.threadId, projectId: p.id, text: 'Read brief.md and write decision.md with one line stating the launch date.', attachments: [brief.id], settings: { permission: 'full', model: codexModel, effort: 2, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'two' }));
  const thread = await settled(host, native.threadId);
  const turn = thread.turns.at(-1)!;
  console.log('codex turn:', turn.status, turn.work.harness, turn.effects.map((e) => `${e.outcome}`), turn.answer?.text);
  assert.equal(turn.status, 'done'); assert.equal(turn.effects.at(-1)?.outcome, 'DONE');
  const decision = (await host.call('material.list', { projectId: p.id })).find((m) => m.name === 'decision.md')!;
  assert.match(value(await host.call('material.read', { id: decision.id })).text!, /14/);
  await kept(host);
  await closed(host);

  // And back: Pi reads what Codex wrote and what the person saved.
  Object.assign(process.env, pi);
  host = createHost({ home, harness: 'harness-pi' });
  await kept(host);
  assert.equal(value(await host.call('threads.get', { id: first.threadId })).turns.length, 2);
  const again = value(await host.call('turns.send', { threadId: first.threadId, projectId: p.id, text: 'Write an editable brief from these', attachments: [decision.id], settings: piSettings, clientKey: 'three' }));
  const last = (await settled(host, again.threadId)).turns.at(-1)!;
  console.log('pi turn:', last.status, last.work.harness, last.work.steps.map((s) => s.label));
  assert.ok(last.work.steps.some((s) => s.label === 'Read decision.md v1'));
  await closed(host);
  console.log('swap: work, thread, person v2 and UNKNOWN preserved across Pi → Codex → Pi');
} finally {
  await scripted.close();
  await removeDataHome(home);
}
