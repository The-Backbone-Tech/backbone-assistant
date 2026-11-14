import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'backbone-key-tool-files-'));
const keychain = join(scratch, 'fake.keychain-db');
writeFileSync(keychain, 'fake file; tools are injected');
after(() => rmSync(scratch, { recursive: true, force: true }));
import { runTool, securityWord, toolStore, type ToolRequest, type ToolResult } from '../src/system-keys/tools.ts';

const absent: ToolResult = { code: 44, stdout: Buffer.alloc(0), errorOutput: true };
const ok: ToolResult = { code: 0, stdout: Buffer.alloc(0), errorOutput: false };

test('macOS writes secrets only to stdin with absolute executable and fixed environment', async () => {
  const calls: ToolRequest[] = [], key = randomBytes(32), account = randomUUID();
  const store = toolStore({ platform: 'darwin', keychain, env: { NODE_OPTIONS: '--inspect', DYLD_INSERT_LIBRARIES: 'untrusted', SECRET: key.toString('base64') }, run: async (r) => { calls.push({ ...r, input: r.input ? Buffer.from(r.input) : undefined }); return r.args[0] === 'find-generic-password' ? absent : ok; } });
  await store.create(account, key);
  const write = calls.at(-1)!;
  assert.equal(write.executable, '/usr/bin/security'); assert.deepEqual(write.args, ['-q', '-i']);
  assert.ok(write.input?.includes(key.toString('base64')));
  assert.ok(write.input?.includes('"-T" "/usr/bin/security"'));
  assert.ok(write.input?.includes(JSON.stringify(keychain)));
  assert.ok(!JSON.stringify({ args: write.args, env: write.env }).includes(key.toString('base64')));
  assert.deepEqual(write.env, { PATH: '/usr/bin:/bin', LC_ALL: 'C' });
  assert.ok(!write.input?.includes('"-U"')); assert.ok(!write.args.includes('-v'));
});

test('Linux writes stdin, preserves only session locators, distinguishes missing from unusable', async () => {
  const calls: ToolRequest[] = [], key = randomBytes(32);
  let response = { ...ok, code: 1 };
  const store = toolStore({ platform: 'linux', env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', XDG_RUNTIME_DIR: '/run/user/1000', HOME: '/untrusted', NODE_OPTIONS: 'bad' }, run: async (r) => { calls.push({ ...r, input: r.input ? Buffer.from(r.input) : undefined }); return r.args[0] === 'lookup' || response.errorOutput ? response : ok; } });
  assert.equal(await store.available(), true);
  assert.equal(await store.get(randomUUID()), null);
  await store.create(randomUUID(), key);
  assert.equal(calls.at(-1)!.executable, '/usr/bin/secret-tool');
  assert.equal(calls.at(-1)!.input?.toString(), key.toString('base64'));
  assert.ok(!JSON.stringify(calls.at(-1)!.args).includes(key.toString('base64')));
  assert.deepEqual(calls.at(-1)!.env, { PATH: '/usr/bin:/bin', LC_ALL: 'C', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', XDG_RUNTIME_DIR: '/run/user/1000' });
  response = { ...response, errorOutput: true };
  assert.equal(await store.available(), false);
  await assert.rejects(store.get(randomUUID()), /No usable system key store/);
});

test('tool errors and unexpected output never become diagnostic text', async () => {
  const secret = randomBytes(32).toString('base64');
  for (const run of [async () => { throw new Error(secret); }, async () => ({ code: 9, stdout: Buffer.from(secret), errorOutput: true })]) {
    const store = toolStore({ platform: 'darwin', env: {}, run });
    await assert.rejects(store.create(randomUUID(), randomBytes(32)), (e: Error) => !e.message.includes(secret));
    assert.equal(await store.available(), false);
  }
  assert.throws(() => securityWord('bad\ncommand'));
  assert.equal(securityWord('a"b\\c'), '"a\\"b\\\\c"');
});

test('unsupported platforms cannot invoke a platform tool', async () => {
  const store = toolStore({ platform: 'win32', run: async () => { assert.fail('invoked tool'); } });
  assert.equal(await store.available(), false);
  await assert.rejects(store.get(randomUUID()), /No usable/);
});

test('runner bounds a hung process, discards stderr, and sanitizes spawn failures', { timeout: TEST_HANG_MS * 2 }, async t => {
  const env = { PATH: '/usr/bin:/bin', LC_ALL: 'C' };
  await assert.rejects(runTool({ executable: '/nonexistent-keystore-tool', args: [], env }), /No usable system key store/);
  t.mock.timers.enable({apis:['setTimeout']});
  let settled=false;
  const hung=runTool({ executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env });
  void hung.then(()=>settled=true,()=>settled=true);
  const rejected=assert.rejects(hung,/No usable system key store/);
  t.mock.timers.tick(2999);await Promise.resolve();assert.equal(settled,false);
  t.mock.timers.tick(1);await rejected;
  t.mock.timers.reset();
  const result = await runTool({ executable: process.execPath, args: ['-e', 'process.stderr.write("private diagnostic"); process.exit(2)'], env });
  assert.equal(result.errorOutput, true); assert.ok(!JSON.stringify(result).includes('private diagnostic'));
});

test('test denial makes the store unusable before even an injected runner can spawn', async () => {
  const store = toolStore({ env: { BACKBONE_SYSTEM_STORE_UNAVAILABLE: '1' }, platform: 'darwin', run: async () => { assert.fail('denied store started a tool'); } });
  assert.equal(await store.available(), false);
  await assert.rejects(store.get(randomUUID()), /BACKBONE_SYSTEM_STORE_UNAVAILABLE=1/);
  await assert.rejects(store.create(randomUUID(), randomBytes(32)), /BACKBONE_SYSTEM_STORE_UNAVAILABLE=1/);
});

test('the mutable stdin buffer is wiped after success and failure', async () => {
  for (const fail of [false, true]) {
    let input: Buffer | undefined;
    const store = toolStore({ platform: 'darwin', env: {}, keychain, run: async (r) => {
      if (r.args[0] === 'find-generic-password') return absent;
      if (r.args[0] === '-q') { input = r.input; if (fail) throw new Error('fake write failed'); }
      return ok;
    } });
    const writing = store.create(randomUUID(), randomBytes(32));
    if (fail) await assert.rejects(writing, /No usable/); else await writing;
    assert.ok(input && input.every((byte) => byte === 0), 'stdin bytes survived the completed write');
  }
});


test('macOS availability uses only the default path preference and filesystem metadata', async () => {
  const calls: string[][] = [];
  const store = toolStore({ platform: 'darwin', env: {}, run: async (r) => {
    calls.push(r.args);
    assert.deepEqual(r.args, ['default-keychain', '-d', 'user']);
    return { code: 0, stdout: Buffer.from(JSON.stringify(keychain)), errorOutput: false };
  } });
  assert.equal(await store.available(), true);
  assert.equal(calls.length, 1);
  const scoped = toolStore({ platform: 'darwin', env: {}, keychain, run: async () => { assert.fail('scoped availability spawned a tool'); } });
  assert.equal(await scoped.available(), true);
});

test('switch diagnostics survive the provider boundary without a plaintext suggestion', async () => {
  const { systemKeys } = await import('../src/system-keys/provider.ts');
  const store = toolStore({ platform: 'darwin', env: { BACKBONE_SYSTEM_STORE_UNAVAILABLE: '1' }, keychain,
    run: async () => { assert.fail('disabled provider spawned a tool'); } });
  assert.equal(await store.available(), false);
  const check = (error: Error) => { assert.match(error.message, /BACKBONE_SYSTEM_STORE_UNAVAILABLE=1/); assert.ok(!error.message.includes('plaintext')); return true; };
  await assert.rejects(systemKeys(scratch, store).wrapKey(randomBytes(32)), check);
  await assert.rejects(runTool({ executable: '/usr/bin/security', args: ['help', 'show-keychain-info', keychain], env: { BACKBONE_SYSTEM_STORE_UNAVAILABLE: '1' } }), check);
});
