// Scripted native engine over real Host controls; no native client or account call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHost, removeDataHome, type Host } from '../src/composition/host.ts';
import { CoreLink } from '../src/composition/core.ts';
import { PIECE_DIRS } from '../src/composition/pieces.ts';
import { pieceDigest, pieceFiles } from '../src/pieces/digest.ts';
import { freshDataHome } from '../src/testing/data-home.ts';
import { withHomeLock, assertHomeWriteAdmission } from '../src/composition/home-lock.ts';
import { ThreadJournal } from '../src/composition/thread-journal.ts';
import { waitFor } from '../../../scripts/lib/test-hang.ts';
import type { Receipt, Thread } from '../src/api.ts';
const value = <T>(r: Receipt<T>): T => { if (!r.ok) throw new Error(r.detail); return r.value; };

for (const readOnly of [true, false]) test(`Stop after native activity readOnly=${readOnly}: controls use possible writes, without an unknown marker`, { timeout: 60_000 }, async t => {
  const home = freshDataHome('native-controls');
  const fixture = mkdtempSync(join(tmpdir(), 'native-controls-piece-'));
  const savedModel = process.env.BACKBONE_CODEX_MODEL; process.env.BACKBONE_CODEX_MODEL = 'controlled';
  let host: Host | undefined;
  t.after(async () => {
    host?.close(); await CoreLink.whenClosed(home); await removeDataHome(home); rmSync(fixture, { recursive: true, force: true });
    if (savedModel === undefined) delete process.env.BACKBONE_CODEX_MODEL; else process.env.BACKBONE_CODEX_MODEL = savedModel;
  });
  for (const path of pieceFiles(PIECE_DIRS['harness-codex'])) { const to = join(fixture, path); mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(PIECE_DIRS['harness-codex'], path), to); }
  writeFileSync(join(fixture, 'src/index.ts'), `export function createCodexHarness(){return {
    specificationVersion:'v1',id:'controlled',label:'Controlled native fixture',async listModels(){return [{id:'controlled',label:'Controlled',efforts:[3]}]},
    start(request){
      let finish; const outcome=new Promise(resolve=>finish=resolve);
      return {events:(async function*(){
        if(request.text!=='Activity'){finish({status:'done',answer:'Ready',usage:{input:0,output:0}});return;}
        yield {type:'tool',tool:'native_connector',readOnly:${readOnly},id:'call',phase:'done',label:'Codex connector fake / tool'};
      })(),outcome,stop(){finish({status:'interrupted',answer:'',usage:{input:0,output:0}})},steer(){}};
    }
  }}`);
  const path = join(fixture, 'backbone.module.json'); const manifest = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...manifest, digest: pieceDigest(fixture) }));
  const open = () => createHost({ home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  host = open();
  const project = value(await host.call('projects.create', { name: 'Controls', kind: 'folder' }));
  const settings = { permission: 'full', model: 'controlled', effort: 3, runsOn: 'this-computer', mode: 'chat' } as const;
  const base = value(await host.call('turns.send', { projectId: project.id, text: 'Base', attachments: [], settings, clientKey: 'base' }));
  await waitFor(async () => !value(await host!.call('threads.get', { id: base.threadId })).summary.running, 'base turn');
  const sent = value(await host.call('turns.send', { threadId: base.threadId, projectId: project.id, text: 'Activity', attachments: [], settings, clientKey: 'activity' }));
  await waitFor(async () => value(await host!.call('threads.get', { id: sent.threadId })).turns.at(-1)!.work.steps.length > 0, 'native activity persisted');
  value(await host.call('turns.stop', { threadId: sent.threadId, turnId: sent.turnId }));
  let thread!: Thread;
  await waitFor(async () => { thread = value(await host!.call('threads.get', { id: sent.threadId })); return !thread.summary.running; }, 'stopped native turn');
  const turn = thread.turns.at(-1)!;
  if (!readOnly) for (const step of turn.work.steps) assert.equal(new Date(step.at!).toISOString(), step.at, 'possible-write step has an ISO observation time');
  assert.equal(turn.status, 'stopped'); assert.equal(turn.unknownOutcome, undefined); assert.equal(turn.nativeAccountActivity === true, !readOnly);
  assert.equal((await host.call('threads.rewindPreview', { threadId: sent.threadId, turnId: base.turnId })).ok, readOnly);
  const restart = await host.call('threads.restart', { threadId: sent.threadId, turnId: sent.turnId });
  assert.equal(restart.ok, readOnly, JSON.stringify(restart));
  if (!restart.ok) { assert.match(restart.detail, /Native account activity/); assert.match(restart.detail, /I checked this myself/); }
  if (!readOnly) {
    for (const failed of [false, true]) {
      host.close(); await CoreLink.whenClosed(home);
      // Engine failure is a refused turn with failure detail; exercise both terminal variants.
      await withHomeLock(home, async () => {
        const path = join(home, 'threads', `${sent.threadId}.json`);
        const stored = JSON.parse(readFileSync(path, 'utf8')); stored.turns.at(-1).status = 'refused';
        if (failed) stored.turns.at(-1).failure = { detail: 'Scripted engine failure' };
        else delete stored.turns.at(-1).failure;
        assertHomeWriteAdmission(home, dirname(path)); writeFileSync(path, JSON.stringify(stored));
        await new ThreadJournal(home).append({ kind: 'turn.closed', threadId: sent.threadId, turnId: sent.turnId, state: { status: 'refused', effects: [], nativeAccountActivity: true, ...(failed ? { failure: { detail: 'Scripted engine failure' } } : {}) } });
      });
      host = open();
      assert.equal(!!value(await host.call('threads.get', { id: sent.threadId })).turns.at(-1)!.failure, failed);
      const refused = await host.call('threads.restart', { threadId: sent.threadId, turnId: sent.turnId });
      assert.equal(refused.ok, false); if (!refused.ok) assert.match(refused.detail, /Native account activity/);
      const rewind = await host.call('threads.rewindPreview', { threadId: sent.threadId, turnId: base.turnId });
      assert.equal(rewind.ok, false);
      if (!rewind.ok) { assert.match(rewind.detail, /Native account activity/); assert.match(rewind.detail, /I checked this myself/); }
    }
    const q = value(await host.unknownChecks.question(sent));
    assert.match(q.steps.map(s => s.label).join(' '), /fake \/ tool/);
    assert.ok(q.steps.every(s => !Number.isNaN(Date.parse(s.at))));
    value(await host.unknownChecks.check({ ...sent, revision: q.revision }));
    assert.equal((await host.call('threads.rewindPreview', { threadId: sent.threadId, turnId: base.turnId })).ok, true);
    const ended = await host.call('threads.restart', sent);
    assert.equal(ended.ok, false);
    if (!ended.ok) assert.match(ended.detail, /already finished.*new message/);
    value(await host.call('turns.send', { threadId: sent.threadId, projectId: project.id, text: 'Continue after inspection', attachments: [], settings, clientKey: 'checked-continuation' }));
    await waitFor(async () => !value(await host!.call('threads.get', { id: sent.threadId })).summary.running, 'checked native continuation');

  }
});
