import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {observeNativeHomeLocks} from './native-lock-observation.ts';
import type { CoreLink } from '../src/composition/core.ts';
import { createDocumentGateway, continueOriginalWrites, type DocumentGatewayOptions, type WriteCrashPoint } from '../src/composition/document-writes.ts';
import { projectRecoveredWrites, verifiedRecoveredWrites, type StoredWrite } from '../src/composition/recovered-writes.ts';
import type { EffectRecord } from '../src/api.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { readJson, writeJson } from '../src/stub/fsx.ts';
import { unconfirmedCustody, reconcileReclaimedCustody } from '../src/composition/thread-custody.ts';
import { ThreadJournal } from '../src/composition/thread-journal.ts';

function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'document-recovery-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'threads'));
  writeJson(join(home, 'threads', 'thread.json'), { summary: { id: 'thread', projectId: 'project' }, turns: [], sideTurns: [], clientKeys: [], task: 'task' });
  const material = new MaterialStore(home, {}, () => {});
  let original: StoredWrite | undefined;
  let dispatches = 0;
  let proposals = 0;
  let cut: WriteCrashPoint | undefined;
  let cancelMode: 'ok' | 'lost' | 'dispatch-race' = 'ok';
  let kernelVersion: { title: string; content: string; via_effect: string } | undefined;
  const controller = new AbortController();
  // A controlled seam, not a SQL/authority substitute. Real-gateway evidence remains separate.
  const link = {
    id: {workspace:'11111111-1111-4111-8111-111111111111'},
    system: () => ({}),
    read: async (_principal: unknown, sql: string) => ({ rows: sql.includes('FROM app.documents') ? (kernelVersion ? [kernelVersion] : []) : original ? [structuredClone(original)] : [] }),
    proposeWrite: async (_h: unknown, args: StoredWrite['args']) => {
      proposals++;
      if (!original) original = { id: 'original-effect', status: 'allowed', args: structuredClone(args), key: 'turn:summary.md', run: 'run' };
      else assert.deepEqual(args, original.args);
      return { ...original, routeReason: null, repeatOf: null };
    },
    heldClaims: async () => [{ effect: 'original-effect', claim: 'original-claim' }],
    claimEffect: async () => { original!.status = 'claimed'; return 'original-claim'; },
    // Untainted synthetic runs: no private-task exemption to recheck.
    documentAudienceHolds: async () => true,
    beginDispatch: async () => { dispatches++; original!.status = 'dispatching'; return true; },
    observe: async (_id: string, _claim: string, status: string) => { original!.status = status; },
    writeDocument: async (effect: string, _document: string, title: string, content: string) => { kernelVersion = { title, content, via_effect: effect }; },
    call: async () => {
      if (cancelMode === 'dispatch-race') { original!.status = 'dispatching'; throw new Error('too_late'); }
      if (cancelMode === 'lost') throw new Error('cancellation unavailable');
      assert.ok(original && ['allowed', 'claimed', 'proposed', 'awaiting_checker'].includes(original.status));
      original.status = 'cancelled';
      return 'cancelled';
    },
  } as unknown as CoreLink;
  const options = (): DocumentGatewayOptions => ({ home, material, link, handle: { run: 'run', fence: 1, secret: 'synthetic' },
    threadId: 'thread', turnId: 'turn', projectId: 'project', projectDir: () => home, journal:new ThreadJournal(home),
    crash: (point) => { if (point === cut) { cut = undefined; throw new Error(`cut:${point}`); } },
    signal: controller.signal,
  });
  const gateway = () => createDocumentGateway(options());
  const effect = (): EffectRecord => ({ key: '', kind: 'write-working-copy', target: 'summary.md', outcome: 'UNKNOWN' });
  const perform = () => Promise.resolve(material.create('project', 'summary.md', 'text/markdown', Buffer.from('summary of v1'), 'working', 'agent', 'summary'));
  return { home, material, gateway, options, controller, effect, perform, cutAt(point: WriteCrashPoint) { cut = point; },
    cancelAs(mode: typeof cancelMode) { cancelMode = mode; },
    get original() { return original; }, get dispatches() { return dispatches; }, get proposals() { return proposals; } };
}

test('restart cannot rebase the original pending sources when output bytes are identical', async (t) => {
  const s = setup(t);
  const source = s.material.create('project', 'source.md', 'text/markdown', Buffer.from('v1 facts'), 'working', 'agent', 'source');
  s.cutAt('write.proposed');
  const target = { document: 'summary', name: 'summary.md', body: 'summary of v1', baseVersion: null,
    sourceVersions: [{ id: source.id, name: source.name, version: 1 }] };
  await assert.rejects(s.gateway().write(target, s.effect(), s.perform), /cut:write.proposed/);
  assert.equal(s.original?.status, 'allowed');
  assert.equal((await s.material.save(source.id, 'person v2 facts', 1)).ok, true);
  const resumed = s.effect();
  await s.gateway().write({ ...target, sourceVersions: [{ id: source.id, name: source.name, version: 2 }] }, resumed, s.perform);
  assert.equal(s.dispatches, 0, 'identical output cannot authorize replacing the original source binding');
  assert.equal(s.material.load('summary'), null);
  assert.equal(s.material.load(source.id)?.current, 2);
  assert.equal(s.original?.id, 'original-effect');
});

test('material-only commit is not a verified Kernel result', async (t) => {
  const s = setup(t);
  s.cutAt('write.materialised');
  await assert.rejects(s.gateway().write({ document: 'summary', name: 'summary.md', body: 'summary of v1', baseVersion: null }, s.effect(), s.perform), /cut:/);
  assert.ok(s.material.load('summary'));
  s.original!.status = 'succeeded'; // An inconsistent old observation must not manufacture proof.
  const recovered = await verifiedRecoveredWrites(s.options().link, [s.original!], s.material, 'project');
  assert.deepEqual(recovered.files, []);
  assert.equal(recovered.effects[0].outcome, 'UNKNOWN');
  assert.match(recovered.detail, /exact verified/);
});

for (const cut of ['write.proposed', 'write.claimed'] as const) test(`saved ${cut} original continues once without a new proposal or model replay`, async (t) => {
  const s = setup(t);
  s.cutAt(cut);
  const target = { document: 'summary', name: 'summary.md', body: 'summary of v1', baseVersion: null, managed: true as const, sourceVersions: [] };
  await assert.rejects(s.gateway().write(target, s.effect(), s.perform), /cut:/);
  await continueOriginalWrites(s.options(), [structuredClone(s.original!)]);
  assert.equal(s.proposals, 1);
  assert.equal(s.dispatches, 1);
  assert.equal(s.original?.id, 'original-effect');
  assert.equal(s.original?.status, 'succeeded');
  assert.equal(s.material.load('summary')?.projection, 'managed');
  assert.equal(Buffer.from(s.material.bytes('summary', 1)).toString(), target.body);
  await continueOriginalWrites(s.options(), [structuredClone(s.original!)]);
  assert.equal(s.dispatches, 1);
  assert.equal(s.material.load('summary')?.current, 1);
});

test('recovery cancels the original stale-source proposal instead of rebasing identical output', async (t) => {
  const s = setup(t);
  const source = s.material.create('project', 'source.md', 'text/markdown', Buffer.from('v1'), 'working', 'agent', 'source');
  s.cutAt('write.claimed');
  await assert.rejects(s.gateway().write({ document: 'summary', name: 'summary.md', body: 'summary of v1', baseVersion: null, sourceVersions: [{ id: source.id, name: source.name, version: 1 }] }, s.effect(), s.perform), /cut:/);
  await s.material.save(source.id, 'person v2', 1);
  await continueOriginalWrites(s.options(), [structuredClone(s.original!)]);
  assert.equal(s.original?.status, 'cancelled');
  assert.equal(s.dispatches, 0);
  assert.equal(s.proposals, 1);
  assert.equal(s.material.load('summary'), null);
  assert.equal(s.material.load('source')?.current, 2);
});

for (const corrupt of [false, true]) test(`${corrupt ? 'corrupt' : 'missing'} legacy custody uses only original pre-dispatch cancellation`, async (t) => {
  const s = setup(t);
  s.cutAt('write.proposed');
  await assert.rejects(s.gateway().write({ document: 'summary', name: 'summary.md', body: 'summary of v1', baseVersion: null }, s.effect(), s.perform), /cut:/);
  const path = join(s.home, 'threads', 'thread.json');
  const stored = readJson<Record<string, unknown>>(path, {});
  if (corrupt) stored.writeCustody = { version: 1, writes: { 'turn:summary.md': { version: 99 } } };
  else delete stored.writeCustody;
  writeJson(path, stored);
  await continueOriginalWrites(s.options(), [structuredClone(s.original!)]);
  assert.equal(s.original?.status, 'cancelled');
  assert.equal(s.dispatches, 0);
  assert.equal(s.proposals, 1);
});

for (const status of ['dispatching', 'unknown']) test(`${status} original is never resent or replaced`, async (t) => {
  const s = setup(t);
  s.cutAt('write.proposed');
  const target = { document: 'summary', name: 'summary.md', body: 'summary of v1', baseVersion: null };
  await assert.rejects(s.gateway().write(target, s.effect(), s.perform), /cut:/);
  s.original!.status = status;
  await continueOriginalWrites(s.options(), [structuredClone(s.original!)]);
  await s.gateway().write({ ...target, body: 'changed retry' }, s.effect(), s.perform);
  assert.equal(s.original?.status, status);
  assert.equal(s.dispatches, 0);
  assert.equal(s.proposals, 1);
});

for (const mode of ['lost', 'dispatch-race'] as const) test(`a ${mode} cancellation reports the durable original, not invented cancellation`, async (t) => {
  const s = setup(t);
  s.cutAt('write.proposed');
  await assert.rejects(s.gateway().write({ document: 'summary', name: 'summary.md', body: 'summary of v1', baseVersion: null }, s.effect(), s.perform), /cut:/);
  s.controller.abort();
  s.cancelAs(mode);
  await continueOriginalWrites(s.options(), [structuredClone(s.original!)]);
  const recovered = projectRecoveredWrites([s.original!], s.material, 'project');
  assert.equal(s.original?.status, mode === 'lost' ? 'allowed' : 'dispatching');
  assert.equal(recovered.pending, mode === 'lost');
  assert.equal(recovered.effects[0].outcome, 'UNKNOWN');
  assert.equal(s.dispatches, 0);
  assert.equal(s.proposals, 1);
});

for (const refusal of ['raw-path', 'source-version', 'stopped']) test(`local ${refusal} refusal leaves no uncertain proposal custody`, async (t) => {
  const s = setup(t);
  const target = { document: 'summary', name: 'summary.md', body: 'summary of v1', baseVersion: null, managed: true as const,
    sourceVersions: [] as { id: string; name: string; version: number }[] };
  if (refusal === 'raw-path') writeJson(join(s.home, target.name), { person: 'owned' });
  if (refusal === 'source-version') target.sourceVersions.push({ id: 'missing-source', name: 'source.md', version: 1 });
  if (refusal === 'stopped') s.controller.abort();
  const effect = s.effect();
  await s.gateway().write(target, effect, s.perform);
  assert.equal(effect.outcome, 'REFUSED');
  assert.equal(s.proposals, 0);
  assert.equal(s.dispatches, 0);
  assert.equal(await unconfirmedCustody(s.home, 'thread', null, 'turn', 'project', []), false);
});

test('a raw path created after claim cancels the original managed import without dispatch', async (t) => {
  const s = setup(t);
  s.cutAt('write.claimed');
  const target = { document: 'summary', name: 'summary.md', body: 'summary of v1', baseVersion: null, managed: true as const };
  await assert.rejects(s.gateway().write(target, s.effect(), s.perform), /cut:/);
  writeJson(join(s.home, target.name), { person: 'owned' });
  await continueOriginalWrites(s.options(), [structuredClone(s.original!)]);
  assert.equal(s.original?.status, 'cancelled');
  assert.equal(s.dispatches, 0);
  assert.equal(s.material.load(target.document), null);
  assert.deepEqual(readJson(join(s.home, target.name), {}), { person: 'owned' });
});


test('the actual document gateway keeps its home lock through an asynchronous proposal', async t => {
  const s = setup(t), link = s.options().link;
  let watch = false, lockRequests = 0;
  observeNativeHomeLocks(t,s.home,()=>{if(watch)lockRequests++;});
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const proposing = new Promise<void>(resolve => { entered = resolve; });
  const propose = link.proposeWrite.bind(link);
  link.proposeWrite = async (...args) => { entered(); await barrier; return propose(...args); };
  const handle = { run: 'run', fence: 2, secret: 'synthetic' };
  const writing = createDocumentGateway({ ...s.options(), handle }).write({ document: 'summary', name: 'summary.md', body: 'summary of v1', baseVersion: null, managed: true }, s.effect(), s.perform);
  await proposing; watch = true;
  const core = {
    system: () => ({}), runOf: () => ({}),
    async read(_actor: unknown, sql: string) { return { rows: sql.includes('sec.current_run()') ? [{ id: 'run' }] : s.original ? [s.original] : [] }; },
  } as unknown as Pick<CoreLink, 'system' | 'runOf' | 'read'>;
  let reconciled = false;
  const cleanup = reconcileReclaimedCustody({ home: s.home, thread: 'thread', run: 'run', turn: 'turn', project: 'project' }, core, handle,
    { files: [{ name: 'summary.md', body: 'summary of v1' }] }).then(result => { reconciled = true; return result; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(lockRequests, 0, 'cleanup is queued behind the gateway before it can even request the filesystem lock');
    assert.equal(reconciled, false, 'the same-handle cleanup cannot pass the gateway proposal in flight');
  } finally { release(); await writing; await cleanup; }
  assert.equal(lockRequests, 1, 'only after the proposal finishes may cleanup acquire the lock');
  assert.deepEqual(await cleanup, { status: 'reconciled', removed: 0, retained: 1, receipts: 1 });
  assert.equal(s.original?.status, 'succeeded');
  assert.equal(await unconfirmedCustody(s.home, 'thread', 'run', 'turn', 'project', [s.original!]), false);
});

test('a recovery inspection copy is refused before recording or delivering an ordinary material read', async t => {
  const s = setup(t);
  const entry = s.material.create('project', 'Recovery.md', 'text/markdown', Buffer.from('Recovery bytes.'), 'working', 'agent', 'recovery-copy', 'managed',undefined,undefined,{turnId:'turn',reason:'Not imported.'});
  let reads = 0;
  const options = s.options();
  options.link.recordMaterialSourceRead = async () => { reads++; throw new Error('Unexpected registration'); };
  await assert.rejects(createDocumentGateway(options).read({materialId:entry.id,name:entry.name,version:entry.current,withdrawals:0,profile:'harness'}), /recovery|not imported|unavailable/i);
  assert.equal(reads, 0, 'an inspection copy does not acquire a new source identity');
});
