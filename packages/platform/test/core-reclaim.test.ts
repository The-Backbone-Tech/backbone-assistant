// A local timer is not evidence that the native holder's lease has expired.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CoreLink,CoreRefusal} from '../src/composition/core.ts';
function fixture(expiries:boolean[],piece:string|null=null){
 let reads=0,claims=0,last=false;
 const fake={system:()=>({}),async read(){last=expiries[Math.min(reads++,expiries.length-1)];return {rows:[{ms:0,piece_id:piece,status:'running',lease_expired:last}]};},async claim(){claims++;assert.equal(last,true,'a local wait cannot authorize a claim while Core still reports a held lease');return {run:'original',fence:2,secret:'synthetic'};}};
 return {run:()=>CoreLink.prototype.reclaimRun.call(fake as never,'original',piece),reads:()=>reads,claims:()=>claims};
}
test('recovery re-observes native lease expiry after waiting before claiming its original run',async()=>{
 const f=fixture([false,true]);assert.equal((await f.run()).run,'original');assert.equal(f.reads(),2);assert.equal(f.claims(),1);
});
test('a lease that remains held refuses after bounded observations without any claim or replacement',async()=>{
 const f=fixture([false]);await assert.rejects(f.run(),error=>error instanceof CoreRefusal&&error.reason==='not_claimable');assert.equal(f.reads(),3);assert.equal(f.claims(),0);
});
