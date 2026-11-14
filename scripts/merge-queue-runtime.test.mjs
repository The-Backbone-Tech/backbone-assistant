import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeLock, releaseLock } from './heavy-slots.mjs';
import { preflight, withQueueHeavyLease, archiveEvidence, assertRecordTarget, appendIntegrationRecord, driverSnapshot, assertDriverUnchanged, runPostGate, expectedOracleOnly, fastForwardIntegration } from './lib/merge-queue-runtime.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'merge-queue-runtime-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, text) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text); };
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git('init', '-qb', 'claude/integration');
  for (const [key,value] of Object.entries({'user.name':'Test','user.email':'test@example.invalid','commit.gpgsign':'false','core.hooksPath':'/dev/null'})) git('config', key, value);
  put('tracked.txt', 'base\n'); put('.gitignore', '.gate/\n'); git('add', '.'); git('commit', '-qm', 'base');
  return { root, put, git, lock: join(root, '.gate/.heavy.lock') };
}
const healthy = f => ({lock:f.lock, freeBytes:()=>30*1024**3, load:()=>[0.1,0.1,0.1], gates:()=>[], segments:()=>0});

test('preflight refuses low disk, busy load, a foreign priority marker and a running gate in seconds', async t => {
  const f=fixture(t), options=healthy(f);
  await assert.rejects(preflight(f.root,{...options,freeBytes:()=>19*1024**3}),/20 GiB/);
  await assert.rejects(preflight(f.root,{...options,load:()=>[3,0,0],maxLoad:2}),/load/i);
  await assert.rejects(preflight(f.root,{...options,gates:()=>[{pid:99,cwd:f.root}]}),/running gate/i);
  f.put('.gate/.heavy.next',JSON.stringify({pid:99,token:'foreign'}));
  await assert.rejects(preflight(f.root,options),/priority/i);
  assert.equal(JSON.parse(readFileSync(join(f.root,'.gate/.heavy.next'))).token,'foreign');
});

test('foreign live or dead heavy leases remain untouched', async t => {
  const f=fixture(t); await takeLock(f.lock,{pid:999999,token:'foreign',role:'gate'},0);
  try {
    await assert.rejects(preflight(f.root,{...healthy(f),pidAlive:()=>false}),/heavy|priority/i);
    assert.equal(JSON.parse(readFileSync(join(f.lock,'owner'))).token,'foreign');
  } finally { await releaseLock(f.lock,'foreign'); }
});

test('only the persisted queue-owned receipt and a dead PID allow stale lease cleanup', async t => {
  const f=fixture(t), token='owned-queue';
  await takeLock(f.lock,{pid:999999,token,role:'gate',protocol:'backbone-merge-queue-lease-v1'},0);
  const receipt=join(f.root,'.gate/lease.json');
  f.put('.gate/lease.json',JSON.stringify({protocol:'backbone-merge-queue-lease-v1',pid:999999,token,lock:f.lock}));
  await preflight(f.root,{...healthy(f),ownedReceipt:receipt,pidAlive:()=>false});
  assert.equal(existsSync(f.lock),false);
  assert.equal(existsSync(join(f.root,'.gate/.heavy.next')),false);
});

test('queue heavy lease reserves both slots, lends A to gate children and releases only its controls', async t => {
  const f=fixture(t), receipt=join(f.root,'.gate/lease.json');
  const result=await withQueueHeavyLease(async lease=>{
    const inherited=JSON.parse(lease.env.BACKBONE_HEAVY_LEASE);
    assert.equal(inherited.slot,'A'); assert.equal(inherited.lock,f.lock);
    assert.equal(existsSync(f.lock),true); assert.equal(existsSync(`${f.lock}.b`),true);
    lease.assertValid(); return 7;
  },{root:f.root,...healthy(f),receipt});
  assert.equal(result,7); assert.equal(existsSync(f.lock),false); assert.equal(existsSync(`${f.lock}.b`),false);
  assert.equal(existsSync(join(f.root,'.gate/.heavy.next')),false);
});

test('record writer refuses a missing file and a missing section without creating either', t=>{
  const f=fixture(t);
  assert.throws(()=>assertRecordTarget(f.root),/docs\/execution\.md.*missing|missing.*docs\/execution\.md/i);
  assert.equal(existsSync(join(f.root,'docs/execution.md')),false);
  f.put('docs/execution.md','# Execution\n\n## Now\nHuman text.\n');
  assert.throws(()=>appendIntegrationRecord(f.root,'- Gate a; passed.'),/Integration record/);
  assert.equal(readFileSync(join(f.root,'docs/execution.md'),'utf8'),'# Execution\n\n## Now\nHuman text.\n');
});

test('record append preserves Now and every prose byte outside its inserted line', t=>{
  const f=fixture(t), original='# Execution\r\n\r\n## Integration record\r\n\r\nHuman prose.\r\n- Old.\r\n\r\n## Now\r\nKeep exactly.\r\n';
  f.put('docs/execution.md',original);
  appendIntegrationRecord(f.root,'- Gate new; passed.');
  const after=readFileSync(join(f.root,'docs/execution.md'),'utf8');
  assert.equal(after.replace('- Gate new; passed.\r\n',''),original);
  assert.ok(after.indexOf('- Old.')<after.indexOf('- Gate new; passed.'));
  assert.ok(after.indexOf('- Gate new; passed.')<after.indexOf('## Now'));
});

test('a rerun rotates prior evidence instead of overwriting it', t=>{
  const f=fixture(t), out=join(f.root,'.gate/candidate'); f.put('.gate/candidate/log.txt','old');
  const moved=archiveEvidence(out);
  assert.ok(moved&&moved!==out); assert.equal(existsSync(out),false);
  assert.equal(readFileSync(join(moved,'log.txt'),'utf8'),'old');
  assert.equal(archiveEvidence(out),null);
});

test('loaded driver bytes are frozen and later edits refuse qualification',t=>{
  const f=fixture(t); f.put('scripts/merge-queue.mjs','export const value=1;\n');
  const snapshot=driverSnapshot(f.root,['scripts/merge-queue.mjs']); assertDriverUnchanged(snapshot);
  f.put('scripts/merge-queue.mjs','export const value=2;\n');
  assert.throws(()=>assertDriverUnchanged(snapshot),/driver.*changed/i);
});

test('postgate requires reviewed native commands before executing anything', async t=>{
  const f=fixture(t), calls=[];
  await assert.rejects(runPostGate(f.root,async(...args)=>{calls.push(args);return{code:0};},{}),/nativeCollector|native collector/i);
  assert.equal(calls.length,0);
});

test('postgate orders collector, restored native, owned Colima smoke, install and oracle restoration',async t=>{
  const f=fixture(t), calls=[];
  const result=await runPostGate(f.root,async(cwd,cmd,args,options)=>{calls.push({cmd,args,env:options?.env});return{code:0,output:''};},{nativeCollector:['collector','--safe'],restoredNative:['restored','--safe'],colimaProfile:'queue-fixture',colimaRoot:join(f.root,'.gate/colima'),env:{TEST_LEASE:'yes',DOCKER_CONTEXT:'foreign'}});
  assert.deepEqual(calls.map(c=>[c.cmd,...c.args].join(' ')),[
    'collector --safe','restored --safe','colima start --profile queue-fixture --activate=false',
    'bash scripts/docker-smoke.sh','colima stop --profile queue-fixture','colima delete --force --profile queue-fixture','pnpm test:install','git checkout -- oracle/results',
  ]);
  assert.ok(calls[3].env.DOCKER_HOST.endsWith('/queue-fixture/docker.sock'));
  assert.equal(calls[3].env.DOCKER_CONTEXT,undefined);
  assert.equal(calls[3].env.TEST_LEASE,'yes'); assert.ok(result.every(p=>p.durationSeconds>=0));
});

test('postgate smoke failure stops only its own Colima profile and restores oracle results',async t=>{
  const f=fixture(t), calls=[];
  await assert.rejects(runPostGate(f.root,async(cwd,cmd,args)=>{calls.push([cmd,...args].join(' '));return{code:cmd==='bash'?1:0,output:''};},{nativeCollector:['collector'],restoredNative:['restored'],colimaProfile:'queue-fixture',colimaRoot:join(f.root,'.gate/colima')}),/docker|smoke|failed/i);
  assert.ok(calls.includes('colima stop --profile queue-fixture'));
  assert.ok(calls.includes('colima delete --force --profile queue-fixture'));
  assert.equal(calls.at(-1),'git checkout -- oracle/results');
  assert.equal(calls.includes('pnpm test:install'),false);
});

test('oracle exit one passes only with the exact expected unimplemented summary',()=>{
  const output='lifecycle: not implemented\nscenes: not implemented\noracle (successor): 271 passed, 0 failed, 2 not implemented\n';
  assert.equal(expectedOracleOnly(output,1),true);
  assert.equal(expectedOracleOnly(output,2),false);
  assert.equal(expectedOracleOnly(output.replace('0 failed','1 failed'),1),false);
  assert.equal(expectedOracleOnly(output.replace('scenes:','other:'),1),false);
  assert.equal(expectedOracleOnly(output+output,1),false);
});

function candidate(f){f.git('checkout','-qb','unit');f.put('tracked.txt','candidate\n');f.git('commit','-qam','unit');const head=f.git('rev-parse','HEAD');f.git('checkout','-q','claude/integration');return head;}
function driver(f){const repository=join(f.root,'.gate/driver');f.git('worktree','add','-qb','queue-driver',repository);return repository;}

test('integration sync advances only the guarded integration worktree and sets the stack ref',t=>{
  const f=fixture(t), base=f.git('rev-parse','HEAD'), head=candidate(f);
  const result=fastForwardIntegration({repository:driver(f),integrationWorktree:f.root,base,head,stackBranch:'claude/stack-test',onLocked(){
    const switched=spawnSync('git',['checkout','unit'],{cwd:f.root,encoding:'utf8'});assert.notEqual(switched.status,0);
  }});
  assert.equal(result.head,head);assert.equal(f.git('rev-parse','HEAD'),head);assert.equal(f.git('rev-parse','claude/stack-test'),head);
  assert.equal(f.git('status','--porcelain'),'');assert.equal(readFileSync(join(f.root,'tracked.txt'),'utf8'),'candidate\n');
});

test('integration sync refuses dirty, wrong-branch and non-fast-forward states without losing edits',t=>{
  const f=fixture(t), base=f.git('rev-parse','HEAD'), head=candidate(f);
  const repository=driver(f);
  f.put('tracked.txt','human\n');
  assert.throws(()=>fastForwardIntegration({repository,integrationWorktree:f.root,base,head,stackBranch:'claude/stack-test'}),/dirty|changed/i);
  assert.equal(readFileSync(join(f.root,'tracked.txt'),'utf8'),'human\n');assert.equal(f.git('rev-parse','HEAD'),base);
  f.git('checkout','--','tracked.txt');f.git('checkout','-q','unit');
  assert.throws(()=>fastForwardIntegration({repository,integrationWorktree:f.root,base:head,head:base,stackBranch:'claude/stack-test'}),/integration|ancestor|fast-forward/i);
  assert.equal(f.git('rev-parse','HEAD'),head);
});

test('record writer refuses duplicate integration sections',t=>{
  const f=fixture(t), original='# Execution\n## Integration record\n- Old.\n## Integration record\n';
  f.put('docs/execution.md',original);assert.throws(()=>appendIntegrationRecord(f.root,'- New.'),/exactly one/);
  assert.equal(readFileSync(join(f.root,'docs/execution.md'),'utf8'),original);
});

test('postgate preserves the original smoke failure when VM cleanup also fails',async t=>{
  const f=fixture(t);
  await assert.rejects(runPostGate(f.root,async(cwd,cmd,args)=>({code:cmd==='bash'?9:cmd==='colima'&&args[0]==='stop'?8:0,output:''}),{
    nativeCollector:['collector'],restoredNative:['restored'],colimaRoot:join(f.root,'.gate/colima'),
  }),error=>{assert.match(error.message,/Docker smoke failed \(9\)/);assert.ok(error.cleanupErrors.some(text=>text.includes('Colima stop')));return true;});
});

test('local synchronization preserves ignored human files that a candidate would replace',t=>{
  const f=fixture(t),base=f.git('rev-parse','HEAD');candidate(f);
  f.git('checkout','-q','unit');f.put('.gate/collision','candidate\n');f.git('add','-f','.gate/collision');f.git('commit','-qm','tracked collision');
  const head=f.git('rev-parse','HEAD');f.git('checkout','-q','claude/integration');f.put('.gate/collision','human\n');
  assert.throws(()=>fastForwardIntegration({repository:driver(f),integrationWorktree:f.root,base,head,stackBranch:'claude/stack-test'}),/untracked|overwritten|human/i);
  assert.equal(readFileSync(join(f.root,'.gate/collision'),'utf8'),'human\n');assert.equal(f.git('rev-parse','HEAD'),base);
});

test('a live gate keeps a dead queue parents owned lease closed to new admission',async t=>{
  const f=fixture(t),token='dead-queue-live-gate';
  await takeLock(f.lock,{pid:999999,token,role:'gate',protocol:'backbone-merge-queue-lease-v1'},0);
  const receipt=join(f.root,'.gate/lease.json');f.put('.gate/lease.json',JSON.stringify({protocol:'backbone-merge-queue-lease-v1',pid:999999,token,lock:f.lock}));
  try {
    await assert.rejects(preflight(f.root,{...healthy(f),ownedReceipt:receipt,pidAlive:()=>false,gates:()=>[{pid:12345,cwd:f.root}]}),/running gate/i);
    assert.equal(JSON.parse(readFileSync(join(f.lock,'owner'))).token,token);
    assert.equal(JSON.parse(readFileSync(join(f.root,'.gate/.heavy.next'))).token,token);
  }finally{await releaseLock(f.lock,token);}
});

test('default driver snapshot also freezes the isolated installed retry entrypoint',t=>{
  const f=fixture(t);f.put('scripts/merge-queue.mjs','export const driver=1;\n');f.put('scripts/merge-queue-isolated.mjs','export const retry=1;\n');
  const snapshot=driverSnapshot(f.root);assert.ok(snapshot.files.some(entry=>entry.file==='scripts/merge-queue-isolated.mjs'));
  f.put('scripts/merge-queue-isolated.mjs','export const retry=2;\n');assert.throws(()=>assertDriverUnchanged(snapshot),/driver.*changed/i);
});

test('custom Colima home binds every VM command and smoke socket without touching a foreign environment profile',async t=>{
  const f=fixture(t),profile='queue-home-check',owned=join(f.root,'.gate/owned-colima'),foreign=join(f.root,'.gate/foreign-colima');
  f.put('.gate/foreign-colima/queue-home-check/human-vm.txt','keep foreign VM\n');
  const calls=[];
  await runPostGate(f.root,async(cwd,cmd,args,context)=>{
    calls.push({cmd,args,env:context.env});
    if(cmd==='colima'&&args[0]==='delete')rmSync(join(context.env.COLIMA_HOME,profile),{recursive:true,force:true});
    return{code:0,output:''};
  },{nativeCollector:['collector'],restoredNative:['restored'],colimaRoot:owned,colimaProfile:profile,env:{COLIMA_HOME:foreign}});
  assert.equal(readFileSync(join(foreign,profile,'human-vm.txt'),'utf8'),'keep foreign VM\n');
  for(const call of calls.filter(call=>call.cmd==='colima'))assert.equal(call.env.COLIMA_HOME,owned);
  const smoke=calls.find(call=>call.cmd==='bash');assert.equal(smoke.env.COLIMA_HOME,owned);assert.equal(smoke.env.DOCKER_HOST,`unix://${join(owned,profile,'docker.sock')}`);
});

test('configured Colima environment home refuses an existing profile before native or VM commands',async t=>{
  const f=fixture(t),home=join(f.root,'.gate/configured-colima'),profile='queue-owned-check',calls=[];
  f.put('.gate/configured-colima/queue-owned-check/human-vm.txt','keep\n');
  await assert.rejects(runPostGate(f.root,async(...args)=>{calls.push(args);return{code:0};},{nativeCollector:['collector'],restoredNative:['restored'],colimaProfile:profile,env:{COLIMA_HOME:home}}),/profile already exists/i);
  assert.equal(calls.length,0);assert.equal(readFileSync(join(home,profile,'human-vm.txt'),'utf8'),'keep\n');
});
