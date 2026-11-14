// These controls exercise real PostgreSQL crossings, triggers, snapshots and durable read rows.
// They never claim crash durability from the ordinary fsync=off shared functional-test cluster.
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {enter} from '../src/db/session.ts';
import {startTestPostgres,type TestPostgres} from '../src/db/testing.ts';
import {closureFixture,TRACED_RECALL,waitForNativeBlockPids,type ClosureFixture} from './material-closure-fixture.ts';

let postgres:TestPostgres,c:ClosureFixture;
beforeAll(async()=>{postgres=await startTestPostgres();});
afterAll(async()=>{await postgres?.stop();});
beforeEach(async()=>{c=await closureFixture(postgres);});
afterEach(async()=>{await c?.close();});

async function proof(candidate:string){return (await c.admin.query('SELECT * FROM app.knowledge_candidate_inputs WHERE workspace_id=$1 AND candidate_id=$2',[c.ws,candidate])).rows[0];}
async function currentHead(){return (await c.admin.query('SELECT last_seq,last_hash FROM app.ledger_heads WHERE workspace_id=$1',[c.ws])).rows[0];}

// A typed recall is a new ABI. The old two-column crossing stays intact for warmed callers.
describe('material closure: real Native positive family and compatibility',()=>{
 it('new workspaces receive exactly one native boundary before their first candidate',async()=>{
  const boundaries=(await c.admin.query("SELECT * FROM app.ledger WHERE workspace_id=$1 AND entry_type='knowledge.dependencies_enabled'",[c.ws])).rows;
  expect(boundaries).toHaveLength(1);expect(boundaries[0].subject).toBeNull();
  expect(boundaries[0].payload).toEqual({version:'material-closure-foundation-v1'});
  const input=await c.personal(),p=await proof(input.candidate);
  expect(BigInt(p.boundary_seq)).toBe(BigInt(boundaries[0].seq));expect(BigInt(p.capture_seq)).toBeGreaterThanOrEqual(BigInt(p.boundary_seq));
 });
 it('an actual P declaration citing Q Native message captures a complete immutable cut at H and proposal H+1',async()=>{
  const input=await c.personal(),p=await proof(input.candidate);
  expect(p.proposed_by).toBe(c.p);expect(p.run_id).toBeNull();expect(p.on_behalf_of).toBe(c.p);
  expect(p.input_manifest.complete).toBe(true);expect(p.input_manifest.unknown).toEqual([]);expect(p.input_manifest.read_edges).toEqual([]);
  expect(p.input_manifest.sources).toHaveLength(1);
  expect(p.input_manifest.sources[0]).toMatchObject({episode_id:input.episode,message_id:input.message,author_id:c.q,source_kind:'message'});
  const [proposal]=(await c.admin.query("SELECT * FROM app.ledger WHERE workspace_id=$1 AND entry_type='knowledge.proposed' AND subject=$2",[c.ws,input.candidate])).rows;
  expect(BigInt(proposal.seq)).toBe(BigInt(p.capture_seq)+1n);expect(proposal.seq).toBe(p.proposal_seq);expect(proposal.prev_hash).toBe(p.capture_hash);
  expect(proposal.actor_id).toBe(c.p);expect(proposal.payload.run).toBeNull();
 });
 it.each([
  ['person','absent'],['person','empty'],['run','absent'],['run','empty'],
 ])('a %s proposal captures %s evidence without certifying it; promotion alone refuses not_verbatim',async(kind,excerptKind)=>{
  const input=await c.source('Minutes: the launch date is still open.');
  const who=kind==='run'?c.runActor(await c.run(c.p)):c.actor(c.p);
  const excerpt=excerptKind==='empty'?'':'on 3 November';
  const principal=kind==='run'?(await c.admin.query('SELECT agent_id FROM app.runs WHERE workspace_id=$1 AND id=$2',[c.ws,who.run!.id])).rows[0].agent_id:c.p;
  const candidate=await c.one<string>(who,'gov.propose_candidate($1,$2::jsonb,$3,$4)',
   ['The launch is on 3 November.',JSON.stringify([{episode:input.episode,excerpt}]),principal,'closure']);
  const p=await proof(candidate);
  expect(p.input_manifest.complete).toBe(false);
  expect(p.input_manifest.unknown).toContainEqual({kind:'citation_not_verbatim',episode_id:input.episode});
  expect(p.input_manifest.sources).toHaveLength(1);
  expect(p.input_manifest.sources[0].citations).toEqual([expect.objectContaining({ordinal:'1',verbatim:false})]);
  const [row]=(await c.admin.query('SELECT status,owner_id,valid_from,valid_to,terms_hash FROM app.knowledge_candidates WHERE workspace_id=$1 AND id=$2',[c.ws,candidate])).rows;
  expect(row).toEqual({status:'open',owner_id:null,valid_from:null,valid_to:null,terms_hash:null});
  const before=await c.snapshot();
  await expect(c.one(who,'gov.request_promotion($1,$2,NULL,NULL)',[candidate,c.owner])).rejects.toThrow(/^not_verbatim:/);
  expect(await c.snapshot()).toEqual(before);expect(await proof(candidate)).toEqual(p);
  expect((await c.admin.query('SELECT id FROM app.decisions WHERE workspace_id=$1 AND subject_id=$2',[c.ws,candidate])).rows).toEqual([]);
  expect((await c.admin.query('SELECT id FROM app.knowledge WHERE workspace_id=$1 AND candidate_id=$2',[c.ws,candidate])).rows).toEqual([]);
  const closure=await c.one<{state:string}>(c.actor(c.owner),'gov._knowledge_personal_closure_v1($1,$2)',[candidate,c.owner],c.admin);
  expect(closure.state).toBe('unknown');
 });
 it('released NULL-topic/general encoding remains valid with deferred validation advanced explicitly',async()=>{
  const input=await c.source('A null topic remains a historical supported encoding.');
  await enter(c.service,c.actor(c.p));
  try{
   const candidate=(await c.service.query('SELECT gov.propose_candidate($1,$2::jsonb,$3,NULL) AS id',[input.statement,JSON.stringify([{episode:input.episode,excerpt:input.statement}]),c.p])).rows[0].id;
   await c.service.query('SET CONSTRAINTS ALL IMMEDIATE');
   expect((await c.service.query('COMMIT')).command).toBe('COMMIT');
   const row=(await c.admin.query('SELECT topic FROM app.knowledge_candidates WHERE workspace_id=$1 AND id=$2',[c.ws,candidate])).rows[0];
   expect(row.topic).toBe('general');expect((await proof(candidate)).input_manifest.complete).toBe(true);
  }finally{await c.service.query('ROLLBACK');}
 });
 it('accepted personal Native roots produce all six typed columns and a real receiving-run dependency before COMMIT',async()=>{
  const input=await c.personal(),knowledge=await c.accept(input),r=await c.run();
  const reader=await c.connect(),observer=await c.connect('admin');
  await enter(reader,c.runActor(r));
  try{
   const result=await reader.query(TRACED_RECALL,[r.id,r.fence,[],100]);
   expect(result.rows).toHaveLength(1);const row=result.rows[0];
   expect(Object.keys(row)).toEqual(['read_id','knowledge_id','candidate_id','read_seq','statement','topic']);
   expect(row).toMatchObject({knowledge_id:knowledge,candidate_id:input.candidate,statement:input.statement,topic:'closure'});
   expect(typeof row.read_seq).toBe('string');expect(BigInt(row.read_seq)).toBeGreaterThan(0n);
   // Another backend cannot observe an uncommitted read receipt. The caller's rows stay private.
   expect((await observer.query('SELECT count(*)::integer AS n FROM app.knowledge_reads WHERE workspace_id=$1',[c.ws])).rows[0].n).toBe(0);
   expect((await reader.query('COMMIT')).command).toBe('COMMIT');
   const stored=(await observer.query('SELECT * FROM app.knowledge_reads WHERE workspace_id=$1',[c.ws])).rows;
   expect(stored).toHaveLength(1);expect(stored[0]).toMatchObject({read_id:row.read_id,receiving_run_id:r.id,receiving_person_id:c.owner,knowledge_id:knowledge,candidate_id:input.candidate,source_sensitive:false,source_elsewhere:false});
   expect(stored[0].read_seq).toBe(row.read_seq);expect(stored[0].source_snapshot.candidate_closure.state).toBe('known_personal_closure');
  }finally{await reader.query('ROLLBACK');}
 });
 it('ROLLBACK after actual recall erases every staged read and ledger effect, then a fresh call succeeds',async()=>{
  const input=await c.personal();await c.accept(input);const r=await c.run(),before=await c.snapshot();
  await enter(c.service,c.runActor(r));
  const staged=await c.service.query(TRACED_RECALL,[r.id,r.fence,[],100]);expect(staged.rows).toHaveLength(1);
  expect((await c.service.query('ROLLBACK')).command).toBe('ROLLBACK');expect(await c.snapshot()).toEqual(before);
  expect(await c.recall(r)).toHaveLength(1);
 });
 it('the original two-column prepared recall keeps its ABI and result after the new crossing is used',async()=>{
  const input=await c.personal();await c.accept(input);const r=await c.run();
  await enter(c.service,c.runActor(r));
  const old=await c.service.query({name:'closure-old-recall',text:'SELECT * FROM gov.recall_knowledge($1,$2,100)',values:[r.id,[]]});
  expect(old.fields.map(f=>f.name)).toEqual(['statement','topic']);expect((await c.service.query('COMMIT')).command).toBe('COMMIT');
  await c.recall(r);
  await enter(c.service,c.runActor(r));
  const again=await c.service.query({name:'closure-old-recall',text:'SELECT * FROM gov.recall_knowledge($1,$2,100)',values:[r.id,[]]});
  expect(again.rows).toEqual(old.rows);expect(again.fields.map(f=>f.name)).toEqual(['statement','topic']);await c.service.query('COMMIT');
 });
 it('current receiver admission survives original proposer removal without inventing an ongoing proposer policy',async()=>{
  const input=await c.personal();await c.accept(input);const r=await c.run();
  await c.admin.query("UPDATE app.principals SET status='removed' WHERE workspace_id=$1 AND id=$2",[c.ws,c.p]);
  expect(await c.recall(r)).toHaveLength(1);
 });
 it('current source audience is checked for the receiver independently of the original proposer',async()=>{
  const input=await c.personal();await c.accept(input);const r=await c.run();
  await c.admin.query("UPDATE app.tasks SET visibility='private' WHERE workspace_id=$1 AND id=$2",[c.ws,input.task]);
  expect(await c.recall(r)).toEqual([]);
 });
 it('a forged message reference is not a Native positive root and never yields typed knowledge',async()=>{
  const statement='A message-shaped source label alone is not Native evidence.';
  const episode=await c.one<string>(c.actor(c.system),"gov.record_source('message',$1,$2,$3,NULL,NULL)",[`message:${randomUUID()}`,statement,c.q]);
  const input={statement,episode,message:randomUUID(),task:await c.task(c.q)};
  const candidate=await c.propose(input);await c.accept({...input,candidate});const r=await c.run();
  expect((await proof(candidate)).input_manifest.complete).toBe(false);expect(await c.recall(r)).toEqual([]);
 });
 it('a proposing run is always UNKNOWN until every retained context family is traced, even with honest personal evidence',async()=>{
  const input=await c.source('A run cannot declare its entire context complete.'),r=await c.run(c.p);
  const candidate=await c.propose(input,c.runActor(r)),p=await proof(candidate);
  expect(p.run_id).toBe(r.id);expect(p.input_manifest.complete).toBe(false);
  expect(p.input_manifest.unknown.length).toBeGreaterThan(0);
 });
});

describe('material closure: Native admission, isolation and structural failures',()=>{
 it.each(['REPEATABLE READ','SERIALIZABLE'])('candidate BEFORE guard refuses %s before proof, proposal or candidate effects',async isolation=>{
  const input=await c.source('A stale transaction is not a current admission.'),before=await c.snapshot();
  await c.service.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  await c.service.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true)",[c.ws,c.p]);
  await expect(c.service.query('SELECT gov.propose_candidate($1,$2::jsonb,$3,$4)',[input.statement,JSON.stringify([{episode:input.episode,excerpt:input.statement}]),c.p,'closure'])).rejects.toThrow(/requires READ COMMITTED/);
  await c.service.query('ROLLBACK');expect(await c.snapshot()).toEqual(before);
 });
 it.each(['REPEATABLE READ','SERIALIZABLE'])('traced recall refuses %s before even an empty read event',async isolation=>{
  const r=await c.run(),before=await c.snapshot();await c.service.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  await c.service.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.run',$2,true),set_config('backbone.secret',$3,true)",[c.ws,r.id,r.secret]);
  await expect(c.service.query(TRACED_RECALL,[r.id,r.fence,[],100])).rejects.toThrow(/requires READ COMMITTED/);
  await c.service.query('ROLLBACK');expect(await c.snapshot()).toEqual(before);
 });
 it('an unrelated person cannot cite a System-recorded private task source',async()=>{
  const input=await c.source('System recording does not grant the recipient audience.',c.q,'private'),before=await c.snapshot();
  await expect(c.propose(input)).rejects.toThrow(/outside its receiving audience/);expect(await c.snapshot()).toEqual(before);
 });
 it('a real waiting old proposer observes audience revoked by the preceding head owner',async()=>{
  const input=await c.source('Admission uses a post-wait Native snapshot.'),holder=await c.connect('admin'),caller=await c.connect(),observer=await c.connect('admin');
  const holderPid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const callerPid=(await caller.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await enter(holder,c.actor(c.owner));await holder.query('SELECT gov._lock_workspace()');
  await enter(caller,c.actor(c.p));
  const call=caller.query('SELECT gov.propose_candidate($1,$2::jsonb,$3,$4)',[input.statement,JSON.stringify([{episode:input.episode,excerpt:input.statement}]),c.p,'closure']);
  // Attach rejection before awaiting the observation, so a native refusal cannot be unhandled.
  const outcome=call.then(value=>({value,error:undefined}),error=>({value:undefined,error}));
  try{
   await waitForNativeBlockPids(observer,callerPid,holderPid);
   await holder.query("UPDATE app.tasks SET visibility='private' WHERE workspace_id=$1 AND id=$2",[c.ws,input.task]);
   await holder.query('COMMIT');
   const settled=await outcome;expect(settled.value).toBeUndefined();expect(settled.error?.message).toMatch(/outside its receiving audience/);
   await caller.query('ROLLBACK');
   expect((await c.admin.query('SELECT count(*)::integer AS n FROM app.knowledge_candidates WHERE workspace_id=$1',[c.ws])).rows[0].n).toBe(0);
   expect((await c.admin.query('SELECT count(*)::integer AS n FROM app.knowledge_candidate_inputs WHERE workspace_id=$1',[c.ws])).rows[0].n).toBe(0);
  }finally{await holder.query('ROLLBACK');await caller.query('ROLLBACK');await outcome;}
 });
 it('ALWAYS BEFORE enforcement also handles a privileged direct INSERT under replica mode; no proposal cannot commit',async()=>{
  const input=await c.source('Direct table writes still need the actual Native H+1 proposal.'),before=await c.snapshot();
  await enter(c.admin,c.actor(c.p));await c.admin.query("SET LOCAL session_replication_role='replica'");
  const id=randomUUID();
  try{
   await c.admin.query(`INSERT INTO app.knowledge_candidates(workspace_id,id,statement,topic,evidence,proposed_by,on_behalf_of) VALUES($1,$2,$3,'closure',$4::jsonb,$5,$5)`,[c.ws,id,input.statement,JSON.stringify([{episode:input.episode,excerpt:input.statement}]),c.p]);
   const staged=(await c.admin.query('SELECT * FROM app.knowledge_candidate_inputs WHERE workspace_id=$1 AND candidate_id=$2',[c.ws,id])).rows;
   expect(staged).toHaveLength(1);
   await expect(c.admin.query('COMMIT')).rejects.toThrow(/exactly one matching proposal event/);
  }finally{await c.admin.query('ROLLBACK');}
  expect(await c.snapshot()).toEqual(before);
 });
 it('SET CONSTRAINTS IMMEDIATE before the old multi-statement crossing fails closed rather than fabricating a proposal',async()=>{
  const input=await c.source('An immediate constraint sees no completed proposal yet.'),before=await c.snapshot();
  await enter(c.service,c.actor(c.p));await c.service.query('SET CONSTRAINTS ALL IMMEDIATE');
  await expect(c.service.query('SELECT gov.propose_candidate($1,$2::jsonb,$3,$4)',[input.statement,JSON.stringify([{episode:input.episode,excerpt:input.statement}]),c.p,'closure'])).rejects.toThrow();
  await c.service.query('ROLLBACK');expect(await c.snapshot()).toEqual(before);
 });
 it('a Native H+1 cut cannot be replaced by an unrelated ledger append before the matching proposal',async()=>{
  const input=await c.source('The next real ledger event is part of the proof.'),before=await c.snapshot(),id=randomUUID();
  await enter(c.admin,c.actor(c.p));
  try{
   await c.admin.query(`INSERT INTO app.knowledge_candidates(workspace_id,id,statement,topic,evidence,proposed_by,on_behalf_of) VALUES($1,$2,$3,'closure',$4::jsonb,$5,$5)`,[c.ws,id,input.statement,JSON.stringify([{episode:input.episode,excerpt:input.statement}]),c.p]);
   await c.admin.query("SELECT gov._append('synthetic.intervening',NULL,'{}'::jsonb)");
   await c.admin.query("SELECT gov._append('knowledge.proposed',$1,jsonb_build_object('run',NULL,'topic',sec.digest('closure')))",[id]);
   await expect(c.admin.query('COMMIT')).rejects.toThrow(/immediately follow its native input cut/);
  }finally{await c.admin.query('ROLLBACK');}
  expect(await c.snapshot()).toEqual(before);
 });
 it('private proof/read tables deny service access and preserve append-only history',async()=>{
  const input=await c.personal();
  await expect(c.as(c.actor(c.p),'SELECT * FROM app.knowledge_candidate_inputs')).rejects.toThrow(/permission denied/);
  await expect(c.as(c.actor(c.p),'SELECT * FROM app.knowledge_reads')).rejects.toThrow(/permission denied/);
  await expect(c.admin.query('UPDATE app.knowledge_candidate_inputs SET input_sha256=repeat(\'0\',64) WHERE workspace_id=$1 AND candidate_id=$2',[c.ws,input.candidate])).rejects.toThrow(/never change|never.*changed|frozen/);
 });
 it('a valid empty recall records invocation without fabricating a read or context completeness',async()=>{
  const r=await c.run(),head=await currentHead();expect(await c.recall(r)).toEqual([]);
  const calls=(await c.admin.query("SELECT payload FROM app.ledger WHERE workspace_id=$1 AND seq>$2 AND entry_type='knowledge.recalled'",[c.ws,head.last_seq])).rows;
  expect(calls).toHaveLength(1);expect(calls[0].payload.reads).toEqual([]);
  expect((await c.admin.query('SELECT count(*)::integer AS n FROM app.knowledge_reads WHERE workspace_id=$1',[c.ws])).rows[0].n).toBe(0);
 });
 it('the pure material projection reads a real binding from a STABLE wrapper while another backend owns the head',async()=>{
  const material=await c.materialRead(),holder=await c.connect('admin'),reader=await c.connect('admin');
  await c.admin.query(`CREATE FUNCTION public.closure_projection_probe(uuid) RETURNS text LANGUAGE sql STABLE AS 'SELECT gov._material_source_projection($1)'`);
  await enter(holder,c.actor(c.owner));await holder.query('SELECT gov._lock_workspace()');
  await enter(reader,c.actor(c.system));await reader.query("SET LOCAL statement_timeout='1s'; SET LOCAL lock_timeout='500ms'");
  try{expect((await reader.query('SELECT public.closure_projection_probe($1::uuid) AS state',[material.episode])).rows).toEqual([{state:'live'}]);}
  finally{await reader.query('ROLLBACK');await holder.query('ROLLBACK');await c.admin.query('DROP FUNCTION public.closure_projection_probe(uuid)');}
  await material.withdraw();
  await enter(reader,c.actor(c.system));
  try{expect((await reader.query('SELECT gov._material_source_projection($1::uuid) AS state',[material.episode])).rows).toEqual([{state:'withdrawn'}]);}
  finally{await reader.query('ROLLBACK');}
 });
 it('a live typed material citation can be recorded as a candidate but promotion and typed recall stay withheld',async()=>{
  const material=await c.materialRead(),candidate=await c.propose({...material,message:randomUUID()});
  expect((await proof(candidate)).input_manifest.complete).toBe(false);
  await expect(c.one(c.actor(c.p),'gov.request_promotion($1,$2,NULL,NULL)',[candidate,c.owner])).rejects.toThrow(/paused:/);
  const r=await c.run();expect(await c.recall(r)).toEqual([]);
 });
 it('cited withdrawn material refuses creation atomically while an uncited prior withdrawn input remains an UNKNOWN dependency',async()=>{
  const r=await c.run(c.p),material=await c.materialRead(r.id);await material.withdraw();const before=await c.snapshot();
  await expect(c.propose({...material,message:randomUUID()},c.runActor(r))).rejects.toThrow(/cited material is withdrawn/);expect(await c.snapshot()).toEqual(before);
  const message=await c.source('This separate current personal source can still be proposed.');
  const candidate=await c.propose(message,c.runActor(r)),p=await proof(candidate);
  expect(p.input_manifest.complete).toBe(false);
  expect(p.input_manifest.sources.some((source:{episode_id:string;material_state_at_capture:string})=>source.episode_id===material.episode&&source.material_state_at_capture==='withdrawn')).toBe(true);
  expect(p.input_manifest.unknown.some((u:{kind:string;episode_id:string})=>u.kind==='material_not_live_at_capture'&&u.episode_id===material.episode)).toBe(true);
 });
 it('the typed crossing refuses invalid bounds, forged fence and wrong session run atomically',async()=>{
  const r=await c.run(),other=await c.run(),before=await c.snapshot();
  await expect(c.recall(r,[],0)).rejects.toThrow(/limit between 1 and 100/);
  await expect(c.recall(r,Array.from({length:65},()=>''))).rejects.toThrow(/bounded request budget/);
  await expect(c.recall(r,['x'.repeat(257)])).rejects.toThrow(/bounded request budget/);
  await expect(c.as(c.runActor(r),TRACED_RECALL,[r.id,String(BigInt(r.fence)+1n),[],100])).rejects.toThrow(/stale:/);
  await expect(c.as(c.runActor(r),TRACED_RECALL,[other.id,other.fence,[],100])).rejects.toThrow(/stale:/);
  expect(await c.snapshot()).toEqual(before);
 });
 it('charges a real oversized legacy topic to the Native input budget and returns no read or partial result',async()=>{
  const input=await c.personal('A large topic must not escape the bounded typed crossing.','x'.repeat(2097153));
  await c.accept(input);const r=await c.run(),before=await c.snapshot();
  await expect(c.recall(r,[],1)).rejects.toThrow(/traced recall input derivation budget exceeded/);
  expect(await c.snapshot()).toEqual(before);
 });
 it('records actual traced-recall plans and costs for a bounded multi-source workload, rolling every sample back',async()=>{
  for(let i=0;i<8;i++){const input=await c.personal(`Native plan sample ${i}: the observatory remains blue.`);await c.accept(input);}
  const r=await c.run(),before=await c.snapshot(),observations=[];
  for(const request of [{words:[],limit:1,expected:1},{words:['observatory'],limit:4,expected:4},{words:[],limit:100,expected:8},{words:['absent-needle'],limit:100,expected:0}]){
   await enter(c.service,c.runActor(r));
   try{
    const explained=(await c.service.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+TRACED_RECALL,[r.id,r.fence,request.words,request.limit])).rows[0]['QUERY PLAN'][0];
    expect(explained.Plan['Node Type']).toBe('Function Scan');expect(explained.Plan['Actual Rows']).toBe(request.expected);
    expect(Number.isFinite(explained['Execution Time'])).toBe(true);expect(explained['Execution Time']).toBeGreaterThanOrEqual(0);
    const reads=(await c.admin.query('SELECT count(*)::integer AS n FROM app.knowledge_reads WHERE workspace_id=$1',[c.ws])).rows[0].n;
    expect(reads).toBe(0);
    observations.push({limit:request.limit,searchWords:request.words.length,actualRows:explained.Plan['Actual Rows'],planningMs:explained['Planning Time'],executionMs:explained['Execution Time'],sharedHitBlocks:explained.Plan['Shared Hit Blocks']??0,sharedReadBlocks:explained.Plan['Shared Read Blocks']??0,plan:explained});
   }finally{await c.service.query('ROLLBACK');}
   expect(await c.snapshot()).toEqual(before);
  }
  const sourceCounts=(await c.admin.query(`SELECT
   (SELECT count(*)::integer FROM app.knowledge WHERE workspace_id=$1) AS accepted,
   (SELECT count(*)::integer FROM app.knowledge_candidate_inputs WHERE workspace_id=$1) AS proofs,
   (SELECT count(*)::integer FROM app.episodes WHERE workspace_id=$1) AS episodes,
   (SELECT count(*)::integer FROM app.ledger WHERE workspace_id=$1) AS ledger`,[c.ws])).rows[0];
  expect(sourceCounts).toMatchObject({accepted:8,proofs:8,episodes:8});
  console.info(JSON.stringify({kind:'material-closure-native-plans',sourceCounts,observations,
   declaredBudgets:{scan:5000,roots:1024,inputBytes:2097152,snapshotBytes:2097152,requestLimit:100},
   limits:'Actual full crossing under rollback on the functional shared cluster; no production latency threshold, hardware durability claim or whole-run completeness claim.'}));
 });
 it('revoking the receiving mandate refuses typed recall before another dependency is recorded',async()=>{
  const input=await c.personal();await c.accept(input);const r=await c.run();await c.one(c.actor(c.owner),'gov.revoke_mandate($1)',[r.mandate]);
  const before=await c.snapshot();await expect(c.recall(r)).rejects.toThrow(/paused:|stale:/);expect(await c.snapshot()).toEqual(before);
 });
});
