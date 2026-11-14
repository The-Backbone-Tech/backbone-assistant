// Factory failures occur before a caller can own the connection: they must close it themselves.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import pg from 'pg';
import {serviceClient} from '@backbone/core/db';
const driver=pg as unknown as {Client:new(config:unknown)=>unknown};

test('invalid native timeout limits reject before creating a service connection',async()=>{
 const original=driver.Client;let created=0;let returned:Awaited<ReturnType<typeof serviceClient>>|undefined;
 class FakeClient{constructor(){created++;}async connect(){}async query(){return {rows:[{rolsuper:false,rolbypassrls:false}]};}async end(){}}
 driver.Client=FakeClient;
 try{await assert.rejects(async()=>{returned=await serviceClient('synthetic-unused',{connectionTimeoutMillis:0});},/timeout.*positive|positive.*timeout/i);assert.equal(created,0);}
 finally{await returned?.end();driver.Client=original;}
});

for(const phase of ['connect','posture'])test(`a failed ${phase} closes the service client before propagating the failure`,async()=>{
 const original=driver.Client;let ended=0;
 class FakeClient{async connect(){if(phase==='connect')throw new Error('Synthetic connect failed');}async query(){throw new Error('Synthetic posture failed');}async end(){ended++;}}
 driver.Client=FakeClient;
 try{await assert.rejects(serviceClient('synthetic-unused',{connectionTimeoutMillis:100,query_timeout:100,statement_timeout:80,lock_timeout:50}),/Synthetic/);assert.equal(ended,1);}
 finally{driver.Client=original;}
});
