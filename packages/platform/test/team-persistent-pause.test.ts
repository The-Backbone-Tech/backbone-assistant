import assert from 'node:assert/strict';
import {test} from 'node:test';
import pg from 'pg';
import {dataHomeAdminUrl} from '@backbone/core/testing';
import {open,value,idle,settings,freshDir} from './helpers.ts';
import {createHost,hostClosed} from '../src/composition/host.ts';
import {CoreLink} from '../src/composition/core.ts';
import {join} from 'node:path';

test('a persistent identity pause on a once-shared folder still lets its sole device owner read and save work',async()=>{
 const {home,host}=open();
 const project=value(await host.call('projects.create',{name:'My own work',kind:'folder'}));
 const sent=value(await host.call('turns.send',{projectId:project.id,text:'Write a brief',attachments:[],clientKey:'brief',settings}));await idle(host,sent.threadId);
 const doc=(await host.call('material.list',{projectId:project.id}))[0];assert.ok(doc);
 const invite=value(await host.call('identity.invite',{role:'member'})),colleague=value(await host.acceptInvitation(invite.token,'Former colleague'));
 value(await host.call('identity.share',{projectId:project.id,personId:colleague.person.id,access:'editor'}));
 const automation=value(await host.call('identity.automation.create',{personId:colleague.person.id,projectId:project.id,name:'Former colleague automation'}));
 value(await host.call('identity.remove',{personId:colleague.person.id}));
 host.close();await hostClosed(home);
 const db=new pg.Client({connectionString:dataHomeAdminUrl(home)});await db.connect();
 try{await db.query('GRANT EXECUTE ON FUNCTION gov.identity_invite(text,text,timestamptz) TO backbone_operator');}finally{await db.end();}
 for(let count=0;count<2;count++){
  const reopened=createHost({home}),link=await CoreLink.open({home});
  try{
   assert.equal(link.identityStatus.state,'paused','the real catalogue mismatch persists across reopen');
   assert.ok((await reopened.call('projects.list',{})).some(row=>row.id===project.id));
   if(count===0){
    const probe=new pg.Client({connectionString:dataHomeAdminUrl(home)});await probe.connect();
    try{
     await probe.query("UPDATE app.identity_sessions SET revoked_at=NULL,expires_at=clock_timestamp()+interval '1 hour' WHERE principal_id=$1",[colleague.person.id]);
     assert.equal(await link.legacyDeviceOnly(),false,'a live colleague session forbids the sole-device path');
     await probe.query('UPDATE app.identity_sessions SET revoked_at=clock_timestamp() WHERE principal_id=$1',[colleague.person.id]);
     await probe.query("UPDATE app.principals SET status='active' WHERE id=$1",[automation.id]);
     await probe.query("INSERT INTO app.mandates(workspace_id,issuer_id,subject_id,on_behalf_of_id,ceiling,expires_at,intent,carrier) SELECT workspace_id,issuer_id,subject_id,on_behalf_of_id,ceiling,clock_timestamp()+interval '1 hour',intent,'direct' FROM app.mandates WHERE subject_id=$1 LIMIT 1",[automation.id]);
     assert.equal(await link.legacyDeviceOnly(),false,'a live automation for another person forbids the sole-device path');
     await probe.query('UPDATE app.mandates SET revoked_at=clock_timestamp() WHERE subject_id=$1 AND revoked_at IS NULL',[automation.id]);
     assert.equal(await link.legacyDeviceOnly(),true);
    }finally{await probe.end();}
   }
   const current=value(await reopened.call('material.read',{id:doc.id}));
   value(await reopened.call('material.save',{id:doc.id,baseVersion:current.entry.current,text:`Saved during persistent pause ${count}`}));
   assert.equal(value(await reopened.call('material.read',{id:doc.id})).text,`Saved during persistent pause ${count}`);
   assert.equal(link.identityStatus.state,'paused','ordinary work does not clear the pause');
  }finally{await link.release();reopened.close();await hostClosed(home);}
 }
});

test('a still-shared paused folder explains the pause and its device owner can export work',async()=>{
 const {home,host}=open();value(await host.call('projects.create',{name:'Safe work',kind:'folder'}));
 const invite=value(await host.call('identity.invite',{role:'member'}));value(await host.acceptInvitation(invite.token,'Active colleague'));
 host.close();await hostClosed(home);
 const db=new pg.Client({connectionString:dataHomeAdminUrl(home)});await db.connect();
 try{await db.query('GRANT EXECUTE ON FUNCTION gov.identity_invite(text,text,timestamptz) TO backbone_operator');}finally{await db.end();}
 const reopened=createHost({home});
 try{
  await assert.rejects(reopened.call('projects.list',{}),{message:'Team features are paused on this Mac. Your work is safe; export it from Settings › Backup.'});
  const exported=value(await reopened.call('backup.export',{to:join(freshDir('paused-export-'),'copy')}));assert.ok(exported.counts.projects);
 }finally{reopened.close();await hostClosed(home);}
});
