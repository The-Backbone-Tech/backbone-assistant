import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {startTestPostgres} from '../src/db/testing.ts';
import {closureFixture} from './material-closure-fixture.ts';
it.each(['queue_run','propose_undo','propose_candidate'])('%s discloses the same refusal for absent and hidden resources',async crossing=>{
 const postgres=await startTestPostgres(),f=await closureFixture(postgres);
 try{
  const agent=await f.one<string>(f.actor(f.q),"gov.create_agent('Private worker','worker')"),task=await f.task(f.q,'private');
  const mandate=await f.one<string>(f.actor(f.q),`gov.issue_mandate($1,NULL,'"*"'::jsonb,'"*"'::jsonb,'"*"'::jsonb,'"*"'::jsonb,3::smallint,NULL,NULL,NULL,NULL,$2,'direct')`,[agent,new Date(Date.now()+3600000)]);
  const id=await f.one<string>(f.actor(f.q),'gov.queue_run($1,$2,$3)',[task,agent,mandate]);
  const claim=(await f.as({workspace:f.ws},"SELECT secret,fence FROM gov.claim_run($1,'private-worker',300000,'direct')",[id]))[0];
  const run={id,agent,task,mandate,person:f.q,secret:claim.secret as string,fence:String(claim.fence)},source=await f.source('Hidden source',f.q,'private');
  const effect=await f.one<string>(f.runActor(run),"gov.propose_effect($1,$2,NULL,'fixture','outbox.write',NULL,NULL,NULL,NULL,$3::jsonb,'Hidden',NULL,$4)",[run.id,run.fence,JSON.stringify({name:'hidden.txt',content:'private'}),randomUUID()]);
  const refusal=async(sql:string,args:unknown[])=>{try{await f.as(f.actor(f.p),sql,args);}catch(error){return(error as Error).message;}throw new Error('Expected refusal');};
  const queue='SELECT gov.queue_run($1,$2,$3)';
  if(crossing==='queue_run'){const hidden=await refusal(queue,[run.task,run.agent,run.mandate]);expect(hidden).toBe(await refusal(queue,[randomUUID(),run.agent,run.mandate]));expect(hidden).toMatch(/^not_found:/);return;}
  const undo="SELECT gov.propose_undo($1,'{}','Undo',NULL,$2)";
  if(crossing==='propose_undo'){const hidden=await refusal(undo,[effect,randomUUID()]);expect(hidden).toBe(await refusal(undo,[randomUUID(),randomUUID()]));expect(hidden).toMatch(/^not_found:/);return;}
  const candidate='SELECT gov.propose_candidate($1,$2::jsonb,$3,NULL)';
  const hidden=await refusal(candidate,['Statement',JSON.stringify([{episode:source.episode,excerpt:'Hidden source'}]),f.p]);
  const absent=await refusal(candidate,['Statement',JSON.stringify([{episode:randomUUID(),excerpt:'Hidden source'}]),f.p]);
  expect(hidden).toBe(absent);expect(hidden).toMatch(/denied:/);
 }finally{await f.close();await postgres.stop();}
});
