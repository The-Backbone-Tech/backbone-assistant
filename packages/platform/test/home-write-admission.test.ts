// Public initialization must refuse before local migrations, key wrapping, claims or PG startup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,sep} from 'node:path';
import {test,type TestContext} from 'node:test';
import {openPersonalDatabase} from '@backbone/core/db';
import {CoreLink,CoreCloseWaitRefusal} from '../src/composition/core.ts';
import {createHost} from '../src/composition/host.ts';
import {assertHomeWriteAdmission,HomeWriteUnavailable,withHomeLock} from '../src/composition/home-lock.ts';
import {Vault,type HomeKeys} from '../src/keys/vault.ts';
import {serveApiLine} from '../src/composition/api-line.ts';
import {serveDoors} from '../src/composition/doors.ts';
import {apiSocket} from '../src/doors/api-line.ts';
import {doorSocket} from '../src/doors/protocol.ts';
import {claimCoreHome} from '../src/composition/home-kernel.ts';

function context(t:TestContext){const home=fs.mkdtempSync(join(tmpdir(),'home-admission-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return home;}
function unsupportedStorage(t:TestContext){const real=fs.statfsSync;t.mock.method(fs,'statfsSync',((path:fs.PathLike)=>({...real(path),type:0x6969})) as typeof fs.statfsSync);}
const refusal=(code:HomeWriteUnavailable['code'])=>(error:unknown)=>error instanceof HomeWriteUnavailable&&error.code===code;

for(const readOnly of [false,true])test(`Host storage admission precedes even synchronous legacy triage migration (readOnly=${readOnly})`,t=>{
 const home=context(t),triage=JSON.stringify({items:{mail:{id:'mail',version:'one',from:[],subject:'Private original',date:'2026-11-10',done:false}},runs:[]});
 fs.writeFileSync(join(home,'triage.json'),triage);fs.chmodSync(home,0o755);const before=fs.statSync(home).mode;
 unsupportedStorage(t);
 assert.throws(()=>createHost({home,readOnly}),refusal('filesystem'));
 assert.deepEqual(fs.readdirSync(home),['triage.json']);assert.equal(fs.readFileSync(join(home,'triage.json'),'utf8'),triage);
 assert.equal(fs.statSync(home).mode,before,'even privacy changes happen only after admission');
});

test('a known unsupported keys submount refuses before the earlier Host home writes',t=>{
 const home=context(t),keys=join(home,'keys');fs.mkdirSync(keys);const real=fs.statfsSync;
 t.mock.method(fs,'statfsSync',((path:fs.PathLike)=>({...real(path),type:String(path)===keys?0x6969:real(path).type})) as typeof fs.statfsSync);
 assert.throws(()=>createHost({home}),refusal('filesystem'));
 assert.deepEqual(fs.readdirSync(home),['keys']);assert.deepEqual(fs.readdirSync(keys),[]);
});

test('Core and Vault refuse unsupported storage before a claim or any key callback',async t=>{
 const home=context(t);let keys=0;
 const holder:HomeKeys={holder:'plaintext',wrap:'none',async wrapKey(key){keys++;return key;},async unwrapKey(key){keys++;return {key,rewrap:false};}};
 unsupportedStorage(t);
 await assert.rejects(CoreLink.open({home,keys:holder}),refusal('filesystem'));
 await assert.rejects(Vault.open(home,holder),refusal('filesystem'));
 assert.equal(keys,0);assert.deepEqual(fs.readdirSync(home),[]);
});

test('owned personal PG admission precedes password cleanup, binary resolution and keeper writes',async t=>{
 const home=context(t),dir=join(home,'pg');fs.mkdirSync(dir);
 const retained='Private synthetic legacy recovery bytes';fs.writeFileSync(join(dir,'pw'),retained);let calls=0;
 unsupportedStorage(t);
 await assert.rejects(openPersonalDatabase({dir,baselineSql:'',native:join(home,'missing-native'),passwords:{async read(){calls++;return null;},async write(){calls++;}}}),refusal('filesystem'));
 assert.equal(calls,0);assert.deepEqual(fs.readdirSync(dir),['pw']);assert.equal(fs.readFileSync(join(dir,'pw'),'utf8'),retained);
});

for(const kind of ['api-line','doors'] as const)test(`${kind} checks the actual socket folder before chmod, listen or a Core callback`,async t=>{
 const home=context(t),path=kind==='api-line'?apiSocket(home):doorSocket(home),folder=dirname(path);
 assert.ok(folder.startsWith(fs.realpathSync(home)+sep),'the control owns the complete socket folder');
 fs.mkdirSync(folder,{recursive:true,mode:0o755});const before=fs.statSync(folder).mode,real=fs.statfsSync;let calls=0;
 t.mock.method(fs,'statfsSync',((path:fs.PathLike)=>({...real(path),type:String(path)===folder?0x6969:real(path).type})) as typeof fs.statfsSync);
 let server:{close():Promise<void>}|undefined;
 const open=()=>kind==='api-line'?serveApiLine({home,call:async()=>{calls++;throw Error('Unexpected API use');}}):serveDoors({home,link:async()=>{calls++;throw Error('Unexpected Core use');}});
 try{await assert.rejects(open().then(value=>{server=value;return value;}),refusal('filesystem'));}finally{await server?.close();}
 assert.equal(calls,0);assert.equal(fs.statSync(folder).mode,before);assert.deepEqual(fs.readdirSync(folder),[]);
});

test('typed pending-close refusal still wins before write admission inside the home lock',async t=>{
 const home=context(t);let done!:()=>void;
 const barrier=new Promise<void>(resolve=>{done=resolve;});
 CoreLink.closeWhenOpen(home,Promise.resolve({close:()=>barrier} as unknown as CoreLink));
 try{
  await withHomeLock(home,async()=>{
   unsupportedStorage(t);
   await assert.rejects(CoreLink.open({home}),error=>error instanceof CoreCloseWaitRefusal);
  });
 }finally{done();await CoreLink.whenClosed(home);}
});

for(const platform of ['win32','freebsd'] as const)test(`unsupported platform admission refuses without creating storage (${platform})`,t=>{
 const at=context(t),home=join(at,'unmade'),descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;
 Object.defineProperty(process,'platform',{value:platform});t.after(()=>Object.defineProperty(process,'platform',descriptor));
 assert.throws(()=>assertHomeWriteAdmission(home),refusal('platform'));assert.equal(fs.existsSync(home),false);
});

test('a legacy lock directory refuses Host before any constructor migration or privacy write',async t=>{
 const home=context(t);fs.mkdirSync(join(home,'.lock'));fs.chmodSync(home,0o755);const before=fs.statSync(home).mode;
 let created:ReturnType<typeof createHost>|undefined;
 try{assert.throws(()=>{created=createHost({home});},refusal('legacy-lock'));}finally{created?.close();if(created)await import('../src/composition/host.ts').then(module=>module.hostClosed(home));}
 assert.deepEqual(fs.readdirSync(home),['.lock']);assert.equal(fs.statSync(home).mode,before);
});

test('an unstamped working home propagates an unsafe lock refusal instead of swallowing the claim failure',async t=>{
 const home=context(t);fs.writeFileSync(join(home,'projects.json'),'[]');fs.writeFileSync(join(home,'.lock'),'',{mode:0o644});
 await assert.rejects(claimCoreHome(home),refusal('unsafe-lock'));
 assert.equal(fs.existsSync(join(home,'kernel.json')),false);assert.equal(fs.statSync(join(home,'.lock')).mode&0o777,0o644);
});

test('a stamped home with an unsafe existing lock refuses before Vault or Core startup',async t=>{
 const home=context(t);fs.writeFileSync(join(home,'kernel.json'),JSON.stringify({kernel:'core',database:'',workspace:''}));
 fs.writeFileSync(join(home,'.lock'),'',{mode:0o644});let vaults=0;
 t.mock.method(Vault,'open',async()=>{vaults++;throw Error('Unsafe admission reached Vault');});
 await assert.rejects(CoreLink.open({home}),refusal('unsafe-lock'));assert.equal(vaults,0);
 assert.equal(fs.existsSync(join(home,'pg')),false);assert.equal(fs.existsSync(join(home,'keys')),false);
});
