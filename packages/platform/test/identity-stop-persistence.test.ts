// A Stop authorizes and aborts under its identity admission; its save waits for the data-folder
// lock without holding that admission. Stops pending on persistence must never use up the reserve
// a further Stop and the status reads need (independent review M1, 14 Nov 2026).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { waitFor } from '../../../scripts/lib/test-hang.ts';
import { withHomeLock } from '../src/composition/home-lock.ts';
import { readJson } from '../src/stub/fsx.ts';
import { startScriptedModel, scriptedStep } from '../src/testing/scripted-model.ts';
import { randomUUID } from 'node:crypto';
import { freshHome, idle, open, settings, value } from './helpers.ts';

test('four Stops waiting to save leave a further threads.get and Stop served while ordinary reads queue behind a held lock', async () => {
  let releaseModel!: () => void;
  const held = new Promise<void>((resolve) => { releaseModel = resolve; });
  const model = await startScriptedModel('stop-persistence', scriptedStep, { before: async () => { await held; } });
  const endpoint = process.env.BACKBONE_MODEL_ENDPOINT, modelId = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  let releaseLock!: () => void;
  try {
    const ctx = open(freshHome(), { harness: 'harness-pi' });
    const p = value(await ctx.host.call('projects.create', { name: 'P', kind: 'folder' }));
    // Five running turns, each waiting for its model.
    const sent: { threadId: string; turnId: string }[] = [];
    for (let i = 0; i < 5; i++) sent.push(value(await ctx.host.call('turns.send', { projectId: p.id, text: `Draft a brief ${i}`, attachments: [], settings, clientKey: `t${i}` })));
    await waitFor(async () => model.requests.length >= 5, 'five turns reach their model');
    // An unrelated holder keeps the data-folder lock.
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
    const holder = withHomeLock(ctx.home, async () => { locked(); await new Promise<void>((resolve) => { releaseLock = resolve; }); });
    await lockHeld;
    // Eight ordinary readers wait for that lock, holding every ordinary admission connection.
    let readsDone = 0;
    const reads = Array.from({ length: 8 }, (_, i) => (i % 2 ? ctx.host.call('work.now', { projectId: p.id }) : ctx.host.call('material.list', { projectId: p.id })).then(() => { readsDone++; }));
    // Four Stops abort at once and then wait for the lock to save their records.
    let stopsDone = 0;
    const stops = sent.slice(0, 4).map((s) => ctx.host.call('turns.stop', { threadId: s.threadId }).then((r) => { stopsDone++; return r; }));
    await waitFor(async () => {
      const turns = await Promise.all(sent.slice(0, 4).map(async (s) => value(await ctx.host.call('threads.get', { id: s.threadId })).turns.at(-1)));
      return turns.every((turn) => turn?.stopRequested);
    }, 'the four Stops have acted');
    // A further status read and a fifth Stop are served while everything above still waits.
    const thread = value(await ctx.host.call('threads.get', { id: sent[4].threadId }));
    assert.equal(thread.summary.running, true);
    const fifth = ctx.host.call('turns.stop', { threadId: sent[4].threadId });
    await waitFor(async () => value(await ctx.host.call('threads.get', { id: sent[4].threadId })).turns.at(-1)?.stopRequested === true, 'the fifth Stop has acted');
    assert.equal(readsDone, 0, 'the ordinary readers still wait for the lock');
    assert.equal(stopsDone, 0, 'a Stop is acknowledged only after its record is saved');
    releaseLock();
    await holder;
    const answers = await Promise.all([...stops, fifth]);
    await Promise.all(reads);
    for (const [i, answer] of answers.entries()) {
      assert.equal(value(answer).stopped, true);
      const onDisk = readJson<{ turns: { stopRequested?: boolean }[] }>(join(ctx.home, 'threads', `${sent[i].threadId}.json`), null as never);
      assert.equal(onDisk.turns.at(-1)?.stopRequested, true, 'recorded before the Stop was acknowledged');
    }
    ctx.host.close();
  } finally {
    releaseLock?.(); releaseModel();
    process.env.BACKBONE_MODEL_ENDPOINT = endpoint; process.env.BACKBONE_MODEL_ID = modelId;
    await model.close();
  }
});

// The Stop's admission now ends after it authorized and aborted, before its save. Removal may
// therefore overlap that save; it cannot overlap the authorization, and a later Stop from the
// removed person is refused at admission.
test('a removed person\'s next Stop is refused while their earlier Stop is still saving', async () => {
  let releaseModel!: () => void;
  const held = new Promise<void>((resolve) => { releaseModel = resolve; });
  const model = await startScriptedModel('stop-removal', scriptedStep, { before: async () => { await held; } });
  const endpoint = process.env.BACKBONE_MODEL_ENDPOINT, modelId = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  let releaseLock: (() => void) | undefined;
  try {
    const ctx = open(freshHome(), { harness: 'harness-pi' });
    const project = value(await ctx.host.call('projects.create', { name: 'Team', kind: 'folder' }));
    const invitation = value(await ctx.host.call('identity.invite', { role: 'member' }));
    const joined = value(await ctx.host.acceptInvitation(invitation.token, 'Member'));
    value(await ctx.host.call('identity.share', { projectId: project.id, personId: joined.person.id, access: 'editor' }));
    const first = value(await ctx.host.callAuthenticated(joined.session, 'turns.send', { projectId: project.id, text: 'Draft a team brief', settings, attachments: [], clientKey: randomUUID() }));
    const second = value(await ctx.host.callAuthenticated(joined.session, 'turns.send', { projectId: project.id, text: 'Draft a second brief', settings, attachments: [], clientKey: randomUUID() }));
    await waitFor(async () => model.requests.length >= 2, 'both turns reach their model');
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
    const holder = withHomeLock(ctx.home, async () => { locked(); await new Promise<void>((resolve) => { releaseLock = resolve; }); });
    await lockHeld;
    const stop = ctx.host.callAuthenticated(joined.session, 'turns.stop', { threadId: first.threadId });
    await waitFor(async () => value(await ctx.host.call('threads.get', { id: first.threadId })).turns.at(-1)?.stopRequested === true, 'the member\'s Stop has acted');
    let stopAnswered = false;
    void stop.then(() => { stopAnswered = true; }, () => { stopAnswered = true; });
    // With the lock still held, the removal commits while the earlier Stop is still saving.
    value(await ctx.host.call('identity.remove', { personId: joined.person.id }));
    assert.equal(stopAnswered, false, 'the earlier Stop is still waiting to save');
    await assert.rejects(ctx.host.callAuthenticated(joined.session, 'turns.stop', { threadId: second.threadId }));
    assert.equal(stopAnswered, false, 'the refusal came while the earlier Stop was still waiting to save');
    releaseLock!(); await holder;
    assert.equal(value(await stop).stopped, true, 'the Stop authorized before removal is still acknowledged once saved');
    await idle(ctx.host, second.threadId);
    ctx.host.close();
  } finally {
    releaseLock?.(); releaseModel();
    process.env.BACKBONE_MODEL_ENDPOINT = endpoint; process.env.BACKBONE_MODEL_ID = modelId;
    await model.close();
  }
});
