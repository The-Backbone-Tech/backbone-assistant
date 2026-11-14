import assert from 'node:assert/strict';
import {test} from 'node:test';
import {writeFileSync} from 'node:fs';
import {createHost,removeDataHome} from '@backbone-next/platform/composition';
import {freshDataHome} from '@backbone-next/platform/testing/data-home';
import {startScriptedModel} from '@backbone-next/platform/testing';
import {toolWorld} from '@backbone-next/platform/testing/tools';
import {enableConnector} from '@backbone-next/platform/testing/connectors';
import {startChannels} from '../src/index.ts';
import {fakeProvider} from './fake-providers.ts';
import {telegramMessage} from './messages.ts';
import {fakeRead,hostState} from './decision-fixtures.ts';

test('a bound person discards a channel read from the chat once, with restart, foreign-chat and duplicate protection',async()=>{
 const remote=await fakeRead(),home=freshDataHome('channel-decision-chat'),world=toolWorld({seed:false}),fake=await fakeProvider('telegram');
 writeFileSync(world.files.claude,JSON.stringify({mcpServers:{notes:{type:'http',url:remote.url}}}));
 const model=await startScriptedModel('decision-chat',messages=>messages.some(m=>m.role==='tool')?{text:'Read attempt finished.'}:{calls:[{name:'mcp__notes__lookup',args:{}}]});
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 const host=createHost({home,harness:'harness-pi',connectors:{env:world.toolEnv,sources:['claude-code'],callTimeoutMs:1000}});
 const until=hostState(host,()=>JSON.stringify({calls:remote.calls(),modelRequests:model.requests.length}));
 let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try{
  const listed=await host.call('connectors.refresh',{serverId:'claude-code:notes'});assert.ok(listed.ok);assert.equal(listed.value.problem,undefined);
  assert.ok((await enableConnector(host,'claude-code:notes')).ok);assert.ok((await enableConnector(host,'claude-code:notes','lookup')).ok);
  const project=await host.call('projects.create',{name:'In-chat decision',kind:'folder'});assert.ok(project.ok);
  const options={home,projectId:project.value.id,settings:{permission:'ask',model:model.model,effort:3,mode:'chat',runsOn:'this-computer'} as const,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}};
  service=await startChannels(host,options);fake.events(r=>service!.webhook('telegram',r));service.ledger.pair('telegram','7',service.ledger.invite());
  await fake.emit(telegramMessage(1,'Read the note'));
  await until(async()=>{const threads=await host.call('threads.list',{});if(!threads.length)return false;const t=await host.call('threads.get',{id:threads[0].id});return t.ok&&t.value.turns.length===1&&t.value.turns[0].status!=='running'&&!t.value.summary.running;});
  await service.idle();
  const pending=async()=>(await host.call('work.now',{projectId:project.value.id})).needsYou.filter(n=>n.kind==='connector-read');
  assert.equal((await pending()).length,1);assert.equal(remote.calls(),1);
  const instructions=()=>fake.posts().filter(p=>String(p.text).includes('/decision '));
  assert.equal(instructions().length,1,'one actionable choice for one Needs you item');
  const code=String(instructions()[0].text).match(/\/decision ([a-f0-9]{32}) discard/)?.[1];assert.ok(code);
  await service.close();service=await startChannels(host,options);await service.idle();assert.equal(instructions().length,1);
  const foreign=telegramMessage(2,`/decision ${code} discard`);foreign.message.chat.id=2;
  await fake.emit(foreign);await service.idle();assert.equal((await pending()).length,1,'a different private chat cannot answer this choice');
  await fake.emit(telegramMessage(3,`/decision ${code} reconcile`));await service.idle();assert.equal((await pending()).length,1,'no retained result can be invented');
  await fake.emit(telegramMessage(4,`/decision ${code} discard`));await service.idle();assert.equal((await pending()).length,0);
  await fake.emit(telegramMessage(4,`/decision ${code} discard`));await fake.emit(telegramMessage(5,`/decision ${code} discard`));await service.idle();
  assert.equal(remote.calls(),1,'neither choice nor replay dispatches the read');
  const thread=(await host.call('threads.list',{}))[0],view=await host.call('threads.get',{id:thread.id});assert.ok(view.ok);assert.equal(view.value.turns.length,1,'decision commands never enter the model');
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();await remote.close();await model.close();world.remove();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});
