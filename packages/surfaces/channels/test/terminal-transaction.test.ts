import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHost,removeDataHome} from '@backbone-next/platform/composition';
import {freshDataHome as freshHome} from '@backbone-next/platform/testing/data-home';
import {Ledger,startChannels,type Inbound} from '../src/index.ts';
import {fakeProvider} from './fake-providers.ts';
const settings={permission:'ask',model:'stub',effort:3,mode:'chat',runsOn:'this-computer'} as const;

for(const reason of ['INVALID','NOT_FOUND'] as const)test(`${reason} terminal notice insertion rolls back with the refusal; committed notice and successor recover once`,async()=>{
 const prior=reason==='INVALID'?0:2;
 const home=freshHome(),host=createHost({home}),fake=await fakeProvider('telegram');
 let ledger:Ledger|undefined,observer:DatabaseSync|undefined,service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try{
  const p=await host.call('projects.create',{name:'Terminal transaction',kind:'folder'});assert.ok(p.ok);
  ledger=new Ledger(home);ledger.pair('telegram','7',ledger.invite());
  const m:Inbound={provider:'telegram',conversation:'telegram:1',sender:'7',id:'terminal-message',text:'refused input',direct:true,bindingVersion:ledger.bindingVersion('telegram','7')};
  ledger.receive(m);for(let n=0;n<prior;n++)assert.equal(ledger.refuseIntake(m,reason,'Cannot take this input.'),false);
  observer=new DatabaseSync(join(home,'channels','journal.sqlite'));
  // Fail the actual SQLite insertion, after terminal state was written in the same transaction.
  observer.exec("CREATE TRIGGER refuse_notice_insert BEFORE INSERT ON deliveries WHEN NEW.id LIKE 'intake-refused:%' BEGIN SELECT RAISE(ABORT,'synthetic notice insertion failure'); END");
  assert.throws(()=>ledger!.refuseIntake(m,reason,'Cannot take this input.'));
  const row=observer.prepare('SELECT state,refusals FROM intake WHERE external_id=?').get(m.id)!;
  assert.equal(row.state,'pending');assert.equal(row.refusals,prior);
  assert.equal(observer.prepare('SELECT count(*) AS n FROM deliveries').get()!.n,0);
  ledger.close();ledger=new Ledger(home);
  assert.equal(ledger.intakeStatus(m.provider,m.id)?.state,'pending');assert.equal(ledger.intakeStatus(m.provider,m.id)?.refusals,prior);
  observer.exec('DROP TRIGGER refuse_notice_insert');
  assert.equal(ledger.refuseIntake(m,reason,'Cannot take this input.'),true);
  assert.equal(ledger.intakeStatus(m.provider,m.id)?.refusals,prior+1);
  assert.equal(observer.prepare('SELECT state FROM intake WHERE external_id=?').get(m.id)!.state,'refused');
  assert.equal(observer.prepare('SELECT state FROM deliveries WHERE id=?').get(`intake-refused:telegram:${m.id}`)!.state,'pending');
  ledger.receive({...m,id:'successor-message',text:'successor'});ledger.close();ledger=undefined;observer.close();observer=undefined;
  // Surface restart stands in for a crash after the terminal COMMIT and before any post.
  const options={home,projectId:p.value.id,settings,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}};
  service=await startChannels(host,options);await service.idle();
  const notices=()=>fake.posts().filter(p=>p.text==='This message could not be taken: Cannot take this input.');
  assert.equal(notices().length,1);assert.equal(fake.posts()[0].text,notices()[0].text);
  const threads=await host.call('threads.list',{});assert.equal(threads.length,1);
  const view=await host.call('threads.get',{id:threads[0].id});assert.ok(view.ok);assert.deepEqual(view.value.turns.map(t=>t.user.text),['successor']);
  await service.close();service=await startChannels(host,options);await service.idle();assert.equal(notices().length,1);
  const again=await host.call('threads.get',{id:threads[0].id});assert.ok(again.ok);assert.equal(again.value.turns.length,1);
 }finally{observer?.close();ledger?.close();await service?.close();host.close();await removeDataHome(home);await fake.close();}
});
