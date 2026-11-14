import {FakeMailbox,readSeed} from '@backbone-next/connector-mail';
import {waitFor} from '../../../scripts/lib/test-hang.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {copyFileSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,existsSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {pieceDigest,pieceFiles} from '../src/pieces/digest.ts';
import {PIECE_DIRS} from '../src/composition/pieces.ts';
import {freshDir,open,value,idle,settings} from './helpers.ts';

test('Codex launch loses native account tools while a second person has project access, then regains them',async()=>{
 const piece=freshDir('team-codex-'),record=join(freshDir('team-launch-'),'launch.jsonl');
 for(const path of pieceFiles(PIECE_DIRS['harness-codex'])){const dest=join(piece,path);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(PIECE_DIRS['harness-codex'],path),dest);}
 symlinkSync(join(PIECE_DIRS['harness-codex'],'node_modules'),join(piece,'node_modules'),'dir');
 const native=join(piece,'test/fixtures/native.mjs'),hold=join(dirname(record),'hold'),started=join(dirname(record),'started');
 writeFileSync(native,readFileSync(native,'utf8').replace("const [mode, command, ...args] = process.argv.slice(2);",`const [mode, command, ...args] = process.argv.slice(2);\nif(command==='app-server') await appendFile(${JSON.stringify(record)},JSON.stringify(args)+'\\n');`));
 writeFileSync(native,"import {existsSync} from 'node:fs';\n"+readFileSync(native,'utf8').replace("else if (method === 'turn/start') {",`else if (method === 'turn/start') { if(existsSync(${JSON.stringify(hold)})){await writeFile(${JSON.stringify(started)},'running');while(existsSync(${JSON.stringify(hold)}))await new Promise(resolve=>setTimeout(resolve,10));}`));
 copyFileSync(join(piece,'src/index.ts'),join(piece,'src/real.ts'));
 writeFileSync(join(piece,'src/index.ts'),`import {createCodexHarness as real} from './real.ts';\nexport function createCodexHarness(options={}){return real({...options,environment:'full',command:${JSON.stringify([process.execPath,native,'success'])}});}`);
 const path=join(piece,'backbone.module.json');writeFileSync(path,JSON.stringify({...JSON.parse(readFileSync(path,'utf8')),digest:pieceDigest(piece)}));
 const prior=process.env.BACKBONE_CODEX_MODEL;process.env.BACKBONE_CODEX_MODEL='test-model';
 try{
  const {host}=open(undefined,{harness:'harness-codex',pieceDirs:{'harness-codex':piece},mail:{connector:new FakeMailbox({seed:{...readSeed(),messages:readSeed().messages.slice(0,1)}})}});
  const project=value(await host.call('projects.create',{name:'Team',kind:'folder'}));
  const schedule=value(await host.call('schedules.create',{projectId:project.id,text:'Scheduled work',when:'every monday at 7',settings:{...settings,permission:'full',model:'test-model'},clientKey:'before-sharing'}));
  const invitation=value(await host.call('identity.invite',{role:'member'}));
  const colleague=value(await host.acceptInvitation(invitation.token,'Colleague'));
  for(const shared of [false,true,false]){
   value(await host.call('identity.share',{projectId:project.id,personId:colleague.person.id,access:shared?'editor':null}));
   writeFileSync(record,'');
   const sent=value(await host.call('turns.send',{projectId:project.id,text:'Work',attachments:[],clientKey:crypto.randomUUID(),settings:{...settings,permission:'full',model:'test-model'}}));
   const thread=await idle(host,sent.threadId),turn=thread.turns.at(-1)!;
   assert.equal(turn.status,'done',JSON.stringify(turn.failure??turn.answer?.text));
   let scheduledNotice=!shared;
   if(shared){
    const scheduled=value(await host.call('schedules.run',{id:schedule.id,clientKey:'after-sharing'}));let threadId:string|null=null;
    await waitFor(async()=>{threadId=(await host.call('schedules.get',{})).runs.find(run=>run.id===scheduled.id)?.threadId??null;return !!threadId;},'scheduled native turn starts');
    const scheduledThread=await idle(host,threadId!);
    scheduledNotice=scheduledThread.turns.at(-1)!.work.steps.some(step=>step.kind==='note'&&step.label==='Your Codex connectors are off in shared projects');
   }
   const launches=readFileSync(record,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as string[]);
   assert.ok(launches.length);
   for(const args of launches){assert.equal(args.includes('features.apps=false'),shared,'native apps launch setting');assert.equal(args.includes('features.plugins=false'),shared,'native plugins launch setting');}
   // The discovery process reads server names without starting a turn. Every final
   // contained client then explicitly disables those servers before thread/start.
   const sessions=launches.filter(args=>args.some(arg=>arg.startsWith('mcp_servers.')));
   if(shared){assert.ok(sessions.length>=2);for(const args of sessions)assert.ok(args.includes('mcp_servers.demo.enabled=false'));}
   else assert.equal(sessions.length,0,'private turns retain the native account policy');
   assert.equal(scheduledNotice,true);
   assert.equal(turn.work.steps.filter(step=>step.kind==='note'&&step.label==='Your Codex connectors are off in shared projects').length,shared?1:0);
  }
  writeFileSync(hold,'hold the native turn');
  const running=value(await host.call('turns.send',{projectId:project.id,text:'Keep working',attachments:[],clientKey:'native-running',settings:{...settings,permission:'full',model:'test-model'}}));
  try{
   await waitFor(()=>existsSync(started),'the native account engine reaches its running turn');
   await assert.rejects(host.call('identity.share',{projectId:project.id,personId:colleague.person.id,access:'editor'}),/Stop the running work in this project first\./);
   assert.equal(value(await host.call('threads.get',{id:running.threadId})).turns.at(-1)!.status,'running');
  }finally{rmSync(hold,{force:true});}
  assert.equal((await idle(host,running.threadId)).turns.at(-1)!.status,'done','sharing did not silently stop the native turn');
  value(await host.call('triage.connect',{}));
  const mailboxProject=host.triage!.stored.connection!.projectId;
  value(await host.call('identity.share',{projectId:mailboxProject,personId:colleague.person.id,access:'editor'}));
  writeFileSync(record,'');
  await host.triage!.run('person');
  const mailboxLaunches=readFileSync(record,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as string[]);
  assert.ok(mailboxLaunches.length,'mailbox triage started a contained engine');
  assert.ok(mailboxLaunches.every(args=>args.includes('features.apps=false')&&args.includes('features.plugins=false')),'mailbox triage cannot run native account tools in its shared project');

 }finally{if(prior===undefined)delete process.env.BACKBONE_CODEX_MODEL;else process.env.BACKBONE_CODEX_MODEL=prior;}
});
