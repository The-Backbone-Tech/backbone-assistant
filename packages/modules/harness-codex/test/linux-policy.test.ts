import assert from 'node:assert/strict';
import { test } from 'node:test';
import { environmentOf, filesystemFor } from '../src/native.ts';
import { prompt, LINUX_READONLY_NOTICE, readOnlyBoundaryEvent } from '../src/index.ts';

test('Linux defaults to contained; full requires an explicit choice; Mac stays full', () => {
  assert.equal(environmentOf({}, 'linux'), 'contained');
  assert.equal(environmentOf({}, 'darwin'), 'full');
  assert.equal(environmentOf({ environment: 'full' }, 'linux'), 'full');
  assert.equal(environmentOf({ environment: 'contained' }, 'darwin'), 'contained');
});
test('only Linux read-only engine instructions explain discarded writes', () => {
  const request = { threadId: 't', turnId: 'u', text: 'Review', history: [], attachments: [], effort: 3 as const, resumed: false };
  assert.ok(prompt(request, [], 'contained', true, 'linux').includes(LINUX_READONLY_NOTICE));
  assert.ok(!prompt(request, [], 'contained', true, 'darwin').includes(LINUX_READONLY_NOTICE));
  assert.ok(!prompt(request, [], 'contained', false, 'linux').includes(LINUX_READONLY_NOTICE));
});

import { linuxExpected, assessLinuxAudit, refuseVisibleHostDatagrams } from '../src/linux-audit.ts';
for (const environment of ['full', 'contained', 'bare', 'readOnly'] as const) {
  for (const fresh_proc of [true, false]) test(`${environment}: parsed Linux audit matrix (fresh proc=${fresh_proc})`, () => {
    const result = { ...linuxExpected(environment, fresh_proc), fresh_proc, pid_namespace_distinct: fresh_proc, network_namespace_distinct: true, host_hits: environment === 'full' ? ['sendmsg'] : [] };
    const assessed = assessLinuxAudit(environment, result);
    assert.equal(assessed.networkAcceptable, environment !== 'full');
    for (const key of Object.keys(linuxExpected(environment))) {
      const bad = { ...result, [key]: ['allowed'] };
      assert.throws(() => assessLinuxAudit(environment, bad), /mismatch/);
    }
    assert.throws(() => assessLinuxAudit(environment, { ...result, host_hits: ['udp'] }), /network delivery/);
    assert.throws(() => assessLinuxAudit(environment, { ...result, surprise: true }), /unexpected/);
  });
}
test('visible Host datagrams refuse; absent sockets qualify; malformed evidence refuses', async () => {
  const metrics={count:1,limit:250000,time_limit_ms:10000,elapsed_ms:1};
  const invoke = (value: unknown) => refuseVisibleHostDatagrams(async args => {
    if (!args.some(arg=>arg.includes('readdirSync'))) return JSON.stringify({mounts:'1 0 0:1 / / ro - ext4 root ro',network_namespace:'net:[2]'});
    return JSON.stringify(value && typeof value==='object' ? {...metrics,...value} : value);
  }, '/tmp/stage', 'full', process.execPath, [], 'net:[1]', undefined, {mounts:'host',sockets:''});
  await invoke({visible:false,complete:true,network_namespace:'net:[2]'});
  await assert.rejects(invoke({visible:true,complete:true,network_namespace:'net:[2]'}), /Host datagram socket is visible/);
  await assert.rejects(invoke({visible:false,complete:false,network_namespace:'net:[2]'}), /incomplete.*1\/250000 entries, 1\/10000 ms/);
  await assert.rejects(invoke({visible:false,complete:true,network_namespace:'net:[1]'}), /namespace isolation/);
  await assert.rejects(invoke({visible:false,complete:true,network_namespace:null}), /namespace isolation/);
  for (const value of [null, [], {visible:['false'],complete:true}, {visible:false,complete:true, other:true}]) await assert.rejects(invoke(value), /Invalid/);
});

test('Linux read-only notice is a persisted native work note and does not modify judge answers', () => {
  assert.deepEqual(readOnlyBoundaryEvent(true, 'linux'), { type: 'tool', phase: 'done', tool: 'native_staged', id: 'linux-readonly-boundary', label: LINUX_READONLY_NOTICE });
  assert.equal(readOnlyBoundaryEvent(true, 'darwin'), null); assert.equal(readOnlyBoundaryEvent(false, 'linux'), null);
});


test('CI integrity lock covers the exact client and every platform binary package', async () => {
  const { readFile } = await import('node:fs/promises');
  const lock = JSON.parse(await readFile(new URL('../../../../scripts/codex-qualification/package-lock.json', import.meta.url), 'utf8'));
  const { CODEX_VERSION } = await import('../src/native.ts');
  assert.equal(lock.packages[''].dependencies['@openai/codex'], CODEX_VERSION);
  assert.equal(Object.keys(lock.packages).length, 8);
  for (const [name, pkg] of Object.entries(lock.packages) as [string, {integrity?:string;resolved?:string}][]) if (name) {
    assert.match(pkg.integrity ?? '', /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    assert.ok(pkg.resolved?.startsWith('https://registry.npmjs.org/@openai/codex/-/codex-'));
  }
});


test('real arrangement and Host data-home denies are kept in every profile', () => {
  for (const environment of ['full', 'contained', 'bare', 'readOnly'] as const) {
    const map = filesystemFor(environment, ['/owned/data-home', '/owned/arrangement']);
    assert.equal(map['/owned/data-home'], 'deny'); assert.equal(map['/owned/arrangement'], 'deny');
  }
});


import { LINUX_SOCKET_INVENTORY_PROGRAM } from '../src/linux-audit.ts';
import { mkdtemp, rename, chmod, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const expectedNetworkNamespace = process.platform === 'linux' ? readlinkSync('/proc/self/ns/net') : null;
const scan = (root: string) => {
  const child = spawnSync(process.execPath, ['-e', LINUX_SOCKET_INVENTORY_PROGRAM, JSON.stringify({paths:[root],exclude_runtime:false})], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr); const result=JSON.parse(child.stdout);
  assert.ok(result.count>0);assert.equal(result.limit,250000);assert.equal(result.time_limit_ms,10000);assert.ok(result.elapsed_ms>=0);
  const {count,limit,time_limit_ms,elapsed_ms,...proof}=result;return proof;
};
test('actual-view inventory finds a renamed socket with repeated spaces and tabs', async () => {
  const root = await mkdtemp('/tmp/codex-socket-scan-'); const server = createServer(socket => socket.destroy());
  try {
    const from = join(root, 'bound.sock'), to = join(root, 'renamed  two\tspaces.sock');
    await new Promise<void>((resolve,reject) => {server.once('error',reject);server.listen(from,resolve);});
    await rename(from,to);
    assert.deepEqual(scan(root), {visible:true,complete:true,network_namespace:expectedNetworkNamespace});
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); await rm(root,{recursive:true,force:true}); }
});
test('actual-view inventory rejects an opaque but traversable directory', async () => {
  const root = await mkdtemp('/tmp/codex-socket-scan-'), opaque = join(root,'opaque');
  try {
    assert.deepEqual(scan(root), {visible:false,complete:true,network_namespace:expectedNetworkNamespace});
    await mkdir(opaque); await chmod(opaque,0o000);
    assert.deepEqual(scan(root), {visible:false,complete:true,network_namespace:expectedNetworkNamespace});
    await chmod(opaque,0o111);
    assert.deepEqual(scan(root), {visible:false,complete:false,network_namespace:expectedNetworkNamespace});
  } finally { await chmod(opaque,0o700).catch(()=>{}); await rm(root,{recursive:true,force:true}); }
});
test('matching proc PID alone cannot establish a fresh proc mount', () => {
  const shared = {...linuxExpected('full',false),fresh_proc:false,pid_namespace_distinct:false,network_namespace_distinct:true,host_hits:['sendmsg']};
  assert.equal(assessLinuxAudit('full',shared).limits.includes('host-cmdline'),true);
  assert.throws(()=>assessLinuxAudit('full',{...shared,fresh_proc:true}),/proc evidence/);
  assert.equal(assessLinuxAudit('full',{...shared,pid_namespace_distinct:true}).expected,true);
});
