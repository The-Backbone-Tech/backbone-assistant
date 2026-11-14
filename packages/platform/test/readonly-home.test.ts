import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import pg from 'pg';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
import {PersonalReadRefusal,openPersonalDatabase} from '@backbone/core/db';
import {createHost,hostClosed,removeDataHome} from '../src/composition/host.ts';
import {CoreLink} from '../src/composition/core.ts';
import {HomeIncomplete} from '../src/composition/home-complete.ts';
import {withHomeLock} from '../src/composition/home-lock.ts';
import {systemKeys} from '../src/system-keys/provider.ts';
import {memoryKeychain} from '../src/testing/keys.ts';
import {document,systemFixture} from './policy-fixture.ts';
import {exportAuditHome} from '../src/composition/audit-home.ts';
import {ownerSocket} from '../src/composition/home-owner.ts';
import {LOG_POLICY_QUERY} from '../src/authority/log-policy.ts';
import {Vault,plaintextKeys} from '../src/keys/vault.ts';
import {freshDir,freshHome} from './helpers.ts';
import {homeState,assertHomeState,logicalState} from './readonly-home-state.ts';
import {nativeHome,rawServer,baseline} from './readonly-native-fixtures.ts';

test('a read-only Host refuses a vault-only first run without changing any entry',async()=>{
 const home=freshDir('f7-vault-only-');await Vault.open(home,plaintextKeys());
 const before=homeState(home);let host:ReturnType<typeof createHost>|undefined;
 try{assert.throws(()=>{host=createHost({home,readOnly:true});},error=>error instanceof Error&&/kernel.json/.test(error.message)&&/projects create/.test(error.message));}
 finally{host?.close();if(host)await hostClosed(home);}
 assertHomeState(before,homeState(home));
});

test('read-only ownership excludes a writer and a snapshot exporter without touching the home',async t=>{
 // The external test database has no local PID guard that could mask a missing owner check.
 const home=freshHome(),keys=plaintextKeys(),seed=createHost({home,keys});
 try{await seed.call('projects.list',{});}finally{seed.close();await hostClosed(home);}
 const f={home,keys},reader=createHost({home,keys,readOnly:true});
 try{
  await reader.call('projects.list',{});const before=homeState(f.home);
  const writer=createHost({home:f.home,keys:f.keys});
  try{await assert.rejects(writer.call('projects.list',{}),/in use by another host/);}finally{writer.close();await hostClosed(f.home);}
  const paths:string[]=[],original=net.createConnection;
  const probe=t.mock.method(net,'createConnection',(...args:Parameters<typeof original>)=>{
   const first:unknown=args[0];if(typeof first==='string')paths.push(first);
   else if(typeof first==='object'&&first&&'path' in first&&typeof first.path==='string')paths.push(first.path);
   return Reflect.apply(original,net,args);
  });
  syncBuiltinESMExports();
  try{
   let output=false;
   await assert.rejects(exportAuditHome(f.home,{since:'2000-01-01T00:00:00Z',until:'2100-01-01T00:00:00Z'},async()=>{output=true;}));
   assert.equal(output,false,'a held home never starts snapshot output');
   assert.ok(paths.includes(ownerSocket(f.home,true)),'snapshot export probes the active read-only ownership endpoint');
  }finally{probe.mock.restore();syncBuiltinESMExports();}
  assertHomeState(before,homeState(f.home),true);
 }finally{reader.close();await hostClosed(f.home);}
});
test('a failed new-server schema verification stops only its own child',async t=>{
 const f=await nativeHome(t),damage=await rawServer(t,f.home,f.vault);
 await damage.client.query("UPDATE ops.schema_migrations SET checksum=$1 WHERE version='material-closure-hardening-v1'",['0'.repeat(64)]);
 await damage.client.end();await damage.stop();const before=homeState(f.home);
 const host=createHost({home:f.home,keys:f.keys,readOnly:true});
 try{await assert.rejects(host.call('projects.list',{}),PersonalReadRefusal);}finally{host.close();await hostClosed(f.home);}
 assert.equal(existsSync(join(f.home,'pg','data','postmaster.pid')),false);assertHomeState(before,homeState(f.home),true);
});
test('a failed Core connection logging check also closes pools and its newly started server',async t=>{
 const f=await nativeHome(t),before=homeState(f.home);let checks=0;
 const original=pg.Pool.prototype.query;
 t.mock.method(pg.Pool.prototype,'query',function(this:pg.Pool,...args:Parameters<typeof original>){
  if(args[0]===LOG_POLICY_QUERY){checks++;return Promise.resolve({rows:[{}]}) as unknown as ReturnType<typeof original>;}
  return Reflect.apply(original,this,args);
 });
 const reader=createHost({home:f.home,keys:f.keys,readOnly:true});
 try{await assert.rejects(reader.call('projects.list',{}));assert.equal(checks,1);}
 finally{reader.close();await hostClosed(f.home);}
 assert.equal(existsSync(join(f.home,'pg','data','postmaster.pid')),false);assertHomeState(before,homeState(f.home),true);
});
test('a copied port and authenticated password cannot select another home server',async t=>{
 const source=await nativeHome(t),target=await nativeHome(t),server=await rawServer(t,target.home,target.vault);
 await source.vault.passwords().write((await target.vault.passwords().read())!);
 writeFileSync(join(source.home,'pg','cluster.json'),readFileSync(join(target.home,'pg','cluster.json')));
 const before=homeState(source.home),logicalBefore=await logicalState(server.client);
 await assert.rejects(openPersonalDatabase({dir:join(source.home,'pg'),baselineSql:baseline,passwords:source.vault.passwords(),readOnly:true}),e=>e instanceof PersonalReadRefusal&&e.code==='server-identity');
 assertHomeState(before,homeState(source.home));assert.deepEqual(await logicalState(server.client),logicalBefore);
});
test('a PID reused by a live non-server process is neither removed nor signalled',async t=>{
 const f=await nativeHome(t),child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}});
 const pid=join(f.home,'pg','data','postmaster.pid');
 writeFileSync(pid,`${child.pid}\n${join(f.home,'pg','data')}\n`);
 try{
  const before=homeState(f.home);
  await assert.rejects(openPersonalDatabase({dir:join(f.home,'pg'),baselineSql:baseline,passwords:f.vault.passwords(),readOnly:true}),e=>e instanceof PersonalReadRefusal&&e.code==='server-identity');
  assertHomeState(before,homeState(f.home));assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
 }finally{rmSync(pid);}
});
test('crash recovery may change physical pages but preserves committed logical state',async t=>{
 const f=await nativeHome(t,'plaintext','complete',true),server=await rawServer(t,f.home,f.vault);
 await server.client.query("UPDATE app.tasks SET title=title||' synthetic recovery'");
 const logicalBefore=await logicalState(server.client);await server.client.end();
 server.child.kill('SIGKILL');await new Promise(resolve=>server.child.once('exit',resolve));
 const before=homeState(f.home),reader=createHost({home:f.home,keys:f.keys,readOnly:true});
 try{await reads(reader,f);}finally{reader.close();await hostClosed(f.home);}
 const after=await rawServer(t,f.home,f.vault);assert.deepEqual(await logicalState(after.client),logicalBefore);
 await after.client.end();await after.stop();assertHomeState(before,homeState(f.home),true);
});
test('read-only vault opening defers key rewrapping and refuses mutators before a lock',async t=>{
 const home=freshDir('f7-rotation-'),keys=memoryKeychain();await Vault.open(home,keys);Vault.forget(home);
 const rotating={...keys,unwrapKey:async(wrapped:Buffer)=>({...await keys.unwrapKey(wrapped),rewrap:true})};
 const wrap=t.mock.method(rotating,'wrapKey',keys.wrapKey),before=homeState(home);
 const vault=await Vault.open(home,rotating,{readOnly:true});
 await assert.rejects(async()=>vault.put('forbidden',Buffer.from('fake')));
 await assert.rejects(vault.masterKey());assert.equal(wrap.mock.callCount(),0);assertHomeState(before,homeState(home));
 await Vault.open(home,rotating);assert.equal(wrap.mock.callCount(),1,'a later writable open still performs the deferred rewrap');
});
test('policy reads and required telemetry remain inspection-only on a read-only Host',async t=>{
 const f=await nativeHome(t);systemFixture(t,document({telemetryRequired:true,telemetryEndpoint:'https://collector.invalid/v1/traces'}));
 const before=homeState(f.home),host=createHost({home:f.home,keys:f.keys,readOnly:true});
 try{await host.call('projects.list',{});assert.equal((await host.call('settings.policy.get',{})).state,'verified');}
 finally{host.close();await hostClosed(f.home);}
 assertHomeState(before,homeState(f.home),true);
});

for(const kind of ['plaintext','system'])for(const stage of ['vault','stamp','passwords','cluster','identity','missing-folders'])test(`incomplete ${kind} home at ${stage} refuses Host and Core without any path exception`,async t=>{
 const f=await nativeHome(t,kind,stage==='missing-folders'?'complete':stage);
 if(stage==='missing-folders'){rmSync(join(f.home,'memory'),{recursive:true});rmSync(join(f.home,'threads'),{recursive:true});}
 const before=homeState(f.home),writes=f.store.writes;
 assert.throws(()=>createHost({home:f.home,keys:f.keys,readOnly:true}),error=>{
  assert.ok(error instanceof HomeIncomplete);assert.ok(error.missing.length>0);assert.match(error.message,/projects create/);return true;
 });
 await assert.rejects(CoreLink.open({home:f.home,keys:f.keys,readOnly:true}),HomeIncomplete);
 assertHomeState(before,homeState(f.home));assert.equal(f.store.writes,writes);
 assert.equal(existsSync(join(f.home,'pg','data','postmaster.pid')),false);
});

async function reads(host:ReturnType<typeof createHost>,f:{home:string;projectId:string;threadId:string}){
 const projects=await host.call('projects.list',{});assert.ok(projects.some(p=>p.id===f.projectId));
 assert.ok((await host.call('threads.list',{})).some(thread=>thread.id===f.threadId));
 assert.equal((await host.call('threads.get',{id:f.threadId})).ok,true);
 await host.call('work.now',{projectId:f.projectId});
 assert.equal((await host.call('backup.inspect',{from:join(f.home,'not-an-export')})).ok,false);
 await host.call('connectors.list',{});
 const period={since:'2000-01-01T00:00:00Z',until:'2100-01-01T00:00:00Z'};
 const audit=await host.call('audit.export',period);assert.equal(audit.ok,true);
 if(audit.ok&&audit.value.session)await host.call('audit.export',{...period,session:audit.value.session,cancel:true});
 assert.equal((await host.call('projects.create',{name:'Forbidden',kind:'folder'})).ok,false);
}
for(const kind of ['plaintext','system'])for(const running of [false,true])test(`whole Host pins files, logical rows, catalogue, roles and history (${kind}, already running=${running})`,async t=>{
 const f=await nativeHome(t,kind,'complete',true);
 // A reader must not renew even an absent mandate pointer or repair its identity file.
 const idPath=join(f.home,'core.json'),id=JSON.parse(readFileSync(idPath,'utf8'));id.mandate='';writeFileSync(idPath,JSON.stringify(id));
 const observer=await rawServer(t,f.home,f.vault),logicalBefore=await logicalState(observer.client);
 if(!running){await observer.client.end();await observer.stop();}
 const before=homeState(f.home),storeWrites=f.store.writes;
 const mutators:string[]=[];const original=pg.Client.prototype.query;
 const spy=t.mock.method(pg.Client.prototype,'query',function(this:pg.Client,...args:Parameters<typeof original>){
  const sql=typeof args[0]==='string'?args[0]:(args[0] as {text?:string})?.text??'';
  const mutation=/(?:^|;)\s*(ALTER|CREATE|INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/i.exec(sql);
  if(mutation)mutators.push(mutation[1].toUpperCase());
  if(/\bFOR\s+(?:UPDATE|SHARE)\b/i.test(sql))mutators.push('row lock');
  return Reflect.apply(original,this,args);
 });
 const host=createHost({home:f.home,keys:f.keys,readOnly:true,harness:'harness-stub'});
 try{await reads(host,f);}finally{host.close();await hostClosed(f.home);spy.mock.restore();}
 assert.deepEqual(mutators,[],'read-only startup never attempts an installer or role reconciliation');
 const afterObserver=running?observer:await rawServer(t,f.home,f.vault);
 assert.deepEqual(await logicalState(afterObserver.client),logicalBefore);
 if(running)assert.equal((await observer.client.query('SELECT 1 AS alive')).rows[0].alive,1,'closing a reused reader leaves the existing server alive');
 else{await afterObserver.client.end();await afterObserver.stop();}
 assertHomeState(before,homeState(f.home),true);assert.equal(f.store.writes,storeWrites);
});

for(const kind of ['plaintext','system'])for(const stage of ['pending','release-pending'])test(`released pending schema refuses read-only and upgrades through a writable Host (${kind}, ${stage})`,async t=>{
 const f=await nativeHome(t,kind,stage),server=await rawServer(t,f.home,f.vault);
 const logicalBefore=await logicalState(server.client),before=homeState(f.home);
 const ledgerBefore=(await server.client.query('SELECT to_jsonb(l) AS row FROM app.ledger l ORDER BY seq')).rows;
 const reader=createHost({home:f.home,keys:f.keys,readOnly:true});
 try{await assert.rejects(reader.call('projects.list',{}),e=>e instanceof PersonalReadRefusal&&e.code==='needs-upgrade');}
 finally{reader.close();await hostClosed(f.home);}
 assert.deepEqual(await logicalState(server.client),logicalBefore);assertHomeState(before,homeState(f.home),true);
 // The Team update of an existing folder is admitted only on the app main-process path.
 const writer=createHost({home:f.home,keys:f.keys,allowIdentityUpgrade:true});
 try{await writer.call('projects.list',{});}finally{writer.close();await hostClosed(f.home);}
 const accepted=await openPersonalDatabase({dir:join(f.home,'pg'),baselineSql:baseline,passwords:f.vault.passwords(),readOnly:true});await accepted.stopIfStarted();
 const upgraded=await rawServer(t,f.home,f.vault),after=await logicalState(upgraded.client);
 assert.ok(after.history.length>logicalBefore.history.length);
 // The released signature and closure migrations append their boundary receipts and advance
 // the ledger head. Preserve every old receipt and all other personal rows exactly.
 const oldHead=ledgerBefore.length;
 assert.deepEqual((await upgraded.client.query('SELECT to_jsonb(l) AS row FROM app.ledger l WHERE seq<=$1 ORDER BY seq',[oldHead])).rows,ledgerBefore);
 assert.deepEqual((await upgraded.client.query('SELECT entry_type FROM app.ledger WHERE seq>$1 ORDER BY seq',[oldHead])).rows.map(r=>r.entry_type),['decision.basis_enabled','knowledge.dependencies_enabled']);
 for(const [table,hash] of Object.entries(logicalBefore.data))if(!['ops.schema_migrations','app.ledger','app.ledger_heads'].includes(table))assert.equal(after.data[table],hash,`upgrade preserves ${table}`);
});

for(const damage of ['unknown','tampered','baseline','role'])test(`a native read refuses ${damage} state without repairing it or stopping a reused server`,async t=>{
 const f=await nativeHome(t),server=await rawServer(t,f.home,f.vault);
 if(damage==='unknown')await server.client.query("INSERT INTO ops.schema_migrations(version,checksum) VALUES('synthetic-unknown-step',$1)",['0'.repeat(64)]);
 if(damage==='tampered')await server.client.query("UPDATE ops.schema_migrations SET checksum=$1 WHERE version='material-closure-hardening-v1'",['0'.repeat(64)]);
 if(damage==='baseline')await server.client.query("UPDATE ops.schema_migrations SET checksum=$1 WHERE version='baseline'",['0'.repeat(64)]);
 if(damage==='role')await server.client.query('ALTER ROLE backbone_app BYPASSRLS');
 const before=homeState(f.home),logicalBefore=await logicalState(server.client);
 const host=createHost({home:f.home,keys:f.keys,readOnly:true});
 try{await assert.rejects(host.call('projects.list',{}),PersonalReadRefusal);}
 finally{host.close();await hostClosed(f.home);}
 assert.deepEqual(await logicalState(server.client),logicalBefore);assertHomeState(before,homeState(f.home),true);
});

for(const missing of ['cluster','port','passwords','legacy'])test(`personal read-only mode refuses ${missing} metadata before starting or writing`,async t=>{
 const f=await nativeHome(t);
 if(missing==='cluster')rmSync(join(f.home,'pg','data'),{recursive:true});
 if(missing==='port')rmSync(join(f.home,'pg','cluster.json'));
 if(missing==='passwords'){const path=join(f.home,'keys','vault.json'),file=JSON.parse(readFileSync(path,'utf8'));delete file.entries.pg;writeFileSync(path,JSON.stringify(file));}
 if(missing==='legacy')writeFileSync(join(f.home,'pg','secrets.json'),JSON.stringify({...(await f.vault.passwords().read()),port:1}));
 const before=homeState(f.home);
 await assert.rejects(openPersonalDatabase({dir:join(f.home,'pg'),baselineSql:baseline,passwords:f.vault.passwords(),readOnly:true}),PersonalReadRefusal);
 assertHomeState(before,homeState(f.home));
});
test('a complete native home opens read-only with only listed PostgreSQL changes',async()=>{
 const home=freshDir('f7-complete-'),keys=plaintextKeys();
 const writer=createHost({home,keys});
 try{await writer.call('projects.list',{});}finally{writer.close();await hostClosed(home);}
 const before=homeState(home),reader=createHost({home,keys,readOnly:true});
 try{assert.deepEqual(await reader.call('projects.list',{}),[]);}
 finally{reader.close();await hostClosed(home);}
 assertHomeState(before,homeState(home),true);await removeDataHome(home);
});
