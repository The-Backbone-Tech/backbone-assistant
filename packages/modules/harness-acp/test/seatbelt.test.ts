// Real macOS Seatbelt canaries against owned processes and disposable files only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, chmod, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {auditScratchParent} from '@backbone-next/platform/audit-scratch';
import { test } from 'node:test';
import { candidateWriteRestrictionCommand as writeRestrictionCommand } from '../src/write-restrictions.ts';

test('deny-default profile applies process, service and file rules and permits IP network', { timeout: 20_000 }, async t => {
  if (process.platform !== 'darwin') { assert.throws(() => writeRestrictionCommand({ command: '/bin/true', args: [], work: '/', state: '/' }), /refused|No supported write-restriction profile/); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acp-seatbelt-')));
  const storage = join(root, 'storage'), work = join(storage, 'one', 'work'), state = join(storage, 'one', 'agent');
  const siblingWork = join(storage, 'two', 'work'), siblingState = join(storage, 'two', 'agent');
  const host = join(root, 'host'), home = join(root, 'home');
  for (const dir of [work, state, siblingWork, siblingState, host, join(home, '.ssh')]) await mkdir(dir, { recursive: true });
  for (const dir of [siblingWork, siblingState, host, join(home, '.ssh')]) await writeFile(join(dir, 'canary'), 'private canary');
  const target = spawn(process.execPath, ['-e', "process.on('SIGUSR2',()=>{}); console.log('ready');setInterval(()=>{},1000)"], { env: { ACP_ENV_CANARY: 'owned-canary' }, stdio: ['ignore', 'pipe', 'ignore'] });
  const server = createServer((_req, res) => res.end('network-ready'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const run = (command: string, args: string[]) => {
    const previous = process.env.HOME;
    let argv: string[];
    try { process.env.HOME = home; argv = writeRestrictionCommand({ command, args, work, state, storage, extraDenies: [host] }); }
    finally { process.env.HOME = previous; }
    return spawnSync(argv[0], argv.slice(1), { cwd: work, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: state, TMPDIR: work }, encoding: 'utf8', timeout: 5000 });
  };
  try {
    await new Promise<void>(resolve => target.stdout.once('data', () => resolve()));
    await t.test('outside signals fail and own children can be signalled', () => {
    const signals = run(process.execPath, ['-e', `const {spawn}=require('node:child_process'); let outside; try {process.kill(${target.pid},'SIGUSR2');outside='sent'}catch(e){outside=e.code}; const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); c.once('spawn',()=>c.kill('SIGTERM')); c.once('exit',(_,signal)=>console.log(JSON.stringify({outside,signal})));`]);
    assert.equal(signals.status, 0, signals.stderr); assert.deepEqual(JSON.parse(signals.stdout), { outside: 'EPERM', signal: 'SIGTERM' });
    });
    await t.test('launchctl print is refused by the executable guard', () => {
    const print = run('/bin/launchctl', ['print', `user/${process.getuid!()}`]);
    assert.notEqual(print.status, 0, 'the launchctl client must not execute');
    });
    const submitMarker = join(root, 'submitted-marker');
    await t.test('launchctl submit is refused by the executable guard', () => {
      const submit = run('/bin/launchctl', ['submit', '-l', `acp.canary.${process.pid}`, '--', '/usr/bin/touch', submitMarker]);
      assert.notEqual(submit.status, 0, 'launchctl execution must be refused');
    });
    const openMarker = join(root, 'opened-marker'), script = join(work, 'probe.command');
    await writeFile(script, `#!/bin/sh\n/usr/bin/touch '${openMarker}'\n`); await chmod(script, 0o700);
    await t.test('open refuses the command without starting desktop code', async () => {
    const opened = run('/usr/bin/open', ['-g', '-j', script]);
    assert.notEqual(opened.status, 0, 'LaunchServices must refuse open');
    assert.equal(opened.signal, null, 'open must return a refusal, rather than timing out');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(existsSync(submitMarker), false); assert.equal(existsSync(openMarker), false);
    });
    await t.test('sibling sessions, Host home and credentials are unreadable while own writes work', async () => {
    const files = run(process.execPath, ['-e', `const fs=require('node:fs'); const denied=${JSON.stringify([siblingWork, siblingState, host, join(home, '.ssh')])}; console.log(JSON.stringify(denied.map(p=>{try {fs.readFileSync(p+'/canary');return 'read'}catch(e){return e.code}}))); fs.writeFileSync('inside','allowed'); fs.writeFileSync(${JSON.stringify(join(state, 'state-write'))},'allowed');`]);
    assert.equal(files.status, 0, files.stderr); assert.deepEqual(JSON.parse(files.stdout), ['EPERM', 'EPERM', 'EPERM', 'EPERM']);
    assert.equal(await readFile(join(work, 'inside'), 'utf8'), 'allowed');
    });
    await t.test('IP network is reachable', async () => {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    // Async child: the outside test server must remain able to answer the request.
    const previous = process.env.HOME; process.env.HOME = home;
    let argv: string[];
    try { argv = writeRestrictionCommand({ command: process.execPath, args: ['-e', `fetch('http://127.0.0.1:${address.port}').then(r=>r.text()).then(console.log)`], work, state, storage, extraDenies: [host] }); }
    finally { process.env.HOME = previous; }
    const network = spawn(argv[0], argv.slice(1), { cwd: work, env: { HOME: state, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = ''; network.stdout.on('data', b => { output += b; }); network.stderr.on('data', b => { errors += b; });
    const code = await new Promise(resolve => network.once('exit', resolve));
    assert.equal(code, 0, errors); assert.equal(output.trim(), 'network-ready');
    });
  } finally {
    target.kill('SIGKILL'); await new Promise<void>(resolve => { if (target.exitCode !== null || target.signalCode !== null) resolve(); else target.once('exit', () => resolve()); });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

// Accepted platform limit, not a confidentiality guarantee. Inspect only our disposable target.
test('known macOS limit: the restricted-writes profile can read another same-user process environment and arguments', { timeout: 10_000 }, async () => {
  if (process.platform !== 'darwin') return;
  const { fileURLToPath } = await import('node:url');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acp-procargs-limit-')));
  const work = join(root, 'work'), state = join(root, 'state'), helper = join(root, 'procargs');
  await mkdir(work); await mkdir(state);
  const compiled = spawnSync('/usr/bin/clang', [fileURLToPath(new URL('./procargs.c', import.meta.url)), '-o', helper], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const target = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)", 'owned-argument-canary'], { env: { ACP_ENV_CANARY: 'owned-canary' }, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise<void>(resolve => target.stdout.once('data', () => resolve()));
    const control = spawnSync(helper, [String(target.pid)]);
    assert.equal(control.status, 0); assert.ok(control.stdout.includes('ACP_ENV_CANARY=owned-canary')); assert.ok(control.stdout.includes('owned-argument-canary'));
    const argv = writeRestrictionCommand({ command: helper, args: [String(target.pid)], work, state, storage: root });
    const exposed = spawnSync(argv[0], argv.slice(1));
    assert.equal(exposed.status, 0, exposed.stderr.toString());
    assert.ok(exposed.stdout.includes('ACP_ENV_CANARY=owned-canary'), 'record the actual peer-environment exposure instead of claiming isolation');
    assert.ok(exposed.stdout.includes('owned-argument-canary'));
  } finally {
    target.kill('SIGKILL'); await new Promise<void>(resolve => { if (target.exitCode !== null || target.signalCode !== null) resolve(); else target.once('exit', () => resolve()); });
    await rm(root, { recursive: true, force: true });
  }
});

test('SMJobSubmit is refused, and an allow-job-creation profile variant creates only the disposable job', { timeout: 15_000 }, async () => {
  if (process.platform !== 'darwin') return;
  const { fileURLToPath } = await import('node:url');
  const { randomUUID } = await import('node:crypto');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acp-job-submit-'))), work = join(root, 'work'), state = join(root, 'agent'), helper = join(root, 'job-submit');
  await mkdir(work); await mkdir(state);
  const compiled = spawnSync('/usr/bin/clang', [fileURLToPath(new URL('./job-submit.c', import.meta.url)), '-o', helper, '-framework', 'ServiceManagement', '-framework', 'CoreFoundation', '-Wno-deprecated-declarations'], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const deniedLabel = `io.backbone.acp.canary.${randomUUID()}`, allowedLabel = `io.backbone.acp.canary.${randomUUID()}`;
  const deniedMarker = join(root, 'denied-marker'), allowedMarker = join(root, 'allowed-marker');
  const argv = writeRestrictionCommand({ command: helper, args: ['submit', deniedLabel, deniedMarker], work, state, storage: root });
  const execute = (args: string[]) => spawnSync(args[0], args.slice(1), { cwd: work, encoding: 'utf8', timeout: 5000 });
  try {
    const denied = execute(argv); assert.equal(denied.signal, null); assert.equal(denied.status, 1, denied.stderr); assert.equal(denied.stdout.trim(), 'refused'); assert.equal(existsSync(deniedMarker), false);
    const positive = [...argv]; assert.match(positive[2], /\(deny job-creation\)/);
    positive[2] = positive[2].replace('(deny job-creation)', '(allow job-creation)');
    positive[positive.length - 2] = allowedLabel; positive[positive.length - 1] = allowedMarker;
    const allowed = execute(positive);
    assert.equal(allowed.status, 0, allowed.stderr); assert.equal(allowed.stdout.trim(), 'allowed');
    for (let i = 0; i < 100 && !existsSync(allowedMarker); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(existsSync(allowedMarker), true, 'the positive control must really run the disposable marker job');
    assert.equal(existsSync(deniedMarker), false);
  } finally {
    try {
      const removals = [deniedLabel, allowedLabel].map(label => spawnSync(helper, ['remove', label], { encoding: 'utf8', timeout: 5000 }));
      for (const removed of removals) assert.equal(removed.status, 0, removed.stderr);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('IP outbound permits loopback while Unix socket connections are refused', async () => {
  if (process.platform !== 'darwin') return;
  const { createServer: unixServer } = await import('node:net');
  const root = await realpath(await mkdtemp('/tmp/acp-unix-')), storage = join(root, 'storage'), work = join(storage, 'work'), state = join(storage, 'agent'), socket = join(root, 'local.sock');
  await mkdir(work, { recursive: true }); await mkdir(state);
  const server = unixServer(connection => connection.end()); await new Promise<void>(resolve => server.listen(socket, resolve));
  const script = `const c=require('node:net').connect(${JSON.stringify(socket)});c.on('connect',()=>{console.log('connected');c.destroy();});c.on('error',e=>console.log(e.code));`;
  try {
    const control = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 }); assert.equal(control.status, 0); assert.equal(control.stdout.trim(), 'connected');
    const argv = writeRestrictionCommand({ command: process.execPath, args: ['-e', script], work, state, storage });
    const denied = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 5000 }); assert.equal(denied.status, 0, denied.stderr); assert.equal(denied.stdout.trim(), 'EPERM');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('the real write-restriction profile refuses immutable flags and deny-delete ACLs while ordinary writes work', async () => {
  if (process.platform !== 'darwin') return;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acp-file-metadata-'))), work = join(root, 'work'), state = join(root, 'agent');
  await mkdir(work); await mkdir(state);
  const file = join(work, 'plain'); await writeFile(file, 'ordinary');
  const run = (command: string, args: string[]) => { const argv = writeRestrictionCommand({ command, args, work, state, storage: root }); return spawnSync(argv[0], argv.slice(1), { cwd: work, encoding: 'utf8' }); };
  try {
    for (const [command, plant, undo] of [['/usr/bin/chflags', ['uchg', file], ['nouchg', file]], ['/bin/chmod', ['+a', 'everyone deny delete', file], ['-N', file]]] as const) {
      const control = spawnSync(command, [...plant], { encoding: 'utf8' }); assert.equal(control.status, 0, control.stderr);
      assert.equal(spawnSync(command, [...undo]).status, 0);
      const denied = run(command, [...plant]); assert.notEqual(denied.status, 0); assert.match(denied.stderr, /Operation not permitted/);
    }
    const ordinary = run('/bin/sh', ['-c', 'chmod 600 plain && echo allowed > plain && rm plain']);
    assert.equal(ordinary.status, 0, ordinary.stderr); assert.equal(existsSync(file), false);
  } finally { spawnSync('/usr/bin/chflags', ['nouchg', file]); spawnSync('/bin/chmod', ['-N', file]); await rm(root, { recursive: true, force: true }); }
});

test('the real macOS restricted profile cannot read the default audit scratch parent',async()=>{
  if(process.platform!=='darwin')return;
  const root=await realpath(await mkdtemp('/tmp/acp-audit-')),work=join(root,'work'),state=join(root,'agent');
  await mkdir(work);await mkdir(state);await mkdir(auditScratchParent(),{recursive:true,mode:0o700});
  const canary=join(auditScratchParent(),`acp-canary-${process.pid}`);await writeFile(canary,'audit-copy-private-canary',{mode:0o600});
  try{
    assert.equal(await readFile(canary,'utf8'),'audit-copy-private-canary');
    const args=writeRestrictionCommand({command:process.execPath,args:['-e',`try{console.log(require('node:fs').readFileSync(${JSON.stringify(canary)},'utf8'))}catch(e){console.log(e.code)}`],work,state,storage:root});
    const result=spawnSync(args[0],args.slice(1),{cwd:work,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'EPERM');
  }finally{await rm(canary,{force:true});await rm(root,{recursive:true,force:true});}
});

test('a link at the audit parent neither refuses a restricted session nor hides its target ancestor',async()=>{
  if(process.platform!=='darwin')return;
  const root=await realpath(await mkdtemp('/tmp/acp-audit-link-')),storage=join(root,'storage'),work=join(storage,'work'),state=join(storage,'agent');
  await mkdir(work,{recursive:true});await mkdir(state);const canary=join(root,'ancestor-canary');await writeFile(canary,'ordinary-readable-ancestor');
  const originalUid=process.getuid!;
  // Select an unused fixture uid's default path without changing the OS identity or moving
  // this real user's scratch parent, which another export may be using.
  const fixtureUid=1000000000+process.pid;let parent:string|undefined,planted=false;
  try{
    process.getuid=()=>fixtureUid;parent=auditScratchParent();assert.equal(existsSync(parent),false);await symlink(root,parent);planted=true;
    const argv=writeRestrictionCommand({command:process.execPath,args:['-e',`console.log(require('node:fs').readFileSync(${JSON.stringify(canary)},'utf8'))`],work,state,storage});
    process.getuid=originalUid;
    const result=spawnSync(argv[0],argv.slice(1),{cwd:work,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'ordinary-readable-ancestor');
    assert.equal(argv[2].includes(`(subpath ${JSON.stringify(root)})`),false,'the link target never becomes a read exclusion');
  }finally{process.getuid=originalUid;if(planted&&parent)await rm(parent,{force:true});await rm(root,{recursive:true,force:true});}
});
