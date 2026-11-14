import { hangDetector } from '../../../scripts/lib/test-hang.ts';
import { waitFor } from '../../../scripts/lib/test-hang.ts';
// The door holds no secret: it reaches its grant only through the process that holds the home's keys
// (the app's host, or `backbone-mcp host`), over a socket only the person's user can open, which
// carries nothing but an existing grant's four gateway calls. Adverse cases: no host, a host that
// stops mid-call, a control call or a malformed line on the socket, and a second host on the home.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { grantDoor } from '../src/composition/gateway.ts';
import { connectDoor } from '../src/doors/client.ts';
import { doorSocket } from '../src/doors/protocol.ts';
import { freshDataHome } from '../src/testing/data-home.ts';
import { freshHome, open } from './helpers.ts';

const write = (key: string, name = 'note.txt', content = 'hello') => ({ operation: 'outbox.write', args: { name, content }, description: 'a note', idempotencyKey: key });
const doors: { close(): Promise<void> }[] = [];
after(async () => {
  for (const d of doors) await d.close();
});
function door(home: string, grant: string) {
  const d = connectDoor({ home, grant });
  doors.push(d);
  return d;
}

/** A host serving `home`'s doors: opened, and answering on the socket (it listens once its core is up). */
async function serving(home = freshHome()) {
  const opened = open(home, { doors: true });
  await waitFor(()=>new Promise<boolean>(resolve=>{
    const probe=createConnection(doorSocket(home));
    probe.once('connect',()=>{probe.destroy();resolve(true);});
    probe.once('error',()=>resolve(false));
  }),'Host door socket readiness', {diagnostic:()=>`socket=${doorSocket(home)}`});
  return opened;
}

/** Read each protocol reply or peer close; elapsed socket time is only a hang guard. */
async function raw(home: string, lines: string[]): Promise<string[]> {
  const socket = createConnection(doorSocket(home));
  let got = '';
  try {
    return await hangDetector(new Promise<string[]>((resolve, reject) => {
      socket.on('connect', () => socket.write(lines.map(l => `${l}\n`).join('')));
      socket.on('data', d => { got += String(d); if (got.split('\n').filter(Boolean).length >= lines.length) socket.destroy(); });
      socket.on('close', () => resolve(got.split('\n').filter(Boolean)));
      socket.on('error', reject);
    }), 'door raw replies or closes', { diagnostic: () => JSON.stringify({ replies: got, destroyed: socket.destroyed }) });
  } finally { socket.destroy(); }
}

test('the door works through the host that holds the keys, and the socket is the person\'s alone', async () => {
  const { home } = await serving();
  await grantDoor({ home, name: 'relay', operations: ['outbox.write'], ceiling: 3 });
  const d = door(home, 'relay');
  const r = await d.call('effects.propose', write('relay-1'));
  assert.ok(r.ok && r.value.outcome === 'DONE', JSON.stringify(r));
  assert.equal(readFileSync(`${home}/outbox/note.txt`, 'utf8'), 'hello');
  const again = await d.call('effects.get', { idempotencyKey: 'relay-1' });
  assert.ok(again.ok && again.value.effect === r.value.effect);
  // Only the person's user reaches it: its folder admits no one else.
  assert.equal(statSync(dirname(doorSocket(home))).mode & 0o077, 0, 'the socket\'s folder is open to other users');
});

test('the socket carries only an existing grant\'s gateway calls: no control call, no malformed line, no other door\'s name', async () => {
  const { home } = await serving();
  await grantDoor({ home, name: 'narrow', operations: ['outbox.write'], ceiling: 3 });
  await door(home, 'narrow').call('effects.list', {});
  const hello = JSON.stringify({ door: 1, grant: 'narrow' });
  for (const method of ['grant', 'revoke', 'tools.connect', 'settings.model.put', 'constructor', '__proto__']) {
    const [ready, reply] = await raw(home, [hello, JSON.stringify({ id: 1, method, args: { name: 'x', operations: ['outbox.write'], ceiling: 4 } })]);
    assert.deepEqual(JSON.parse(ready), { ready: true });
    assert.equal(JSON.parse(reply).result.reason, 'INVALID', method);
  }
  // A line that is not the protocol ends the connection; nothing is granted or written.
  assert.deepEqual(await raw(home, ['not json']), []);
  const [refused] = await raw(home, [JSON.stringify({ door: 1, grant: '../doors/narrow' })]);
  assert.equal(JSON.parse(refused).refused.reason, 'INVALID');
  assert.ok(!existsSync(`${home}/doors/x.json`));
});

test('with nothing serving the home every call is refused as not running, nothing is sent, and the door connects once the host is up', async () => {
  const home = freshHome();
  const d = door(home, 'later');
  const refused = await d.call('effects.propose', write('later-1'));
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.reason === 'NOT_AVAILABLE' && /not running/.test(refused.detail), JSON.stringify(refused));
  open(home, { doors: true });
  await grantDoor({ home, name: 'later', operations: ['outbox.write'], ceiling: 3 });
  let r = await d.call('effects.propose', write('later-1'));
  await waitFor(async()=>{if(r.ok)return true;r=await d.call('effects.propose',write('later-1'));return r.ok;},'door reconnecting after Host startup',{diagnostic:()=>JSON.stringify(r)});
  assert.ok(r.ok && r.value.outcome === 'DONE', JSON.stringify(r));
});

test('a host gone mid-call leaves the outcome unknown: the call fails, never as a refusal that says nothing was sent', async () => {
  const home = freshHome();
  // A stand-in host that answers the door's hello, then dies on its first call.
  const server = createServer((socket) => {
    let seen = '';
    socket.on('data', (d) => {
      seen += String(d);
      const lines = seen.split('\n');
      if (lines.length > 1 && lines[0] && !seen.includes('"method"')) socket.write(`${JSON.stringify({ ready: true })}\n`);
      if (seen.includes('"method"')) socket.destroy();
    });
  });
  const path = doorSocket(home);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await new Promise<void>((r) => server.listen(path, r));
  try {
    const d = door(home, 'dying');
    await assert.rejects(d.call('effects.propose', write('dying-1')), /not known/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a home too long for a socket path is served from this user\'s own folder, which a door started with another environment finds too', async () => {
  const home = freshDataHome('a-data-home-whose-path-is-long-enough-that-its-socket-would-not-fit');
  const at = doorSocket(home);
  assert.ok(!at.startsWith(home), 'the socket would not fit in the home');
  // The app and the tool's door rarely share an environment: no TMPDIR, another HOME.
  const elsewhere = spawnSync(process.execPath, ['--input-type=module', '-e', `import { doorSocket } from ${JSON.stringify(new URL('../src/doors/protocol.ts', import.meta.url).href)}; console.log(doorSocket(process.argv[1]));`, home], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent' },
  });
  assert.equal(elsewhere.stdout.trim(), at, elsewhere.stderr);
  const { home: served } = await serving(home);
  await grantDoor({ home: served, name: 'long', operations: ['outbox.write'], ceiling: 3 });
  const r = await door(served, 'long').call('effects.propose', write('long-1'));
  assert.ok(r.ok && r.value.outcome === 'DONE', JSON.stringify(r));
  assert.equal(statSync(dirname(at)).mode & 0o077, 0);
});

test('a socket whose folder other users may enter is never used: the door takes it for no app at all', async () => {
  const home = freshHome();
  const path = doorSocket(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  chmodSync(dirname(path), 0o755);
  // A stand-in for the app that says yes to everything: fake receipts for whatever the tool asks.
  let calls = 0;
  const impostor = createServer((socket) => {
    let seen = '';
    socket.on('data', (d) => {
      seen += String(d);
      for (let at = seen.indexOf('\n'); at >= 0; at = seen.indexOf('\n')) {
        const line = JSON.parse(seen.slice(0, at)) as { id?: number };
        seen = seen.slice(at + 1);
        calls++;
        socket.write(`${JSON.stringify(line.id === undefined ? { ready: true } : { id: line.id, result: { ok: true, value: { outcome: 'DONE' } } })}\n`);
      }
    });
  });
  await new Promise<void>((r) => impostor.listen(path, r));
  const d = door(home, 'any');
  try {
    const r = await d.call('effects.propose', write('impostor-1'));
    assert.ok(!r.ok && r.reason === 'NOT_AVAILABLE', JSON.stringify(r));
    assert.equal(calls, 0, 'the door spoke to a socket in a folder others may enter');
  } finally {
    await d.close();
    impostor.close();
  }
});

test('on Windows the door refuses to run, and no host serves one: a pipe another user could make first is never trusted', () => {
  const home = freshHome();
  // A folder of its own as the working directory: a socket named like a pipe must land nowhere else.
  const cwd = mkdtempSync(join(tmpdir(), 'backbone-win32-'));
  const url = (p: string) => JSON.stringify(new URL(p, import.meta.url).href);
  const script = `
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { connectDoor } = await import(${url('../src/doors/client.ts')});
    const { serveDoors } = await import(${url('../src/composition/doors.ts')});
    const door = connectDoor({ home: process.argv[1], grant: 'any' });
    const ready = await door.ready();
    const call = await door.call('effects.list', {});
    let served = 'served';
    try {
      const s = await serveDoors({ home: process.argv[1], link: async () => { throw new Error('no link'); } });
      await s.close();
    } catch (error) {
      served = error.message;
    }
    console.log(JSON.stringify({ ready, call, served }));`;
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, home], { encoding: 'utf8', cwd });
    const seen = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as { ready: { detail?: string }; call: { reason?: string; detail?: string }; served: string };
    assert.match(seen.ready?.detail ?? '', /not supported on Windows yet/, r.stdout + r.stderr);
    assert.equal(seen.call.reason, 'NOT_AVAILABLE');
    assert.match(seen.call.detail ?? '', /not supported on Windows yet/);
    assert.match(seen.served, /not supported on Windows yet/);
    assert.deepEqual(readdirSync(cwd), [], 'a pipe-named socket was made');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a second host on a home leaves the first one serving its doors', async () => {
  const { home } = await serving();
  await grantDoor({ home, name: 'first', operations: ['outbox.write'], ceiling: 3 });
  const d = door(home, 'first');
  assert.ok((await d.call('effects.list', {})).ok);
  const { host: second } = open(home, { doors: true });
  await assert.rejects(second.call('projects.list', {}), /in use by another host/);
  assert.ok((await d.call('effects.propose', write('first-1'))).ok);
});
