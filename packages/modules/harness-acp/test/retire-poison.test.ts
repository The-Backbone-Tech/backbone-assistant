import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir, chmod, symlink, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { TurnContext, TurnRequest } from '@backbone-next/platform/ports';
import { createAcpHarness } from '../src/index.ts';
import { Session } from '../src/session.ts';
import { removeRetiredTree, retireDirectory, sweepRetired } from '../src/storage.ts';
const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const request: TurnRequest = { threadId: 'poison', turnId: 'one', text: 'ready', history: [], attachments: [], effort: 3, resumed: false };
const context: TurnContext = { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'no grant' }) }, route: { kind: 'agent', provider: 'acp:fake', baseUrl: '', model: 'chosen-by-agent', label: 'fake', credential: null }, credential: async () => { throw new Error('No credential'); } };
const currentRoot = async (storage: string) => { const [anchor] = await readdir(storage); const parent = join(storage, anchor); return join(parent, JSON.parse(await readFile(join(parent, 'current.json'), 'utf8'))); };
async function collect(events: AsyncIterable<unknown>) { for await (const _ of events) { /* Exhaustion is required. */ } }

for (const plant of ['fifo', 'sealed']) for (const route of ['stop', 'reconnect']) test(`${route} handles an agent-planted ${plant}, closes the stream and removes the old tree`, { timeout: 10_000 }, async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'acp-retire-poison-'));
  const options = { acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: process.platform === 'darwin' ? 'restricted-writes' as const : 'person-rights' as const, storageDir, env: { ACP_FAKE_MODE: route === 'stop' ? 'poison-wait' : 'load-state', ACP_FAKE_PLANT: plant } };
  const firstHarness = createAcpHarness(options); let secondHarness: ReturnType<typeof createAcpHarness> | undefined;
  try {
    const turn = firstHarness.start(request, context); let oldRoot = '';
    const stream = (async () => { for await (const event of turn.events) { if (route === 'stop' && event.type === 'text' && event.delta === 'rea') { oldRoot = await currentRoot(storageDir); turn.stop(); } } })();
    const first = await turn.outcome; await stream;
    assert.equal(first.status, route === 'stop' ? 'interrupted' : 'done', first.error ?? '');
    if (route === 'reconnect') {
      oldRoot = await currentRoot(storageDir); await firstHarness.close(); secondHarness = createAcpHarness(options);
      const second = secondHarness.start({ ...request, turnId: 'two', history: [{ role: 'user', text: request.text }, { role: 'assistant', text: first.answer }] }, context);
      const drained = collect(second.events), result = await second.outcome; assert.equal(result.status, 'done'); assert.equal(result.answer, 'retained'); await drained;
    } else {
      const next = firstHarness.start({ ...request, turnId: 'two', text: 'next' }, context);
      const drained = collect(next.events), result = await next.outcome; await drained;
      assert.equal(result.status, 'done'); assert.equal(result.answer, 'fresh');
    }
    await assert.rejects(access(oldRoot));
    assert.ok((await readdir(dirname(oldRoot))).every(name => !name.startsWith('.retired-')));
  } finally { await firstHarness.close(); await secondHarness?.close(); await removeRetiredTree(storageDir); }
});

test('a failing copy still deletes the retired tree, including sealed directories, without following links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-retire-failure-')), tree = join(root, 'session'), outside = join(root, 'outside');
  await mkdir(tree); await mkdir(outside); await writeFile(join(outside, 'keep'), 'keep'); await symlink(outside, join(tree, 'link')); await mkdir(join(tree, 'sealed')); await writeFile(join(tree, 'sealed', 'state'), 'private'); await chmod(join(tree, 'sealed'), 0);
  try {
    await assert.rejects(retireDirectory(tree, async retired => { await sweepRetired(root); await access(retired); throw new Error('Injected copy failure'); }), /Injected copy failure/);
    assert.deepEqual(await readdir(root), ['outside']); assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'keep');
  } finally { await removeRetiredTree(root); }
});

test('Session.create sweeps orphaned retired state and restores private directory access for deletion', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'acp-retire-sweep-'));
  const options = { acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: 'person-rights' as const, storageDir };
  const first = await Session.create(options, request.threadId), parent = dirname(first.root), orphan = join(parent, `.retired-${randomUUID()}`);
  await mkdir(orphan); await writeFile(join(orphan, 'native-state'), 'old secretless state'); await chmod(orphan, 0);
  let second: Session | undefined;
  try { second = await Session.create(options, request.threadId); await assert.rejects(stat(orphan)); assert.ok((await readdir(parent)).every(name => !name.startsWith('.retired-'))); }
  finally { await first.close(true); await second?.close(true); await removeRetiredTree(storageDir); }
});

test('an invalidate error cannot reject the turn, leave its stream open or keep the thread busy', { timeout: 5000 }, async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'acp-retire-finally-'));
  const h = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: 'person-rights', storageDir, env: { ACP_FAKE_MODE: 'poison-wait', ACP_FAKE_PLANT: 'sealed' } });
  const original = Session.prototype.invalidate; let once = true;
  Session.prototype.invalidate = async function () { await original.call(this); if (once) { once = false; throw new Error('Injected cleanup failure'); } };
  try {
    const turn = h.start(request, context), stream = (async () => { for await (const event of turn.events) if (event.type === 'text') turn.stop(); })();
    const outcome = await turn.outcome; await stream; assert.equal(outcome.status, 'interrupted'); assert.match(outcome.error ?? '', /cleanup could not be confirmed/);
    const next = h.start({ ...request, turnId: 'two', text: 'next' }, context), drained = collect(next.events);
    const result = await next.outcome; await drained; assert.equal(result.status, 'done'); assert.equal(result.answer, 'fresh');
  } finally { Session.prototype.invalidate = original; await h.close(); await removeRetiredTree(storageDir); }
});

for (const plant of ['immutable', 'acl']) test(`Host metadata repair removes retired ${plant} state without blocking later turns`, async () => {
  if (process.platform !== 'darwin') return;
  const { spawnSync } = await import('node:child_process');
  const storageDir = await mkdtemp(join(tmpdir(), 'acp-retire-leftover-'));
  const options = { acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: 'restricted-writes' as const, storageDir };
  const seed = await Session.create(options, request.threadId), parent = dirname(seed.root);
  await seed.close(true);
  const stuck = join(parent, `.retired-${randomUUID()}`), later = join(parent, `.retired-${randomUUID()}`);
  await mkdir(stuck); await writeFile(join(stuck, 'native-state'), 'leftover'); await mkdir(later);
  const command = plant === 'immutable' ? '/usr/bin/chflags' : '/bin/chmod';
  const undo = plant === 'immutable' ? ['nouchg', join(stuck, 'native-state')] : ['-N', join(stuck, 'native-state')];
  const planted = spawnSync(command, plant === 'immutable' ? ['uchg', join(stuck, 'native-state')] : ['+a', 'everyone deny delete', join(stuck, 'native-state')], { encoding: 'utf8' });
  const h = createAcpHarness(options);
  try {
    assert.equal(planted.status, 0, planted.stderr);
    assert.deepEqual(await sweepRetired(parent), []); await assert.rejects(access(later)); await assert.rejects(access(stuck));
    for (const turnId of ['one', 'two']) {
      const turn = h.start({ ...request, turnId }, context), drained = collect(turn.events);
      const outcome = await turn.outcome; await drained; assert.equal(outcome.status, 'done', outcome.error ?? ''); assert.equal(outcome.answer, 'ready');
    }
  } finally { await h.close(); spawnSync(command, undo); await removeRetiredTree(storageDir); }
});
