import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {readAudit} from '../src/audit.ts';
import {CoreLink} from '../src/composition/core.ts';
import {createHost,hostClosed} from '../src/composition/host.ts';
import {serveApiLine} from '../src/composition/api-line.ts';
import {attachApi} from '../src/doors/api-line.ts';
import {Vault} from '../src/keys/vault.ts';
import {exportAuditHome} from '../src/composition/audit-home.ts';
import {systemKeys} from '../src/system-keys/index.ts';
import {MemoryKeyStore} from '../src/system-keys/fake.ts';
import {memoryKeychain} from '../src/testing/keys.ts';
import {collectAuditHome} from './fixtures/audit-collect.ts';
import {freshHome,freshDir,value} from './helpers.ts';
import {AUDIT_PERIOD} from './fixtures/audit-activity.ts';
const bytes=(home:string)=>readFileSync(join(home,'keys','vault.json'));
async function close(host:ReturnType<typeof createHost>,home:string){host.close();await hostClosed(home);}

test('Core and read-only Hosts leave the vault identical; only the first writable holding Host prepares the master',async()=>{
  const home=freshHome(),original=bytes(home),link=await CoreLink.open({home});
  try{assert.equal(link.vault.get('credentials.master')===null,true);assert.ok(bytes(home).equals(original));}finally{await link.close();}
  // Complete the structural fixture through its writer, then model a finished older home
  // that never prepared a credential master. The read itself must not complete first run.
  const seed=createHost({home,harness:'harness-stub'});try{await seed.call('projects.list',{});}finally{await close(seed,home);}
  writeFileSync(join(home,'keys','vault.json'),original);Vault.forget(home);
  const before=bytes(home),ro=createHost({home,readOnly:true,harness:'harness-stub'});
  let first:string;
  try{
    assert.deepEqual(await ro.call('projects.list',{}),[]);
    assert.deepEqual((await ro.call('schedules.get',{})).schedules,[]); // Both reads stay in READS.
    const inspection=await ro.call('backup.inspect',{from:freshDir('audit-inspect-')});assert.equal(inspection.ok,false);
    const server=await serveApiLine({home,call:ro.call});
    try{
      const line=await attachApi(home);assert.ok(line);
      try{
        assert.deepEqual((await line.call('schedules.get',{})).schedules,[]);
        const page=value(await line.call('audit.export',AUDIT_PERIOD));assert.ok(page.trailer);first=page.jsonl;
        assert.equal(page.header.digestKey.derivation,'legacy-service-secret');assert.ok(bytes(home).equals(before));
      }finally{line.close();}
    }finally{await server.close();}
  }finally{await close(ro,home);}
  assert.ok(bytes(home).equals(before));
  const standalone=value(await collectAuditHome(home,AUDIT_PERIOD));assert.equal(standalone.header.digestKey.derivation,'legacy-service-secret');assert.ok(bytes(home).equals(before));
  const writer=createHost({home,harness:'harness-stub'});
  try{await writer.call('projects.list',{});assert.ok((await Vault.open(home)).get('credentials.master'));}finally{await close(writer,home);}
  const prepared=bytes(home);assert.equal(prepared.equals(before),false);
  const after=value(await collectAuditHome(home,{...AUDIT_PERIOD,after:readAudit(first!).trailer.cursor!.id}));
  assert.equal(after.header.digestKey.derivation,'hkdf-master-sha256');assert.notEqual(after.header.digestKey.id,standalone.header.digestKey.id);
  readAudit(first!);readAudit(after.jsonl);
  assert.throws(()=>readAudit(after.jsonl,first!),/these files were digested under different keys .*each verifies alone/);
  const again=createHost({home,harness:'harness-stub'});try{await again.call('projects.list',{});}finally{await close(again,home);}
  assert.ok(bytes(home).equals(prepared),'reopening an already prepared writable Host never rewrites the master');
  const existing=createHost({home,readOnly:true,harness:'harness-stub'});try{await existing.call('projects.list',{});assert.deepEqual((await existing.call('schedules.get',{})).schedules,[]);}finally{await close(existing,home);}
  assert.ok(bytes(home).equals(prepared),'read-only open with an existing master is also byte-identical');
});

for(const kind of ['system','app'] as const)test(`standalone audit refuses ${kind}-held keys without accessing a store or changing the vault`,async()=>{
  const home=freshDir('audit-protected-'),store=new MemoryKeyStore();
  const keys=kind==='system'?systemKeys(home,store):{...memoryKeychain(),wrap:'electron-safeStorage'};
  await Vault.open(home,keys);
  writeFileSync(join(home,'core.json'),JSON.stringify({workspace:'00000000-0000-0000-0000-000000000001',person:'00000000-0000-0000-0000-000000000002'}));
  const before=bytes(home),reads=store.reads,writes=store.writes;
  store.usable=false;
  assert.equal(process.env.BACKBONE_SYSTEM_STORE_UNAVAILABLE,'1','shared test wrappers keep real stores denied');
  await assert.rejects(exportAuditHome(home,AUDIT_PERIOD,async()=>assert.fail('protected export must not write output'),{keys}),/Standalone audit export requires a home with plaintext keys/);
  assert.ok(bytes(home).equals(before));assert.equal(store.reads,reads);assert.equal(store.writes,writes);
});
