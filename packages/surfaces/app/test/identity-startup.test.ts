import assert from 'node:assert/strict';
import {test} from 'node:test';
import {layoutPerson} from '../src/lib/identity-startup.ts';

test('a successful identity binds retained layout to that person',async()=>{
 assert.equal(await layoutPerson(async()=>({ok:true,value:{person:{id:'person-a',name:'A',role:'member',status:'active'},people:[],deviceOwner:false}})),'person-a');
});
test('an absent or malformed identity never assigns an unidentified window legacy ownership',async()=>{
 for(const value of [null,undefined,{}, {ok:true,value:{}},{ok:false}])await assert.rejects(layoutPerson(async()=>value as never));
});
test('only the confirmed sole-device error permits the legacy surface',async()=>{
 const legacy=Object.assign(new Error('Fixed paused response'),{name:'LegacyIdentityUnavailable'});
 assert.equal(await layoutPerson(async()=>{throw legacy;}),'legacy-device');
 assert.equal(await layoutPerson(async()=>{throw new Error("Error invoking remote method 'api': LegacyIdentityUnavailable: Fixed paused response");}),'legacy-device');
 for(const name of ['IdentityUnavailable','IdentityRefused','KeysRefused']){
  const error=Object.assign(new Error('Fixed refusal'),{name});await assert.rejects(layoutPerson(async()=>{throw error;}),failure=>failure===error);
 }
 await assert.rejects(layoutPerson(async()=>{throw new Error("Provider said ': LegacyIdentityUnavailable: outside the IPC error boundary");}));
});
