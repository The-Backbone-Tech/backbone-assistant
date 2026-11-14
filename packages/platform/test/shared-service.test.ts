import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { METHODS } from '../src/api.ts';
import { createHost, hostClosed, removeDataHome } from '../src/composition/host.ts';
import { freshDataHome } from '../src/testing/data-home.ts';
import { makeJoinLink, parseJoinLink, RemoteClient, RemoteError } from '../src/remote/client.ts';
import { remoteWorkspace } from '../src/remote/workspace.ts';
import { plaintextKeys } from '../src/keys/vault.ts';
import { findInHome } from '../src/testing/keys.ts';
import { value, idle, settings } from './helpers.ts';
import { waitFor } from '../../../scripts/lib/test-hang.ts';
import { restrictedMethodArgs, memberMethods } from './shared-service-authority-fixture.ts';

const main = new URL('../../surfaces/cli/src/main.ts', import.meta.url).pathname;
function cli(home: string, args: string[], script?:string) {
  const child = spawn(process.execPath, [main, '--home', home, ...args], {
    env: { ...process.env, BACKBONE_KEYS:'plaintext', BACKBONE_HARNESS:script?'scripted':'stub', ...(script?{BACKBONE_SCRIPT_DIR:script}:{}) }, stdio:['ignore','pipe','pipe'] });
  let out='', err=''; child.stdout.on('data', b=>out+=b); child.stderr.on('data', b=>err+=b);
  const done = once(child, 'close').then(([code]) => ({ code, out, err }));
  return { child, done, output:()=>out+err };
}
test('a colleague joins a TLS daemon from a second process and completes shared work with live revocation', async () => {
  const home=freshDataHome('shared-service'), clientHome=mkdtempSync(join(tmpdir(),'shared-colleague-'));
  const host=createHost({home,harness:'harness-stub'});
  const shared=value(await host.call('projects.create',{name:'Shared work',kind:'folder'}));
  value(await host.call('projects.create',{name:'Owner private',kind:'folder'}));
  const seed=value(await host.call('turns.send',{projectId:shared.id,text:'Hello team',settings,attachments:[],clientKey:randomUUID()}));
  await idle(host,seed.threadId); host.close(); await hostClosed(home);
  const script=mkdtempSync(join(tmpdir(),'shared-script-'));mkdirSync(join(script,'plans'));
  writeFileSync(join(script,'plans',createHash('sha256').update('A colleague says hello').digest('hex')+'.json'),JSON.stringify({answer:'The scripted team answer.'}));
  const address=Object.values(networkInterfaces()).flat().find(i=>i?.family==='IPv4'&&!i.internal)?.address??'127.0.0.1';
  const daemon=cli(home,['daemon','run','--share',`${address}:0`],script);
  const command=async(h:string,args:string[],ok=true)=>{const result=await cli(h,args).done;if(ok)assert.equal(result.code,0,result.err);else assert.notEqual(result.code,0);return result;};
  try {
    await waitFor(()=>daemon.output().includes('daemon: serving')||daemon.child.exitCode!==null,'shared daemon is ready');
    assert.equal(daemon.child.exitCode,null,daemon.output());
    const status=JSON.parse((await command(home,['daemon','status','--json'])).out);
    assert.ok(status.shared.fingerprint);
    const origin=`https://${address}:${new URL(status.shared.origin).port}`;
    const invitation=JSON.parse((await command(home,['team','invite','--json'])).out);
    const link=makeJoinLink({...parseJoinLink(invitation.link),origin});
    await command(clientHome,['join',link,'--name','Remote colleague']);
    const workspace=await remoteWorkspace(clientHome,plaintextKeys()), client=await workspace.client();
    const me=value(await client.call('identity.get',{}));
    await command(home,['team','share',shared.id,'--person',me.person.id,'--access','editor']);
    assert.deepEqual(JSON.parse((await command(clientHome,['remote','projects','--json'])).out).map((p:{id:string})=>p.id),[shared.id]);
    assert.match((await command(clientHome,['remote','read',seed.threadId])).out,/Hello team/);
    const sent=await command(clientHome,['remote','send','A colleague says hello','--project',shared.id]);
    assert.match(sent.out,/The scripted team answer/);
    const threads=await client.call('threads.list',{}), own=threads.find(t=>t.id!==seed.threadId)!;
    const read=value(await client.call('threads.get',{id:own.id})); assert.ok(read.turns.at(-1)?.answer?.text);
    const disk=JSON.parse(readFileSync(join(home,'threads',own.id+'.json'),'utf8')); assert.equal(disk.personId,me.person.id);
    assert.deepEqual(findInHome(clientHome,[(client as unknown as {session:string}).session]),[],'bearer is never stored in a plain file');
    // Use a working member first; a project viewer, independently of workspace role, cannot send.
    await command(home,['team','share',shared.id,'--person',me.person.id,'--access','viewer']);
    const viewer=await command(clientHome,['remote','send','Viewer tries','--project',shared.id],false);
    assert.match(viewer.err,/viewer.*cannot send/i);
    await assert.rejects(new RemoteClient({origin,fingerprint:'00'.repeat(32)}).request('/identity/accept',{invitation:parseJoinLink(link).invitation,name:'Wrong pin'}),/certificate.*match/i);
    await assert.rejects(fetch(origin.replace('https:','http:')+'/api'));
    const reused=await command(clientHome,['join',link,'--name','Reuse'],false); assert.match(reused.err,/refused|invitation|Access ended/i);
    await command(home,['team','share',shared.id,'--person',me.person.id,'--access','editor']);
    // Device controls are explicitly enumerated across every exported Method. Missing session never reaches Host.
    const allowed=new Set<string>(memberMethods);
    const restricted=restrictedMethodArgs(shared.id,own.id,read.turns.at(-1)!.id,me.person.id,clientHome);
    const anonymous=new RemoteClient({origin,fingerprint:status.shared.fingerprint});
    for(const method of METHODS){
      const args=restricted[method as keyof typeof restricted]??{};
      await assert.rejects(anonymous.request('/api',{method,args}),error=>{
        assert.ok(error instanceof RemoteError,method);
        assert.equal(error.status,401,method);
        assert.equal(error.outcome,'REFUSED',method);
        assert.match(error.message,/Access ended|workspace session is required/,method);
        return true;
      });
      if(!allowed.has(method)) await assert.rejects(client.call(method,args),error=>{
        assert.ok(error instanceof RemoteError,method);
        assert.equal(error.status,403,method);
        assert.equal(error.outcome,'REFUSED',method);
        assert.equal(error.accessEnded,false,method);
        assert.match(error.message,/not permitted for this workspace or project|request was refused.*project permissions/,method);
        return true;
      });
    }
    const waitForEnd=async(action:()=>Promise<unknown>)=>{
      const abort=new AbortController(), stream=client.events(abort.signal)[Symbol.asyncIterator]();
      const pending=stream.next();
      try{
        await new Promise(r=>setTimeout(r,150));await action();
        let ended=false;for(let n=0;n<4;n++){const event=await(n===0?pending:stream.next());if(event.value?.urgent?.includes('Access ended')){ended=true;break;}if(event.done)break;}
        assert.equal(ended,true);assert.equal((await stream.next()).done,true);
      }finally{abort.abort();}
    };
    await waitForEnd(()=>command(home,['team','share',shared.id,'--person',me.person.id,'--access','none']));
    await command(clientHome,['remote','read',seed.threadId],false);
    await command(home,['team','share',shared.id,'--person',me.person.id,'--access','viewer']);
    await waitForEnd(()=>command(home,['team','remove',me.person.id]));
    const removed=await command(clientHome,['remote','projects'],false); assert.match(removed.err,/Access ended.*invitation/i);
  } finally {
    daemon.child.kill('SIGTERM'); await daemon.done;
    await removeDataHome(home); rmSync(clientHome,{recursive:true,force:true});rmSync(script,{recursive:true,force:true});
  }
});
