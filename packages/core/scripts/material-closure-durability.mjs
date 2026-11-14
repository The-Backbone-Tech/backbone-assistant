// Explicit production-settings crash proof. Run alone under the shared heavy slot:
// node packages/core/scripts/material-closure-durability.mjs [ignored-output.json]
// This owns only its new loopback cluster and temporary files. No product home is opened.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import pg from 'pg';
import {binaries,freePort,ready,guardCluster} from '@backbone-next/kernel/cluster';
import {buildBaseline} from '../src/db/baseline.ts';
import {rolePasswordSql} from '../src/db/personal.ts';
import {enter} from '../src/db/session.ts';
import {upgradeMaterialGuard} from '../src/db/material-guard.ts';
import {upgradeMaterialLink} from '../src/db/material-link.ts';
import {upgradeMaterialEnforcement} from '../src/db/material-enforcement.ts';
import {upgradeSignatureLedger,verifySignatureLedger} from '../src/db/signature-ledger.ts';
import {upgradeMaterialClosure,verifyMaterialClosure,materialClosureStep} from '../src/db/material-closure.ts';
import {upgradeMaterialClosureHardening,materialClosureHardeningStep} from '../src/db/material-closure-hardening.ts';
import {closureFixture,TRACED_RECALL} from '../test/material-closure-fixture.ts';

if(process.env.BACKBONE_TEST_PG)throw new Error('Crash qualification refuses a borrowed shared test cluster. Run this explicit runner with BACKBONE_TEST_PG unset.');
const output=process.argv[2]??'evidence/material-closure-20261110/durability.json';
const dir=mkdtempSync(join(tmpdir(),'core-closure-durability-'));
const data=join(dir,'data'),native=binaries(),port=await freePort();
const passwords={admin:randomBytes(24).toString('hex'),app:randomBytes(24).toString('hex'),operator:randomBytes(24).toString('hex')};
const url=(role,password,database)=>`postgres://${role}:${password}@127.0.0.1:${port}/${database}`;
const adminUrl=database=>url('postgres',passwords.admin,database);
let child,fixture,control,log='';
const settings={fsync:'on',synchronous_commit:'on',full_page_writes:'on'};
const counts=async(client,workspace)=>{
 const result={};
 for(const table of ['knowledge_candidates','knowledge_candidate_inputs','knowledge_reads','ledger'])
  result[table]=(await client.query(`SELECT count(*)::integer AS count FROM app.${table} WHERE workspace_id=$1`,[workspace])).rows[0].count;
 const head=(await client.query('SELECT last_seq,last_hash FROM app.ledger_heads WHERE workspace_id=$1',[workspace])).rows[0];
 return {...result,head};
};
async function connect(database){const c=new pg.Client({connectionString:adminUrl(database)});c.on('error',()=>{});await c.connect();return c;}
async function actualSettings(client){
 const result={};for(const key of Object.keys(settings))result[key]=(await client.query(`SHOW ${key}`)).rows[0][key];
 assert.deepEqual(result,settings);return result;
}
async function start(){
 log='';
 child=spawn(native.postgres,['-D',data,'-p',String(port),'-c','listen_addresses=127.0.0.1','-c','unix_socket_directories=',
  '-c','fsync=on','-c','synchronous_commit=on','-c','full_page_writes=on','-c','log_checkpoints=off',
  '-c','log_parameter_max_length=0','-c','log_parameter_max_length_on_error=0','-c','auto_explain.log_parameter_max_length=0'],
 {detached:true,stdio:['ignore','ignore','pipe']});
 child.stderr.on('data',chunk=>{log=(log+String(chunk)).slice(-16000);});
 guardCluster(child,dir);await ready(adminUrl('postgres'),child,()=>log);
}
async function killServer(){
 assert.ok(child?.pid,'Owned postmaster PID is required');
 const exited=once(child,'exit');
 // This process created a dedicated process group; kill only its own whole server group.
 process.kill(-child.pid,'SIGKILL');const [code,signal]=await exited;
 assert.equal(code,null);assert.equal(signal,'SIGKILL');
 return {method:'SIGKILL owned postmaster process group',code,signal};
}
async function stop(){
 if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGINT');await exited;}
 rmSync(dir,{recursive:true,force:true});
}
try{
 writeFileSync(join(dir,'pw'),passwords.admin,{mode:0o600});
 const initialized=spawnSync(native.initdb,['-D',data,'-U','postgres','--auth=scram-sha-256',`--pwfile=${join(dir,'pw')}`,'-E','UTF8','--locale=C'],{encoding:'utf8'});
 if(initialized.status!==0)throw new Error(`Disposable initdb failed: ${initialized.stderr}`);
 rmSync(join(dir,'pw'));await start();control=await connect('postgres');
 const beforeSettings=await actualSettings(control);
 await control.query('CREATE DATABASE closure_durable_template');
 const template=await connect('closure_durable_template');
 try{
  const baseline=buildBaseline().sql;await template.query(baseline);
  for(const install of [upgradeMaterialGuard,upgradeMaterialLink,upgradeMaterialEnforcement,upgradeSignatureLedger,upgradeMaterialClosure,upgradeMaterialClosureHardening]){
   const status=await install(template,baseline);assert.equal(status.state,'verified',status.reason);
  }
  await template.query(`${rolePasswordSql('backbone_app',passwords.app)};${rolePasswordSql('backbone_operator',passwords.operator)}`);
 }finally{await template.end();}
 const postgres={
  adminUrl,
  appUrl:database=>url('backbone_app',passwords.app,database),operatorUrl:database=>url('backbone_operator',passwords.operator,database),
  async clone(database){assert.match(database,/^closure_[a-f0-9]+$/);await control.query(`CREATE DATABASE ${database} TEMPLATE closure_durable_template`);},
  async drop(database){assert.match(database,/^closure_[a-f0-9]+$/);await control.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);},
  async stop(){},
 };
 fixture=await closureFixture(postgres);
 const claim=await fixture.personal('Native committed candidate proof survives a production-settings server crash.');
 const knowledge=await fixture.accept(claim),run=await fixture.run();
 const committed=await fixture.recall(run);assert.equal(committed.length,1);assert.equal(committed[0].knowledge_id,knowledge);
 const before=await counts(fixture.admin,fixture.ws);assert.equal(before.knowledge_candidate_inputs,1);assert.equal(before.knowledge_reads,1);
 assert.equal((await verifyMaterialClosure(fixture.service)).state,'verified');
 // These actual rows are kept private by this runner and never handed to a product consumer.
 // Neither the second read nor the subsequent candidate is committed before the server dies.
 const pending=await fixture.connect('admin');await enter(pending,fixture.runActor(run));
 const uncommitted=(await pending.query(TRACED_RECALL,[run.id,run.fence,[],100])).rows;assert.equal(uncommitted.length,1);
 const pendingCandidate=(await pending.query('SELECT gov.propose_candidate($1,$2::jsonb,$3,$4) AS id',
  ['Uncommitted candidate must not survive the crash.',JSON.stringify([{episode:claim.episode,excerpt:claim.statement}]),run.agent,'closure'])).rows[0].id;
 const staged=(await pending.query('SELECT count(*)::integer AS count FROM app.knowledge_candidate_inputs WHERE workspace_id=$1',[fixture.ws])).rows[0].count;
 assert.equal(staged,2);
 const crash=await killServer();
 await start();await control.end().catch(()=>{});control=await connect('postgres');
 const recoveryObserved=/database system was interrupted|redo starts at|redo done at/i.test(log);
 assert.equal(recoveryObserved,true,'The restarted owned server must report crash recovery');
 const restored=await fixture.connect('admin'),afterSettings=await actualSettings(restored),after=await counts(restored,fixture.ws);
 assert.deepEqual(after,before);
 assert.equal((await restored.query('SELECT count(*)::integer AS count FROM app.knowledge_reads WHERE workspace_id=$1 AND read_id=$2',[fixture.ws,uncommitted[0].read_id])).rows[0].count,0);
 assert.equal((await restored.query('SELECT count(*)::integer AS count FROM app.knowledge_candidates WHERE workspace_id=$1 AND id=$2',[fixture.ws,pendingCandidate])).rows[0].count,0);
 assert.equal((await restored.query('SELECT count(*)::integer AS count FROM app.knowledge_candidate_inputs WHERE workspace_id=$1 AND candidate_id=$2',[fixture.ws,pendingCandidate])).rows[0].count,0);
 const reader=await fixture.connect();
 const closure=await verifyMaterialClosure(reader),signature=await verifySignatureLedger(reader);
 assert.equal(closure.state,'verified');assert.equal(signature.state,'verified');
 const resumed=await fixture.recall(run,[],100,reader);assert.equal(resumed.length,1);assert.equal(resumed[0].knowledge_id,knowledge);
 const final=await counts(restored,fixture.ws);assert.equal(final.knowledge_reads,before.knowledge_reads+1);
 const report={version:1,kind:'material-closure-production-settings-crash',at:new Date().toISOString(),
  stepChecksum:materialClosureStep()?.checksum,hardeningStepChecksum:materialClosureHardeningStep()?.checksum,settingsBefore:beforeSettings,settingsAfter:afterSettings,crash,recoveryObserved,
  committedSurvived:true,uncommittedReadAbsent:true,uncommittedCandidateAndProofAbsent:true,
  before,after,postRestartRecall:{rows:resumed.length,readCount:final.knowledge_reads},closure:closure.state,signature:signature.state,
  controls:['production_settings_on_before_and_after','actual_owned_postmaster_group_crash_and_recovery',
   'committed_candidate_proof_and_read_survive','uncommitted_read_candidate_and_proof_absent',
   'committed_ledger_counts_head_and_hash_unchanged','restored_complete_closure_profile_verified',
   'restored_signature_profile_verified','fresh_post_restart_traced_recall_succeeds'].map(name=>({name,result:'PASS'})),limits:['Real local PostgreSQL process-group crash/restart; no hardware power-loss, filesystem failure or remote storage claim.',
   'Synthetic Native personal-source family only; product consumer handover and retained context coverage are separate controls.']};
 mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({result:'PASS',controls:report.controls.length,stepChecksum:report.stepChecksum,settings:settings,
  committedRowsPreserved:true,uncommittedRowsAbsent:true,recoveryObserved,report:output,sha256:createHash('sha256').update(JSON.stringify(report,null,2)+'\n').digest('hex')}));
}finally{
 await fixture?.close().catch(()=>{});await control?.end().catch(()=>{});await stop();
}
