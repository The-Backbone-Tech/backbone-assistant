import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {FakeMailbox} from '@backbone-next/connector-mail';
import {join} from 'node:path';
import {test} from 'node:test';
import {withHomeLock} from '../src/composition/home-lock.ts';
import {freshHome, open, value} from './helpers.ts';

for (const kind of ['folder', 'git'] as const) {
  test(`unkeyed ${kind} creation checks the projects storage before writing`, async t => {
    const home = freshHome(), {host} = open(home);
    await host.call('projects.list', {});
    fs.mkdirSync(join(home, 'projects'), {recursive:true});
    const statfs = fs.statfsSync;
    t.mock.method(fs, 'statfsSync', ((path: fs.PathLike) => ({...statfs(path), ...(String(path) === join(home, 'projects') ? {type:0x6969} : {})})) as typeof fs.statfsSync);
    const receipt = await host.call('projects.create', {name:'Unkeyed', kind});
    assert.ok(!receipt.ok); assert.equal(receipt.outcome, 'UNKNOWN');
    assert.deepEqual(fs.readdirSync(join(home, 'projects')), []);
    assert.equal(fs.existsSync(join(home, 'projects.json')), false);
    assert.deepEqual(await host.call('projects.list', {}), []);
  });
}

test('unkeyed creation waits for the data-folder lock', async () => {
  const home = freshHome(), {host} = open(home);
  await host.call('projects.list', {});
  let release!: () => void, locked!: () => void;
  const entered = new Promise<void>(resolve => {locked = resolve;});
  const barrier = new Promise<void>(resolve => {release = resolve;});
  const holder = withHomeLock(home, async () => {locked(); await barrier;});
  await entered;
  let finished = false;
  const creation = host.call('projects.create', {name:'Waited', kind:'folder'}).then(receipt => {finished = true; return receipt;});
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(fs.existsSync(join(home, 'projects.json')), false);
  } finally {release(); await holder;}
  assert.equal(value(await creation).name, 'Waited');
});

for (const failure of ['unknown', 'partial'] as const) {
  test(`triage preserves an unknown creation outcome after ${failure} project creation`, async t => {
    const home = freshHome(), mailbox = new FakeMailbox();
    const {host} = open(home, {mail:{connector:mailbox}});
    await host.call('projects.list', {});
    fs.mkdirSync(join(home, 'projects'), {recursive:true});
    const statfs = fs.statfsSync, openSync = fs.openSync;
    let attempts = 0;
    if (failure === 'unknown') {
      t.mock.method(fs, 'statfsSync', ((path:fs.PathLike) => {
        if (String(path) === join(home, 'projects')) {attempts++; return {...statfs(path), type:0x6969};}
        return statfs(path);
      }) as typeof fs.statfsSync);
    } else {
      t.mock.method(fs, 'openSync', ((path:fs.PathLike, ...args:unknown[]) => {
        if (String(path).startsWith(join(home, 'projects') + '/')) {attempts++; throw new Error('Project folder cannot be opened.');}
        return Reflect.apply(openSync, fs, [path, ...args]);
      }) as typeof fs.openSync);
    }
    syncBuiltinESMExports();
    try {
      const result = await host.call('triage.connect', {});
      assert.ok(!result.ok);
      assert.equal(result.outcome, 'UNKNOWN');
      assert.equal(result.reason, 'NOT_AVAILABLE');
      assert.match(result.detail, failure === 'unknown' ? /lost write admission/ : /Partial files were left at/);
      assert.equal(attempts, 1, 'creation is not retried');
      assert.equal(fs.readdirSync(join(home, 'project-create-intents')).length, 1);
      assert.equal(fs.readdirSync(join(home, 'projects')).length, failure === 'partial' ? 1 : 0);
      assert.equal((await host.call('triage.get', {})).connection, null);
      assert.deepEqual(await host.call('projects.list', {}), []);
      assert.equal(mailbox.truth.applied.length, 0);
    } finally {t.mock.restoreAll(); syncBuiltinESMExports();}
  });
}
