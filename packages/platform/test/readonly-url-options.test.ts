import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import pg from 'pg';
import {createHost,hostClosed} from '../src/composition/host.ts';
import {CoreLink,CoreRefusal} from '../src/composition/core.ts';
import {freshHome} from './helpers.ts';

const cases=[
 {name:'ordinary URL timeout',options:'-c statement_timeout=2000'},
 {name:'encoded URL read-write option',options:'-c default_transaction_read_only=off -c statement_timeout=2000'},
 {name:'PGOPTIONS long switches in URL',options:'--default_transaction_read_only=off --statement_timeout=2000'},
 {name:'compact switches and repeated URL options',options:'-cdefault_transaction_read_only=off -cstatement_timeout=2000',duplicate:true},
 {name:'PGOPTIONS environment',environment:'--default_transaction_read_only=off --statement_timeout=2000'},
 {name:'escaped trailing option',options:'-c statement_timeout=2000 -c default_transaction_read_only=off\\'},
];

for(const scenario of cases)test(`URL configuration cannot enable writes on read-only Core connections: ${scenario.name}`,async t=>{
 const home=freshHome(),host=createHost({home,harness:'harness-stub'});
 try{await host.call('projects.list',{});}finally{host.close();await hostClosed(home);}
 const path=join(home,'pg','external.json'),config=JSON.parse(readFileSync(path,'utf8'));
 for(const key of ['appUrl','operatorUrl']){
  const url=new URL(config[key]);
  if(scenario.duplicate)url.searchParams.append('options','-c default_transaction_read_only=off');
  if(scenario.options)url.searchParams.append('options',scenario.options);
  config[key]=url.toString();
 }
 writeFileSync(path,JSON.stringify(config),{mode:0o600});
 if(scenario.environment){
  const previous=process.env.PGOPTIONS;process.env.PGOPTIONS=scenario.environment;
  t.after(()=>{if(previous===undefined)delete process.env.PGOPTIONS;else process.env.PGOPTIONS=previous;});
 }
 const task='SELECT gov.create_task($1,$1,$2,NULL,NULL)',workspace="SELECT workspace_id FROM operator.create_workspace('Synthetic options probe','personal','Synthetic','synthetic@example.invalid')";
 const link=await CoreLink.open({home,readOnly:true});
 try{
  const operator=(link as unknown as {operator:pg.Pool}).operator;
  // These are real persistent writes through all three transport paths, not constructor spies.
  const writes=await Promise.allSettled([
   link.read(link.person(),task,[link.id.person,'Forbidden application write']),
   operator.query(workspace),
   link.readBounded(link.person(),task,[link.id.person,'Forbidden dedicated write'],new AbortController().signal),
  ]);
  for(const [index,result] of writes.entries()){
   assert.equal(result.status,'rejected',`transport ${index} permitted a persistent write`);
   if(result.status==='rejected'){
    if(index===1)assert.equal(result.reason.code,'25006');
    else{assert.ok(result.reason instanceof CoreRefusal);assert.match(result.reason.message,/read.only/i);}
   }
  }
  for(const sql of ['SHOW default_transaction_read_only','SHOW transaction_read_only']){
   const key=sql.slice(5);
   assert.equal((await link.read(link.system(),sql)).rows[0][key],'on','application pool');
   assert.equal((await operator.query(sql)).rows[0][key],'on','operator pool');
   assert.equal((await link.readBounded(link.system(),sql,[],new AbortController().signal)).rows[0][key],'on','dedicated service connection');
  }
  assert.equal((await link.read(link.system(),'SHOW statement_timeout')).rows[0].statement_timeout,'2s','allowed URL/environment settings survive');
 }finally{await link.close();}
 // Ordinary writable opening retains these supported configurations and write authority.
 const writer=await CoreLink.open({home});
 try{
  assert.equal(typeof (await writer.read(writer.person(),task,[writer.id.person,'Allowed application write'])).rows[0].create_task,'string');
  const operator=(writer as unknown as {operator:pg.Pool}).operator;
  assert.equal((await operator.query(workspace)).rowCount,1);
  assert.equal(typeof (await writer.readBounded(writer.person(),task,[writer.id.person,'Allowed dedicated write'],new AbortController().signal)).rows[0].create_task,'string');
 }finally{await writer.close();}
});
