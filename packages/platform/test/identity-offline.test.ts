// Local read-only inspection is distinct from an authenticated person transport.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createIdentityHost,type IdentityHostDeps} from '../src/composition/identity-host.ts';
import {IdentityUnavailable} from '../src/composition/identity-core.ts';
import {freshDir} from './helpers.ts';
test('trusted read-only connector listing stays local while a person bearer still requires Core',async()=>{
 let queries=0,dispatches=0;
 const listing={servers:[],held:[]};
 const deps:IdentityHostDeps={home:freshDir('backbone-identity-offline-'),readOnly:true,
  link:async()=>{queries++;throw new Error('Synthetic offline Core');},projects:()=>[],threads:new Map(),summary:async thread=>thread.summary,
  material:{} as never,piece:()=>null,nativeEngine:()=>false,emit(){assert.fail('No mutation');},abort(){assert.fail('No abort');},on:()=>()=>{},
  dispatch:async()=>{dispatches++;return listing as never;}};
 const boundary=createIdentityHost(deps);
 assert.deepEqual(await boundary.call(undefined,'connectors.list',{}),listing);
 assert.equal(queries,0);assert.equal(dispatches,1);
 await assert.rejects(boundary.call('fixture-person-session','connectors.list',{}),IdentityUnavailable);
 assert.equal(queries,1);assert.equal(dispatches,1);
});
