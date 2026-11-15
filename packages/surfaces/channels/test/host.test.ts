import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHost, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome as freshHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel } from '@backbone-next/platform/testing';
import type { TurnSettings } from '@backbone-next/platform';
import { startChannels } from '../src/index.ts';
import { fakeProvider } from './fake-providers.ts';
import { slackMessage, telegramMessage } from './messages.ts';
const settings:TurnSettings={permission:'ask',model:'channel-script',effort:3,mode:'chat',runsOn:'this-computer'};
async function until(fn:()=>Promise<boolean>) {for(let n=0;n<500;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('condition did not become true');}
for(const provider of ['slack','telegram'] as const)test(`${provider} channel turns are ordinary threads and another surface continues with channel replies`,async()=>{
 const model=await startScriptedModel('channel-script',messages=>{const last=messages.findLastIndex(m=>m.role==='user');if(!messages.slice(last+1).some(m=>m.role==='tool'))return {calls:[{name:'list_files',args:{}}]};const content=messages[last]?.content;return {text:`Reply: ${typeof content==='string'?content:(content??[]).map(p=>p.text??'').join('')}`};});
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 const home=freshHome(),host=createHost({home,harness:'harness-pi'}),fake=await fakeProvider(provider);
 let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try {
  const p=await host.call('projects.create',{name:'Channels',kind:'folder'});assert.ok(p.ok);
  service=await startChannels(host,{home,projectId:p.value.id,settings,[provider]:provider==='slack'?{token:'fake',signingSecret:'test-signing',apiUrl:fake.url+'/api/'}:{token:'fake',secret:'test-signing',apiUrl:fake.url}});
  const active=service; fake.events(r=>active.webhook(provider,r));
  active.ledger.pair(provider,provider==='slack'?'T1:U1':'7',active.ledger.invite());
  const message=provider==='slack'?slackMessage:telegramMessage;
  await fake.emit(message(1,'first'));await fake.emit(message(1,'first'));
  await Promise.all([fake.emit(message(2,'second')),fake.emit(message(3,'third'))]);
  await until(async()=>{const t=(await host.call('threads.list',{}))[0];if(!t)return false;const view=await host.call('threads.get',{id:t.id});return view.ok&&view.value.turns.length===3&&!view.value.summary.running;});
  const threads=await host.call('threads.list',{});assert.equal(threads.length,1);
  // 'second' and 'third' are sent at the same moment, so which arrives first is not fixed. The contract's order is the
  // order in which the journal recorded them ("by arrival within a conversation"), with 'first' first because it arrived alone.
  const arrival=active.ledger.arrivals();
  assert.equal(arrival[0],'first');assert.deepEqual([...arrival].sort(),['first','second','third']);
  const view=await host.call('threads.get',{id:threads[0].id});assert.ok(view.ok);assert.deepEqual(view.value.turns.map(t=>t.user.text),arrival);
  const secondSurface={call:host.call.bind(host)};
  assert.ok((await secondSurface.call('turns.send',{projectId:p.value.id,threadId:threads[0].id,text:'from CLI',attachments:[],settings,clientKey:'second-surface'})).ok);
  await until(async()=>{const t=await host.call('threads.get',{id:threads[0].id});return t.ok&&!t.value.summary.running;});
  const final = await host.call('threads.get',{id:threads[0].id}); assert.ok(final.ok);
  assert.ok(final.value.turns.at(-1)?.answer?.text.includes('from CLI'),JSON.stringify(final.value.turns.at(-1)));
  await active.idle();
  const posts = fake.posts();
  const reply = posts.find(post=>post.text==='Reply: from CLI');
  assert.ok(reply,'second surface reply reaches the original channel');
  assert.equal(provider==='slack'?reply.channel:reply.chat_id,provider==='slack'?'D1':'1');
  assert.equal(reply.thread_ts,undefined,'DM replies do not invent a Slack thread');
  assert.ok(posts.some(post=>post.text==='Reply: first'));
  assert.ok(view.value.turns[0].work.steps.some(step=>posts.some(post=>post.text===step.label)),'Host progress is delivered to the channel');

 } finally {await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});
