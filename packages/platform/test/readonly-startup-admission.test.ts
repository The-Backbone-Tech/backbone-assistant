import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import pg from 'pg';
import {PersonalReadRefusal,serviceClient} from '@backbone/core/db';
import {createHost,hostClosed} from '../src/composition/host.ts';
import {CoreLink} from '../src/composition/core.ts';
import {freshHome} from './helpers.ts';

const refused=(error:unknown)=>error instanceof PersonalReadRefusal&&error.code==='connection-options';
async function complete(){
 const home=freshHome(),host=createHost({home,harness:'harness-stub'});
 try{await host.call('projects.list',{});}finally{host.close();await hostClosed(home);}
 const path=join(home,'pg','external.json');return {home,path,config:JSON.parse(readFileSync(path,'utf8'))};
}
const triggers=[['options','-c default_transaction_read_only=off\0application_name\0synthetic'],['application_name','synthetic\0default_transaction_read_only\0off']];
for(const [field,value] of triggers)for(const target of ['appUrl','operatorUrl'])test(`Core refuses ${field} packet splitting in ${target} before any connect`,async t=>{
 const f=await complete(),url=new URL(f.config[target]);url.searchParams.set(field,value);f.config[target]=url.toString();
 writeFileSync(f.path,JSON.stringify(f.config),{mode:0o600});let connects=0;
 const mock=t.mock.method(pg.Client.prototype,'connect',()=>{connects++;throw new Error('Unsafe startup reached connect');});
 try{await assert.rejects(CoreLink.open({home:f.home,readOnly:true}),refused);assert.equal(connects,0);}
 finally{mock.mock.restore();}
});

function recordClosed(t:TestContext){
 const closed:pg.Client[]=[],end=pg.Client.prototype.end;
 t.mock.method(pg.Client.prototype,'end',function(this:pg.Client,...args:Parameters<typeof end>){closed.push(this);return end.apply(this,args);});
 return closed;
}
for(const kind of ['pool','operator'] as const)test(`a new ${kind} connection is refused and closed before acquisition if its server mode is writable`,async t=>{
 const f=await complete(),link=await CoreLink.open({home:f.home,readOnly:true});
 const pool=(link as unknown as {pool:pg.Pool;operator:pg.Pool})[kind];let leaked:pg.PoolClient|undefined;
 try{
  const initial=await pool.connect();initial.release(true);
  const closed=recordClosed(t);let acquired=0;pool.on('acquire',()=>acquired++);
  // Inject after configuration validation: only the server-side check can stop this.
  pool.options.options='-c default_transaction_read_only=off';
  await assert.rejects(async()=>{leaked=await pool.connect();},refused);
  assert.equal(acquired,0,'an unverified client must never reach a pool caller');
  assert.ok(closed.some(client=>(client as unknown as {_ended:boolean})._ended),'the rejected backend connection is closed');
 }finally{leaked?.release(true);await link.close();}
});

for(const injection of ['options','packet-options','packet-name'])test(`a dedicated client changed past validation is refused and closed before return (${injection})`,async t=>{
 const f=await complete(),closed=recordClosed(t);
 type StartupClient=pg.Client&{_connecting:boolean;getStartupConf():Record<string,unknown>};
 const prototype=pg.Client.prototype as StartupClient,startup=prototype.getStartupConf;
 t.mock.method(prototype,'getStartupConf',function(this:StartupClient){
  const config=startup.call(this);
  if(this._connecting){
   if(injection==='options')config.options='-c default_transaction_read_only=off';
   if(injection==='packet-options')config.options='-c default_transaction_read_only=off\0application_name\0synthetic  -c default_transaction_read_only=on';
   if(injection==='packet-name')config.application_name='synthetic\0default_transaction_read_only\0off';
  }
  return config;
 });
 let leaked:pg.Client|undefined;
 try{
  await assert.rejects(async()=>{leaked=await serviceClient(f.config.appUrl,{readOnly:true});},refused);
  assert.ok(closed.some(client=>(client as unknown as {_ended:boolean})._ended));
 }finally{await leaked?.end();}
});

for(const kind of ['pool','operator'] as const)test(`a new ${kind} validates inherited startup controls again before connecting`,async t=>{
 const f=await complete(),link=await CoreLink.open({home:f.home,readOnly:true});
 const pool=(link as unknown as {pool:pg.Pool;operator:pg.Pool})[kind];
 const previous=process.env.PGAPPNAME;let connects=0;
 try{
  const initial=await pool.connect();initial.release(true);
  process.env.PGAPPNAME='synthetic\nunsafe';
  const mock=t.mock.method(pg.Client.prototype,'connect',()=>{connects++;throw new Error('Unsafe inherited value reached connect');});
  try{await assert.rejects(pool.connect(),refused);assert.equal(connects,0);}finally{mock.mock.restore();}
 }finally{if(previous===undefined)delete process.env.PGAPPNAME;else process.env.PGAPPNAME=previous;await link.close();}
});
