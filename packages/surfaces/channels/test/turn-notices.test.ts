import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHost,removeDataHome} from '@backbone-next/platform/composition';
import {freshDataHome as freshHome} from '@backbone-next/platform/testing/data-home';
import {Ledger} from '../src/index.ts';
import {hostConsumer,type ChannelHost} from '../src/host-consumer.ts';
const settings={permission:'ask',model:'stub',effort:3,mode:'chat',runsOn:'this-computer'} as const;

async function fixture(){
 const home=freshHome(),host=createHost({home}),ledger=new Ledger(home);
 const p=await host.call('projects.create',{name:'Notices',kind:'folder'});assert.ok(p.ok);
 const sent=await host.call('turns.send',{projectId:p.value.id,text:'snapshot',attachments:[],settings,clientKey:'notices'});assert.ok(sent.ok);
 let view=await host.call('threads.get',{id:sent.value.threadId});
 for(let n=0;n<500&&view.ok&&!view.value.turns[0]?.completed;n++){await new Promise(r=>setTimeout(r,10));view=await host.call('threads.get',{id:sent.value.threadId});}
 assert.ok(view.ok&&view.value.turns[0].completed);
 const snapshot=structuredClone(view.value),posts:{id:string;text:string}[]=[];
 ledger.pair('telegram','7',ledger.invite());ledger.set('conversations',[{provider:'telegram',conversation:'telegram:1',sender:'7',threadId:sent.value.threadId,direct:true,bindingVersion:ledger.bindingVersion('telegram','7')}]);
 const proxy:ChannelHost={on:fn=>host.on(fn),async call(method,args){if(method==='threads.get')return {ok:true,value:snapshot} as never;return host.call(method,args);}};
 const consumer=hostConsumer(proxy,ledger,{home,projectId:p.value.id,settings},async(id,_p,_c,text)=>{posts.push({id,text});},()=>false);
 return {home,host,ledger,projectId:p.value.id,snapshot,turn:snapshot.turns[0],posts,consumer,async close(){ledger.close();host.close();await removeDataHome(home);}};
}
for(const status of ['refused','failed'] as const)test(`${status} turn posts the Host answer reason before progress or generic diagnostics`,async()=>{
 const f=await fixture();
 try{
  f.turn.status=status==='failed'?'stopped':status;f.turn.completed=false;f.turn.answer={text:`Host ${status} reason.`,files:[]};
  f.turn.refusal={reason:'NOT_AVAILABLE',detail:'Generic refusal.'};f.turn.failure={detail:'Generic failure.'};
  f.turn.work.steps=[{kind:'read',label:'Read source.'}];await f.consumer.sync();
  assert.equal(f.posts[0].text,`Host ${status} reason.`);
  assert.ok(!f.posts.some(p=>p.text==='Generic refusal.'||p.text==='Generic failure.'));
 }finally{await f.close();}
});
test('done before completed posts no completion notice and preserves the final answer id',async()=>{
 const f=await fixture();
 try{
  f.turn.status='done';f.turn.completed=false;f.turn.answer={text:'Provisional answer.',files:[]};f.turn.work.steps=[];
  await f.consumer.sync();assert.deepEqual(f.posts,[]);
  f.turn.completed=true;f.turn.answer.text='Final answer.';await f.consumer.sync();
  assert.deepEqual(f.posts,[{id:`answer:${f.turn.id}`,text:'Final answer.'}]);
 }finally{await f.close();}
});

test('a read finishing between thread projections does not send a stale connector decision notice',async()=>{
 const f=await fixture();let reads=0,pending=true;
 try{
  f.snapshot.summary.running=true;f.turn.status='running';f.turn.completed=false;f.turn.work.steps=[];delete f.turn.answer;
  const proxy:ChannelHost={on:fn=>f.host.on(fn),async call(method,args){
   if(method==='threads.get'){
    if(++reads===2){f.snapshot.summary.running=false;pending=false;}
    return {ok:true,value:f.snapshot} as never;
   }
   if(method==='work.now'){
    const now=await f.host.call('work.now',{projectId:f.projectId});
    return {...now,needsYou:pending?[{kind:'connector-read',threadId:f.snapshot.summary.id,observationId:'finishing-read',title:'Read',detail:'Pending registration'}]:[]} as never;
   }
   return f.host.call(method,args);
  }};
  const consumer=hostConsumer(proxy,f.ledger,{home:f.home,projectId:f.projectId,settings},async(id,_p,_c,text)=>{f.posts.push({id,text});},()=>false);
  await consumer.sync();assert.equal(reads,2);assert.deepEqual(f.posts,[]);
 }finally{await f.close();}
});
