import { document, systemFixture } from './policy-fixture.ts';
import { pollUntil } from './helpers.ts';
// Consumer regressions with controlled ports: no database, model server or account.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FakeMailbox, readSeed, readTask } from '@backbone-next/connector-mail';
import { CoreRefusal } from '../src/composition/core.ts';
import { saveItem } from '../src/triage/items.ts';
import { saveRun } from '../src/triage/runs.ts';
import { withHomeLock } from '../src/composition/home-lock.ts';
import { sha256 } from '../src/stub/fsx.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { offerFor, type CapabilityRecord } from '../src/triage/capability.ts';
import { briefOf, viewOf } from '../src/triage/brief.ts';
import { TriageService, type Stored, type TriageDeps } from '../src/triage/service.ts';

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
};

function consumer(initial = 2, seed = readSeed()) {
  const home = mkdtempSync(join(tmpdir(), 'triage-consumer-'));
  const task = readTask();
  const box = new FakeMailbox({ initial, seed: { ...seed, messages: seed.messages.slice(0, 2) } });
  const pin = { id: 'test-piece', version: '1', digest: 'sha256:test' };
  const payload = offerFor({ tenant: 'workspace', owner: { id: 'person', name: 'Person' }, account: box.account, model: { route: 'endpoint:openai-compatible', model: 'test-model' }, tool: pin, adapter: pin, configuration: `sha256:${sha256(JSON.stringify(task))}` });
  const cap: CapabilityRecord = { payload, hash: 'signed-hash', mandate: 'root', mandates: ['root'], signedAt: new Date().toISOString(), signedWith: 'touch-id', window: { day: new Date().toISOString().slice(0, 10), expiresAt: payload.expiresAt }, state: 'active' };
  const state: Stored = { connection: { provider: box.provider, account: box.account, label: box.label, connectedAt: new Date().toISOString(), registration: { ...pin, piece: pin.id }, agent: 'worker', task: 'task', projectId: 'project', mandate: 'connection', entitled: true, detail: '' }, capabilities: [cap], pending: null, items: {}, runs: [] };
  mkdirSync(join(home, 'triage'));
  writeFileSync(join(home, 'triage/state.json'), JSON.stringify(state));
  const grants = new Map<string, { parent: string | null; revoked: boolean; hash?: string }>([['root', { parent: null, revoked: false, hash: 'signed-hash' }], ['connection', { parent: null, revoked: false }]]);
  const effects = new Map<string, Record<string, unknown>>();
  const runMandates = new Map<string, string>();
  const dispatched: string[] = [];
  const revoked: string[] = [];
  let starts = 0;
  let failRevoke = 0;
  let seq = 0;
  const link = {
    id: { workspace: 'workspace', person: 'person' }, person: () => 'person', system: () => 'system', runOf: () => 'worker',
    async call(_actor: unknown, sql: string, args: unknown[] = []) {
      if (sql.includes('gov.issue_mandate')) {
        const id = `grant-${++seq}`; const parent = grants.has(args[1] as string) ? args[1] as string : null; grants.set(id, { parent, revoked: false, ...(parent ? {} : { hash: 'signed-hash' }) }); return id;
      }
      if (sql.includes('gov.revoke_mandate')) {
        if (failRevoke-- > 0) throw new Error('database unavailable');
        const id = args[0] as string; revoked.push(id);
        const revoke = (id: string) => { const g = grants.get(id); if (g) g.revoked = true; for (const [child, g] of grants) if (g.parent === id) revoke(child); };
        revoke(id); return 1;
      }
      if (sql.includes('gov.propose_effect')) {
        const id = `effect-${++seq}`;
        effects.set(id, { id, operation: args[3], args: JSON.parse(args[6] as string), status: 'allowed', decision_id: null }); return id;
      }
      if (sql.includes('sec.args_hash') || sql.includes('SELECT intent_hash')) return 'signed-hash';
      if (sql.includes('gov.cancel_effect')) { effects.get(args[0] as string)!.status = 'cancelled'; return 'cancelled'; }
      if (sql.includes('gov.record_source')) return 'source';
      if (sql.includes('gov.run_standing')) return grants.get(runMandates.get(args[0] as string)!)?.revoked ? 'mandate_revoked' : 'ok';
      throw new Error(`Unexpected core call: ${sql}`);
    },
    async read(_actor: unknown, sql: string, args: unknown[] = []) {
      if (sql.includes('AS spent FROM app.effects')) return { rows: [{ spent: [...effects.values()].filter((e) => !['denied', 'cancelled'].includes(e.status as string)).length }] };
      if (sql.includes('FROM app.effects')) return { rows: sql.includes('WHERE id = $1') ? [effects.get(args[0] as string)].filter(Boolean) : [...effects.values()] };
      if (sql.includes('FROM app.runs')) return { rows: [] };
      if (sql.includes('FROM app.principals')) return { rows: [{ name: 'Person' }] };
      if (sql.includes('FROM app.mandates') && sql.includes('intent_hash')) return { rows: [...grants].filter(([, g]) => g.hash === args[0]).map(([id]) => ({ id })) };
      if (sql.includes('FROM app.mandates')) return { rows: [{ ok: !grants.get(args[0] as string)?.revoked }] };
      throw new Error(`Unexpected core read: ${sql}`);
    },
    async openRun() { return null; },
    async startRunUnder(_task: string, _agent: string, mandate: string) {
      assert.equal(grants.get(mandate)?.revoked, false);
      const run = `run-${++seq}`; runMandates.set(run, mandate);
      return { run, fence: 1, secret: 'fake' };
    },
    async renewRun() {}, async finishRun() {}, async reclaimRun() { return { run: 'recovered', fence: 1, secret: 'fake' }; },
    async claimEffect(id: string) { effects.get(id)!.status = 'claimed'; return 'fake-claim'; },
    async beginDispatch(id: string) { dispatched.push(effects.get(id)!.operation as string); return true; },
    async observe(id: string, _claim: string, outcome: string) { effects.get(id)!.status = outcome; },
  };
  const engine = { start() { starts++; return { events: (async function* () {})(), outcome: Promise.resolve({ status: 'done', answer: 'requester: Person <person@example.test>\ncategory: internal\nurgency: low\nlabel: none\nmove: none\nsuspicious: no\nreply:\nnone' }), stop() {} }; } };
  const deps = { home, link: async () => link, mail: async () => ({ connector: box, task, piece: pin, registration: { ...pin, piece: pin.id } }), route: () => ({ kind: 'endpoint', provider: 'openai-compatible', model: 'test-model' }), tool: () => pin, engine: () => engine, emit() {}, project: () => 'project', credential: async () => '' } as unknown as TriageDeps;
  const service = new TriageService(deps);
  return { home, service, box, grants, effects, revoked, dispatched, deps, get starts() { return starts; }, failNextRevocation() { failRevoke = 1; }, close() { service.close(); rmSync(home, { recursive: true, force: true }); } };
}

test('F1: revoke after narrowing terminates every historical grant', async () => {
  const c = consumer();
  try {
    const next = structuredClone(c.service.current()!.payload); next.budget.modelTurnsPerDay = 1;
    await c.service.change(next);
    await c.service.revoke();
    assert.ok(c.revoked.includes('root'), 'the original broader root must end');
    assert.ok([...c.grants].filter(([id]) => id !== 'connection').every(([, g]) => g.revoked));
  } finally { c.close(); }
});

test('F2: a failed revocation stays pending across restart and cannot report success', async () => {
  const c = consumer();
  try {
    c.failNextRevocation();
    await assert.rejects(c.service.revoke(), /database unavailable/);
    assert.notEqual(c.service.current()!.state, 'active');
    const restarted = new TriageService(c.deps);
    await restarted.recover();
    assert.equal(c.grants.get('root')!.revoked, true);
    assert.equal(restarted.current()!.state, 'revoked');
    restarted.close();
  } finally { c.close(); }
});

test('F3: the consumer enforces a narrowed one-turn budget', async () => {
  const c = consumer();
  try {
    const signed = structuredClone(c.service.current()!.payload);
    const next = structuredClone(signed); next.budget.modelTurnsPerDay = 1;
    await c.service.change(next);
    await c.service.run('person');
    assert.equal(c.starts, 1, 'only one model turn under the narrowed authority');
    assert.deepEqual(c.service.current()!.payload, signed, 'the signed payload remains immutable');
  } finally { c.close(); }
});

test('F3: a second unsigned change cannot restore a previously narrowed budget', async () => {
  const c = consumer();
  try {
    const next = structuredClone(c.service.current()!.payload); next.budget.modelTurnsPerDay = 1;
    await c.service.change(next);
    const wider = structuredClone(next); wider.budget.modelTurnsPerDay = 2;
    await assert.rejects(c.service.change(wider), /widens|signature/i);
  } finally { c.close(); }
});

for (const operation of ['labels', 'read'] as const) {
  test(`F4: Stop during ${operation} starts no later effect or model work`, async () => {
    const c = consumer();
    const entered = gate(), resume = gate();
    const original = c.box[operation].bind(c.box) as (...args: never[]) => Promise<unknown>;
    c.box[operation] = (async (...args: never[]) => { entered.release(); await resume.promise; return original(...args); }) as never;
    try {
      const run = c.service.run('person');
      await entered.promise;
      const before = [...c.dispatched];
      assert.equal(c.service.stop(), true);
      resume.release();
      const result = await run;
      assert.deepEqual(c.dispatched, before);
      assert.equal(c.starts, 0);
      assert.equal(result.outcome, 'stopped');
    } finally { resume.release(); c.close(); }
  });
}


test('F5: disconnect and restart retain UNKNOWN receipts in the brief', async () => {
  const c = consumer();
  try {
    const item = { id: 'm01', version: '1', from: { name: 'Person', address: 'person@example.test' }, subject: 'Request', date: new Date().toISOString(), done: true, draft: { effect: 'unknown', document: 'document', name: 'draft' } };
    c.service.stored.items.m01 = item;
    c.effects.set('unknown', { id: 'unknown', operation: 'workspace.write_document', status: 'unknown', args: { message: 'm01' }, decision_id: null });
    await c.service.disconnect();
    const restarted = new TriageService(c.deps);
    const effects = await restarted.effects();
    assert.equal(effects.get('unknown')?.status, 'unknown');
    assert.equal(briefOf(restarted.stored, effects).counts.unknown, 1);
    delete restarted.stored.items.m01;
    assert.equal(briefOf(restarted.stored, effects).counts.unknown, 1, 'a later item version cannot hide the retained receipt');
    restarted.close();
  } finally { c.close(); }
});

test('F6: an arrival after the list snapshot is processed without another delivery or manual run', async () => {
  const c = consumer(1);
  const entered = gate(), resume = gate();
  const read = c.box.read.bind(c.box);
  c.box.read = async (id) => { if (id === 'm01') { entered.release(); await resume.promise; } return read(id); };
  try {
    c.service.listen();
    await new Promise((r) => setImmediate(r));
    const run = c.service.run('person');
    await entered.promise;
    c.box.deliver(1);
    await new Promise((r) => setTimeout(r, 250));
    resume.release();
    await run;
    await pollUntil(async active => { while (active() && (!c.service.stored.items.m02?.done)) await new Promise((r) => setTimeout(r, 10)); }, "packages/platform/test/triage-regressions.test.ts:189 polling state");
    assert.equal(c.service.stored.items.m02?.done, true);
    await c.service.whenIdle();
  } finally { resume.release(); c.close(); }
});


test('F7: recovery schedules the remaining authorized work without a manual run', async () => {
  const c = consumer();
  try {
    const state = JSON.parse(readFileSync(join(c.home, 'triage/state.json'), 'utf8'));
    state.runs.push({ run: 'interrupted', trigger: 'person', capability: 'signed@1', startedAt: new Date().toISOString(), handled: 0, modelTurns: 0 });
    writeFileSync(join(c.home, 'triage/state.json'), JSON.stringify(state));
    const restarted = new TriageService(c.deps);
    await restarted.recover();
    await restarted.whenIdle();
    assert.equal(restarted.stored.items.m02?.done, true);
    restarted.close();
  } finally { c.close(); }
});


test('terminal revocation dominates an older suspended termination across restart', async () => {
  const c = consumer();
  const entered = gate(), release = gate();
  const link = await c.deps.link(); const call = link.call.bind(link); let first = true;
  link.call = (async (...args: Parameters<typeof link.call>) => {
    if (first && args[1].includes('gov.revoke_mandate')) { first = false; entered.release(); await release.promise; }
    return call(...args);
  }) as typeof link.call;
  try {
    const suspending = c.service.suspend('anomaly');
    await entered.promise;
    const revoking = c.service.revoke('owner revoked');
    assert.ok(c.service.current()!.terminalRevocation, 'terminal intent is durable before the serialized confirmation');
    release.release(); await Promise.all([suspending, revoking]);
    assert.equal(c.service.current()!.state, 'revoked', 'an older suspend must never overwrite terminal revocation');
    const restarted = new TriageService(c.deps);
    assert.equal(restarted.current()!.state, 'revoked');
    restarted.propose(restarted.current()!.payload);
    await assert.rejects(restarted.sign({ hash: 'signed-hash', presence: 'touch-id' }), /revoked/i);
    restarted.close();
  } finally { release.release(); c.close(); }
});

test('disconnect during formation cannot activate or leave the issued grant live', async () => {
  const c = consumer();
  const entered = gate(), release = gate();
  await c.service.suspend('test formation after suspension');
  const link = await c.deps.link(); const call = link.call.bind(link);
  link.call = (async (...args: Parameters<typeof link.call>) => {
    const result = await call(...args);
    if (args[1].includes('gov.issue_mandate')) { entered.release(); await release.promise; }
    return result;
  }) as typeof link.call;
  try {
    const signing = c.service.sign({ hash: 'signed-hash', presence: 'touch-id' });
    const rejected = assert.rejects(signing, /ended|revoked|formation/i);
    await entered.promise;
    let disconnected = false;
    const disconnecting = c.service.disconnect().then(() => { disconnected = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(disconnected, false, 'disconnect waits for an issuance whose result is still in flight');
    release.release(); await Promise.all([disconnecting, rejected]);
    assert.equal(c.service.current()!.state, 'revoked');
    assert.equal(c.service.stored.connection, null);
    assert.ok([...c.grants.values()].every((g) => g.revoked));
  } finally { release.release(); c.close(); }
});


test('F4: Stop after claiming cancels an effect that was never dispatched', async () => {
  const c = consumer(); const entered = gate(), release = gate();
  const link = await c.deps.link(); const claim = link.claimEffect.bind(link);
  link.claimEffect = async (id) => { const result = await claim(id); entered.release(); await release.promise; return result; };
  try {
    const running = c.service.run('person'); await entered.promise;
    c.service.stop(); release.release(); await running;
    assert.equal(c.dispatched.length, 0);
    assert.ok([...c.effects.values()].every((e) => e.status === 'cancelled'));
  } finally { release.release(); c.close(); }
});

test('F4: closing after an explicit Stop must not resume the job on restart', async () => {
  const c = consumer(); const entered = gate(), release = gate(); const read = c.box.read.bind(c.box);
  c.box.read = async (id) => { entered.release(); await release.promise; return read(id); };
  try {
    const running = c.service.run('person'); await entered.promise;
    c.service.stop(); c.service.close(); release.release(); await running;
    const restarted = new TriageService(c.deps); await restarted.recover(); await restarted.whenIdle();
    assert.equal(c.starts, 0); assert.equal(restarted.stored.items.m02, undefined);
    restarted.close();
  } finally { release.release(); c.close(); }
});


test('F4: an unconfirmed cancellation suspends authority durably instead of reporting Stop success', async () => {
  const c = consumer(); const entered = gate(), release = gate();
  const link = await c.deps.link(); const claim = link.claimEffect.bind(link), call = link.call.bind(link);
  let unavailable = true;
  link.claimEffect = async (id) => { const result = await claim(id); entered.release(); await release.promise; return result; };
  link.call = (async (...args: Parameters<typeof link.call>) => {
    if (unavailable && /gov.(cancel_effect|revoke_mandate)/.test(args[1])) throw new Error('cancellation database unavailable');
    return call(...args);
  }) as typeof link.call;
  try {
    const running = c.service.run('person'); const rejected = assert.rejects(running, /database unavailable/);
    await entered.promise; c.service.stop(); release.release(); await rejected;
    assert.equal(c.service.current()!.state, 'suspended');
    assert.ok(c.service.current()!.endPending);
    unavailable = false;
    const restarted = new TriageService(c.deps); await restarted.recover();
    assert.equal(c.grants.get('root')!.revoked, true);
    assert.equal(c.starts, 0); restarted.close();
  } finally { release.release(); c.close(); }
});


test('R1: disconnect before the formation journal prevents a later root', async () => {
  const c = consumer(); const entered = gate(), release = gate();
  const next = structuredClone(c.service.current()!.payload); next.version++;
  c.service.propose(next);
  const entitlement = c.box.entitlement.bind(c.box);
  c.box.entitlement = async () => { const answer = await entitlement(); entered.release(); await release.promise; return answer; };
  try {
    const signing = c.service.sign({ hash: 'signed-hash', presence: 'touch-id' });
    const rejected = assert.rejects(signing, /connection|authority|ended|revoked/i);
    await entered.promise; await c.service.disconnect(); release.release(); await rejected;
    assert.equal(c.service.stored.connection, null);
    assert.ok([...c.grants.values()].every((g) => g.revoked));
  } finally { release.release(); c.close(); }
});

test('R3: a persisted Stop survives process death before the read returns', async () => {
  const c = consumer(); const entered = gate(), release = gate(); const read = c.box.read.bind(c.box); let first = true;
  c.box.read = async (id) => { if (first) { first = false; entered.release(); await release.promise; } return read(id); };
  const running = c.service.run('person');
  try {
    await entered.promise; c.service.stop();
    // Read the exact on-disk Stop state while the original process is still blocked.
    const restarted = new TriageService(c.deps); await restarted.recover(); await restarted.whenIdle();
    assert.equal(c.starts, 0); assert.equal(restarted.stored.items.m02, undefined);
    restarted.close();
  } finally { release.release(); await running; c.close(); }
});

test('R6: arrival during an authority change is retained and processed', async () => {
  const c = consumer(0); const entered = gate(), release = gate();
  const link = await c.deps.link(), call = link.call.bind(link);
  link.call = (async (...args: Parameters<typeof link.call>) => { if (args[1].includes('gov.issue_mandate')) { entered.release(); await release.promise; } return call(...args); }) as typeof link.call;
  const next = structuredClone(c.service.current()!.payload); next.budget.modelTurnsPerDay = 1;
  try {
    c.service.listen(); await new Promise((r) => setImmediate(r));
    const changing = c.service.change(next); await entered.promise;
    c.box.deliver(1); await new Promise((r) => setTimeout(r, 250));
    release.release(); await changing; await c.service.whenIdle();
    assert.equal(c.service.stored.items.m01?.done, true);
  } finally { release.release(); c.close(); }
});

test('R5: a model turn is durably reserved before the engine can answer', async () => {
  const c = consumer();
  const entered = gate(), resume = gate();
  const engine = c.deps.engine()!;
  const start = engine.start.bind(engine);
  engine.start = (...args) => {
    const turn = start(...args); entered.release();
    return { ...turn, events: (async function* () { await resume.promise; })() };
  };
  try {
    const next = structuredClone(c.service.current()!.payload); next.budget.modelTurnsPerDay = 1;
    await c.service.change(next);
    const run = c.service.run('person'); await entered.promise;
    const disk = JSON.parse(readFileSync(join(c.home, 'triage/state.json'), 'utf8')) as Stored;
    assert.equal(disk.runs.at(-1)!.modelTurns, 1, 'uncertain dispatch counts before any outcome');
    c.service.stop();
    const restarted = new TriageService(c.deps);
    await restarted.recover();
    await restarted.run('person');
    assert.equal(c.starts, 1, 'restart cannot spend the reservation again');
    restarted.close(); resume.release(); await run;
  } finally { resume.release(); c.close(); }
});

test('termination failures stay open and cannot be reported as a completed run', async () => {
  const c = consumer(0);
  const link = await c.deps.link();
  link.finishRun = async () => { throw new Error('finish database unavailable'); };
  try {
    await assert.rejects(c.service.run('person'), /database unavailable/);
    assert.equal(c.service.stored.runs.at(-1)!.endedAt, undefined);
    assert.notEqual(c.service.current()!.state, 'active');
  } finally { c.close(); }
});

test('recovery cannot swallow an unavailable core as an already-closed run', async () => {
  const c = consumer(0);
  const link = await c.deps.link();
  try {
    await c.service.run('person');
    const disk = JSON.parse(readFileSync(join(c.home, 'triage/state.json'), 'utf8')) as Stored;
    delete disk.runs[0].endedAt; saveRun(c.home, disk.runs[0]); writeFileSync(join(c.home, 'triage/state.json'), JSON.stringify(disk));
    link.reclaimRun = async () => { throw new Error('reclaim database unavailable'); };
    const restarted = new TriageService(c.deps);
    await assert.rejects(restarted.recover(), /database unavailable/);
    assert.equal(restarted.stored.runs[0].endedAt, undefined);
    assert.notEqual(restarted.current()!.state, 'active');
    restarted.close();
  } finally { c.close(); }
});

test('R2: revocation drains an unsigned replacement and ends its late grant', async () => {
  const c = consumer(0), entered = gate(), release = gate();
  const link = await c.deps.link(), call = link.call.bind(link);
  link.call = (async (...args: Parameters<typeof link.call>) => {
    const value = await call(...args);
    if (args[1].includes('gov.issue_mandate')) { entered.release(); await release.promise; }
    return value;
  }) as typeof link.call;
  try {
    const next = structuredClone(c.service.current()!.payload); next.budget.modelTurnsPerDay = 1;
    const changing = c.service.change(next), rejected = assert.rejects(changing, /authority|revok/i);
    await entered.promise;
    const revoking = c.service.revoke();
    release.release(); await Promise.all([revoking, rejected]);
    assert.equal(c.service.current()!.state, 'revoked');
    assert.ok([...c.grants].filter(([id]) => id !== 'connection').every(([, g]) => g.revoked));
  } finally { release.release(); c.close(); }
});

test('a stale same-home consumer cannot erase terminal revocation and re-sign the old payload', async () => {
  const c = consumer(0), stale = new TriageService(c.deps);
  try {
    await c.service.revoke();
    await stale.run('person');
    await stale.suspend('stale anomaly');
    stale.propose(stale.stored.capabilities[0].payload);
    await assert.rejects(stale.sign({ hash: 'signed-hash', presence: 'touch-id' }), /revoked/i);
    assert.ok([...c.grants].filter(([id]) => id !== 'connection').every(([, g]) => g.revoked));
  } finally { stale.close(); c.close(); }
});

test('a stale run projection cannot erase a newer effective narrowing', async () => {
  const c = consumer(0), stale = new TriageService(c.deps);
  try {
    const signed = structuredClone(c.service.current()!.payload), next = structuredClone(signed); next.budget.modelTurnsPerDay = 1;
    await c.service.change(next);
    await stale.run('person');
    const restarted = new TriageService(c.deps);
    await assert.rejects(restarted.change(signed), /widens|signature/);
    assert.equal(restarted.current()!.effective!.budget.modelTurnsPerDay, 1);
    restarted.close();
  } finally { stale.close(); c.close(); }
});

for (const action of ['stop', 'revoke', 'narrow'] as const) test(`another consumer's ${action} fences a model after an in-flight read`, async () => {
  const c = consumer(), entered = gate(), release = gate(), other = new TriageService(c.deps);
  const read = c.box.read.bind(c.box);
  c.box.read = async (id) => { entered.release(); await release.promise; return read(id); };
  try {
    const running = c.service.run('person'); await entered.promise;
    if (action === 'stop') other.stop();
    else if (action === 'revoke') await other.revoke();
    else { const next = structuredClone(other.current()!.payload); next.budget.modelTurnsPerDay = 1; await other.change(next); }
    release.release(); await running;
    assert.equal(c.starts, 0);
  } finally { release.release(); other.close(); c.close(); }
});


test('the capability view distinguishes current narrowed limits from the signed payload', async () => {
  const c = consumer(0);
  try {
    const next = structuredClone(c.service.current()!.payload); next.budget.modelTurnsPerDay = 1;
    await c.service.change(next);
    const view = viewOf(c.service.stored, new Map(), { available: true, running: false, writes: 'gated', offer: null });
    assert.ok(view.capability!.effectiveSummary?.some((line) => line.includes('1 model turns a day')));
    assert.ok(view.capability!.summary.some((line) => line.includes('200 model turns a day')));
    assert.equal(view.capability!.hash, 'signed-hash');
  } finally { c.close(); }
});


test('a pending shared revocation fences work before the core can confirm it', async () => {
  const c = consumer(), entered = gate(), release = gate(), locked = gate(), unlock = gate(), other = new TriageService(c.deps);
  const read = c.box.read.bind(c.box); c.box.read = async (id) => { entered.release(); await release.promise; return read(id); };
  let revoking: Promise<void> | undefined;
  let holder: Promise<void> | undefined;
  try {
    const run = c.service.run('person'); await entered.promise;
    holder = withHomeLock(join(c.home, 'triage', 'authority'), async () => { locked.release(); await unlock.promise; });
    await locked.promise;
    revoking = other.revoke(); await new Promise((r) => setImmediate(r));
    release.release(); await run;
    assert.equal(c.starts, 0);
  } finally { release.release(); unlock.release(); await holder; await revoking; other.close(); c.close(); }
});

test('a stale consumer cannot erase the recovery record of an in-flight run', async () => {
  const c = consumer(), stale = new TriageService(c.deps), entered = gate(), release = gate();
  const read = c.box.read.bind(c.box); c.box.read = async (id) => { entered.release(); await release.promise; return read(id); };
  let run: Promise<unknown> | undefined;
  try {
    run = c.service.run('person'); await entered.promise;
    const id = c.service.stored.runs.at(-1)!.run;
    stale.stop();
    const restarted = new TriageService(c.deps);
    assert.ok(restarted.stored.runs.some((r) => r.run === id && !r.endedAt));
    restarted.close();
  } finally { release.release(); await run; stale.close(); c.close(); }
});

for (const operation of ['mail.labels', 'mail.read']) test(`shared Stop at beginDispatch cannot start ${operation}`, async () => {
  const c = consumer(), other = new TriageService(c.deps), entered = gate(), release = gate();
  const link = await c.deps.link(), begin = link.beginDispatch.bind(link), method = operation === 'mail.labels' ? 'labels' : 'read';
  let providerCalls = 0;
  const provider = c.box[method].bind(c.box) as (...args: never[]) => Promise<unknown>;
  c.box[method] = (async (...args: never[]) => { providerCalls++; return provider(...args); }) as never;
  link.beginDispatch = async (id, claim) => { const ok = await begin(id, claim); if (c.effects.get(id)!.operation === operation) { entered.release(); await release.promise; } return ok; };
  try {
    const run = c.service.run('person'); await entered.promise; other.stop(); release.release(); await run;
    assert.equal(providerCalls, 0);
    assert.equal(c.starts, 0);
  } finally { release.release(); other.close(); c.close(); }
});

test('shared Stop at draft beginDispatch cannot start the material write', async () => {
  const c = consumer(), other = new TriageService(c.deps), entered = gate(), release = gate();
  const link = await c.deps.link(), begin = link.beginDispatch.bind(link);
  let writes = 0;
  c.deps.material = { list() { return []; }, load() { return null; }, create() { writes++; return { versions: [{ sha256: 'test' }] }; } } as unknown as TriageDeps['material'];
  link.beginDispatch = async (id, claim) => { const ok = await begin(id, claim); entered.release(); await release.promise; return ok; };
  try {
    const message = await c.box.read('m01'), item = { ...c.service.stored.items.m01, id: message.id, version: message.version };
    const draft = Reflect.get(c.service, 'draft').call(c.service, link, { run: 'run', fence: 1 }, item, message, { requester: message.from, reply: 'I will check the request.' }, new AbortController().signal);
    const rejected = assert.rejects(draft);
    await entered.promise; other.stop(); release.release(); await rejected;
    assert.equal(writes, 0);
  } finally { release.release(); other.close(); c.close(); }
});

test('an unsupported per-operation checker mode is refused before replacing a grant', async () => {
  const c = consumer(0);
  try {
    const cap = c.service.current()!, old = cap.mandate;
    const next = structuredClone(cap.payload); next.classes.find((v) => v.operation === 'mail.read')!.mode = 'propose';
    await assert.rejects(c.service.change(next), /class|mode|checker|represent/);
    assert.equal(c.service.current()!.mandate, old);
    assert.equal(c.starts, 0);
  } finally { c.close(); }
});

test('a loaded connector cannot substitute another entitled account under the signed grant', async () => {
  const c = consumer();
  const mail = c.deps.mail.bind(c.deps), seed = readSeed();
  const other = new FakeMailbox({ seed: { ...seed, account: 'other@example.test' } });
  c.deps.mail = async (...args) => ({ ...await mail(...args), connector: other });
  let reads = 0; const labels = other.labels.bind(other); other.labels = async () => { reads++; return labels(); };
  try {
    const result = await c.service.run('person');
    assert.equal(result.outcome, 'refused');
    assert.equal(reads, 0);
    assert.equal(c.starts, 0);
    assert.equal(c.service.current()!.state, 'suspended');
  } finally { c.close(); }
});

test('a stale consumer cannot erase completed requests and their pending proposals', async () => {
  const c = consumer(), stale = new TriageService(c.deps);
  const engine = c.deps.engine()!, start = engine.start.bind(engine);
  engine.start = (...args) => { const turn = start(...args); return { ...turn, outcome: turn.outcome.then((outcome) => ({ ...outcome, answer: 'requester: Person <person@example.test>\ncategory: billing\nurgency: normal\nlabel: Billing\nmove: none\nsuspicious: no\nreply:\nnone' })) }; };
  try {
    await c.service.run('person');
    assert.ok(c.service.stored.items.m01.proposal);
    const completed = structuredClone(c.service.stored.items);
    stale.stop();
    const restarted = new TriageService(c.deps);
    assert.deepEqual(restarted.stored.items, completed);
    restarted.close();
  } finally { stale.close(); c.close(); }
});


test('a second consumer leaves a live renewing run and its capability alone', async () => {
  const c = consumer(), entered = gate(), release = gate();
  const read = c.box.read.bind(c.box); c.box.read = async (id) => { entered.release(); await release.promise; return read(id); };
  const link = await c.deps.link(), coreRead = link.read.bind(link);
  const originalReclaim = link.reclaimRun.bind(link);
  let run: Promise<unknown> | undefined;
  try {
    run = c.service.run('person'); await entered.promise;
    link.reclaimRun = async () => { throw new CoreRefusal('not_claimable', 'The existing worker renewed its lease.'); };
    link.read = (async (...args: Parameters<typeof link.read>) => args[1].includes('AS live') ? { rows: [{ live: true }] } : coreRead(...args)) as typeof link.read;
    const other = new TriageService(c.deps);
    await assert.doesNotReject(other.recover());
    assert.equal(c.grants.get('root')!.revoked, false);
    assert.equal(other.current()!.state, 'active');
    other.close();
  } finally { link.reclaimRun = originalReclaim; release.release(); await run; c.close(); }
});

test('a declared higher class cannot turn a read checker mode into an automatic grant at signing', async () => {
  const c = consumer(0);
  try {
    await c.service.suspend('prepare a replacement');
    const next = structuredClone(c.service.current()!.payload); next.version++;
    const read = next.classes.find((v) => v.operation === 'mail.read')!; read.mode = 'propose'; read.effectClass = 3;
    c.service.propose(next);
    await assert.rejects(c.service.sign({ hash: 'signed-hash', presence: 'touch-id' }), /class|mode|checker|represent/);
    assert.ok([...c.grants].filter(([id]) => id !== 'connection').every(([, g]) => g.revoked));
  } finally { c.close(); }
});

test('a signature cannot inflate declared classes to release a checker-bound mailbox operation', async () => {
  const c = consumer(0);
  try {
    await c.service.suspend('prepare a replacement');
    const next = structuredClone(c.service.current()!.payload); next.version++;
    next.classes.find((v) => v.operation === 'workspace.write_document')!.effectClass = 3;
    next.classes.find((v) => v.operation === 'mail.label')!.effectClass = 4;
    next.classes = next.classes.filter((v) => v.operation !== 'mail.move');
    c.service.propose(next);
    await assert.rejects(c.service.sign({ hash: 'signed-hash', presence: 'touch-id' }), /class|mode/);
    assert.ok([...c.grants].filter(([id]) => id !== 'connection').every(([, g]) => g.revoked));
  } finally { c.close(); }
});

for (const value of [NaN, null, -1, 0.5]) test(`invalid model budget ${String(value)} cannot replace a narrowed grant`, async () => {
  const c = consumer(0);
  try {
    const next = structuredClone(c.service.current()!.payload); next.budget.modelTurnsPerDay = 1;
    await c.service.change(next); const old = c.service.current()!.mandate;
    const malformed = structuredClone(next); malformed.budget.modelTurnsPerDay = value as number;
    await assert.rejects(c.service.change(malformed), /budget|integer|finite/);
    assert.equal(c.service.current()!.mandate, old);
    assert.equal(c.grants.get(old)!.revoked, false);
  } finally { c.close(); }
});

test('same-service recovery can close a run after an unconfirmed finish without a stale owner reopening it', async () => {
  const c = consumer(0), link = await c.deps.link(), finish = link.finishRun.bind(link);
  try {
    link.finishRun = async () => { throw new Error('finish unavailable'); };
    await assert.rejects(c.service.run('person'), /unavailable/);
    link.finishRun = finish;
    await c.service.recover();
    c.service.stop();
    assert.ok(c.service.stored.runs.every((r) => !!r.endedAt));
  } finally { link.finishRun = finish; c.close(); }
});

test('a core-ended grant cannot start a model after a previously dispatched read returns', async () => {
  const c = consumer(), read = c.box.read.bind(c.box);
  c.box.read = async (id) => { const message = await read(id); c.grants.get('root')!.revoked = true; return message; };
  try {
    const run = await c.service.run('person');
    assert.equal(c.starts, 0);
    assert.equal(run.outcome, 'revoked');
  } finally { c.close(); }
});


test('narrowing snapshots the request before any awaited grant replacement', async () => {
  const c = consumer(0), entered = gate(), release = gate();
  const link = await c.deps.link(), call = link.call.bind(link);
  let issuedBudget: unknown;
  link.call = (async (...args: Parameters<typeof link.call>) => {
    if (args[1].includes('gov.revoke_mandate')) { entered.release(); await release.promise; }
    if (args[1].includes('gov.issue_mandate')) issuedBudget = args[2]?.[3];
    return call(...args);
  }) as typeof link.call;
  try {
    const next = structuredClone(c.service.current()!.payload); next.budget.effectsPerDay = 1;
    const changing = c.service.change(next); await entered.promise;
    next.budget.effectsPerDay = 9999; next.budget.modelTurnsPerDay = 9999;
    release.release(); await changing;
    assert.equal(issuedBudget, 1);
    assert.equal(c.service.current()!.effective!.budget.effectsPerDay, 1);
    assert.notEqual(c.service.current()!.effective!.budget.modelTurnsPerDay, 9999);
  } finally { release.release(); c.close(); }
});

for (const control of ['Stop', 'revoke'] as const) test(`an uncertain in-flight write starts no recovery reads after ${control}`, async () => {
  const c = consumer(), entered = gate(), release = gate();
  const link = await c.deps.link(), message = await c.box.read('m01');
  const request = { op: 'modify' as const, id: message.id, version: message.version, add: [], remove: ['INBOX'] };
  const binding = { provider: c.box.provider, account: c.box.account, registration: c.service.stored.connection!.registration.id };
  c.effects.set('pending-write', { id: 'pending-write', status: 'allowed', operation: 'mail.move', args: request, expected_version: message.version });
  c.service.stored.items.m01 = { ...message, done: true, proposal: { effect: 'pending-write', operation: 'mail.move', summary: 'Archive', recovery: 'exact-undo', undo: null, binding } };
  c.box.apply = async () => { entered.release(); await release.promise; throw new Error('no provider answer'); };
  let reads = 0, probes = 0;
  const labels = c.box.labels.bind(c.box);
  c.box.labels = async () => { reads++; return labels(); };
  c.box.probe = async () => { probes++; return { landed: null, evidence: 'unknown' }; };
  try {
    const applying = Reflect.get(c.service, 'apply').call(c.service, link, c.box, 'pending-write', Reflect.get(c.service, 'dispatchEpoch'), Reflect.get(c.service, 'authorityGeneration').call(c.service), c.service.stored.connection!.registration);
    await entered.promise;
    if (control === 'Stop') c.service.stop(); else await c.service.revoke();
    const before = reads;
    release.release(); await applying;
    assert.equal(c.effects.get('pending-write')!.status, 'unknown', 'the already dispatched write is observed');
    assert.equal(reads, before, 'no new label read after authority ends');
    assert.equal(probes, 0, 'the UNKNOWN stays visible without a new provider probe');
  } finally { release.release(); c.close(); }
});

test('Stop while a recovery label read is in flight prevents the later provider probe', async () => {
  const c = consumer(), entered = gate(), release = gate();
  const message = await c.box.read('m01');
  const binding = { provider: c.box.provider, account: c.box.account, registration: c.service.stored.connection!.registration.id };
  c.effects.set('unknown-write', { id: 'unknown-write', status: 'unknown', operation: 'mail.move', args: { op: 'modify', id: message.id, version: message.version, add: [], remove: ['INBOX'] }, note: JSON.stringify({ binding }) });
  const labels = c.box.labels.bind(c.box);
  c.box.labels = async () => { entered.release(); await release.promise; return labels(); };
  let probes = 0;
  c.box.probe = async () => { probes++; return { landed: null, evidence: 'unknown' }; };
  try {
    const reconciling = c.service.reconcile('unknown-write'); await entered.promise;
    c.service.stop(); release.release();
    assert.equal(await reconciling, 'unknown');
    assert.equal(probes, 0);
  } finally { release.release(); c.close(); }
});


for (const action of ['decide', 'undo', 'reconcile'] as const) test(`${action} refuses a different loaded registration on the same mailbox`, async () => {
  const c = consumer(), message = await c.box.read('m01'), mail = c.deps.mail.bind(c.deps);
  const binding = { provider: c.box.provider, account: c.box.account, registration: c.service.stored.connection!.registration.id };
  const request = { op: 'modify' as const, id: message.id, version: message.version, add: [], remove: ['INBOX'] };
  c.effects.set('old-receipt', { id: 'old-receipt', status: action === 'decide' ? 'awaiting_checker' : action === 'undo' ? 'succeeded' : 'unknown', operation: 'mail.move', args: request, expected_version: message.version, decision_id: 'decision', args_hash: 'hash', note: JSON.stringify({ binding, recovery: { request, ...binding } }) });
  c.service.stored.items.m01 = { ...message, done: true, proposal: { effect: 'old-receipt', operation: 'mail.move', summary: 'Archive', recovery: 'exact-undo', undo: null, binding } };
  c.deps.mail = async () => { const loaded = await mail(); return { ...loaded, registration: { ...loaded.registration, id: 'new-registration' } }; };
  let reads = 0;
  const labels = c.box.labels.bind(c.box);
  c.box.labels = async () => { reads++; return labels(); };
  c.box.probe = async () => { reads++; return { landed: null, evidence: 'unknown' }; };
  try {
    if (action === 'reconcile') assert.equal(await c.service.reconcile('old-receipt'), 'unknown');
    else if (action === 'undo') await assert.rejects(c.service.undo('old-receipt'), /registration/);
    else await assert.rejects(c.service.decide('old-receipt', 'accept'), /registration/);
    assert.equal(reads, 0);
    assert.equal(c.grants.get('root')!.revoked, false, 'the old grant still stands; actual implementation binding is independent');
  } finally { c.close(); }
});


for (const independent of [false, true]) test(`provider proof binds the Core receipt through apply and probe (independent change: ${independent})`, async () => {
  const c = consumer(), link = await c.deps.link(), mail = await c.deps.mail(), call = link.call.bind(link);
  const box = new FakeMailbox({ writes: 'open', initial: 2, faults: [{ at: 'modify', kind: independent ? 'timeout-before-commit' : 'timeout-after-commit' }] });
  c.deps.mail = async () => ({ ...mail, connector: box });
  const message = await box.read('m01');
  const classified = box.classify({ op: 'modify', id: message.id, version: message.version, add: ['Label_billing'], remove: [] }, await box.labels());
  assert.ok(classified.ok);
  const binding = { provider: box.provider, account: box.account, registration: mail.registration.id };
  const effect = 'uncertain-original';
  c.effects.set(effect, { id: effect, status: 'allowed', operation: 'mail.label', args: classified.value.args, expected_version: message.version });
  c.service.stored.items.m01 = { ...message, done: true, proposal: { effect, operation: 'mail.label', summary: 'Billing', recovery: 'exact-undo', undo: null, binding } };
  link.call = (async (...args: Parameters<typeof link.call>) => {
    if (args[1].includes('gov.reconcile_effect')) { c.effects.get(args[2]![0] as string)!.status = args[2]![1]; return args[2]![1]; }
    return call(...args);
  }) as typeof link.call;
  const apply = box.apply.bind(box), probe = box.probe.bind(box);
  const keys: unknown[] = [];
  box.apply = async (operation) => {
    keys.push(Reflect.get(operation, 'operationKey'));
    try { return await apply(operation); }
    catch (error) { if (independent) await apply({ ...operation, operationKey: 'independent-actor' } as typeof operation); throw error; }
  };
  box.probe = async (operation) => { keys.push(Reflect.get(operation, 'operationKey')); return probe(operation); };
  try {
    await Reflect.get(c.service, 'apply').call(c.service, link, box, effect, Reflect.get(c.service, 'dispatchEpoch'), Reflect.get(c.service, 'authorityGeneration').call(c.service), mail.registration);
    assert.deepEqual(keys, [effect, effect], 'the trusted service supplies the same exact receipt identity at both crossings');
    assert.equal(c.effects.get(effect)!.status, independent ? 'unknown' : 'succeeded');
    assert.equal(box.truth.applied.length, 1, 'only the original or independent actor applied; a probe never resends');
    assert.equal(box.truth.applied[0].operationKey, independent ? 'independent-actor' : effect);
  } finally { c.close(); }
});


test('same message IDs and versions in another mailbox cannot reuse or display earlier triage', async () => {
  const first = consumer();
  const seed = readSeed();
  const second = consumer(2, { ...seed, account: 'second@example.test', messages: seed.messages.map((m) => ({ ...m, subject: `Second mailbox: ${m.subject}` })) });
  try {
    await first.service.run('person');
    await first.service.disconnect();
    cpSync(join(first.home, 'triage/items'), join(second.home, 'triage/items'), { recursive: true });
    const file = join(second.home, 'triage/state.json'), disk = JSON.parse(readFileSync(file, 'utf8'));
    disk.items = first.service.stored.items; writeFileSync(file, JSON.stringify(disk));
    assert.equal(briefOf(second.service.stored, await second.service.effects()).requests.length, 0, 'old-account items are history, not current-account requests');
    await second.service.run('person');
    assert.equal(second.starts, 2, 'both colliding messages require their own read and model turn');
    assert.ok(second.service.stored.items.m01.subject.startsWith('Second mailbox:'));
    const restarted = new TriageService(second.deps); await restarted.recover(); await restarted.whenIdle();
    assert.ok(restarted.stored.items.m01.subject.startsWith('Second mailbox:'));
    await restarted.run('person');
    assert.equal(second.starts, 2, "restart reuses only this mailbox's completed items");
    restarted.close();
  } finally { first.close(); second.close(); }
});

for (const committed of [false, true]) test(`startup recovery probes a swept mailbox UNKNOWN without resending (committed: ${committed})`, async () => {
  const c = consumer(), link = await c.deps.link(), mail = await c.deps.mail(), call = link.call.bind(link);
  const stateFile = join(c.home, 'provider.json');
  const writer = new FakeMailbox({ stateFile, writes: 'open', initial: 2, faults: [{ at: 'modify', kind: committed ? 'timeout-after-commit' : 'timeout-before-commit' }] });
  const message = await writer.read('m01');
  const operation = writer.classify({ op: 'modify', id: message.id, version: message.version, add: ['Label_billing'], remove: [] }, await writer.labels());
  assert.ok(operation.ok);
  const effect = 'swept-unknown', binding = { provider: writer.provider, account: writer.account, registration: mail.registration.id };
  await assert.rejects(writer.apply({ ...operation.value, operationKey: effect }));
  const observer = new FakeMailbox({ stateFile, writes: 'open' });
  let resends = 0; observer.apply = async () => { resends++; throw new Error('recovery cannot resend'); };
  c.deps.mail = async () => ({ ...mail, connector: observer });
  c.effects.set(effect, { id: effect, status: 'unknown', operation: 'mail.label', args: operation.value.args, expected_version: message.version, note: JSON.stringify({ binding }) });
  link.call = (async (...args: Parameters<typeof link.call>) => {
    if (args[1].includes('gov.reconcile_effect')) { c.effects.get(args[2]![0] as string)!.status = args[2]![1]; return args[2]![1]; }
    return call(...args);
  }) as typeof link.call;
  try {
    const restarted = new TriageService(c.deps); await restarted.recover(); await restarted.whenIdle();
    assert.equal(c.effects.get(effect)!.status, committed ? 'succeeded' : 'failed');
    assert.equal(resends, 0); assert.equal(c.starts, 0);
    restarted.close();
  } finally { c.close(); }
});


test('an unbound legacy draft UNKNOWN cannot be bypassed by a new mailbox document namespace', async () => {
  const c = consumer(), link = await c.deps.link(), message = await c.box.read('m01');
  c.effects.set('legacy-unknown', { id: 'legacy-unknown', status: 'unknown', operation: 'workspace.write_document', args: { message: message.id, message_version: message.version } });
  const item = { ...message, done: false, needsYou: '' };
  try {
    await Reflect.get(c.service, 'draft').call(c.service, link, { run: 'run', fence: 1 }, item, message, { requester: message.from, reply: 'I will check.' }, new AbortController().signal);
    assert.match(item.needsYou, /UNKNOWN.*mailbox identity/);
    assert.equal(c.effects.size, 1, 'no new draft effect can bypass uncertain legacy work');
  } finally { c.close(); }
});


test('an unbound legacy aggregate is retained as evidence without attributing it to the current mailbox', () => {
  const c = consumer(0);
  try {
    const file = join(c.home, 'triage/state.json'), disk = JSON.parse(readFileSync(file, 'utf8'));
    disk.items.m01 = { id: 'm01', version: '1', from: { name: 'Earlier account', address: 'prior@example.test' }, subject: 'Unattributed legacy request', date: new Date().toISOString(), done: true };
    writeFileSync(file, JSON.stringify(disk));
    assert.equal(c.service.stored.items.m01, undefined);
    const evidence = readdirSync(join(c.home, 'triage/items')).map((name) => JSON.parse(readFileSync(join(c.home, 'triage/items', name), 'utf8')));
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].item.subject, disk.items.m01.subject);
  } finally { c.close(); }
});


test('a mailbox reconnect preserves its task identity without reviving its old read grant', async () => {
  const c = consumer(0), link = await c.deps.link(), call = link.call.bind(link), original = { ...c.service.stored.connection! };
  let created = 0;
  link.call = (async (...args: Parameters<typeof link.call>) => {
    if (args[1].includes('gov.classify_operations')) return null;
    if (args[1].includes('gov.create_agent')) return `new-agent-${++created}`;
    if (args[1].includes('gov.create_task')) return `new-task-${++created}`;
    return call(...args);
  }) as typeof link.call;
  try {
    await c.service.disconnect();
    const reconnected = await c.service.connect();
    assert.equal(reconnected.task, original.task);
    assert.equal(reconnected.agent, original.agent);
    assert.notEqual(reconnected.mandate, original.mandate);
    assert.equal(c.grants.get(original.mandate)!.revoked, true);
    assert.equal(c.grants.get(reconnected.mandate)!.revoked, false);
  } finally { c.close(); }
});

test('a changed read result cannot inherit a cached note from the listed version', async () => {
  const c = consumer(1), read = c.box.read.bind(c.box);
  try {
    await c.service.run('person');
    const message = await read('m01');
    const item = { ...c.service.stored.items.m01, run: 'interrupted', order: (c.service.stored.items.m01.order ?? 0) + 1, done: false, note: { requester: message.from, category: 'billing', urgency: 'normal', label: 'Billing', move: 'none', suspicious: false, reply: 'An obsolete reply for the first version.' } };
    saveItem(c.home, item as never);
    const file = join(c.home, 'triage/state.json'), disk = JSON.parse(readFileSync(file, 'utf8')); disk.items.m01 = item; writeFileSync(file, JSON.stringify(disk));
    c.box.read = async (id) => ({ ...await read(id), version: '999', subject: 'Changed after listing', body: 'A different request from the current message version.' });
    await c.service.run('person');
    assert.equal(c.starts, 2, 'the actual new version gets a fresh note');
    assert.equal(c.service.stored.items.m01.version, '999');
    assert.equal(c.service.stored.items.m01.subject, 'Changed after listing');
    assert.equal(c.service.stored.items.m01.note!.category, 'internal');
    assert.equal([...c.effects.values()].filter((e) => e.operation === 'workspace.write_document').length, 0);
  } finally { c.close(); }
});

for (const mailbox of [undefined, { provider: 'fake', account: 'sample@harborlight.example' }]) test(`a retained draft UNKNOWN blocks a different reconnect task (bound: ${!!mailbox})`, async () => {
  const c = consumer(), link = await c.deps.link(), message = await c.box.read('m01');
  const owner = mailbox && { ...mailbox, account: c.box.account };
  c.effects.set('old-task-draft', { id: 'old-task-draft', status: 'unknown', operation: 'workspace.write_document', args: { ...(owner ? { mailbox: owner } : {}), message: message.id, message_version: message.version } });
  const item = { ...message, done: false, needsYou: '' };
  try {
    await Reflect.get(c.service, 'draft').call(c.service, link, { run: 'different-task-run', fence: 1 }, item, message, { requester: message.from, reply: 'A different reply after reconnect.' }, new AbortController().signal);
    assert.match(item.needsYou, /UNKNOWN|unresolved/);
    assert.equal(c.effects.size, 1);
  } finally { c.close(); }
});

test('an older registration UNKNOWN cannot be re-proposed by its replacement on the same account', async () => {
  const c = consumer(), link = await c.deps.link(), message = await c.box.read('m01');
  const request = { op: 'modify', id: message.id, version: message.version, add: ['Label_billing'], remove: [] };
  const binding = { provider: c.box.provider, account: c.box.account, registration: 'earlier-registration' };
  c.effects.set('old-task-change', { id: 'old-task-change', status: 'unknown', operation: 'mail.label', args: request, expected_version: message.version, note: JSON.stringify({ binding }) });
  const readCore = link.read.bind(link);
  link.read = (async (...args: Parameters<typeof link.read>) => args[1].includes('WHERE task_id = $1') ? { rows: [] } : readCore(...args)) as typeof link.read;
  const item = { ...message, done: false, needsYou: '' };
  try {
    await Reflect.get(c.service, 'proposeChange').call(c.service, link, { run: 'new-task-run', fence: 1 }, c.box, item, message, { requester: message.from, category: 'billing', urgency: 'normal', label: 'Billing', move: 'none', suspicious: false, reply: '' }, await c.box.labels(), new AbortController().signal);
    assert.equal(c.effects.size, 1, 'no new receipt for the unresolved physical change');
    assert.match(item.needsYou, /UNKNOWN|unresolved/);
  } finally { c.close(); }
});


test('a person-edited current draft is preserved even when a newly allowed effect has different words', async () => {
  const c = consumer(), link = await c.deps.link(), message = await c.box.read('m01');
  let writes = 0, coreWrites = 0;
  const entry = { id: 'existing', projectId: 'project', name: 'A person-edited draft', class: 'accepted', current: 2, versions: [{ n: 1, by: 'agent', sha256: 'initial' }, { n: 2, by: 'person', sha256: 'person-edit' }] };
  c.deps.material = { list: () => [entry], load: () => entry, save: async () => { writes++; return { ok: true, value: entry }; }, create: () => { writes++; return entry; } } as unknown as TriageDeps['material'];
  link.writeDocument = async () => { coreWrites++; return 'document'; };
  const item = { ...message, done: false, needsYou: '' };
  try {
    await Reflect.get(c.service, 'draft').call(c.service, link, { run: 'new-task', fence: 1 }, item, message, { requester: message.from, reply: 'Different words on reconnect.' }, new AbortController().signal);
    assert.equal(writes, 0, "a person's accepted material cannot be replaced by a regenerated reply");
    assert.equal(coreWrites, 0);
    assert.match(item.needsYou, /edits are preserved/);
    assert.equal([...c.effects.values()][0].status, 'failed');
  } finally { c.close(); }
});


for (const denial of ['read', 'modify', 'provider', 'account'] as const) test(`write dispatch fails closed for missing or mismatched ${denial} entitlement`, async () => {
  const c = consumer(), link = await c.deps.link(), message = await c.box.read('m01'), mail = await c.deps.mail();
  const binding = { provider: c.box.provider, account: c.box.account, registration: mail.registration.id };
  c.effects.set('entitlement-write', { id: 'entitlement-write', status: 'allowed', operation: 'mail.move', args: { op: 'modify', id: message.id, version: message.version, add: [], remove: ['INBOX'] }, expected_version: message.version });
  c.service.stored.items.m01 = { ...message, done: true, proposal: { effect: 'entitlement-write', operation: 'mail.move', summary: 'Archive', recovery: 'exact-undo', undo: null, binding } };
  let applied = 0;
  c.box.apply = async () => { applied++; return { outcome: 'succeeded', evidence: 'applied' }; };
  c.box.entitlement = async () => ({ ok: denial !== 'read', provider: denial === 'provider' ? 'other' : c.box.provider, account: denial === 'account' ? 'other@example.test' : c.box.account, missing: denial === 'modify' ? ['permission to change labels'] : [], detail: 'Synthetic entitlement response' });
  try {
    await assert.rejects(Reflect.get(c.service, 'apply').call(c.service, link, c.box, 'entitlement-write', Reflect.get(c.service, 'dispatchEpoch'), Reflect.get(c.service, 'authorityGeneration').call(c.service), mail.registration), /entitle|permission/);
    assert.equal(applied, 0);
  } finally { c.close(); }
});

test('entitlement lost while beginDispatch awaits cannot start the provider write', async () => {
  const c = consumer(), link = await c.deps.link(), message = await c.box.read('m01'), mail = await c.deps.mail();
  const binding = { provider: c.box.provider, account: c.box.account, registration: mail.registration.id };
  c.effects.set('late-entitlement-write', { id: 'late-entitlement-write', status: 'allowed', operation: 'mail.move', args: { op: 'modify', id: message.id, version: message.version, add: [], remove: ['INBOX'] }, expected_version: message.version });
  c.service.stored.items.m01 = { ...message, done: true, proposal: { effect: 'late-entitlement-write', operation: 'mail.move', summary: 'Archive', recovery: 'exact-undo', undo: null, binding } };
  const begin = link.beginDispatch.bind(link), entitlement = c.box.entitlement.bind(c.box);
  let entitled = true, applied = 0;
  c.box.entitlement = async () => ({ ...await entitlement(), ok: entitled });
  c.box.apply = async () => { applied++; return { outcome: 'succeeded', evidence: 'applied' }; };
  link.beginDispatch = async (...args) => { const result = await begin(...args); entitled = false; return result; };
  try {
    await assert.rejects(Reflect.get(c.service, 'apply').call(c.service, link, c.box, 'late-entitlement-write', Reflect.get(c.service, 'dispatchEpoch'), Reflect.get(c.service, 'authorityGeneration').call(c.service), mail.registration), /entitle|permission/);
    assert.equal(applied, 0);
    assert.equal(c.effects.get('late-entitlement-write')!.status, 'failed', 'no provider call began, so this is a known failure');
  } finally { c.close(); }
});

for (const late of [false, true]) test(`draft namespace conflict ${late ? 'during dispatch fails the original receipt' : 'before proposal needs the person without throwing'}`, async () => {
  const c = consumer(), link = await c.deps.link(), message = await c.box.read('m01');
  c.deps.material = new MaterialStore(c.home, {}, () => {});
  const occupy = () => c.deps.material.create('project', 'Reply to Person (m01).md/agent.md', 'text/plain', Buffer.from('Other work.'), 'working', 'agent', undefined, 'managed');
  if (late) {
    const begin = link.beginDispatch.bind(link);
    link.beginDispatch = async (id, claim) => { const result = await begin(id, claim); occupy(); return result; };
  } else occupy();
  let coreWrites = 0; link.writeDocument = async () => { coreWrites++; return 'document'; };
  const item = { ...message, done: false, needsYou: '' };
  try {
    await Reflect.get(c.service, 'draft').call(c.service, link, { run: 'draft-run', fence: 1 }, item, message, { requester: { name: 'Person', address: 'person@example.test' }, reply: 'A reply.' }, new AbortController().signal);
    assert.match(item.needsYou, /folder|path/);
    assert.equal(coreWrites, 0);
    assert.equal(c.effects.size, late ? 1 : 0);
    if (late) assert.equal([...c.effects.values()][0].status, 'failed');
    assert.equal(c.deps.material.list('project').some(entry => entry.name === 'Reply to Person (m01).md'), false);
  } finally { c.close(); }
});

for (const change of ['tamper', 'provider', 'engine']) test(`triage rechecks ${change} policy before starting the next message`, async t => {
  const c = consumer(); t.after(() => c.close());
  const fixture = systemFixture(t, document());
  const engine = c.deps.engine()!, start = engine.start.bind(engine);
  c.deps.engine = () => ({ ...engine, id: 'harness-pi', start(request, context) {
    const turn = start(request, context);
    return { ...turn, outcome: turn.outcome.then(outcome => {
      if (change === 'tamper') fixture.tamper();
      else fixture.update(document(change === 'provider' ? { modelProviders: ['openai'] } : { harnesses: ['harness-codex'] }));
      return outcome;
    }) };
  } });
  const result = await c.service.run('person');
  assert.equal(c.starts, 1);
  assert.equal(result.outcome, 'failed');
  assert.match(result.reason!, /Managed policy refused/);
});

test('triage repeats live policy at the harness send gate after start and after credential waits', async t => {
  const c = consumer(); t.after(() => c.close());
  const fixture = systemFixture(t, document());
  const engine = c.deps.engine()!;
  let requests = 0, starts = 0;
  c.deps.engine = () => ({ ...engine, id: 'harness-pi', start(request) {
    starts++;
    assert.equal(request.stillAllowed?.(), true);
    fixture.tamper();
    const allowed = request.stillAllowed?.();
    if (allowed === true) requests++;
    assert.match(String(allowed), /Managed policy refused \(signature\)/);
    return { events: (async function* () {})(), outcome: Promise.resolve({ status: 'interrupted' as const, answer: '', error: String(allowed), usage: { input: 0, output: 0 } }), stop() {}, steer() {} };
  } });
  const result = await c.service.run('person');
  assert.equal(requests, 0);
  assert.equal(starts, 1);
  assert.equal(result.outcome, 'failed');
  assert.match(result.reason!, /Managed policy refused \(signature\)/);
});

test('triage uses the owning Host admission when required telemetry changes between messages', async t => {
  const { createPolicyAdmission } = await import('../src/composition/policy-admission.ts');
  const { fakeCollector } = await import('./fake-telemetry-collector.ts');
  const c = consumer(); t.after(() => c.close());
  const collector = await fakeCollector(); t.after(() => collector.close());
  writeFileSync(join(c.home, 'settings.json'), JSON.stringify({ telemetry: { endpoint: collector.endpoint } }));
  systemFixture(t, document({ telemetryRequired: true, telemetryHost: '127.0.0.1' }));
  const host = { on: () => () => {}, call: async () => assert.fail('Policy readiness must not create a Host API call') } as unknown as import('../src/composition/host-types.ts').Host;
  const admission = createPolicyAdmission(c.home, 'harness-pi', () => undefined, undefined, () => host, false);
  await admission.ready(); t.after(() => admission.close());
  const service = new TriageService(c.deps); t.after(() => service.close());
  const engine = c.deps.engine()!, start = engine.start.bind(engine);
  c.deps.engine = () => ({ ...engine, id: 'harness-pi', start(request, context) {
    const turn = start(request, context);
    return { ...turn, outcome: turn.outcome.then(outcome => {
      writeFileSync(join(c.home, 'settings.json'), JSON.stringify({ telemetry: { endpoint: 'http://127.0.0.1:9/v1/traces' } }));
      return outcome;
    }) };
  } });
  const result = await service.run('person');
  assert.equal(c.starts, 1);
  assert.equal(result.outcome, 'failed');
  assert.match(result.reason!, /Required telemetry is not running at the current policy destination/);
});

test('triage refuses an invalid policy before opening its Core link', async t => {
  const c = consumer(); t.after(() => c.close());
  const fixture = systemFixture(t, document()); fixture.tamper();
  c.deps.link = async () => assert.fail('Core must not be opened');
  await assert.rejects(c.service.run('person'), /Managed policy refused \(signature\)/);
  assert.equal(c.starts, 0);
});

test('triage retains its constructing Host admission when another Host uses the same home', async t => {
  const { createPolicyAdmission } = await import('../src/composition/policy-admission.ts');
  const c = consumer(); t.after(() => c.close());
  const fixture = systemFixture(t, document());
  const host = {} as import('../src/composition/host-types.ts').Host;
  const first = createPolicyAdmission(c.home, 'harness-acp', () => ({ environment: 'person-rights' }), undefined, () => host, false);
  const service = new TriageService(c.deps); t.after(() => service.close());
  const second = createPolicyAdmission(c.home, 'harness-pi', () => undefined, undefined, () => host, false);
  t.after(async () => { await first.close(); await second.close(); });
  fixture.update(document({ personRights: false }));
  await assert.rejects(service.run('person'), /Managed policy refused.*person-rights/);
  assert.equal(c.starts, 0);
});
