import assert from 'node:assert/strict';
import { test } from 'node:test';
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTerminal } from '../src/composition/terminal-stream.ts';
import { captureTerminalProcess, inspectTerminalProcess, parseTerminalProcStat } from '../src/composition/terminal-process.ts';
import { terminalOutput } from '../src/composition/terminal-output.ts';

const value = <T>(r: import('../src/api.ts').Receipt<T>) => { assert.ok(r.ok, JSON.stringify(r)); return r.value; };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t: import('node:test').TestContext) {
  const home = fs.mkdtempSync(join(tmpdir(), 'terminal-round-three-'));
  const original = cp.execFileSync, spawn = cp.spawn, kill = process.kill;
  let unavailable = false, failures = 0;
  const signals: string[] = [];
  const child = Object.assign(new EventEmitter(), { pid: 424242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  cp.spawn = (() => child) as unknown as typeof spawn;
  cp.execFileSync = (() => { if (unavailable || failures-- > 0) throw new Error('process check unavailable'); return '424242 424242 Mon Jan  1 00:00:00 2001 S\n'; }) as unknown as typeof original;
  process.kill = ((_pid: number, sig: string) => { signals.push(sig); return true; }) as typeof kill;
  syncBuiltinESMExports();
  const terminal = createTerminal({ home, directory: () => home, exists: () => true, changed() {} });
  const block = value(await terminal.start({ projectId: 'p', command: 'controlled', clientKey: 'once' }));
  const file = join(home, 'terminal', fs.readdirSync(join(home, 'terminal'))[0]);
  const read = async () => value(await terminal.list('p')).commands[0];
  t.after(async () => {
    child.stderr.emit('data', Buffer.from('terminal-exit:0\n')); child.emit('close', 0, null);
    await terminal.close().catch(() => {});
    cp.execFileSync = original; cp.spawn = spawn; process.kill = kill; syncBuiltinESMExports();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, file, terminal, block, child, signals, read, unavailable(v: boolean) { unavailable = v; }, failOnce() { failures = 1; } };
}

test('an unavailable Stop check retries without signalling, then keeps identity and slot with Stop enabled', async t => {
  const f = await fixture(t); f.unavailable(true);
  await f.terminal.stop('p', f.block.id);
  assert.equal((await f.read()).status, 'running', 'a failed check is not a lost process');
  assert.deepEqual(f.signals, []);
  await wait(800);
  const block = await f.read();
  assert.equal(block.status, 'running'); assert.equal(block.stopping, false);
  assert.match(block.detail!, /Stop could not confirm.*press Stop again/i);
  assert.ok(JSON.parse(fs.readFileSync(f.file, 'utf8')).processes[f.block.id]);
  assert.equal((await f.terminal.start({ projectId: 'p', command: 'second', clientKey: 'second' })).ok, false);
  f.unavailable(false); await f.terminal.stop('p', f.block.id);
  assert.deepEqual(f.signals, ['SIGINT']);
});

test('a single failed Stop check retries the same signal without abandoning custody', async t => {
  const f = await fixture(t); f.failOnce();
  await f.terminal.stop('p', f.block.id);
  assert.deepEqual(f.signals, [], 'Stop must not consume a failed check before checking again');
  assert.equal((await f.read()).status, 'running');
  await wait(250); assert.deepEqual(f.signals, ['SIGINT']);
});

test('an owned child exit settles normally while Stop cannot check its identity', async t => {
  const f = await fixture(t); f.unavailable(true);
  await f.terminal.stop('p', f.block.id);
  f.child.stderr.emit('data', Buffer.from('terminal-exit:0\n')); f.child.emit('close', 0, null);
  await wait(50);
  assert.equal((await f.read()).status, 'succeeded');
});

test('recovery and subsequent reads keep an unavailable identity running until a later confirmed check', async t => {
  const f = await fixture(t); f.unavailable(true);
  const recovered = createTerminal({ home: f.home, directory: () => f.home, exists: () => true, changed() {} });
  const read = async () => value(await recovered.list('p')).commands[0];
  try {
    assert.equal((await read()).status, 'running'); assert.match((await read()).detail!, /before the app stopped/);
    assert.equal(recovered.hasRunning('p'), true);
    f.unavailable(false); assert.equal((await read()).status, 'running');
    await recovered.stop('p', f.block.id); assert.deepEqual(f.signals, ['SIGINT']);
  } finally { await recovered.close(); }
});

test('the close deadline preserves an unfinished ladder as running with saved identity', async t => {
  const f = await fixture(t);
  const now = Date.now; let clock = 0;
  Date.now = () => now() + (clock++ > 0 ? 10_000 : 0);
  try { await f.terminal.close(); } finally { Date.now = now; }
  assert.deepEqual(f.signals, ['SIGINT'], 'the close deadline precedes the next ladder step');
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(saved.commands[0].status, 'running'); assert.equal(saved.commands[0].stopping, false);
  assert.ok(saved.processes[f.block.id]);
});

test('a changed group is different from a process check that could not run', async t => {
  const f = await fixture(t);
  const identity = captureTerminalProcess(424242)!;
  f.unavailable(true); assert.equal(inspectTerminalProcess(identity), 'unconfirmed');
  f.unavailable(false); identity.members[0].start = 'different birth';
  assert.notEqual(inspectTerminalProcess(identity), 'unconfirmed');
});

test('Linux captures and checks recorded proc stat text without ps, including spaces and parentheses in comm', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const read = fs.readFileSync, dirs = fs.readdirSync, exec = cp.execFileSync;
  const recorded = '42 (worker (test) name) S 1 42 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 123456 0\n';
  Object.defineProperty(process, 'platform', { value: 'linux' });
  fs.readdirSync = (() => ['1', '42', '43', '44', 'self']) as unknown as typeof dirs;
  fs.readFileSync = ((path: any, ...args: any[]) => String(path).startsWith('/proc/') ? recorded.replace(/^42 /, String(path).split('/')[2] + ' ').replace(' S 1 42 ', String(path).includes('/44/') ? ' Z 1 42 ' : String(path).includes('/1/') ? ' S 0 1 ' : ' S 1 42 ') : (read as any)(path, ...args)) as typeof read;
  cp.execFileSync = (() => { throw new Error('ps is not installed'); }) as typeof exec;
  syncBuiltinESMExports();
  try {
    const identity = captureTerminalProcess(42);
    assert.deepEqual(identity, { group: 42, members: [{ pid: 42, start: '123456' }, { pid: 43, start: '123456' }] });
    assert.equal(inspectTerminalProcess(identity), 'same');
    assert.deepEqual(parseTerminalProcStat(recorded), { pid: 42, group: 42, start: '123456', state: 'S' });
    assert.equal(parseTerminalProcStat(recorded.replace(') S ', ') t ')).state, 't');
  } finally { Object.defineProperty(process, 'platform', originalPlatform); fs.readFileSync = read; fs.readdirSync = dirs; cp.execFileSync = exec; syncBuiltinESMExports(); }
});

test('a capped preview keeps the beginning and latest error with exact middle omissions', () => {
  const block = { output: '', omittedBytes: 0, omittedLines: 0 } as import('../src/api.ts').TerminalBlock;
  const buffer = terminalOutput(block);
  const input = Buffer.from('BEGIN\n' + 'x\n'.repeat(1_000_000) + 'FINAL ERROR\n');
  buffer.append(input, 0); buffer.end();
  assert.ok(block.output.startsWith('BEGIN\n')); assert.ok(block.output.endsWith('FINAL ERROR\n'));
  assert.ok(Buffer.byteLength(block.output) <= 65_536); assert.ok(block.output.split('\n').length <= 1001);
  assert.equal(block.omittedBytes, input.length - Buffer.byteLength(block.output));
  assert.equal(block.omittedLines, 1_000_002 - (block.output.match(/\n/g) ?? []).length);
});

test('a reporting shell killed outside Stop leaves no observed exit status and is not known', async () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'terminal-no-receipt-'));
  const terminal = createTerminal({ home, directory: () => home, exists: () => true, changed() {} });
  try {
    value(await terminal.start({ projectId: 'p', command: 'kill -KILL "$PPID"', clientKey: 'no-receipt' }));
    let block;
    for (let i = 0; i < 200; i++) { block = value(await terminal.list('p')).commands[0]; if (block.status !== 'running') break; await wait(20); }
    assert.equal(block!.code, null); assert.equal(block!.status, 'not-known');
  } finally { await terminal.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('tail snapshots advance after reads, strip controls and stay within both caps for Unicode', () => {
  const block = { output: '', omittedBytes: 0, omittedLines: 0 } as import('../src/api.ts').TerminalBlock;
  const buffer = terminalOutput(block);
  buffer.append(Buffer.from('BEGIN\n' + '界'.repeat(30_000)), 0); buffer.publish();
  assert.doesNotMatch(block.output, /\ufffd/);
  buffer.append(Buffer.from('\n\x1b[31mLATEST\x1b[0m\u202e\n'), 0); buffer.publish();
  assert.ok(block.output.startsWith('BEGIN\n')); assert.ok(block.output.endsWith('\nLATEST\n'));
  assert.doesNotMatch(block.output, /\x1b|\u202e|\ufffd/);
  assert.ok(Buffer.byteLength(block.output) <= 65_536);
  const published = block.output; buffer.end(); assert.equal(block.output, published);
});

test('a child exit observed during a later unavailable ladder check still ends the owned block', async t => {
  const f = await fixture(t);
  await f.terminal.stop('p', f.block.id); assert.deepEqual(f.signals, ['SIGINT']);
  f.unavailable(true); f.child.emit('close', null, 'SIGINT');
  await wait(1100);
  assert.equal((await f.read()).status, 'failed'); assert.equal((await f.read()).detail, 'Stopped by you');
});
