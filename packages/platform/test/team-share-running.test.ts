import assert from 'node:assert/strict';
import {test} from 'node:test';
import pg from 'pg';
import {dataHomeAdminUrl} from '@backbone/core/testing';
import {CoreLink} from '../src/composition/core.ts';
import {open,value} from './helpers.ts';

test('sharing refuses an active native-account turn without aborting it, then succeeds after it ends',async()=>{
 const {home,host}=open();
 const project=value(await host.call('projects.create',{name:'Running native work',kind:'folder'}));
 const invite=value(await host.call('identity.invite',{role:'member'})),colleague=value(await host.acceptInvitation(invite.token,'Colleague'));
 const db=new pg.Client({connectionString:dataHomeAdminUrl(home)});await db.connect();
 const identity=JSON.parse((await import('node:fs')).readFileSync(home+'/core.json','utf8'));
 try{
  // A different local process owns the running-turn lease. Sharing must fail
  // promptly, preserving that connection and every existing project grant.
  await db.query("SELECT pg_advisory_lock_shared(hashtextextended('native-account-turn:'||$1||':'||$2,17))",[identity.workspace,project.id]);
  await assert.rejects(host.call('identity.share',{projectId:project.id,personId:colleague.person.id,access:'editor'}),/Stop the running work in this project first\./);
  assert.deepEqual(value(await host.call('identity.sharing',{projectId:project.id})).grants,[]);
  assert.equal((await db.query('SELECT 1 AS alive')).rows[0].alive,1,'sharing did not abort running work');
  await db.query("SELECT pg_advisory_unlock_shared(hashtextextended('native-account-turn:'||$1||':'||$2,17))",[identity.workspace,project.id]);
  value(await host.call('identity.share',{projectId:project.id,personId:colleague.person.id,access:'editor'}));
 }finally{await db.end();}
});

test('native account work holds its lease until completion and rechecks sharing after taking it',async()=>{
 const {home,host}=open(),link=await CoreLink.open({home});
 try{
  const project=value(await host.call('projects.create',{name:'Lease',kind:'folder'}));
  const invite=value(await host.call('identity.invite',{role:'member'})),colleague=value(await host.acceptInvitation(invite.token,'Colleague'));
  const release=await link.nativeAccountTurn(project.id);
  try{await assert.rejects(host.call('identity.share',{projectId:project.id,personId:colleague.person.id,access:'viewer'}),/Stop the running work/);}
  finally{await release();}
  value(await host.call('identity.share',{projectId:project.id,personId:colleague.person.id,access:'viewer'}));
  const after=await link.nativeAccountTurn(project.id);
  try{assert.equal(await link.nativeAccountToolsAllowed(project.id),false);}finally{await after();}
 }finally{await link.release();}
});
