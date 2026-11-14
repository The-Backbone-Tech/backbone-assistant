import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Project } from '../src/api.ts';
import { createKeyedProject } from '../src/composition/project-create.ts';
import { prepareReservedProject } from '../src/composition/project-create-prepare.ts';
import { HomeWriteUnavailable, withHomeLock } from '../src/composition/home-lock.ts';
import { readJson, sha256, writeJson } from '../src/stub/fsx.ts';

function snapshot(home: string) {
  return fs.readdirSync(home, {recursive:true}).map(String).sort().map(path => {
    const full = join(home, path);
    return [path, fs.lstatSync(full).isDirectory() ? null : fs.readFileSync(full)];
  });
}

for (const kind of ['folder', 'git'] as const) {
  for (const point of ['reserved', 'started', 'prepared', 'recorded'] as const) {
    test(`${kind} creation stops all writes when admission is lost at ${point}`, async t => {
      const home = fs.mkdtempSync(join(tmpdir(), 'project-admission-'));
      t.after(() => fs.rmSync(home, {recursive:true, force:true}));
      let admitted = true, emitted = 0, atLoss: ReturnType<typeof snapshot> | undefined;
      const statfs = fs.statfsSync;
      t.mock.method(fs, 'statfsSync', ((path: fs.PathLike) => ({...statfs(path), ...(!admitted ? {type:0x6969} : {})})) as typeof fs.statfsSync);
      let projects: (Project & {dir:string})[] = [];
      const receipt = await createKeyedProject({
        home, list:() => projects,
        save:next => { writeJson(join(home, 'projects.json'), next); projects = next; },
        emit:() => { emitted++; },
        cut:cut => { if (cut === point) { admitted = false; atLoss = snapshot(home); } },
      }, 'Admission test', kind, 'admission-test');
      assert.ok(atLoss, 'the test reached the requested creation boundary');
      assert.ok(!receipt.ok);
      assert.equal(receipt.outcome, 'UNKNOWN', 'a persisted intent cannot be reported as created');
      assert.equal(emitted, 0);
      assert.deepEqual(snapshot(home), atLoss, 'no folder, Git, project list or intent write follows lost admission');
      if (point === 'reserved' || point === 'started') assert.equal(fs.existsSync(join(home, 'projects')), false);
      const intent = readJson<{phase:string}>(join(home, 'project-create-intents', `${sha256('admission-test')}.json`), {phase:'missing'});
      assert.equal(intent.phase, point === 'reserved' ? 'reserved' : 'started');
    });
  }
}

test('creation refused before its first write leaves no intent, project folder or list', async t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'project-admission-'));
  t.after(() => fs.rmSync(home, {recursive:true, force:true}));
  const statfs = fs.statfsSync;
  t.mock.method(fs, 'statfsSync', ((path: fs.PathLike) => ({...statfs(path), type:0x6969})) as typeof fs.statfsSync);
  const receipt = await createKeyedProject({home, list:() => [], save:() => assert.fail('project list write'), emit:() => assert.fail('created event')}, 'Refused', 'folder', 'refused');
  assert.ok(!receipt.ok); assert.equal(receipt.outcome, 'REFUSED');
  assert.deepEqual(fs.readdirSync(home), []);
});

test('Git setup checks admission again after reserving the folder, before creating README or repository', t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'project-admission-git-'));
  t.after(() => fs.rmSync(home, {recursive:true, force:true}));
  const statfs = fs.statfsSync;
  let admitted = true;
  t.mock.method(fs, 'statfsSync', ((path: fs.PathLike) => ({...statfs(path), ...(!admitted ? {type:0x6969} : {})})) as typeof fs.statfsSync);
  assert.throws(() => prepareReservedProject(home, {
    key:'git', name:'Git', kind:'git', phase:'started',
    project:{id:'git-id', name:'Git', kind:'git', dir:'git-id', createdAt:'now'},
  }, () => { admitted = false; }), HomeWriteUnavailable);
  assert.deepEqual(fs.readdirSync(join(home, 'projects', 'git-id')), []);
});


test('the creator checks admission after lock acquisition and before its first write', async t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'project-admission-first-'));
  t.after(() => fs.rmSync(home, {recursive:true, force:true}));
  const statfs = fs.statfsSync;
  let admitted = true;
  t.mock.method(fs, 'statfsSync', ((path: fs.PathLike) => ({...statfs(path), ...(!admitted ? {type:0x6969} : {})})) as typeof fs.statfsSync);
  await withHomeLock(home, async () => {
    const before = snapshot(home);
    admitted = false;
    const receipt = await createKeyedProject({home, list:() => [], save:() => assert.fail('list write'), emit:() => assert.fail('created event')}, 'First', 'folder', 'first');
    assert.ok(!receipt.ok); assert.equal(receipt.outcome, 'REFUSED');
    assert.deepEqual(snapshot(home), before);
    assert.match(receipt.detail, /this request.*nothing.*earlier attempt.*project list/i);
  });
});

for (const boundary of ['reserve', 'failed'] as const) {
  test(`intent ${boundary} write checks admission immediately before writing`, async t => {
    const home = fs.mkdtempSync(join(tmpdir(), 'project-admission-intent-'));
    t.after(() => fs.rmSync(home, {recursive:true, force:true}));
    let admitted = true, atLoss: ReturnType<typeof snapshot> | undefined;
    const statfs = fs.statfsSync, mkdir = fs.mkdirSync;
    const lose = () => { admitted = false; atLoss = snapshot(home); };
    t.mock.method(fs, 'statfsSync', ((path: fs.PathLike) => ({...statfs(path), ...(!admitted ? {type:0x6969} : {})})) as typeof fs.statfsSync);
    t.mock.method(fs, 'mkdirSync', ((path: fs.PathLike, options: never) => {
      if (boundary === 'failed' && String(path) === join(home, 'projects')) { lose(); throw new Error('preparation failed before making its folder'); }
      const result = mkdir(path, options);
      if (boundary === 'reserve' && String(path) === join(home, 'project-create-intents')) lose();
      return result;
    }) as typeof fs.mkdirSync);
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const receipt = await createKeyedProject({home, list:() => [], save:() => assert.fail('list write'), emit:() => assert.fail('created event')}, 'Intent', 'folder', boundary);
    assert.ok(atLoss); assert.ok(!receipt.ok); assert.equal(receipt.outcome, 'UNKNOWN');
    assert.deepEqual(snapshot(home), atLoss);
  });
}

for (const boundary of ['directory', 'readme-bytes', 'git-directory', 'git-init', 'git-blob', 'git-index', 'git-commit'] as const) {
  test(`preparation checks admission before ${boundary}`, t => {
    const home = fs.mkdtempSync(join(tmpdir(), 'project-admission-prepare-'));
    t.after(() => fs.rmSync(home, {recursive:true, force:true}));
    const dir = join(home, 'projects', 'project-id');
    let admitted = true, atLoss: ReturnType<typeof snapshot> | undefined, gitCalls = 0;
    const statfs = fs.statfsSync, mkdir = fs.mkdirSync, open = fs.openSync, write = fs.writeFileSync, exec = childProcess.execFileSync;
    const lose = () => { admitted = false; atLoss = snapshot(home); };
    t.mock.method(fs, 'statfsSync', ((path: fs.PathLike) => ({...statfs(path), ...(!admitted ? {type:0x6969} : {})})) as typeof fs.statfsSync);
    t.mock.method(fs, 'mkdirSync', ((path: fs.PathLike, options: never) => {
      const result = mkdir(path, options);
      if ((boundary === 'directory' && String(path) === join(home, 'projects')) || (boundary === 'git-init' && String(path) === join(dir, '.git'))) lose();
      return result;
    }) as typeof fs.mkdirSync);
    t.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: never, mode: never) => {
      const fd = open(path, flags, mode);
      if (admitted && boundary === 'readme-bytes' && String(path) === join(dir, 'README.md')) lose();
      return fd;
    }) as typeof fs.openSync);
    t.mock.method(fs, 'writeFileSync', ((...args: Parameters<typeof fs.writeFileSync>) => {
      const result = write(...args);
      if (boundary === 'git-directory') lose();
      return result;
    }) as typeof fs.writeFileSync);
    t.mock.method(childProcess, 'execFileSync', ((...args: Parameters<typeof childProcess.execFileSync>) => {
      const result = exec(...args); gitCalls++;
      if (gitCalls === ['git-blob', 'git-index', 'git-commit'].indexOf(boundary) + 1) lose();
      return result;
    }) as typeof childProcess.execFileSync);
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    assert.throws(() => prepareReservedProject(home, {
      key:'prepare', name:'Prepare', kind:'git', phase:'started',
      project:{id:'project-id', name:'Prepare', kind:'git', dir:'project-id', createdAt:'now'},
    }), HomeWriteUnavailable);
    assert.ok(atLoss, 'the requested boundary was reached');
    assert.deepEqual(snapshot(home), atLoss, 'no write follows admission loss');
  });
}

test('same-key refusal after a partially completed attempt describes only this request', async t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'project-admission-retry-'));
  t.after(() => fs.rmSync(home, {recursive:true, force:true}));
  let admitted = true;
  const statfs = fs.statfsSync;
  t.mock.method(fs, 'statfsSync', ((path: fs.PathLike) => ({...statfs(path), ...(!admitted ? {type:0x6969} : {})})) as typeof fs.statfsSync);
  let projects: (Project & {dir:string})[] = [];
  const deps = {home, list:() => projects, save:(next:typeof projects) => {writeJson(join(home, 'projects.json'), next); projects = next;}, emit:() => assert.fail('created event'), cut:(point:string) => {if(point === 'recorded') admitted = false;}};
  const first = await createKeyedProject(deps, 'Retry', 'folder', 'retry');
  assert.ok(!first.ok); assert.equal(first.outcome, 'UNKNOWN'); assert.equal(projects.length, 1);
  const before = snapshot(home);
  const retry = await createKeyedProject(deps, 'Retry', 'folder', 'retry');
  assert.ok(!retry.ok); assert.equal(retry.outcome, 'REFUSED');
  assert.match(retry.detail, /this request.*nothing.*earlier attempt.*project list/i);
  assert.deepEqual(snapshot(home), before);
});
