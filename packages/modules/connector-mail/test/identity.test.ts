import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FakeMailbox, readSeed, SCOPES } from '../src/index.ts';

const request = async (box: FakeMailbox, key?: string) => {
  const m = await box.read('m01');
  const c = box.classify({op:'modify', id:m.id, version:m.version, add:['Label_billing'], remove:[]}, await box.labels());
  assert.ok(c.ok); return {...c.value, operationKey:key};
};

test('a later independent identical write cannot prove the original unknown landed', async () => {
  const box = new FakeMailbox({writes:'open',faults:[{at:'modify',kind:'timeout-before-commit'}]});
  const original = await request(box,'original');
  await assert.rejects(box.apply(original));
  assert.equal(box.truth.applied.length,0);
  await box.apply({...original,operationKey:'independent'});
  assert.equal(box.truth.applied.length,1);
  assert.equal((await box.probe(original)).landed,null);
});

test('after-commit proof survives restart and binds key, exact request and input version', async () => {
  const dir=mkdtempSync(join(tmpdir(),'triage-proof-'));
  try {
    const stateFile=join(dir,'provider.json');
    const box = new FakeMailbox({stateFile,writes:'open',faults:[{at:'modify',kind:'timeout-after-commit'}]});
    const original = await request(box,'original');
    await assert.rejects(box.apply(original));
    const restarted = new FakeMailbox({stateFile,writes:'open'});
    assert.equal((await restarted.probe(original)).landed,true);
    assert.equal((await restarted.probe({...original,operationKey:'independent'})).landed,null);
    assert.equal((await restarted.probe({...original,args:{...original.args,add:['Label_team']}})).landed,null);
    assert.equal((await restarted.probe({...original,args:{...original.args,version:'other-version'}})).landed,null);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('uncorrelated legacy commits remain unknown even when labels match', async () => {
  const box = new FakeMailbox({writes:'open'});
  const original = await request(box);
  await box.apply(original);
  assert.equal((await box.probe(original)).landed,null);
});


test('an observer opened before a keyed commit reads the current provider proof', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-observer-'));
  try {
    const stateFile = join(dir, 'provider.json');
    const writer = new FakeMailbox({ stateFile, writes: 'open', faults: [{ at: 'modify', kind: 'timeout-after-commit' }] });
    const original = await request(writer, 'original');
    const observer = new FakeMailbox({ stateFile, writes: 'open' });
    await assert.rejects(writer.apply(original));
    assert.equal((await observer.probe(original)).landed, true);
    assert.equal(observer.truth.applied.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two provider instances preserve concurrent independent committed records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-writers-'));
  try {
    const stateFile = join(dir, 'provider.json');
    const first = new FakeMailbox({ stateFile, writes: 'open' }); await first.list();
    const second = new FakeMailbox({ stateFile, writes: 'open' });
    const a = await request(first, 'first');
    const m = await second.read('m02');
    const c = second.classify({ op: 'modify', id: m.id, version: m.version, add: ['Label_team'], remove: [] }, await second.labels());
    assert.ok(c.ok); const b = { ...c.value, operationKey: 'second' };
    const results = await Promise.all([first.apply(a), second.apply(b)]);
    assert.ok(results.every((r) => r.outcome === 'succeeded'));
    const observer = new FakeMailbox({ stateFile, writes: 'open' });
    assert.equal(observer.truth.applied.length, 2);
    assert.equal((await observer.probe(a)).landed, true);
    assert.equal((await observer.probe(b)).landed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('independent processes serialize committed provider records under the existing home lock', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-process-writers-'));
  const children: ReturnType<typeof fork>[] = [];
  try {
    const stateFile = join(dir, 'provider.json');
    const initial = new FakeMailbox({ stateFile, writes: 'open' }); await initial.list();
    const workers = ['m01', 'm02'].map((id, i) => {
      const child = fork(join(import.meta.dirname, 'provider-worker.ts'), [stateFile, id, `worker-${i}`], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child); let output = ''; child.stderr!.on('data', (b) => output += b);
      const ready = new Promise<void>((resolve, reject) => {
        child.on('message', (m) => { if ((m as { ready?: boolean }).ready) resolve(); });
        child.on('error', reject); child.on('exit', (code) => { if (code) reject(new Error(output || `worker exit ${code}`)); });
      });
      const done = new Promise<string>((resolve, reject) => {
        child.on('message', (m) => { if ((m as { result?: string }).result) resolve((m as { result: string }).result); });
        child.on('error', reject); child.on('exit', (code) => { if (code) reject(new Error(output || `worker exit ${code}`)); });
      });
      return { child, ready, done };
    });
    await Promise.all(workers.map((w) => w.ready));
    for (const worker of workers) worker.child.send('apply');
    assert.deepEqual(await Promise.all(workers.map((w) => w.done)), ['succeeded', 'succeeded']);
    const observed = new FakeMailbox({ stateFile, writes: 'open' });
    assert.equal(observed.truth.applied.length, 2);
    assert.deepEqual(observed.truth.applied.map((r) => r.operationKey).sort(), ['worker-0', 'worker-1']);
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill('SIGKILL'); }
    await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve))));
    rmSync(dir, { recursive: true, force: true });
  }
});


test('a probe waits for an already active provider call rather than falsely proving absence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-active-provider-'));
  try {
    const stateFile = join(dir, 'provider.json');
    const writer = new FakeMailbox({ stateFile, writes: 'open', latencyMs: 30 });
    const original = await request(writer, 'active-call');
    const observer = new FakeMailbox({ stateFile, writes: 'open' });
    const writing = writer.apply(original);
    const probing = observer.probe(original);
    assert.equal((await writing).outcome, 'succeeded');
    assert.equal((await probing).landed, true);
    assert.equal(observer.truth.applied.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('a provider file established by another account fails closed for the stale constructor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-provider-owner-'));
  try {
    const stateFile = join(dir, 'provider.json'), seed = readSeed();
    const stale = new FakeMailbox({ stateFile, seed });
    const actual = new FakeMailbox({ stateFile, seed: { ...seed, account: 'other@example.test' } });
    await actual.list();
    await assert.rejects(stale.read('m01'), /another account/);
    assert.equal(actual.truth.account, 'other@example.test');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


for (const lost of [SCOPES.read, SCOPES.modify]) test(`provider refuses a queued modification after ${lost} entitlement is lost`, async () => {
  const scopes: string[] = [SCOPES.read, SCOPES.modify];
  const box = new FakeMailbox({ writes: 'open', scopes });
  const original = await request(box, 'entitlement-loss');
  scopes.splice(scopes.indexOf(lost), 1);
  await assert.rejects(box.apply(original), /entitle|scope|permission/);
  assert.equal(box.truth.applied.length, 0);
});
