import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serveApiLine} from '../src/composition/api-line.ts';
import {attachApi} from '../src/doors/api-line.ts';

test('the shared daemon API line invites members and guests but leaves administrator invites to the app',async()=>{
 const home=mkdtempSync(join(tmpdir(),'line-team-review-')),roles:string[]=[];
 const server=await serveApiLine({home,readOnly:true,teamManagement:true,call:async(_method,args)=>{roles.push((args as {role:string}).role);return {ok:true,value:{token:'synthetic'}} as never;}});
 const client=await attachApi(home);assert.ok(client);
 try{
  assert.equal(client.serverPid,process.pid);
  const admin=await client.call('identity.invite',{role:'admin'});assert.equal(admin.ok,false);if(!admin.ok)assert.match(admin.detail,/app/);assert.deepEqual(roles,[]);
  for(const role of ['member','guest'] as const)assert.equal((await client.call('identity.invite',{role})).ok,true);
  assert.deepEqual(roles,['member','guest']);
 }finally{client.close();await server.close();rmSync(home,{recursive:true,force:true});}
});
