import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {open,value} from './helpers.ts';
import {hostClosed} from '../src/composition/host.ts';
import {serveApiLine} from '../src/composition/api-line.ts';
import {attachApi} from '../src/doors/api-line.ts';

for (const removed of [false,true]) test(`company line refuses creation without a signed-in app, removed device owner: ${removed}`, async () => {
  const initial=open(), {home}=initial;
  value(await initial.host.call('projects.create',{name:'Existing project',kind:'folder'}));
  const owner=value(await initial.host.call('identity.get',{})).person;
  if(removed){
    const invitation=value(await initial.host.call('identity.invite',{role:'member'}));
    const other=value(await initial.host.acceptInvitation(invitation.token,'Other owner'));
    value(await initial.host.call('identity.role',{personId:other.person.id,role:'owner'}));
    value(await initial.host.callAuthenticated(other.session,'identity.remove',{personId:owner.id}));
  }
  initial.host.close();await hostClosed(home);
  const {host}=open(home,{identity:{company:{issuer:'https://provider.example.invalid',clientId:'fixture',redirectUri:'http://127.0.0.1/callback'}}});
  // The company composition has no renderer session on its local socket.
  const server=await serveApiLine({home,projectCreation:'signed-in-app',call:(method,args)=>host.call(method,args)});
  const client=await attachApi(home);assert.ok(client);
  try{
    const before=readFileSync(join(home,'projects.json'),'utf8');
    const denied=await client.call('projects.create',{name:'Must not exist',kind:'folder',clientKey:'company-line'});
    assert.ok(!denied.ok);assert.equal(denied.outcome,'REFUSED');
    assert.match(denied.detail,/create the project in the signed-in app/i);
    assert.equal(readFileSync(join(home,'projects.json'),'utf8'),before);
  }finally{client.close();await server.close();host.close();await hostClosed(home);}
});
