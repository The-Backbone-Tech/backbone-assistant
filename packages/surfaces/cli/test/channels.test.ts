import { waitFor } from '../../../../scripts/lib/test-hang.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHost, hostClosed, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { channelCredentials } from '@backbone-next/platform/credentials/channels';
import { plaintextKeys } from '@backbone-next/platform/keys';
import { Ledger, readChannelConfig } from '@backbone-next/channels';
import { fakeProvider } from '../../channels/test/fake-providers.ts';
import { telegramMessage } from '../../channels/test/messages.ts';
const main=new URL('../src/main.ts',import.meta.url).pathname;
function launch(home:string,args:string[],input=''){
 const child=spawn(process.execPath,[main,...args,'--home',home],{env:{...process.env,BACKBONE_KEYS:'plaintext',BACKBONE_HARNESS:'stub'},stdio:['pipe','pipe','pipe']});
 let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.stdin.end(input);
 const done=new Promise<{code:number|null;out:string;err:string}>(r=>child.once('close',code=>r({code,out,err})));
 return {child,done,seen:()=>({out,err})};
}
async function until(ok:()=>Promise<boolean>|boolean, step:string, diagnostic:()=>string){await waitFor(ok,step,{diagnostic});}
function allFiles(dir:string):string[]{return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?allFiles(join(dir,e.name)):[join(dir,e.name)]);}
test('CLI stores stdin credentials sealed, binds and unbinds, and daemon composes the same channel service',async()=>{
 const home=freshDataHome('channels-cli'),host=createHost({home}),fake=await fakeProvider('telegram');
 let daemon:ReturnType<typeof launch>|undefined;
 const token='fake-channel-token-canary',secret='fake-channel-verification-canary';
 try{
  const project=await host.call('projects.create',{name:'CLI channels',kind:'folder'});assert.ok(project.ok);host.close();await hostClosed(home);
  for(const provider of ['slack','telegram']){
   const connected:{code:number|null;out:string;err:string}=await launch(home,['channels','connect',provider,'--model','stub','--project',project.value.id,'--port','0'],`${token}\n${secret}\n`).done;
   assert.equal(connected.code,0,connected.err);assert.ok(!connected.out.includes(token));assert.ok(!connected.err.includes(token));
   const stored=await channelCredentials(home,plaintextKeys());assert.deepEqual(await stored.resolve(provider as 'slack'|'telegram'),{token,verification:secret});
  }
  const missing=await launch(home,['channels','connect','telegram'],'only-one-line\n').done;assert.equal(missing.code,1);
  const argsToken=await launch(home,['channels','connect','telegram',token]).done;assert.equal(argsToken.code,2);assert.ok(!argsToken.err.includes(token));
  for(const path of allFiles(join(home,'credentials')))assert.ok(!readFileSync(path).includes(Buffer.from(token)),`token was not sealed: ${path}`);
  const config=readChannelConfig(home);assert.ok(config);const ledger=new Ledger(home);
  ledger.set('config',{...config,providers:['telegram'],baseUrls:{telegram:fake.url}});ledger.close();
  daemon=launch(home,['daemon','run']);
  const listener=join(home,'channels','listener.json');await until(()=>existsSync(listener),'channel listener publication',()=>JSON.stringify(daemon!.seen()));
  const {port}=JSON.parse(readFileSync(listener,'utf8')) as {port:number};
  const binding=await launch(home,['channels','bind','--json']).done;assert.equal(binding.code,0,binding.err);
  const code=JSON.parse(binding.out).code as string;
  const send=(id:number,text:string)=>fetch(`http://127.0.0.1:${port}/channels/telegram`,{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify(telegramMessage(id,text))});
  assert.equal((await send(1,code)).status,200);
  await until(()=>{const db=new Ledger(home);try{return db.bound('telegram','7');}finally{db.close();}},'channel binding',()=>JSON.stringify(daemon!.seen()));
  await send(2,'start this job');
  await until(()=>{try {return readdirSync(join(home,'threads')).some(name=>name.endsWith('.json'));}catch{return false;}},'channel thread admission',()=>JSON.stringify(daemon!.seen()));
  const unbound=await launch(home,['channels','unbind','--json']).done;assert.equal(unbound.code,0,unbound.err);assert.equal(JSON.parse(unbound.out).unbound,1);
  await send(3,'refuse this job');
  await until(()=>fake.posts().some(p=>String(p.text).includes('not bound')),'channel unbound refusal',()=>JSON.stringify(daemon!.seen()));
  const threadFiles=readdirSync(join(home,'threads')).filter(name=>name.endsWith('.json'));
  const turns=threadFiles.flatMap(name=>JSON.parse(readFileSync(join(home,'threads',name),'utf8')).turns);
  assert.deepEqual(turns.map((t:{user:{text:string}})=>t.user.text),['start this job']);
  const bad=await fetch(`http://127.0.0.1:${port}/channels/telegram`,{method:'POST',body:JSON.stringify(telegramMessage(4,'spoof'))});assert.notEqual(bad.status,200);
  daemon.child.kill('SIGTERM');const ended=await daemon.done;assert.equal(ended.code,0,ended.err);assert.ok(!existsSync(listener));
  assert.ok(!ended.out.includes(token)&&!ended.err.includes(token)&&!ended.out.includes(secret)&&!ended.err.includes(secret));
 } finally {if(daemon&&daemon.child.exitCode===null){daemon.child.kill('SIGTERM');await daemon.done;}host.close();await removeDataHome(home);await fake.close();}
});
