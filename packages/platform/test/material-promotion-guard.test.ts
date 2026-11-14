// Disposable public Host/Core controls for the adopted temporary guard, not real-home migrations.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { CoreLink, CoreRefusal, type RunHandle } from '../src/composition/core.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { b64, freshHome, open, value } from './helpers.ts';
import { typedMaterialGateway } from './fixtures/typed-material-gateway.ts';

const WORDS = 'Synthetic promotion evidence';
async function context(t: TestContext) {
  const home = freshHome();
  const link = await CoreLink.open({ home });
  t.after(() => link.close());
  const handle = await link.startRun(await link.createTask('Synthetic promotion'));
  const proposer = link.runOf(handle);
  const candidate = (episode: string) => link.call<string>(proposer, 'SELECT gov.propose_candidate($1,$2::jsonb,$3,$4)', [
    WORDS, JSON.stringify([{ episode, excerpt: WORDS }]), link.id.agent, 'synthetic',
  ]);
  const request = (id: string) => link.call<string>(proposer, 'SELECT gov.request_promotion($1,$2,NULL,NULL)', [id, link.id.person]);
  return { home, link, handle, proposer, candidate, request };
}

async function materialRead(home:string,link:CoreLink,handle:RunHandle,words=WORDS){
  const material=new MaterialStore(home,{},()=>{});
  const entry=material.create('synthetic-project','source.txt','text/plain',Buffer.from(words),'original','person',undefined,'managed');
  const {gateway}=typedMaterialGateway({home,link,handle,material,projectId:entry.projectId,threadId:'synthetic',turnId:handle.run});
  return gateway.read({materialId:entry.id,name:entry.name,version:1,withdrawals:0,profile:'harness'});
}

const paused = (error: unknown) => error instanceof CoreRefusal && error.reason === 'paused' &&
  /source withdrawal verification/.test(error.message);

test('a material-file promotion is explicitly paused without closing or deleting its candidate', async (t) => {
  const { home, link, handle, candidate, request } = await context(t);
  const episode = (await materialRead(home,link,handle)).preparation.episode;
  const id = await candidate(episode);
  const before = (await link.read(link.person(), 'SELECT status,terms_hash,evidence FROM app.knowledge_candidates WHERE id=$1', [id])).rows;
  await assert.rejects(request(id), paused);
  assert.deepEqual((await link.read(link.person(), 'SELECT status,terms_hash,evidence FROM app.knowledge_candidates WHERE id=$1', [id])).rows, before);
  assert.equal((await link.read(link.person(), 'SELECT id FROM app.decisions WHERE subject_id=$1', [id])).rows.length, 0);
});

test('ambiguous plain file provenance cannot bypass the material guard with a different reference', async (t) => {
  const { link, candidate, request } = await context(t);
  const episode = await link.call<string>(link.system(), "SELECT gov.record_source('file',$1,$2,NULL,NULL,NULL)", ['different-reference', WORDS]);
  await assert.rejects(request(await candidate(episode)), paused);
});

test('an MCP answer is paused even when recorded through the supported typed producer', async (t) => {
  const { home, link, candidate, request } = await context(t);
  const connection = await link.call<string>(link.person(), 'SELECT gov.register_connection($1,$2,NULL,$3,$4)', ['Synthetic server', 'synthetic', 'person', 'none']);
  const handle = await link.startRun(await link.createTask('Synthetic source'));
  const material=new MaterialStore(home,{},()=>{});
  const {gateway,journal}=typedMaterialGateway({home,link,handle,material,threadId:'synthetic-mcp',turnId:handle.run});
  await gateway.connector!.prepareProtocol(false);
  const result=await gateway.connector!.readObserved({tool:{name:'lookup',serverId:'synthetic',serverName:'Synthetic server',connection:{id:connection,slug:'synthetic'},tool:'synthetic_read',description:'',inputSchema:{},kind:'read',launch:'a'.repeat(64),definition:'b'.repeat(64)},
    args:{},invocation:{engine:'codex',namespace:JSON.stringify(['synthetic-thread','synthetic-turn']),callId:'synthetic-promotion-read'},signal:new AbortController().signal,stillOffered:()=>true,perform:async()=>({observed:true,status:'complete',text:WORDS})});
  assert.equal(result.outcome,'READ');
  const confirmed=journal.read().find(event=>event.kind==='mcp.read.confirmed');
  assert.ok(confirmed&&confirmed.kind==='mcp.read.confirmed');
  const episode=confirmed.receipt.episode;
  await assert.rejects(request(await candidate(episode)), paused);
});

test('ordinary message and web evidence keep the existing promotion and person approval route', async (t) => {
  const { link, candidate, request } = await context(t);
  for (const kind of ['message', 'web']) {
    const episode = await link.call<string>(link.system(), 'SELECT gov.record_source($1,$2,$3,NULL,NULL,NULL)', [kind, 'synthetic', WORDS]);
    const id = await candidate(episode);
    const decision = await request(id);
    const row = (await link.read<{ proposal_hash: string }>(link.person(), 'SELECT proposal_hash FROM app.decisions WHERE id=$1', [decision])).rows[0];
    assert.equal(await link.call(link.person(), 'SELECT gov.answer_decision($1,$2,$3,NULL)', [decision, row.proposal_hash, 'approved']), 'approved');
    assert.equal((await link.read<{ status: string }>(link.person(), 'SELECT status FROM app.knowledge WHERE candidate_id=$1', [id])).rows[0]?.status, 'accepted');
  }
});

test('public withdrawal cannot leave a retained material episode eligible for promotion', async (t) => {
  const { home, link, candidate, request } = await context(t);
  const { host } = open(home);
  const project = value(await host.call('projects.create', { name: 'Synthetic', kind: 'folder' }));
  const entry = value(await host.call('material.attach', { projectId: project.id, name: 'source.txt', mediaType: 'text/plain', base64: b64(WORDS) }));
  const handle = await link.startRun(await link.createTask('Synthetic read'));
  const material = new MaterialStore(home, {}, () => {});
  const {gateway}=typedMaterialGateway({home,link,handle,material,threadId:'synthetic',turnId:'synthetic',projectId:project.id});
  const episode=(await gateway.read({materialId:entry.id,name:entry.name,version:1,withdrawals:0,profile:'harness'})).preparation.episode;
  value(await host.call('material.lifecycle', { id: entry.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  await assert.rejects(request(await candidate(episode)), paused);
  assert.equal((await host.call('material.read', { id: entry.id, version: 1 })).ok, true, 'the person keeps the original bytes');
});

test('a run that read material cannot evade the guard by citing only a web episode', async (t) => {
  const { home, link, request } = await context(t);
  const handle = await link.startRun(await link.createTask('Mixed source work'));
  await materialRead(home,link,handle,'Synthetic material words');
  const web = await link.call<string>(link.system(), "SELECT gov.record_source('web',$1,$2,NULL,$3,NULL)", ['synthetic', WORDS, handle.run]);
  const id = await link.call<string>(link.runOf(handle), 'SELECT gov.propose_candidate($1,$2::jsonb,$3,$4)', [WORDS, JSON.stringify([{ episode: web, excerpt: WORDS }]), link.id.agent, 'synthetic']);
  await assert.rejects(request(id), paused);
});

test('a later material read does not change the sources of a previously proposed web-only statement', async (t) => {
  const { home, link } = await context(t);
  const handle = await link.startRun(await link.createTask('Ordered source work'));
  const actor = link.runOf(handle);
  const web = await link.call<string>(link.system(), "SELECT gov.record_source('web',$1,$2,NULL,$3,NULL)", ['synthetic', WORDS, handle.run]);
  const id = await link.call<string>(actor, 'SELECT gov.propose_candidate($1,$2::jsonb,$3,$4)', [WORDS, JSON.stringify([{ episode: web, excerpt: WORDS }]), link.id.agent, 'synthetic']);
  await materialRead(home,link,handle,'Later material, not the proposed statement');
  const decision = await link.call<string>(actor, 'SELECT gov.request_promotion($1,$2,NULL,NULL)', [id, link.id.person]);
  assert.match(decision, /^[a-f0-9-]{36}$/);
});

test('an agent cannot evade run provenance by proposing outside a run and citing only web', async (t) => {
  const { home, link } = await context(t);
  const handle = await link.startRun(await link.createTask('Material read'));
  await materialRead(home,link,handle,'Earlier material');
  const actor = { workspace: link.id.workspace, principal: link.id.agent };
  const web = await link.call<string>(link.system(), "SELECT gov.record_source('web',$1,$2,NULL,NULL,NULL)", ['synthetic', WORDS]);
  const id = await link.call<string>(actor, 'SELECT gov.propose_candidate($1,$2::jsonb,$3,$4)', [WORDS, JSON.stringify([{ episode: web, excerpt: WORDS }]), link.id.agent, 'synthetic']);
  await assert.rejects(link.call(actor, 'SELECT gov.request_promotion($1,$2,NULL,NULL)', [id, link.id.person]), paused);
});
