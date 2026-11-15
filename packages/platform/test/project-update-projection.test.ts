import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createIdentityHost,type IdentityHostDeps} from '../src/composition/identity-host.ts';
for(const access of ['owner','editor','viewer'] as const)for(const readOnly of [false,true])test(`${access} project mutation projection, read-only: ${readOnly}`,async()=>{
  const project={id:'project',name:'Project',kind:'folder',createdAt:'now'};
  const link={person:()=>({principal:'person'}),deviceAvailable:false,id:{person:'person'},identities:{devicePerson:'device',requireReady(){},admit:async(_token:unknown,work:(person:unknown)=>unknown)=>work({id:'person',role:'member',status:'active'})},read:async()=>({rows:[{access}]})};
  const adapter=createIdentityHost({home:'/unused',readOnly,link:async()=>link,threads:new Map(),projects:()=>[project],dispatch:async()=>[project]} as unknown as IdentityHostDeps);
  const projects=await adapter.call('fixture-session','projects.list',{});
  assert.equal(projects[0].canUpdate,access==='owner'&&!readOnly);
});
