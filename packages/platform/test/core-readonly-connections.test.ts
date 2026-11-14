import assert from 'node:assert/strict';
import {test} from 'node:test';
import pg from 'pg';
import {CoreLink,CoreRefusal} from '../src/composition/core.ts';
import {nativeHome} from './readonly-native-fixtures.ts';

for(const readOnly of [true,false])test(`native Core sessions preserve their requested database mode (readOnly=${readOnly})`,async t=>{
 const f=await nativeHome(t),link=await CoreLink.open({home:f.home,keys:f.keys,readOnly});
 try{
  const expected=readOnly?'on':'off';
  assert.equal((await link.read(link.system(),'SHOW transaction_read_only')).rows[0].transaction_read_only,expected,'application pool');
  // The operator pool is intentionally not a product crossing. Inspect its actual server
  // session as a control, so removing either pool's setting fails this property test.
  const operator=(link as unknown as {operator:pg.Pool}).operator;
  assert.equal((await operator.query('SHOW transaction_read_only')).rows[0].transaction_read_only,expected,'operator pool');
  const bounded=await link.readBounded(link.system(),'SHOW transaction_read_only',[],new AbortController().signal);
  assert.equal(bounded.rows[0].transaction_read_only,expected,'dedicated service connection');
 }finally{await link.close();}
});

test('a read-only Core refuses write crossings before acquiring a connection or requiring a lock',async t=>{
 const f=await nativeHome(t),link=await CoreLink.open({home:f.home,keys:f.keys,readOnly:true});
 let connections=0;
 const denied=()=>{connections++;throw new Error('A read-only write crossing acquired a connection');};
 const pool=t.mock.method(pg.Pool.prototype,'connect',denied),client=t.mock.method(pg.Client.prototype,'connect',denied);
 const handle={run:'00000000-0000-4000-8000-000000000001',fence:1,secret:'synthetic-read-only-handle'};
 const signal=new AbortController().signal;
 const event={id:'synthetic-withdrawal',materialId:'synthetic-material',projectId:'synthetic-project',version:1,sequence:1,at:'2026-11-10T00:00:00Z'};
 try{
  for(const perform of [
   ()=>link.call(link.person(),'SELECT gov.create_task($1,$1,$2,NULL,NULL)',[link.id.person,'Forbidden']),
   ()=>link.createTask('Forbidden'),
   ()=>link.confirmMaterialWithdrawal(event),
   ()=>link.recordMaterialSourceRead(handle,{project:'synthetic-project',material:'synthetic-material',version:1,generation:1,readKey:'synthetic-read',originalSha256:'0'.repeat(64),transformation:{},sourceKind:'file',episodeContent:'synthetic',preparedText:'synthetic',authoredBy:null},()=>undefined,signal),
   ()=>link.admitMaterialConnectorRead(handle,handle.run,signal),
   ()=>link.claimMaterialRecovery(handle.run,null,signal),
   ()=>link.beginConnectorDispatch(handle.run,handle.run,false),
  ])await assert.rejects(perform,error=>error instanceof CoreRefusal&&error.reason==='read_only');
  assert.equal(connections,0);
 }finally{pool.mock.restore();client.mock.restore();await link.close();}
});
