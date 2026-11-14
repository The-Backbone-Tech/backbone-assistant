import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import pg from 'pg';
import {freshHome,open,value} from './helpers.ts';
import {createHost,hostClosed} from '../src/composition/host.ts';
import {dataHomeAdminUrl} from '@backbone/core/testing';
import {serveIdentityApi} from '../src/composition/identity-http.ts';

test('a locked-out device owner cannot override another owner and a sole-owner recovery is audited',async t=>{
 const home=freshHome(),first=open(home).host;
 const owner=value(await first.call('identity.get',{})).person;
 const project=value(await first.call('projects.create',{name:'Device work',kind:'folder'}));
 const invitation=value(await first.call('identity.invite',{role:'member'}));
 const colleague=value(await first.acceptInvitation(invitation.token,'Other owner'));
 value(await first.call('identity.role',{personId:colleague.person.id,role:'owner'}));
 value(await first.callAuthenticated(colleague.session,'identity.remove',{personId:owner.id}));
 first.close();await hostClosed(home);
 const query=pg.Client.prototype.query;
 // A failed service attestation pauses this open. The operator recovery crossing
 // is separately pinned and must not depend on that failed read or on membership.
 const pause=t.mock.method(pg.Client.prototype,'query',function(this:pg.Client,text:unknown,...args:unknown[]){
  if(typeof text==='string'&&text.startsWith('SELECT version,checksum FROM app.material_guard_history'))return Promise.reject(new Error('Injected service attestation read failure'));
  return Reflect.apply(query,this,[text,...args]);
 } as never);
 const host=createHost({home});let server:Awaited<ReturnType<typeof serveIdentityApi>>|undefined;
 try{
  assert.equal((await host.deviceRecoveryStatus()).available,true);
  await assert.rejects(host.call('identity.get',{}),/paused|profile|verified/);
  await assert.rejects(host.callAuthenticated(colleague.session,'identity.restoreDeviceAccess' as never,{} as never));
  await assert.rejects(host.call('identity.restoreDeviceAccess' as never,{} as never));
  server=await serveIdentityApi({host});
  const response=await fetch(server.origin+'/api',{method:'POST',headers:{authorization:`Bearer ${colleague.session}`,'content-type':'application/json'},body:JSON.stringify({method:'identity.restoreDeviceAccess',args:{}})});
  assert.notEqual(response.status,200);
  await assert.rejects(host.restoreDeviceAccess(),/Another owner manages this workspace/);
  const admin=new pg.Client({connectionString:dataHomeAdminUrl(home)});await admin.connect();
  try{await admin.query("UPDATE app.principals SET status='removed' WHERE id=$1",[colleague.person.id]);}finally{await admin.end();}
  await host.restoreDeviceAccess();
 }finally{await server?.close();host.close();await hostClosed(home);pause.mock.restore();}
 const reopened=open(home).host;
 const view=value(await reopened.call('identity.get',{}));assert.equal(view.person.id,owner.id);assert.equal(view.recoveries?.[0]?.person,owner.id);
 await assert.rejects(reopened.restoreDeviceAccess(),/outside an access failure/);
 assert.ok((await reopened.call('projects.list',{})).some(row=>row.id===project.id));
 const db=new pg.Client({connectionString:dataHomeAdminUrl(home)});
 try{
  await db.connect();
  const audit=(await db.query("SELECT actor_id,payload FROM app.ledger WHERE entry_type='identity.device_access_restored'")).rows;
  assert.deepEqual(audit,[{actor_id:owner.id,payload:{from_status:'removed',from_role:'owner',path:'device'}}]);
  assert.equal((await db.query('SELECT status FROM app.principals WHERE id=$1',[colleague.person.id])).rows[0].status,'removed');
  const device=JSON.parse(readFileSync(join(home,'core.json'),'utf8'));
  assert.equal((await db.query('SELECT status FROM app.principals WHERE id=$1',[device.agent])).rows[0].status,'active');
  assert.ok((await db.query('SELECT 1 FROM app.mandates WHERE issuer_id=$1 AND revoked_at IS NOT NULL',[owner.id])).rowCount!>0,'previous permissions stay revoked');
 }finally{await db.end();}
});
