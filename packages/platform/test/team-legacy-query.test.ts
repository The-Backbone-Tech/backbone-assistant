import pg from 'pg';
import {dataHomeAdminUrl} from '@backbone/core/testing';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CoreLink} from '../src/composition/core.ts';
import {open,value} from './helpers.ts';

test('the real principal policy query allows only the sole device owner, including after a colleague is removed',async()=>{
 const {home,host}=open();
 value(await host.call('projects.create',{name:'Solo',kind:'folder'}));
 const link=await CoreLink.open({home});
 try{
  assert.equal(await link.legacyDeviceOnly(),true);
  const admin=new pg.Client({connectionString:dataHomeAdminUrl(home)});await admin.connect();
  try{
   await admin.query('CREATE POLICY synthetic_extra ON app.principals AS RESTRICTIVE FOR SELECT TO backbone_app USING(true)');
   assert.equal(await link.legacyDeviceOnly(),false,'an unknown principal policy cannot establish legacy access');
   await admin.query('DROP POLICY synthetic_extra ON app.principals');
   assert.equal(await link.legacyDeviceOnly(),true);
  }finally{await admin.end();}
  const invitation=value(await host.call('identity.invite',{role:'member'}));
  const colleague=value(await host.acceptInvitation(invitation.token,'Colleague'));
  assert.equal(await link.legacyDeviceOnly(),false);
  value(await host.call('identity.remove',{personId:colleague.person.id}));
  assert.equal(await link.legacyDeviceOnly(),true,'current sole-device facts admit work after removal revokes colleague sessions and automations');
 }finally{await link.release();}
});

test('native account admission cannot combine audience reads from opposite sides of a grant change',async()=>{
 const {home,host}=open();
 const project=value(await host.call('projects.create',{name:'Audience changes',kind:'folder'}));
 const join=async(name:string)=>{const invite=value(await host.call('identity.invite',{role:'member'}));return value(await host.acceptInvitation(invite.token,name));};
 const first=await join('First colleague'),second=await join('Second colleague');
 value(await host.call('identity.share',{projectId:project.id,personId:second.person.id,access:'viewer'}));
 const link=await CoreLink.open({home}),admin=new pg.Client({connectionString:dataHomeAdminUrl(home)});await admin.connect();
 const original=link.call.bind(link);let entered!:()=>void,release!:()=>void;
 const checkedFirst=new Promise<void>(resolve=>{entered=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
 link.call=(async(...args:Parameters<CoreLink['call']>)=>{
  const result=await original(...args);
  if(args[1]==='SELECT gov.identity_project_access($1)'&&args[0].principal===first.person.id){entered();await resume;}
  return result;
 }) as CoreLink['call'];
 try{
  const decision=link.nativeAccountToolsAllowed(project.id);await checkedFirst;
  let changed=false;
  const sharing=(async()=>{value(await host.call('identity.share',{projectId:project.id,personId:first.person.id,access:'editor'}));value(await host.call('identity.share',{projectId:project.id,personId:second.person.id,access:null}));changed=true;})();
  const {waitFor}=await import('../../../scripts/lib/test-hang.ts');
  await waitFor(async()=>changed||(await admin.query("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%gov.identity_project_share%' AND cardinality(pg_blocking_pids(pid))>0) AS blocked")).rows[0].blocked,'the grant either commits or waits behind audience admission');
  release();
  assert.equal(await decision,false,'the project had a colleague throughout the grant change');
  await sharing;
 }finally{release();link.call=original;await admin.end();await link.release();}
});
