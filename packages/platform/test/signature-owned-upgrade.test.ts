// Real owned clusters: never substitute the shared external template for the owned-open hook.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import pg from 'pg';
import {buildBaseline,upgradeMaterialGuard,upgradeMaterialLink,upgradeMaterialEnforcement,verifySignatureLedger} from '@backbone/core/db';
import {dataHomeAdminUrl} from '@backbone/core/testing';
import {CoreLink} from '../src/composition/core.ts';
import {removeDataHome} from '../src/composition/host.ts';
import {ConnectorService,type ConnectorCore} from '../src/connectors/service.ts';
import {plaintextKeys} from '../src/keys/vault.ts';
import {defaultToolEnv} from '../src/tools/places.ts';
import {freshDir,value} from './helpers.ts';
// C1 and its hardening are ordered, append-only steps; owned open must record every one.
const identityVersions=['identity-v1','identity-work-v1','identity-role-revocation-v1','identity-resource-guard-v1','identity-admission-closure-v1','identity-guarantees-v1','identity-platform-v1','identity-role-closure-v1','identity-piece-admission-v1','identity-lookup-closure-v1','identity-invitation-closure-v1','identity-device-recovery-v1','identity-device-lockout-v1','identity-device-subject-v1','identity-native-turn-v1','identity-device-current-v1'];
const legacy=JSON.parse(readFileSync(new URL('./fixtures/material-guard-legacy.json',import.meta.url),'utf8')).sqlLines.join('\n')+'\n';
const baseline=buildBaseline().sql,prerequisites=[upgradeMaterialGuard,upgradeMaterialLink,upgradeMaterialEnforcement];
const versions=['material-source-guard-v1','material-source-link-v1','material-source-enforcement-v1'];
for(const prefix of [0,1,2,3])test(`owned open upgrades released baseline plus ${prefix} steps, then records standing and person releases`,async t=>{
 const home=mkdtempSync(join(tmpdir(),'signature-owned-'));
 let link:CoreLink|undefined,admin:pg.Client|undefined,service:ConnectorService|undefined;
 t.after(async()=>{await service?.close();await admin?.end();await link?.close();await removeDataHome(home);});
 // The frozen baseline cannot admit any later step's SQL. This first open creates a real
 // owned home at the released shape; only the chosen released prefix is then installed.
 link=await CoreLink.open({home,keys:plaintextKeys(),baselineSql:legacy});
 assert.equal(link.materialGuard.state,'paused');
 const passwords=await link.vault.passwords().read();assert.ok(passwords);
 admin=new pg.Client({connectionString:dataHomeAdminUrl(home,passwords)});await admin.connect();
 for(const install of prerequisites.slice(0,prefix)){
  const status=await install(admin,baseline);assert.equal(status.state,'verified',status.reason);
 }
 assert.deepEqual((await admin.query('SELECT version FROM ops.schema_migrations ORDER BY applied_at,version')).rows.map(r=>r.version),['baseline',...versions.slice(0,prefix)]);
 assert.equal((await verifySignatureLedger(admin)).state,'paused');
 assert.equal((await admin.query("SELECT to_regprocedure('gov.give_connector_signature(uuid,text,text)') IS NULL AS absent")).rows[0].absent,true);
 await admin.end();admin=undefined;await link.close();link=undefined;
 // The app-admitted owned open, without an explicit signature installer, performs the upgrade.
 link=await CoreLink.open({home,allowIdentityUpgrade:true});
 assert.equal(link.identityStatus.state,'verified',link.identityStatus.reason);
 admin=new pg.Client({connectionString:dataHomeAdminUrl(home,passwords)});await admin.connect();
 const status=await verifySignatureLedger(admin);assert.equal(status.state,'verified',status.reason);
 for(const material of [link.materialGuard,link.materialLink,link.materialEnforcement])assert.equal(material.state,'verified',material.reason);
 assert.deepEqual((await admin.query('SELECT version FROM ops.schema_migrations ORDER BY applied_at,version')).rows.map(r=>r.version),['baseline',...versions,'connector-signature-ledger-v1','material-closure-foundation-v1','material-closure-hardening-v1',...identityVersions]);
 const person=freshDir('signature-owned-person-'),log=join(person,'calls.jsonl');
 writeFileSync(join(person,'.claude.json'),JSON.stringify({mcpServers:{notes:{command:process.execPath,args:[join(import.meta.dirname,'fake-mcp-server.ts')],env:{FAKE_MCP_LOG:log}}}}));
 const owned=link;
 service=new ConnectorService({home,env:()=>defaultToolEnv({HOME:person,PATH:process.env.PATH}),link:async()=>owned});
 const server='claude-code:notes';
 value(await service.refresh(server));value(await service.set(server,{enabled:true}));
 for(const name of ['draft_note','plain'])value(await service.set(server,{tool:{name,enabled:true}}));
 value(await service.set(server,{egress:true,seal:service.doorSeal(server)!}));
 const shown=service.toolView(server,'draft_note')!;
 value(await service.set(server,{seal:shown.seal,tool:{name:'draft_note',standing:{stamp:shown.stamp}}}));
 const signature=JSON.parse(readFileSync(join(home,'connectors','mcp.json'),'utf8')).servers[server].tools.draft_note.standing.id;
 const core={readObserved:async()=>{throw Error('An effect entered the read port');}} as unknown as ConnectorCore;
 let n=0;
 const call=(name:string,args:Record<string,unknown>)=>service!.call(service!.offered().find(t=>t.tool===name)!,args,core,{threadId:'synthetic',turnId:`owned-${++n}`,seq:n},new AbortController().signal);
 assert.equal((await call('draft_note',{text:'signed after upgrade'})).outcome,'SENT');
 assert.equal((await call('plain',{x:'person after upgrade'})).outcome,'HELD');
 const held=service.list().held.find(h=>h.state==='waiting')!;
 assert.equal(value(await service.decide(held.effect,held.argsHash,'release')).state,'sent');
 const answers=(await link.read<{subject:string;basis:unknown}>(link.person(),"SELECT subject,payload->'basis' AS basis FROM app.ledger WHERE entry_type='decision.answered' ORDER BY seq")).rows;
 assert.deepEqual(answers.map(r=>r.basis),[{method:'standing_signature',signature},{method:'person'}]);
 for(const answer of answers)assert.deepEqual(await link.call(link.person(),'SELECT gov.decision_answer_basis($1)',[answer.subject]),answer.basis);
 assert.equal(readFileSync(log,'utf8').trim().split('\n').length,2,'one send under each basis');
 assert.equal(await link.call(link.person(),'SELECT gov.verify_ledger()'),null);
});
