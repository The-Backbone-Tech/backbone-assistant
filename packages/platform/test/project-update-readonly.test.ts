import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createIdentityHost,type IdentityHostDeps} from '../src/composition/identity-host.ts';

test('an owning read-only caller receives the storage refusal rather than a false ownership refusal',async()=>{
  let dispatched=false;
  const person={id:'owner',role:'owner',status:'active'};
  const link={person:()=>({principal:'owner'}),deviceAvailable:false,id:{person:'owner'},identities:{devicePerson:'owner',requireReady(){},admit:async(_token:unknown,work:(person:unknown)=>unknown)=>work(person)},legacyDeviceCall:async()=>({legacy:false}),read:async()=>({rows:[{access:'owner'}]})};
  const adapter=createIdentityHost({home:'/unused',readOnly:true,link:async()=>link,threads:new Map(),projects:()=>[{id:'project',name:'Project',kind:'folder',createdAt:'now'}],dispatch:async()=>{dispatched=true;return {ok:false,reason:'NOT_AVAILABLE',outcome:'REFUSED',detail:'This data folder was opened read-only.'};}} as unknown as IdentityHostDeps);
  const result=await adapter.call(undefined,'projects.update',{id:'project',patch:{name:'Name'}});
  assert.ok(!result.ok);assert.equal(result.outcome,'REFUSED');assert.match(result.detail,/read-only/);assert.equal(dispatched,true);
});

test('a missing or malformed project id is refused before reaching Core or storage',async()=>{
  let inspected=false;
  const link={person:()=>({principal:'owner'}),deviceAvailable:false,id:{person:'owner'},identities:{devicePerson:'owner',requireReady(){},admit:async(_token:unknown,work:(person:unknown)=>unknown)=>work({id:'owner',role:'owner'})},legacyDeviceCall:async()=>({legacy:false}),read:async()=>{inspected=true;throw new Error('An invalid id reached Core');}};
  const adapter=createIdentityHost({home:'/unused',readOnly:false,link:async()=>link,threads:new Map(),projects:()=>[],dispatch:async()=>assert.fail('storage dispatch')} as unknown as IdentityHostDeps);
  const result=await adapter.call(undefined,'projects.update',{id:'not-a-project-id',patch:{name:'Name'}});
  assert.ok(!result.ok);assert.equal(result.reason,'NOT_FOUND');assert.equal(result.outcome,'REFUSED');assert.equal(inspected,false);
});

test('a project request stays bound to the id and patch authorized before an async wait',async()=>{
  let entered!:()=>void,release!:()=>void,dispatched:unknown;
  const entering=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  const link={person:()=>({principal:'owner'}),deviceAvailable:false,id:{person:'owner'},identities:{devicePerson:'owner',requireReady(){},admit:async(_token:unknown,work:(person:unknown)=>unknown)=>work({id:'owner',role:'owner'})},legacyDeviceCall:async()=>({legacy:false}),read:async(_person:unknown,_sql:string,params:string[])=>{assert.equal(params[0],'owned');entered();await held;return {rows:[{access:'owner'}]};}};
  const adapter=createIdentityHost({home:'/unused',readOnly:false,link:async()=>link,threads:new Map(),projects:()=>['owned','other'].map(id=>({id,name:id,kind:'folder',createdAt:'now'})),dispatch:async(_method:unknown,args:unknown)=>{dispatched=args;return {ok:true,value:{id:'owned'}};}} as unknown as IdentityHostDeps);
  const args={id:'owned',patch:{name:'Requested name'}};
  const operation=adapter.call(undefined,'projects.update',args);await entering;
  args.id='other';args.patch.name='Changed while waiting';release();await operation;
  assert.deepEqual(dispatched,{id:'owned',patch:{name:'Requested name'}});
});

 test('an invisible project and an absent project return the same refusal',async()=>{
  const link={person:()=>({principal:'member'}),deviceAvailable:false,id:{person:'member'},identities:{devicePerson:'owner',requireReady(){},admit:async(_token:unknown,work:(person:unknown)=>unknown)=>work({id:'member',role:'member'})},legacyDeviceCall:async()=>({legacy:false}),read:async()=>({rows:[{access:null}]})};
  const adapter=createIdentityHost({home:'/unused',readOnly:false,link:async()=>link,threads:new Map(),projects:()=>[{id:'private',name:'Private',kind:'folder',createdAt:'now'}],dispatch:async()=>assert.fail('storage dispatch')} as unknown as IdentityHostDeps);
  const request=(id:string)=>adapter.call('session','projects.update',{id,patch:{name:'Name'}});
  assert.deepEqual(await request('private'),await request('missing'));
 });
