import { waitFor } from '../../../../scripts/lib/test-hang.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHost, hostClosed, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { channelCredentials } from '@backbone-next/platform/credentials/channels';
import { plaintextKeys } from '@backbone-next/platform/keys';
import { attachApi } from '@backbone-next/platform/doors/api-line';
import { DAEMON_READY, observeChild } from '../../../../scripts/lib/test-child.ts';
import { Ledger } from '@backbone-next/channels';
import { fakeProvider } from '../../channels/test/fake-providers.ts';
const settings={permission:'full',model:'stub',effort:3,mode:'chat',runsOn:'this-computer'} as const;
async function until(fn:()=>Promise<boolean>,diagnostic:()=>string){await waitFor(fn,'daemon schedule after channel failure',{diagnostic});}
for(const fault of ['busy port','bad credential'] as const)test(`channel ${fault} is reported and a due schedule still runs`,async()=>{
 const home=freshDataHome('channel-start-failure'),fake=await fakeProvider('telegram'),occupied=createServer();
 await new Promise<void>(r=>occupied.listen(0,'127.0.0.1',r));const port=(occupied.address() as {port:number}).port;
 const host=createHost({home,harness:'stub',schedules:{now:()=>Date.now()-3*3_600_000}});
 let child:ReturnType<typeof spawn>|undefined,line:Awaited<ReturnType<typeof attachApi>>=null,ended:Promise<number|null>|undefined;let output='',errors='';
 try{
  const p=await host.call('projects.create',{name:'Schedules survive',kind:'folder'});assert.ok(p.ok);
  assert.ok((await host.call('schedules.create',{projectId:p.value.id,text:'Summarise the inbox',when:'every hour',settings,clientKey:'due'})).ok);
  const credentials=await channelCredentials(home,plaintextKeys());await credentials.connect('telegram','fake','test-signing');
  const db=new Ledger(home);db.set('config',{version:1,projectId:p.value.id,settings,port:fault==='busy port'?port:0,providers:['telegram'],baseUrls:{telegram:fake.url}});db.close();
  if(fault==='bad credential'){const path=join(home,'credentials','channels.json');const handles=JSON.parse(readFileSync(path,'utf8'));handles['telegram-bot']='cred_00000000-0000-0000-0000-000000000000';writeFileSync(path,JSON.stringify(handles));}
  host.close();await hostClosed(home);
  child=spawn(process.execPath,[new URL('../src/main.ts',import.meta.url).pathname,'daemon','run','--home',home],{env:{...process.env,BACKBONE_KEYS:'plaintext',BACKBONE_HARNESS:'stub'},stdio:['ignore','pipe','pipe']});
  child.stdout!.on('data',d=>output+=d);child.stderr!.on('data',d=>errors+=d);ended=new Promise(r=>child!.once('close',r));
  await observeChild(child, 'channel daemon').waitForOutput(DAEMON_READY);
  await until(async()=>{line??=await attachApi(home);if(!line)return false;const state=await line.call('schedules.get',{});return state.runs.some(run=>run.outcome==='done');},()=>`stdout:\n${output}\nstderr:\n${errors}`);
  assert.match(output,/channels: could not start; schedules and goals remain active/);assert.equal(child.exitCode,null);
  line!.close();line=null;child.kill('SIGTERM');assert.equal(await ended,0,errors);
 }finally{(line as Awaited<ReturnType<typeof attachApi>>)?.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await ended;}host.close();await removeDataHome(home);await fake.close();await new Promise<void>(r=>occupied.close(()=>r()));}
});
