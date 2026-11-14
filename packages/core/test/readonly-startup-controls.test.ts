import {createRequire} from 'node:module';
import pg from 'pg';
import {afterEach,expect,it,vi} from 'vitest';
import {readOnlyConnectionConfig,serviceClient,ReadOnlyClient} from '../src/db/session.ts';
import {PersonalReadRefusal,matchingPersonalServer} from '../src/db/personal-readonly.ts';

// Use the installed driver's serializer rather than a replacement packet encoder.
const {serialize}=createRequire(import.meta.resolve('pg'))('pg-protocol');
const fields=['options','application_name','fallback_application_name','user','database','replication'];
const controls=['\0','\n','\r','\t','\x1b','\x7f','\x85'];
const base='postgres://synthetic:synthetic@localhost/synthetic';
const refusal=(error:unknown)=>error instanceof PersonalReadRefusal&&error.code==='connection-options';
afterEach(()=>vi.restoreAllMocks());
afterEach(()=>vi.unstubAllEnvs());

function urlWith(field:string,value:string):string{
 const url=new URL(base);
 if(field==='database')url.pathname='/'+encodeURIComponent(value);
 else if(field==='user')url.username=value;
 else url.searchParams.set(field,value);
 // An unused fallback must also be safe if it becomes the effective name later.
 if(field==='fallback_application_name')url.searchParams.set('application_name','synthetic safe name');
 return url.toString();
}

for(const field of fields)for(const control of controls)it(`refuses startup control U+${control.charCodeAt(0).toString(16).padStart(4,'0')} in ${field}`,()=>{
 let caught:unknown;
 try{readOnlyConnectionConfig(urlWith(field,'synthetic'+control+'injected'));}catch(error){caught=error;}
 expect(refusal(caught)).toBe(true);
 expect((caught as Error).message).not.toContain('injected');
});

for(const env of ['PGOPTIONS','PGAPPNAME','PGUSER','PGDATABASE'])it(`validates inherited effective ${env} before acquisition`,()=>{
 vi.stubEnv(env,'synthetic\ninjected');
 const url=env==='PGUSER'?'postgres://localhost/synthetic':env==='PGDATABASE'?'postgres://synthetic:synthetic@localhost':base;
 expect(()=>readOnlyConnectionConfig(url)).toThrow(PersonalReadRefusal);
});

const triggers=[
 ['options','-c default_transaction_read_only=off\0application_name\0synthetic'],
 ['application_name','synthetic\0default_transaction_read_only\0off'],
];
for(const [field,value] of triggers)for(const pooled of [false,true])it(`refuses the ${field} packet split before serialization (pooled=${pooled})`,async()=>{
 let packets=0,pool:pg.Pool|undefined;
 try{
  expect(()=>{
   const config=readOnlyConnectionConfig(urlWith(field,value));
   if(pooled)pool=new pg.Pool(config);
   const client=new pg.Client(pool?.options??config) as pg.Client&{getStartupConf():Record<string,string>};
   serialize.startup(client.getStartupConf());packets++;
  }).toThrow(PersonalReadRefusal);
  expect(packets).toBe(0);
 }finally{await pool?.end();}
});

for(const [field,value] of triggers)it(`refuses ${field} packet splitting before a dedicated connect`,async()=>{
 const connect=vi.spyOn(pg.Client.prototype,'connect').mockImplementation(()=>{throw new Error('A rejected value reached connect');});
 await expect(serviceClient(urlWith(field,value),{readOnly:true})).rejects.toSatisfy(refusal);
 expect(connect).not.toHaveBeenCalled();
});

for(const [defaults,transaction] of [['off','on'],['on','off'],['on',undefined]])it(`requires both server read-only settings before return (${defaults}, ${transaction})`,async()=>{
 const client=new ReadOnlyClient(readOnlyConnectionConfig(base));
 vi.spyOn(pg.Client.prototype,'connect').mockResolvedValue(client);
 const query=vi.spyOn(client,'query').mockResolvedValueOnce({rows:[{default_transaction_read_only:defaults}]} as pg.QueryResult)
  .mockResolvedValueOnce({rows:transaction?[{transaction_read_only:transaction}]:[]} as pg.QueryResult);
 const end=vi.spyOn(client,'end').mockImplementation(async()=>{});
 await expect(client.connect()).rejects.toSatisfy(refusal);
 expect(query.mock.calls.map(call=>call[0])).toEqual(['SHOW default_transaction_read_only','SHOW transaction_read_only']);
 expect(end).toHaveBeenCalled();
});

it('preserves a server-mode refusal during the owned-server identity probe',async()=>{
 const client=new ReadOnlyClient(readOnlyConnectionConfig(base));
 vi.spyOn(pg.Client.prototype,'connect').mockResolvedValue(client);
 vi.spyOn(client,'query').mockResolvedValueOnce({rows:[{default_transaction_read_only:'off'}]} as pg.QueryResult)
  .mockResolvedValueOnce({rows:[{transaction_read_only:'on'}]} as pg.QueryResult);
 const end=vi.spyOn(client,'end').mockImplementation(async()=>{});
 await expect(matchingPersonalServer(base,'synthetic-unused-data',client)).rejects.toSatisfy(refusal);
 expect(end).toHaveBeenCalled();
});
