// 10 November 2026, owner direction: a send is a signed tool like any other; UNKNOWN pauses that tool only, and dispatching is not UNKNOWN.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { inActiveHomeLockScope } from '../src/composition/home-lock.ts';
import { CONNECTION_UNKNOWN, TOOL_DISPATCHING } from '../src/connectors/service.ts';
import { pauseFixture } from './connector-pause-service-fixture.ts';
import { value } from './helpers.ts';

for (const sameTurn of [true, false]) test(`UNKNOWN holds a different signed effect in ${sameTurn ? 'the same' : 'a new'} turn`, async t => {
  const f = await pauseFixture(t);
  assert.equal((await f.call('draft_note', { text: 'unknown' }, 'first')).outcome, 'SENT');
  const result = await f.call('draft_note', { text: 'different' }, sameTurn ? 'first' : 'second');
  assert.equal(result.outcome, 'HELD'); assert.equal(result.detail, CONNECTION_UNKNOWN);
  assert.deepEqual(f.calls().map(c => c.tool), ['draft_note']);
  assert.equal(f.held()[0].state, 'waiting'); assert.equal(f.held()[0].standing, undefined);
});

test('reads, another connection and the person’s per-call release keep working', async t => {
  const f = await pauseFixture(t); await f.call('draft_note', { text: 'unknown' });
  assert.equal((await f.call('search', { q: 'read' })).outcome, 'READ');
  assert.equal((await f.call('draft_note', { text: 'other' }, undefined, 'claude-code:other')).outcome, 'SENT');
  await f.call('draft_note', { text: 'person' }); const held = f.held()[0];
  assert.equal(value(await f.service.decide(held.effect, held.argsHash, 'release')).state, 'sent');
  assert.deepEqual(f.calls().map(c => c.tool), ['draft_note', 'search', 'draft_note', 'draft_note']);
  assert.equal(f.held().find(h => h.effect === held.effect)?.standing, undefined);
  assert.equal(f.held().find(h => h.args.text === 'unknown')?.state, 'unknown');
});

test('reopening and hand-written deletion of the UNKNOWN cannot unpause Core state', async t => {
  const f = await pauseFixture(t); await f.call('draft_note', { text: 'unknown' }); await f.reopen();
  const file = join(f.home, 'connectors/mcp.json'), s = JSON.parse(readFileSync(file, 'utf8'));
  s.held = []; // Deliberate same-user attack, not an admitted Host write.
  s.resolutions = [{ verdict: 'succeeded' }]; writeFileSync(file, JSON.stringify(s));
  assert.equal((await f.call('draft_note', { text: 'after file attack' })).outcome, 'HELD');
  assert.deepEqual(f.calls().map(c => c.tool), ['draft_note']);
});

test('a second process sees the Core pause with no in-memory history', async t => {
  const f = await pauseFixture(t); await f.call('draft_note', { text: 'unknown' });
  const child = spawn(process.execPath, [join(import.meta.dirname, 'fixtures/connector-pause-child.ts'), f.home, f.person], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
  const exit = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(exit, 0, err); assert.match(out, /HELD/); assert.deepEqual(f.calls().map(c => c.tool), ['draft_note']);
});

test('ending and giving a new signature do not settle an unknown effect', async t => {
  const f = await pauseFixture(t); await f.call('draft_note', { text: 'unknown' });
  value(await f.service.set('claude-code:notes', { tool: { name: 'draft_note', standing: false } }));
  await f.sign('draft_note'); assert.equal((await f.call('draft_note', { text: 'new signature' })).outcome, 'HELD');
  assert.equal(f.held().find(h => h.args.text === 'unknown')?.state, 'unknown');
});

test('Core crossings stay outside the home lock and an unavailable pause check fails closed', async t => {
  const f = await pauseFixture(t), read = f.link.read.bind(f.link);
  f.link.read = (async (...args: Parameters<typeof read>) => {
    assert.equal(inActiveHomeLockScope(f.home), false);
    if (String(args[1]).includes('FROM app.effects prior JOIN')) throw Error('private backend diagnostics');
    return read(...args);
  }) as typeof read;
  const result = await f.call('draft_note', { text: 'cannot inspect' });
  assert.equal(result.outcome, 'HELD'); assert.equal(f.calls().length, 0);
});

for (const answer of ['happened', 'did_not_happen', 'keep_closed'] as const) test(`person resolution ${answer} records a receipt and never repeats the original call`, async t => {
  const f = await pauseFixture(t); await f.call('draft_note', { text: 'unknown' }); const original = f.held()[0];
  const result = value(await f.service.resolveUnknown(original.effect, original.argsHash, answer));
  assert.equal(result.state, 'recorded'); assert.equal(result.answer, answer); assert.ok(result.id);
  const state = (await f.link.read<{ status: string }>(f.link.person(), 'SELECT status FROM app.effects WHERE id=$1', [original.effect])).rows[0].status;
  assert.equal(state, answer === 'happened' ? 'succeeded' : answer === 'did_not_happen' ? 'failed' : 'unknown');
  if (answer === 'keep_closed') assert.equal(result.ledger, undefined);
  else {
    assert.ok(result.ledger?.hash); assert.ok(result.ledger?.seq);
    assert.deepEqual(value(await f.service.resolveUnknown(original.effect, original.argsHash, answer)), result, 'repeating the person request returns the same receipt');
  }
  assert.equal((await f.call('draft_note', { text: answer })).outcome, answer === 'keep_closed' ? 'HELD' : 'SENT');
  assert.equal(f.calls().filter(c => c.args.text === 'unknown').length, 1);
  assert.equal(await f.link.call(f.link.person(), 'SELECT gov.verify_ledger()'), null);
});

test('two UNKNOWNs must both be resolved; keep closed can later be answered conclusively', async t => {
  const f = await pauseFixture(t); await f.call('draft_note', { text: 'unknown' }, 'first');
  await f.call('draft_note', { text: 'unknown', nonce: 'second' }, 'second'); const second = f.held()[0];
  assert.equal(second.state, 'waiting');
  assert.equal(value(await f.service.decide(second.effect, second.argsHash, 'release')).state, 'unknown');
  const originals = f.held().filter(h => h.state === 'unknown'); assert.equal(originals.length, 2);
  value(await f.service.resolveUnknown(originals[0].effect, originals[0].argsHash, 'did_not_happen'));
  assert.equal((await f.call('draft_note', { text: 'one remains' })).outcome, 'HELD');
  value(await f.service.resolveUnknown(originals[1].effect, originals[1].argsHash, 'keep_closed'));
  assert.equal((await f.call('draft_note', { text: 'kept closed' })).outcome, 'HELD');
  value(await f.service.resolveUnknown(originals[1].effect, originals[1].argsHash, 'happened'));
  assert.equal((await f.call('draft_note', { text: 'both inspected' })).outcome, 'SENT');
  assert.equal(f.calls().filter(c => c.args.text === 'unknown').length, 2);
});

test('wrong statement and engine run cannot reconcile; a lost Core reply recovers the same ledger receipt', async t => {
  const f = await pauseFixture(t); await f.call('draft_note', { text: 'unknown' }); const original = f.held()[0];
  assert.equal((await f.service.resolveUnknown(original.effect, 'wrong', 'happened')).ok, false);
  const handle = await f.link.startRun(await f.link.createTask('Untrusted resolver'));
  await assert.rejects(f.link.call(f.link.runOf(handle), "SELECT gov.reconcile_effect($1,'succeeded',NULL,'hash','engine claim')", [original.effect]), /reconciler/);
  await f.link.finishRun(handle, 'failed');
  const call = f.link.call.bind(f.link);
  f.link.call = (async (...args: Parameters<typeof call>) => {
    assert.equal(inActiveHomeLockScope(f.home), false);
    const result = await call(...args);
    if (String(args[1]).includes('reconcile_effect')) throw Error('opaque private backend diagnostic');
    return result;
  }) as typeof call;
  const receipt = value(await f.service.resolveUnknown(original.effect, original.argsHash, 'happened'));
  assert.ok(receipt.ledger); assert.equal(f.calls().length, 1);
  assert.equal((await f.link.read(f.link.person(), "SELECT seq FROM app.ledger WHERE entry_type='effect.reconciled' AND subject=$1", [original.effect])).rows.length, 1);
});

test('an already approved call is held if another outcome becomes UNKNOWN before dispatch', async t => {
  const f = await pauseFixture(t), begin = f.link.beginConnectorDispatch.bind(f.link);
  let injected = false;
  f.link.beginConnectorDispatch = async (...args) => {
    if (!injected) { injected = true; await f.call('draft_note', { text: 'unknown' }, 'racing'); }
    return begin(...args);
  };
  assert.equal((await f.call('draft_note', { text: 'approved before unknown' })).outcome, 'HELD');
  assert.deepEqual(f.calls().map(c => c.tool), ['draft_note']);
  const h = f.held().find(h => h.args.text === 'approved before unknown')!;
  assert.equal(h.state, 'waiting'); assert.equal(h.detail, CONNECTION_UNKNOWN);
});


test('a hand-written person approval cannot make an engine answer a held call or bypass the pause', async t => {
  const f = await pauseFixture(t); await f.call('draft_note', { text: 'unknown' });
  await f.call('draft_note', { text: 'forged person' }, 'forged');
  const file = join(f.home, 'connectors/mcp.json'), s = JSON.parse(readFileSync(file, 'utf8'));
  s.held.find((h: { args: { text: string } }) => h.args.text === 'forged person').approval = { by: 'person' };
  writeFileSync(file, JSON.stringify(s));
  assert.equal((await f.call('draft_note', { text: 'forged person' }, 'forged')).outcome, 'HELD');
  assert.deepEqual(f.calls().map(c => c.tool), ['draft_note']);
});

test('Core standing answer keeps the pause even if its local approval is relabelled person', async t => {
  const f = await pauseFixture(t), begin = f.link.beginConnectorDispatch.bind(f.link);
  let injected = false;
  f.link.beginConnectorDispatch = async (...args) => {
    if (!injected) { injected = true; await f.call('draft_note', { text: 'unknown' }, 'racing'); }
    return begin(...args);
  };
  await f.call('draft_note', { text: 'approved' }, 'approved');
  const file = join(f.home, 'connectors/mcp.json'), s = JSON.parse(readFileSync(file, 'utf8'));
  s.held.find((h: { args: { text: string } }) => h.args.text === 'approved').approval = { by: 'person' };
  writeFileSync(file, JSON.stringify(s));
  assert.equal((await f.call('draft_note', { text: 'approved' }, 'approved')).outcome, 'HELD');
  assert.deepEqual(f.calls().map(c => c.tool), ['draft_note']);
});

test('concurrent database admissions permit only one unresolved dispatch, using Core’s answer basis', async t => {
  const f = await pauseFixture(t), claims: [string, string][] = [];
  f.link.beginDispatch = async (effect, claim) => { claims.push([effect, claim]); return false; };
  await f.call('draft_note', { text: 'concurrent one' });
  await f.call('draft_note', { text: 'concurrent two' });
  assert.equal(claims.length, 2); assert.equal(f.calls().length, 0);
  // Different pool clients race with a fresh snapshot after the shared database lock.
  // A caller claiming "person" cannot override the standing basis already recorded in Core.
  const admitted = await Promise.all(claims.map(([effect, claim]) => f.link.beginConnectorDispatch(effect, claim, false)));
  assert.deepEqual(admitted.slice().sort(), ['begun', 'busy']);
  const index = admitted.indexOf('begun');
  await f.link.observe(claims[index][0], claims[index][1], 'unknown', 'synthetic-unanswered-dispatch', 'Local admission test; no provider call was made.');
  assert.equal((await f.call('draft_note', { text: 'later' })).outcome, 'HELD');
});

test('UNKNOWN on a tool leaves another signed tool on the connection available', async t => {
  const f = await pauseFixture(t); await f.call('draft_note', { text: 'unknown' });
  assert.equal((await f.call('plain', { x: 'independent tool' })).outcome, 'SENT');
  assert.deepEqual(f.calls().map(c => c.tool), ['draft_note', 'plain']);
});

for (const byPerson of [false, true]) test(`a parallel same-tool call is held truthfully and later ${byPerson ? 'released' : 'retried'}`, async t => {
  const f = await pauseFixture(t), begin = f.link.beginDispatch.bind(f.link);
  let first!: () => void, continueFirst!: () => void;
  const begun = new Promise<void>(r => { first = r; }), continueDispatch = new Promise<void>(r => { continueFirst = r; });
  let n = 0;
  f.link.beginDispatch = async (...args) => {
    const result = await begin(...args);
    if (result && ++n === 1) { first(); await continueDispatch; }
    return result;
  };
  const firstCall = f.call('draft_note', { text: 'first dispatch' }); await begun;
  if (byPerson) {
    const pause = f.link.connectorEffectPause.bind(f.link); let bypass = true;
    f.link.connectorEffectPause = async effect => { if (bypass) { bypass = false; return null; } return pause(effect); };
  }
  const held = await f.call('draft_note', { text: 'second dispatch' }, 'second');
  assert.equal(held.outcome, 'HELD'); assert.equal(held.detail, TOOL_DISPATCHING);
  assert.equal(f.held().some(h => h.state === 'unknown'), false);
  continueFirst(); assert.equal((await firstCall).outcome, 'SENT');
  const second = f.held().find(h => h.args.text === 'second dispatch')!;
  if (byPerson) assert.equal(value(await f.service.decide(second.effect, second.argsHash, 'release')).state, 'sent');
  else assert.equal((await f.call('draft_note', { text: 'second dispatch' }, 'second')).outcome, 'SENT');
  assert.deepEqual(f.calls().map(c => c.args.text), ['first dispatch', 'second dispatch']);
});
