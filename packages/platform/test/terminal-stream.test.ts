import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs, { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import cp, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTerminal, runTerminal } from '../src/composition/terminal-stream.ts';

async function setup(t: import('node:test').TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'terminal-stream-'));
  const terminal = createTerminal({ home, directory: () => home, exists: () => true, changed() {} });
  const services = [terminal];
  t.after(async () => {
    for (const service of services) {
      const view = await service.list('p');
      if (view.ok) for (const block of view.value.commands) if (block.status === 'running') {
        await service.stop('p', block.id);
        await until(() => service.list('p').then(value), v => v.commands.find(b => b.id === block.id)?.status !== 'running');
      }
      await service.close();
    }
    rmSync(home, { recursive: true, force: true });
  });
  return { terminal, home, services };
}
const value = <T>(r: import('../src/api.ts').Receipt<T>) => { assert.ok(r.ok, JSON.stringify(r)); return r.value; };
async function until<T>(read: () => Promise<T>, accept: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { const v = await read(); if (accept(v)) return v; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Terminal did not reach the expected state');
}

test('output streams in order before exit, stdin ends, and one command per project is refused rather than queued', async t => {
  const { terminal } = await setup(t);
  const args = { projectId: 'p', command: 'printf first; sleep 1; printf second; cat', clientKey: 'ordered' };
  const started = value(await terminal.start(args));
  const view = () => terminal.list('p').then(value);
  await until(view, v => v.commands[0].output === 'first');
  assert.equal((await view()).commands[0].status, 'running');
  assert.equal((await terminal.start({ ...args, clientKey: 'second' })).ok, false);
  assert.equal(value(await terminal.start(args)).id, started.id, 'a repeated identity never starts another process');
  const ended = await until(view, v => v.commands[0].status !== 'running');
  assert.equal(ended.commands[0].output, 'firstsecond');
  assert.equal(ended.commands[0].status, 'succeeded');
  assert.equal(ended.cwd.length > 0, true);
});

test('Stop escalates for the process group after its leader exits, including a child ignoring interrupt and termination', async t => {
  const { terminal } = await setup(t);
  const command = `trap 'exit 0' INT; /bin/sh -c 'trap "" INT TERM; echo child-ready:$$; while :; do sleep 1; done' & wait`;
  const block = value(await terminal.start({ projectId: 'p', command, clientKey: 'stop' }));
  const ready = await until(() => terminal.list('p').then(value), v => v.commands[0].output.includes('child-ready'));
  const childPid = Number(ready.commands[0].output.match(/child-ready:(\d+)/)![1]);
  assert.equal((await terminal.stop('other', block.id)).ok, false);
  value(await terminal.stop('p', block.id));
  const view = await until(() => terminal.list('p').then(value), v => v.commands[0].status === 'failed');
  assert.equal(view.commands[0].detail, 'Stopped by you');
  assert.deepEqual(view.commands[0].signals, ['SIGINT', 'SIGTERM', 'SIGKILL']);
  assert.throws(() => process.kill(childPid, 0), (e: NodeJS.ErrnoException) => e.code === 'ESRCH', 'the interrupt-resistant child is gone');
});

test('output is bounded by bytes and lines, controls are stripped and carriage return progress replaces a line', async t => {
  const { terminal } = await setup(t);
  const run = async (command: string, key: string) => {
    value(await terminal.start({ projectId: 'p', command, clientKey: key }));
    return (await until(() => terminal.list('p').then(value), v => v.commands.at(-1)!.status !== 'running')).commands.at(-1)!;
  };
  assert.equal((await run(`printf '\\033[31mold\\rnew\\033[0m\\n'`, 'controls')).output, 'new\n');
  const bytes = await run('head -c 100000 /dev/zero | tr "\\000" x', 'bytes');
  assert.ok(Buffer.byteLength(bytes.output) <= 65536); assert.ok(bytes.omittedBytes > 0);
  const lines = await run('yes line | head -n 3000', 'lines');
  assert.ok(lines.output.split('\n').length <= 1001); assert.ok(lines.omittedLines > 0);
});

test('clean close stops its command and never repeats its effect', async t => {
  const { terminal, home, services } = await setup(t);
  const args = { projectId: 'p', command: 'echo once >> count; sleep 1', clientKey: 'lost' };
  const block = value(await terminal.start(args));
  await until(() => terminal.list('p').then(value), v => v.commands[0].output === '' && fs.existsSync(join(home, 'count')));
  await terminal.close();
  const again = createTerminal({ home, directory: () => home, exists: () => true, changed() {} });
  services.push(again);
  assert.equal(value(await again.list('p')).commands[0].status, 'failed');
  assert.equal(value(await again.list('p')).commands[0].detail, 'Stopped: the app closed');
  assert.equal(value(await again.start(args)).id, block.id);
  await new Promise(r => setTimeout(r, 1100));
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(join(home, 'count'), 'utf8'), 'once\n');
});

test('history keeps fifty blocks and states how many commands were left out', async t => {
  const { terminal } = await setup(t);
  for (let i = 0; i < 52; i++) {
    value(await terminal.start({ projectId: 'p', command: 'exit 3', clientKey: String(i) }));
    await until(() => terminal.list('p').then(value), v => v.commands.at(-1)!.status === 'failed');
  }
  const view = value(await terminal.list('p'));
  assert.equal(view.commands.length, 50); assert.equal(view.omittedCommands, 2);
  assert.equal((await terminal.start({ projectId: 'p', command: 'exit 3', clientKey: '0' })).ok, false, 'an evicted identity cannot dispatch again');
});

test('a missing process cannot manufacture success and a corrupt record cannot allow a replay', async t => {
  const { terminal, home, services } = await setup(t);
  const missing = createTerminal({ home, directory: () => join(home, 'missing'), exists: () => true, changed() {} });
  services.push(missing);
  value(await missing.start({ projectId: 'absent', command: 'echo never', clientKey: 'absent' }));
  const view = await until(() => missing.list('absent').then(value), v => v.commands[0].status !== 'running');
  assert.equal(view.commands[0].status, 'not-known');
  const { writeFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  writeFileSync(join(home, 'terminal', createHash('sha256').update('corrupt').digest('hex') + '.json'), '{bad');
  const refused = await terminal.start({ projectId: 'corrupt', command: 'echo replay', clientKey: 'used-before-corruption' });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.detail, /cannot be read/);
});

test('stdout and stderr are retained in arrival order and a reused identity with different text is refused', async t => {
  const { terminal } = await setup(t);
  const args = { projectId: 'p', command: 'printf out; sleep 0.1; printf err >&2; sleep 0.1; printf end', clientKey: 'mixed' };
  value(await terminal.start(args));
  const view = await until(() => terminal.list('p').then(value), v => v.commands[0].status !== 'running');
  assert.equal(view.commands[0].output, 'outerrend');
  assert.equal((await terminal.start({ ...args, command: 'echo substituted' })).ok, false);
});

test('an explicit Stop finishes its ladder even when the owning app closes immediately afterward', async t => {
  const { terminal, home, services } = await setup(t);
  const started = value(await terminal.start({ projectId: 'p', command: 'trap "" INT TERM; echo $$; while :; do sleep 1; done', clientKey: 'stop-then-close' }));
  const ready = await until(() => terminal.list('p').then(value), v => /\d+/.test(v.commands[0].output));
  const pid = Number(ready.commands[0].output.trim());
  try {
    value(await terminal.stop('p', started.id));
    await terminal.close();
    const again = createTerminal({ home, directory: () => home, exists: () => true, changed() {} }); services.push(again);
    const block = value(await again.list('p')).commands[0];
    assert.equal(block.status, 'failed'); assert.equal(block.detail, 'Stopped by you');
    assert.deepEqual(block.signals, ['SIGINT', 'SIGTERM', 'SIGKILL']);
    assert.throws(() => process.kill(pid, 0), (e: NodeJS.ErrnoException) => e.code === 'ESRCH');
  } finally {
    // Only this test's detached shell group; a failed assertion must not leave it running.
    try { process.kill(-pid, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
  }
});


test('the legacy time limit is reported as a time limit rather than a person Stop', async t => {
  const { terminal } = await setup(t);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      runTerminal(terminal, { projectId: 'p', command: 'sleep 60' }, 30),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The configured legacy time limit did not stop the command')), 5000); }),
    ]);
    const block = value(await terminal.list('p')).commands[0];
    assert.equal(block.status, 'failed'); assert.match(block.detail!, /time limit/i);
    assert.notEqual(block.detail, 'Stopped by you');
  } finally { clearTimeout(timer); }
});

test('an invalid shell argument is refused before a running block can be recorded', async t => {
  const { terminal } = await setup(t);
  const refused = await terminal.start({ projectId: 'invalid', command: 'echo\u0000never', clientKey: 'invalid' });
  assert.equal(refused.ok, false);
  assert.deepEqual(value(await terminal.list('invalid')).commands, []);
});

test('a burst alternating stdout and stderr preserves shell write order without timing gaps', async t => {
  const { terminal } = await setup(t);
  value(await terminal.start({ projectId: 'p', command: 'for i in 1 2 3 4 5; do printf A; printf B >&2; done', clientKey: 'burst' }));
  const view = await until(() => terminal.list('p').then(value), v => v.commands[0].status !== 'running');
  assert.equal(view.commands[0].output, 'ABABABABAB');
});

test('a Stop that reaches no process group does not relabel an observed successful exit as stopped', async t => {
  const { terminal } = await setup(t);
  const block = value(await terminal.start({ projectId: 'p', command: 'sleep 0.1; exit 0', clientKey: 'already-exiting' }));
  const kill = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal === 'SIGINT') throw Object.assign(new Error('No such group'), { code: 'ESRCH' });
    return kill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill;
  try { value(await terminal.stop('p', block.id)); } finally { process.kill = kill; }
  const view = await until(() => terminal.list('p').then(value), v => v.commands[0].status !== 'running');
  assert.equal(view.commands[0].status, 'succeeded');
  assert.equal(view.commands[0].detail, undefined);
});

test('legacy callers are told when their one-shot output is shortened', async t => {
  const { terminal } = await setup(t);
  const result = value(await runTerminal(terminal, { projectId: 'p', command: 'head -c 100000 /dev/zero | tr "\\000" x' }));
  assert.equal(result.code, 0);
  assert.equal(result.output.includes('bytes and 0 line breaks left out'), true);
  assert.ok(Buffer.byteLength(result.output) < 66_000);
});


test('remaining controls and invisible direction changes cannot disguise output, and an oversized control string ends', async t => {
  const { terminal } = await setup(t);
  const text = '\x1b(Bplain\x1bXhidden\x1b\\\x90hidden\x9c\x9ehidden\x9c\x9fhidden\x9c\u202e\u2066\u2069\u200b!';
  value(await terminal.start({ projectId: 'p', command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.stdout.write(' + JSON.stringify(text) + ')')}`, clientKey: 'more-controls' }));
  const block = (await until(() => terminal.list('p').then(value), v => v.commands[0].status !== 'running')).commands[0];
  value(await terminal.start({ projectId: 'p', command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.stdout.write("\\x1b]" + "a".repeat(300) + "visible")')}`, clientKey: 'unterminated' }));
  const next = (await until(() => terminal.list('p').then(value), v => v.commands.at(-1)!.status !== 'running')).commands.at(-1)!;
  assert.deepEqual({ controls: block.output, oversizedStringEnds: next.output.includes('visible') }, { controls: 'plain!', oversizedStringEnds: true });
});

test('a synchronous spawn throw settles the recorded block and releases the project slot', async t => {
  const { terminal } = await setup(t);
  const original = cp.spawn;
  cp.spawn = (() => { throw new Error('controlled synchronous spawn failure'); }) as typeof cp.spawn;
  syncBuiltinESMExports();
  try { await terminal.start({ projectId: 'p', command: 'echo never', clientKey: 'sync-throw' }).catch(() => {}); }
  finally { cp.spawn = original; syncBuiltinESMExports(); }
  const block = value(await terminal.list('p')).commands[0];
  assert.equal(block.status, 'failed'); assert.match(block.detail!, /not started/i);
  value(await terminal.start({ projectId: 'p', command: 'exit 0', clientKey: 'after-throw' }));
});

test('start-save failure dispatches nothing, periodic and final save failures preserve an observed outcome', async t => {
  const { terminal, home } = await setup(t);
  const root = join(home, 'terminal');
  writeFileSync(root, 'not a directory');
  assert.equal((await terminal.start({ projectId: 'p', command: 'touch should-not-exist', clientKey: 'save-start' })).ok, false);
  assert.equal(fs.existsSync(join(home, 'should-not-exist')), false);
  rmSync(root);
  value(await terminal.start({ projectId: 'p', command: 'printf ready; sleep 2; exit 0', clientKey: 'save-periodic' }));
  const original = fs.renameSync; let runningFailures = 0, finalFailures = 0;
  fs.renameSync = ((from, to) => {
    if (String(to).startsWith(root)) {
      const last = JSON.parse(readFileSync(from, 'utf8')).commands.at(-1);
      if (last.status === 'running') runningFailures++; else finalFailures++;
      throw new Error('controlled disk failure');
    }
    return original(from, to);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    await until(() => terminal.list('p').then(value), v => v.commands.at(-1)!.saveError?.includes('could not be saved') === true);
    await until(async () => finalFailures, n => n > 0);
    const ended = await until(() => terminal.list('p').then(value), v => v.commands.at(-1)!.status !== 'running');
    assert.equal(ended.commands.at(-1)!.status, 'succeeded');
    assert.match(ended.commands.at(-1)!.saveError!, /could not be saved/);
    assert.ok(runningFailures > 0 && finalFailures > 0, 'both periodic and final saves actually failed');
  } finally { fs.renameSync = original; syncBuiltinESMExports(); }
});

test('a crash retains process identity, holds the slot, offers Stop, and never replays', async t => {
  const { terminal, home } = await setup(t);
  const module = new URL('../src/composition/terminal-stream.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {createTerminal} from ${JSON.stringify(module)}; const terminal=createTerminal({home:process.argv[1],directory:()=>process.argv[1],exists:()=>true,changed(){}}); await terminal.start({projectId:'crash',command:'echo once >> count; echo ready; sleep 60',clientKey:'crashed'}); setInterval(()=>{},1000);`, home], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await until(async () => fs.existsSync(join(home, 'count')), Boolean);
  child.kill('SIGKILL'); await new Promise<void>(resolve => child.once('close', () => resolve()));
  const recovered = value(await terminal.list('crash')).commands[0];
  assert.equal(recovered.status, 'running'); assert.match(recovered.detail!, /before the app stopped/);
  assert.equal((await terminal.start({ projectId: 'crash', command: 'echo second', clientKey: 'second' })).ok, false);
  value(await terminal.stop('crash', recovered.id));
  await until(() => terminal.list('crash').then(value), v => v.commands[0].status !== 'running');
  assert.equal(readFileSync(join(home, 'count'), 'utf8'), 'once\n');
});

test('finished history can be cleared while a running block and its identity are kept; corrupt history has the same recovery', async t => {
  const { terminal, home } = await setup(t);
  value(await runTerminal(terminal, { projectId: 'p', command: 'echo finished' }));
  const running = value(await terminal.start({ projectId: 'p', command: 'sleep 30', clientKey: 'kept' }));
  assert.equal(typeof terminal.clear, 'function', 'the service must offer recovery');
  value(await terminal.clear('p'));
  assert.deepEqual(value(await terminal.list('p')).commands.map(b => b.id), [running.id]);
  value(await terminal.stop('p', running.id));
  const file = join(home, 'terminal', createHash('sha256').update('corrupt-clear').digest('hex') + '.json');
  writeFileSync(file, '{bad');
  assert.equal((await terminal.list('corrupt-clear')).ok, false);
  value(await terminal.clear('corrupt-clear'));
  assert.deepEqual(value(await terminal.list('corrupt-clear')).commands, []);
});

test('key storage is bounded, and retired keys cannot dispatch after compaction', async t => {
  const { terminal, home } = await setup(t);
  value(await runTerminal(terminal, { projectId: 'p', command: 'exit 0' }));
  await terminal.close();
  const file = join(home, 'terminal', readdirSync(join(home, 'terminal')).find(f => f.endsWith('.json'))!);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  for (let i=0; i<1000; i++) saved.keys[createHash('sha256').update('retired-'+i).digest('hex')] = 'old';
  writeFileSync(file, JSON.stringify(saved));
  const again = createTerminal({ home, directory: () => home, exists: () => true, changed() {} });
  try {
    value(await runTerminal(again, { projectId: 'p', command: 'exit 0' }));
    await again.close();
    assert.ok(Object.keys(JSON.parse(readFileSync(file, 'utf8')).keys).length <= 1000);
    const recovered = createTerminal({ home, directory: () => home, exists: () => true, changed() {} });
    try {
      const refused = await recovered.start({ projectId: 'p', command: 'touch replayed-key', clientKey: 'retired-0' });
      assert.equal(refused.ok, false);
      assert.equal(fs.existsSync(join(home, 'replayed-key')), false);
      value(await runTerminal(recovered, { projectId: 'p', command: 'exit 0' }));
    } finally { await recovered.close(); }
  } finally { await again.close(); }
});

test('a flood past the cap stops character work and carriage returns only measure the current line', async t => {
  const { terminal } = await setup(t);
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), unref() {} });
  const original = cp.spawn;
  cp.spawn = (() => child) as unknown as typeof cp.spawn; syncBuiltinESMExports();
  try { value(await terminal.start({ projectId: 'p', command: 'controlled output', clientKey: 'flood-work' })); }
  finally { cp.spawn = original; syncBuiltinESMExports(); }
  const iterator = String.prototype[Symbol.iterator], byteLength = Buffer.byteLength;
  let visits = 0, measured = 0;
  String.prototype[Symbol.iterator] = function* (): Generator<string, undefined> { for (const c of { [Symbol.iterator]: () => iterator.call(this) }) { visits++; yield c; } return undefined; };
  Buffer.byteLength = ((text: any, encoding: any) => { measured += text.length; return byteLength(text, encoding); }) as typeof byteLength;
  try {
    child.stdout.emit('data', Buffer.from('x'.repeat(60_000) + '\n'));
    child.stdout.emit('data', Buffer.from('\r1'.repeat(1000)));
    const carriageWork = measured;
    child.stdout.emit('data', Buffer.alloc(8_000_000, 120));
    assert.deepEqual({ carriageWorkBounded: carriageWork < 200_000, floodVisitsBounded: visits < 80_000 }, { carriageWorkBounded: true, floodVisitsBounded: true }, `carriage returns measured ${carriageWork} characters; flood visited ${visits}`);
    assert.ok(value(await terminal.list('p')).commands[0].omittedBytes > 7_000_000);
  } finally {
    String.prototype[Symbol.iterator] = iterator; Buffer.byteLength = byteLength;
    child.emit('close', 0, null);
  }
});

test('stream checkpoints write no more than about once a second and finish saves promptly', async t => {
  const { terminal, home } = await setup(t);
  const original = fs.renameSync; let writes = 0;
  fs.renameSync = ((from, to) => { if (String(to).includes(join(home, 'terminal'))) writes++; return original(from, to); }) as typeof original;
  syncBuiltinESMExports();
  try {
    value(await terminal.start({ projectId: 'p', command: 'i=0; while [ $i -lt 15 ]; do echo x; sleep 0.1; i=$((i+1)); done', clientKey: 'checkpoints' }));
    const startWrites = writes;
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(writes, startWrites, 'output must not rewrite history every 100 ms');
    await until(() => terminal.list('p').then(value), v => v.commands[0].status !== 'running');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(writes - startWrites <= 2, `observed ${writes - startWrites} stream writes`);
    assert.equal(JSON.parse(readFileSync(join(home, 'terminal', readdirSync(join(home, 'terminal')).find(f => f.endsWith('.json'))!), 'utf8')).commands[0].status, 'succeeded');
  } finally { fs.renameSync = original; syncBuiltinESMExports(); }
});

test('a failed custody save cannot release the command past the launcher', async t => {
  const { terminal, home } = await setup(t);
  const original = fs.renameSync; let saves = 0;
  fs.renameSync = ((from, to) => { if (String(to).startsWith(join(home, 'terminal')) && ++saves === 2) throw new Error('controlled custody-save failure'); return original(from, to); }) as typeof original;
  syncBuiltinESMExports();
  try {
    await terminal.start({ projectId: 'p', command: 'touch must-not-run', clientKey: 'custody-save' });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(fs.existsSync(join(home, 'must-not-run')), false, 'a command must wait for its durable process identity');
  } finally { fs.renameSync = original; syncBuiltinESMExports(); }
});

test('a deliberately detached grandchild is outside the Stop group and can outlive it', async t => {
  const { terminal } = await setup(t);
  const script = `const cp=require('node:child_process'); const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); console.log('escaped:'+child.pid); child.unref();`;
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}; sleep 30`;
  const block = value(await terminal.start({ projectId: 'p', command, clientKey: 'escaped-grandchild' }));
  const ready = await until(() => terminal.list('p').then(value), v => /escaped:\d+/.test(v.commands[0].output));
  const pid = Number(ready.commands[0].output.match(/escaped:(\d+)/)![1]);
  try {
    value(await terminal.stop('p', block.id));
    await until(() => terminal.list('p').then(value), v => v.commands[0].status !== 'running');
    assert.equal(process.kill(pid, 0), true, 'Stop promises only the original process group');
  } finally { try { process.kill(pid, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } }
});

test('a replaced group identity stops the ladder before another signal can reach it', async t => {
  const { terminal } = await setup(t);
  const block = value(await terminal.start({ projectId: 'p', command: 'trap "" INT TERM; echo $$; while :; do sleep 1; done', clientKey: 'identity-check' }));
  const ready = await until(() => terminal.list('p').then(value), v => /\d+/.test(v.commands[0].output));
  const commandPid = Number(ready.commands[0].output.trim());
  const pid = Number(cp.execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(commandPid)], { encoding: 'utf8' }).trim());
  assert.ok(pid > 1, 'the OS identifies this test command’s group independently of record format');
  const original = cp.execFileSync, kill = process.kill;
  let replaced = false; const signals: string[] = [];
  cp.execFileSync = ((...args: any[]) => {
    const text = (original as any)(...args);
    if (args[0] === '/bin/ps' && replaced) return `${pid} ${pid} Mon Jan  1 00:00:00 2001 S\n`;
    return text;
  }) as typeof original;
  process.kill = ((group: number, signal?: string | number) => { if (group === -pid && typeof signal === 'string') { signals.push(signal); if (signal === 'SIGINT') replaced = true; } return kill(group, signal as NodeJS.Signals); }) as typeof kill;
  syncBuiltinESMExports();
  try {
    value(await terminal.stop('p', block.id));
    await until(() => terminal.list('p').then(value), v => v.commands[0].status !== 'running');
    assert.deepEqual(signals, ['SIGINT']);
    assert.equal(value(await terminal.list('p')).commands[0].status, 'not-known');
  } finally { cp.execFileSync = original; process.kill = kill; syncBuiltinESMExports(); try { kill(-pid, 'SIGKILL'); } catch {} }
});

test('an unavailable OS identity never releases the launcher into an unowned command', async t => {
  const { home, services } = await setup(t);
  const terminal = createTerminal({ home, directory: () => home, exists: () => true, changed() {} }); services.push(terminal);
  const original = cp.execFileSync;
  cp.execFileSync = (() => { throw new Error('controlled process inspection failure'); }) as typeof original;
  syncBuiltinESMExports();
  try {
    await terminal.start({ projectId: 'p', command: 'touch unowned-effect', clientKey: 'no-identity' });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(fs.existsSync(join(home, 'unowned-effect')), false);
  } finally { cp.execFileSync = original; syncBuiltinESMExports(); }
});


test('crash recovery keeps custody when the command shell exits before its output pipe closes', async t => {
  const { terminal, home } = await setup(t);
  const module = new URL('../src/composition/terminal-stream.ts', import.meta.url).href;
  const command = "/bin/sh -c 'echo child:$$; exec sleep 30' & exit 0";
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {createTerminal} from ${JSON.stringify(module)}; const terminal=createTerminal({home:process.argv[1],directory:()=>process.argv[1],exists:()=>true,changed(){}}); await terminal.start({projectId:'leader-gone',command:${JSON.stringify(command)},clientKey:'leader-gone'}); setInterval(()=>{},1000);`, home], { stdio: 'ignore' });
  let pid: number | undefined;
  try {
    const file = join(home, 'terminal', createHash('sha256').update('leader-gone').digest('hex') + '.json');
    const saved = await until(async () => fs.existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined, s => !!s?.commands[0].output.includes('child:'));
    pid = Number(saved.commands[0].output.match(/child:(\d+)/)[1]);
    child.kill('SIGKILL'); await new Promise<void>(resolve => child.once('close', () => resolve()));
    const recovered = value(await terminal.list('leader-gone')).commands[0];
    assert.equal(recovered.status, 'running');
    value(await terminal.stop('leader-gone', recovered.id));
    await until(() => terminal.list('leader-gone').then(value), v => v.commands[0].status !== 'running');
  } finally { child.kill('SIGKILL'); if (pid) try { process.kill(pid, 'SIGKILL'); } catch {} }
});

test('the one-shot adapter waits sensibly between reads instead of cloning history every 20 ms', async () => {
  const block: import('../src/api.ts').TerminalBlock = { id: 'adapter', clientKey: 'adapter', command: 'controlled', cwd: '/fixture', output: '', status: 'running', code: null, startedAt: new Date().toISOString(), signals: [], omittedBytes: 0, omittedLines: 0 };
  let reads = 0;
  const terminal = {
    async start() { return { ok: true as const, value: block }; },
    async list() { return { ok: true as const, value: { cwd: '/fixture', omittedCommands: 0, historyKey: 'fixture', commands: [{ ...block, status: ++reads > 3 ? 'succeeded' as const : 'running' as const, code: reads > 3 ? 0 : null }] } }; },
    async stop() { return { ok: true as const, value: block }; },
  };
  const original = globalThis.setTimeout, waits: number[] = [];
  globalThis.setTimeout = ((callback: () => void, delay: number) => { waits.push(delay); return original(callback, 0); }) as typeof original;
  try {
    assert.equal(value(await runTerminal(terminal, { projectId: 'p', command: 'controlled' })).code, 0);
    assert.ok(waits.length > 0 && waits.every(ms => ms >= 100), `adapter waits: ${waits.join(', ')}`);
  } finally { globalThis.setTimeout = original; }
});

test('clean close without a prior Stop uses the full ladder and ends an interrupt-resistant process', async t => {
  const { terminal, home, services } = await setup(t);
  const { captureTerminalProcess, inspectTerminalProcess } = await import('../src/composition/terminal-process.ts');
  value(await terminal.start({ projectId: 'p', command: 'trap "" INT TERM; echo $$; while :; do sleep 1; done', clientKey: 'clean-close-ladder' }));
  const ready = await until(() => terminal.list('p').then(value), v => /\d+/.test(v.commands[0].output));
  const pid = Number(ready.commands[0].output.trim());
  const group = Number(cp.execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  const identity = captureTerminalProcess(group);
  t.after(() => { if (inspectTerminalProcess(identity) === 'same') process.kill(-group, 'SIGKILL'); });
  await terminal.close();
  const again = createTerminal({ home, directory: () => home, exists: () => true, changed() {} }); services.push(again);
  const block = value(await again.list('p')).commands[0];
  let alive = true;
  try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; alive = false; }
  assert.deepEqual({ status: block.status, detail: block.detail, signals: block.signals, alive }, { status: 'failed', detail: 'Stopped: the app closed', signals: ['SIGINT', 'SIGTERM', 'SIGKILL'], alive: false });
});

test('a confirmed gone group ends the ladder without inventing uncertainty while close delivery is delayed', async t => {
  const { terminal } = await setup(t);
  const { EventEmitter } = await import('node:events');
  const original = cp.spawn;
  const actual = original('/bin/sh', ['-c', 'read -r ready; echo ready; exec sleep 30'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const delayed = Object.assign(new EventEmitter(), { pid: actual.pid, stdin: actual.stdin, stdout: actual.stdout, stderr: actual.stderr, unref: () => actual.unref() });
  t.after(() => { if (actual.exitCode === null && actual.signalCode === null) actual.kill('SIGKILL'); });
  cp.spawn = (() => delayed) as unknown as typeof cp.spawn; syncBuiltinESMExports();
  try { value(await terminal.start({ projectId: 'p', command: 'controlled delayed close', clientKey: 'gone-before-close' })); }
  finally { cp.spawn = original; syncBuiltinESMExports(); }
  const ready = await until(() => terminal.list('p').then(value), v => v.commands[0].output.includes('ready'));
  value(await terminal.stop('p', ready.commands[0].id));
  const ended = (await until(() => terminal.list('p').then(value), v => v.commands[0].status !== 'running')).commands[0];
  delayed.emit('close', null, 'SIGINT');
  assert.deepEqual({ status: ended.status, detail: ended.detail, signals: ended.signals }, { status: 'failed', detail: 'Stopped by you', signals: ['SIGINT'] });
});

test('concurrent Stop requests share one ladder across the custody-save lock', async t => {
  const { terminal } = await setup(t);
  const block = value(await terminal.start({ projectId: 'p', command: 'trap "" INT TERM; echo ready; while :; do sleep 1; done', clientKey: 'concurrent-stop' }));
  await until(() => terminal.list('p').then(value), v => v.commands[0].output.includes('ready'));
  await Promise.all([terminal.stop('p', block.id), terminal.stop('p', block.id)]);
  const ended = (await until(() => terminal.list('p').then(value), v => v.commands[0].status !== 'running')).commands[0];
  assert.deepEqual(ended.signals, ['SIGINT', 'SIGTERM', 'SIGKILL']);
});

test('control-only floods also reach a work cap without needing visible text to fill it', async t => {
  const { terminal } = await setup(t);
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), unref() {} });
  const original = cp.spawn;
  cp.spawn = (() => child) as unknown as typeof cp.spawn; syncBuiltinESMExports();
  try { value(await terminal.start({ projectId: 'p', command: 'controlled control flood', clientKey: 'control-flood' })); }
  finally { cp.spawn = original; syncBuiltinESMExports(); }
  const iterator = String.prototype[Symbol.iterator]; let visits = 0;
  String.prototype[Symbol.iterator] = function* (): Generator<string, undefined> { for (const c of { [Symbol.iterator]: () => iterator.call(this) }) { visits++; yield c; } return undefined; };
  try {
    child.stdout.emit('data', Buffer.from('\x1b[0m'.repeat(500_000)));
    const block = value(await terminal.list('p')).commands[0];
    assert.deepEqual({ workBounded: visits <= 1_100_000, omissionsCounted: block.omittedBytes > 500_000, output: block.output }, { workBounded: true, omissionsCounted: true, output: '' }, `control flood visited ${visits} characters`);
  } finally { String.prototype[Symbol.iterator] = iterator; child.emit('close', 0, null); }
});

test('an uncertain Clear reloads stored history without losing the live command or claiming refusal', async t => {
  const { terminal, home } = await setup(t);
  value(await runTerminal(terminal, { projectId: 'p', command: 'echo finished' }));
  const block = value(await terminal.start({ projectId: 'p', command: 'printf ready; sleep 1; printf still-owned; sleep 30', clientKey: 'uncertain-clear' }));
  await until(() => terminal.list('p').then(value), v => v.commands.at(-1)!.output.includes('ready'));
  const original = fs.renameSync;
  fs.renameSync = ((from, to) => { original(from, to); if (String(to).startsWith(join(home, 'terminal'))) throw new Error('controlled failure after replacement'); }) as typeof original;
  syncBuiltinESMExports();
  let cleared: Awaited<ReturnType<typeof terminal.clear>>;
  try { cleared = await terminal.clear('p'); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); }
  const view = value(await terminal.list('p'));
  assert.deepEqual({ outcome: cleared.ok ? 'DONE' : cleared.outcome, ids: view.commands.map(b => b.id) }, { outcome: 'UNKNOWN', ids: [block.id] });
  await until(() => terminal.list('p').then(value), v => v.commands[0].output.includes('still-owned'));
  value(await terminal.stop('p', block.id));
});
