import {describe,it,expect,vi} from 'vitest';
import {buildBaseline} from '../src/db/baseline.ts';
import {materialGuardStep} from '../src/db/material-guard.ts';
import {materialLinkStep} from '../src/db/material-link.ts';
import {materialEnforcementStep,upgradeMaterialEnforcement,verifyMaterialEnforcement} from '../src/db/material-enforcement.ts';
vi.mock('../src/db/material-link.ts',async(importOriginal)=>({...await importOriginal<typeof import('../src/db/material-link.ts')>(),verifyMaterialLink:vi.fn(async()=>({state:'verified',reason:'Mock prerequisite only; not native evidence.'}))}));
import {CORE_SCHEMA_UPGRADES,baselineObject} from '../src/db/schema-migrations.ts';

describe('material enforcement executable source admission (no database)',()=>{
 it('keeps the IF comparison CASE parenthesized so inner THEN is not a PL/pgSQL IF terminator',()=>{
  const source=baselineObject(buildBaseline().sql,'gov/_material_source_state.sql')!;
  expect(source).toContain("e.trust IS DISTINCT FROM (CASE WHEN b.authored_by IS NULL THEN 'untrusted' ELSE 'trusted' END)");
  expect(source).not.toContain('e.trust IS DISTINCT FROM CASE WHEN');
 });
 it('refuses the previously unparenthesized body even if the rest of the baseline is unchanged',()=>{
  const baseline=buildBaseline().sql;
  const changed=baseline.replace("e.trust IS DISTINCT FROM (CASE WHEN b.authored_by IS NULL THEN 'untrusted' ELSE 'trusted' END)","e.trust IS DISTINCT FROM CASE WHEN b.authored_by IS NULL THEN 'untrusted' ELSE 'trusted' END");
  expect(changed).not.toBe(baseline);expect(materialEnforcementStep(changed)).toBeNull();
 });

 it('preserves both released step checksums after the additive baseline declarations',()=>{
  const baseline=buildBaseline().sql;
  expect(materialGuardStep(baseline)?.checksum).toBe('aa19fe4ce8779ed4040f50b4a225cfb6e73d71b25787ab3f34aaae23f881cab7');
  expect(materialLinkStep(baseline)?.checksum).toBe('26815c949303419f35ec3acbda282c9a875c73202336b46a0ff157c7c192d206');
 });
 it('assembles only two new functions and the deferred ALWAYS trigger, under their owners',()=>{
  const step=materialEnforcementStep(buildBaseline().sql);
  expect(step).not.toBeNull();
  expect(step!.checksum).toBe(CORE_SCHEMA_UPGRADES.find(step=>step.version==='material-source-enforcement-v1')!.checksum);
  expect(step!.sql.match(/CREATE FUNCTION /g)).toHaveLength(2);
  expect(step!.sql).toContain('CREATE CONSTRAINT TRIGGER material_source_receipt');
  expect(step!.sql).toContain('ENABLE ALWAYS TRIGGER material_source_receipt');
  expect(step!.sql).not.toContain('CREATE OR REPLACE');
  expect(step!.sql).not.toContain('GRANT CREATE');
  expect(step!.sql).not.toContain('WHEN (');
 });
 for(const [name,file,before,after] of [
  ['source state body','gov/_material_source_state.sql',"RETURN 'live';","RETURN 'unknown';"],
  ['trigger isolation','sec/t_material_episode_source.sql',"current_setting('transaction_isolation') <> 'read committed'","false"],
  ['trigger deferral','app/episodes.sql','DEFERRABLE INITIALLY DEFERRED','NOT DEFERRABLE'],
  ['trigger enablement','app/episodes.sql','ENABLE ALWAYS TRIGGER material_source_receipt','ENABLE TRIGGER material_source_receipt'],
  ['function privilege','sec/t_material_episode_source.sql','FROM PUBLIC, backbone_app, backbone_operator;','FROM PUBLIC;'],
 ] as const)it(`refuses changed ${name} rather than installing changed source`,()=>{
  const baseline=buildBaseline().sql;
  const owner=baselineObject(baseline,file)!;
  expect(owner).toContain(before);
  expect(materialEnforcementStep(baseline.replace(owner,owner.replace(before,after)))).toBeNull();
 });
});

// This is a hostile catalogue fixture, not evidence that PostgreSQL emits these rows. Bodies
// come from canonical SQL while explicit posture below supplies independently chosen premises.
import {readFileSync} from 'node:fs';
import {inspectMaterialEnforcement,materialEnforcementCatalogueState,type MaterialEnforcementCatalogue} from '../src/db/material-enforcement-catalogue.ts';
const sourceFile=(file:string)=>readFileSync(new URL(`../schema/${file}`,import.meta.url),'utf8');
function argumentMetadata(file:string){
 const source=sourceFile(file),header=source.match(/CREATE FUNCTION [^(]+\(([\s\S]*?)\)\s*(?:RETURNS|LANGUAGE)/)![1];
 const fields=header.split(',').map(value=>value.trim()).filter(Boolean).map(value=>{
  const output=value.startsWith('OUT ');if(output)value=value.slice(4);
  const [name,...rest]=value.split(/\s+/);return {name,type:rest.join(' ').split(' DEFAULT')[0],mode:output?'o':'i'};
 });
 if(file==='gov/claim_run.sql')fields.push({name:'fence',type:'bigint',mode:'t'},{name:'secret',type:'text',mode:'t'});
 const output=fields.some(value=>value.mode!=='i');
 return {argumentNames:fields.length?fields.map(value=>value.name):null,argumentModes:output?fields.map(value=>value.mode):null,
  allArgumentTypes:output?fields.map(value=>value.type):null,defaultExpression:file==='gov/claim_run.sql'?'NULL::uuid':null};
}
function catalogue():MaterialEnforcementCatalogue{
 const functions=[
  ['gov._material_source_state(uuid)','gov/_material_source_state.sql','plpgsql','v','text',false,false,false],
  ['sec.t_material_episode_source()','sec/t_material_episode_source.sql','plpgsql','v','trigger',false,false,true],
  ['gov._holder(uuid,bigint)','gov/_holder.sql','plpgsql','v','app.runs',false,false,false],
  ['gov.renew_run_lease(uuid,bigint,integer)','gov/renew_run_lease.sql','plpgsql','v','timestamp with time zone',false,true,false],
  ['gov.run_standing(uuid)','gov/run_standing.sql','plpgsql','v','text',false,true,false],
  ['gov._mandate_standing(uuid)','gov/_mandate_standing.sql','plpgsql','s','text',false,false,false],
  ['gov._ancestors(uuid)','gov/_ancestors.sql','sql','s','uuid',true,false,false],
  ['gov._subtree(uuid)','gov/_subtree.sql','sql','s','uuid',true,false,false],
  ['gov.claim_run(uuid,text,integer,text,uuid)','gov/claim_run.sql','plpgsql','v','record',true,true,false],
  ['gov._claim(uuid,text,integer)','gov/_claim.sql','plpgsql','v','record',false,false,false],
  ['gov._claimable(uuid,boolean)','gov/_claimable.sql','sql','s','boolean',false,false,false],
  ['gov._stop_run(uuid,text,text)','gov/_stop_run.sql','plpgsql','v','void',false,false,false],
  ['sec.t_run_marks()','sec/t_run_marks.sql','plpgsql','v','trigger',false,false,true],
  ['sec.t_run_piece()','sec/t_run_piece.sql','plpgsql','v','trigger',false,false,true],
  ['sec.piece_binding(uuid)','sec/piece_binding.sql','sql','s','text',false,false,true],
  ['sec.task_visible(uuid)','sec/task_visible.sql','sql','s','boolean',false,true,true],
  ['sec.viewer()','sec/viewer.sql','sql','s','uuid',false,true,true],
  ['sec.acting_for()','sec/acting_for.sql','sql','s','uuid',false,true,true],
  ['gov.finish_run(uuid,bigint,text)','gov/finish_run.sql','plpgsql','v','text',false,true,false],
  ['gov.park_run(uuid,bigint)','gov/park_run.sql','plpgsql','v','text',false,true,false],
  ['gov._wake_run(uuid)','gov/_wake_run.sql','plpgsql','v','void',false,false,false],
 ] as const;
 return {functions:functions.map(([signature,file,language,volatility,result,set,appExecutes,ownerExecutes])=>({
  signature,kind:'f',support:false,sqlBody:false,body:sourceFile(file).match(/AS \$\$([\s\S]*?)\$\$;/)![1],
  language,volatility,result,set,owner:'backbone_gov',definer:/SECURITY DEFINER/.test(sourceFile(file)),strict:false,leakproof:false,parallel:'u',
  ...argumentMetadata(file),configuration:['search_path=pg_catalog'],defaults:signature.startsWith('gov.claim_run(')?1:0,variadic:false,appExecutes,operatorExecutes:false,ownerExecutes,
  acl:['backbone_gov',...(appExecutes?['backbone_app']:[]),...(ownerExecutes?['backbone_owner']:[])].map(grantee=>({grantee,grantor:'backbone_gov',privilege:'EXECUTE',grantable:false})),
 })),triggers:[{name:'episodes.material_source_receipt',enabled:'A',type:5,function:'sec.t_material_episode_source()',constraint:true,constraintType:'t',constraintTable:true,constraintDeferrable:true,constraintDeferred:true,
  deferrable:true,deferred:true,validated:true,predicate:null,arguments:0,argumentBytes:0,updateColumns:0,oldTable:null,newTable:null,constraintRelation:null,parent:0}],posture:[{safe:true}]};
}

describe('material enforcement hostile catalogue admission (no database)',()=>{
 it('recognizes one explicit candidate profile, and absence only when both new objects and trigger are absent',()=>{
  const value=catalogue();expect(materialEnforcementCatalogueState(value)).toBe('enforced');
  for(const row of value.functions.slice(0,2))row.body=null;
  value.triggers=[];expect(materialEnforcementCatalogueState(value)).toBe('absent');
  value.functions[0].body='tampered';expect(materialEnforcementCatalogueState(value)).toBe('unknown');
 });
 for(const field of ['enabled','type','function','constraint','constraintType','constraintTable','constraintDeferrable','constraintDeferred','deferrable','deferred','validated','predicate','arguments','argumentBytes','updateColumns','oldTable','newTable','constraintRelation','parent'] as const)
  it(`refuses a modified trigger ${field}`,()=>{
   const value=catalogue(),trigger=value.triggers[0];
   (trigger as unknown as Record<string,unknown>)[field]=typeof trigger[field]==='boolean'?!trigger[field]:typeof trigger[field]==='number'?trigger[field]+1:'injected';
   expect(materialEnforcementCatalogueState(value)).toBe('unknown');
  });
 for(const index of Array.from({length:21},(_,index)=>index))it(`refuses changed enforcement/carrier body ${index}`,()=>{
  const value=catalogue();value.functions[index].body+='\n-- changed';expect(materialEnforcementCatalogueState(value)).toBe('unknown');
 });
 for(const field of ['kind','support','sqlBody','language','owner','definer','volatility','result','set','strict','leakproof','parallel','configuration','defaults','defaultExpression','argumentNames','argumentModes','allArgumentTypes','variadic','appExecutes','operatorExecutes','ownerExecutes'] as const)
  it(`refuses changed function ${field}`,()=>{
   const value=catalogue(),row=value.functions[0];
   (row as unknown as Record<string,unknown>)[field]=Array.isArray(row[field])?['search_path=public']:typeof row[field]==='boolean'?!row[field]:typeof row[field]==='number'?row[field]+1:'injected';
   expect(materialEnforcementCatalogueState(value)).toBe('unknown');
  });
 it('refuses PUBLIC or another role grant, grant option and unexpected grantor',()=>{
  for(const mutation of [(value:MaterialEnforcementCatalogue)=>value.functions[0].acl!.push({grantee:'PUBLIC',grantor:'backbone_gov',privilege:'EXECUTE',grantable:false}),
   (value:MaterialEnforcementCatalogue)=>value.functions[0].acl![0].grantable=true,
   (value:MaterialEnforcementCatalogue)=>value.functions[0].acl![0].grantor='backbone_owner']){
   const value=catalogue();mutation(value);expect(materialEnforcementCatalogueState(value)).toBe('unknown');
  }
 });
 it('refuses ambiguous/missing catalogue rows and unsafe native/schema/replication posture',()=>{
  for(const mutation of [(value:MaterialEnforcementCatalogue)=>value.functions.push(value.functions[0]),
   (value:MaterialEnforcementCatalogue)=>value.functions.pop(),(value:MaterialEnforcementCatalogue)=>value.triggers.push(value.triggers[0]),
   (value:MaterialEnforcementCatalogue)=>value.posture[0].safe=false,(value:MaterialEnforcementCatalogue)=>value.posture=[]]){
   const value=catalogue();mutation(value);expect(materialEnforcementCatalogueState(value)).toBe('unknown');
  }
 });
 it('uses catalogue-only queries for source bodies, trigger structure, role/schema and parameter privilege boundaries',async()=>{
  const value=catalogue(),queries:string[]=[];
  const fake={query:async(text:string)=>{queries.push(text);return {rows:queries.length===1?value.functions:queries.length===2?value.triggers:value.posture};}};
  expect(materialEnforcementCatalogueState(await inspectMaterialEnforcement(fake as never))).toBe('enforced');
  expect(queries).toHaveLength(3);
  expect(queries[1]).toContain("ORDER BY (c.relname||'.'||t.tgname) COLLATE \"C\"");
  expect(queries[1]).not.toContain('ORDER BY name COLLATE');
  for(const query of queries)expect(query.trim()).toMatch(/^SELECT /);
  expect(queries.join('\n')).toContain('pg_catalog.has_parameter_privilege');
  expect(queries.join('\n')).toContain('pg_catalog.pg_auth_members');
  expect(queries.join('\n')).toContain('pg_catalog.pg_namespace');
  expect(queries.join('\n')).toContain('pg_catalog.pg_rewrite');
  expect(queries.join('\n')).toContain('attcollation');
  expect(queries.join('\n')).toContain('collisdeterministic');
  expect(queries.join('\n')).not.toMatch(/FROM app\./);
 });
});

describe('original run recovery claim function boundary (source fixture only)',()=>{
 it('attests public native claim signature/OUT table and private claim return record without requiring DEFINER on invoker dependencies',()=>{
  const installed=catalogue();expect(materialEnforcementCatalogueState(installed)).toBe('enforced');
  const claim=installed.functions.find(row=>row.signature==='gov.claim_run(uuid,text,integer,text,uuid)')!;
  expect(claim.defaults).toBe(1);expect(claim.defaultExpression).toBe('NULL::uuid');
  expect(claim.argumentModes).toEqual(['i','i','i','i','i','t','t']);
  expect(claim.allArgumentTypes).toEqual(['uuid','text','integer','text','uuid','bigint','text']);
  expect(installed.functions.find(row=>row.signature==='sec.t_run_piece()')!.definer).toBe(false);
 });
 for(const signature of ['gov.claim_run(uuid,text,integer,text,uuid)','gov._claim(uuid,text,integer)']){
  for(const field of ['argumentNames','argumentModes','allArgumentTypes','defaultExpression','defaults'] as const)
   it(`rejects changed ${signature} ${field}`,()=>{
    const installed=catalogue(),row=installed.functions.find(row=>row.signature===signature)!;
    (row as unknown as Record<string,unknown>)[field]=field==='defaults'?2:field==='defaultExpression'?'gen_random_uuid()':['injected'];
    expect(materialEnforcementCatalogueState(installed)).toBe('unknown');
   });
 }
 it('does not accept a missing claim/stop/invoker dependency as an unenforced old schema',()=>{
  for(const signature of ['gov.claim_run(uuid,text,integer,text,uuid)','gov._claim(uuid,text,integer)','gov._claimable(uuid,boolean)','gov._stop_run(uuid,text,text)','sec.t_run_piece()','sec.task_visible(uuid)']){
   const installed=catalogue();installed.functions.find(row=>row.signature===signature)!.body=null;
   expect(materialEnforcementCatalogueState(installed)).toBe('unknown');
  }
 });
});

function installerFixture(options:{absent?:boolean;partial?:boolean;installer?:boolean;failInstalledProfile?:boolean;changeNamespace?:boolean;failCommit?:boolean;rollbackAck?:boolean;version?:number}={}){
 let installed=!options.absent,ddl=false;
 const events:{query:string;values?:unknown[]}[]=[];
 const history=[{version:'baseline',checksum:'0'.repeat(64)},...CORE_SCHEMA_UPGRADES.slice(0,2)];
 const client={query:async(query:string,values?:unknown[])=>{
  events.push({query,values});
  if(query.includes("current_setting('server_version_num')"))return {rows:[{version:options.version??180000}]};
  if(query.startsWith('SELECT rolsuper'))return {rows:[{installer:options.installer!==false}]};
  if(query.startsWith('SELECT version,checksum'))return {rows:history};
  if(query.includes('SELECT wanted.signature')){
   const value=catalogue();
   if(!installed)for(const row of value.functions.slice(0,2))row.body=null;
   if(options.partial&&!installed)value.functions[0].body='partial';
   if(options.failInstalledProfile&&ddl)value.functions[0].body='bad installation';
   return {rows:value.functions};
  }
  if(query.includes('FROM pg_catalog.pg_trigger t'))return {rows:installed?catalogue().triggers:[]};
  if(query.includes('AS safe'))return {rows:[{safe:true}]};
  if(query.startsWith('SELECT nspname'))return {rows:[{nspname:'sec',owner:'backbone_owner',acl:options.changeNamespace&&ddl?'changed':'original'}]};
  if(query.startsWith('SET LOCAL check_function_bodies=false;')){installed=true;ddl=true;}
  if(query.startsWith('INSERT INTO ops.schema_migrations'))history.push({version:values![0] as string,checksum:values![1] as string});
  if(query==='COMMIT'&&options.failCommit)throw new Error('simulated lost commit response');
  return {rows:[],command:query==='COMMIT'?(options.rollbackAck?'ROLLBACK':'COMMIT'):undefined};
 }};
 return {client:client as never,events,history};
}
describe('material enforcement transaction protocol (mock client; no SQL execution)',()=>{
 it('assembles only reviewed DDL, records history before COMMIT, and verifies the installed profile',async()=>{
  const fixture=installerFixture({absent:true});
  expect((await upgradeMaterialEnforcement(fixture.client,buildBaseline().sql)).state).toBe('verified');
  const queries=fixture.events.map(event=>event.query),ddl=queries.findIndex(query=>query.startsWith('SET LOCAL check_function_bodies=false;'));
  expect(queries[0]).toContain("current_setting('server_version_num')");expect(queries[1]).toMatch(/^SELECT rolsuper/);expect(queries[2]).toBe('BEGIN');
  expect(ddl).toBeGreaterThan(queries.findIndex(query=>query.startsWith('LOCK TABLE app.episodes')));
  expect(queries.findIndex(query=>query.startsWith('INSERT INTO ops.schema_migrations'))).toBeGreaterThan(ddl);
  expect(queries.at(-1)).toBe('COMMIT');expect(fixture.history.at(-1)).toEqual(CORE_SCHEMA_UPGRADES.find(step=>step.version==='material-source-enforcement-v1'));
  expect(queries.some(query=>/^(INSERT|UPDATE|DELETE) (INTO )?app\./.test(query))).toBe(false);
 });
 it('recognizes a fresh exact profile without replacing functions or triggers',async()=>{
  const fixture=installerFixture();
  expect((await upgradeMaterialEnforcement(fixture.client,buildBaseline().sql)).state).toBe('verified');
  expect(fixture.events.some(event=>event.query.startsWith('SET LOCAL check_function_bodies=false;'))).toBe(false);
  expect(fixture.events.at(-1)!.query).toBe('COMMIT');
 });
 it('refuses changed shipped source before even querying installer credentials or database',async()=>{
  const fixture=installerFixture({absent:true});
  expect((await upgradeMaterialEnforcement(fixture.client,buildBaseline().sql.replace('ENABLE ALWAYS TRIGGER material_source_receipt','ENABLE TRIGGER material_source_receipt'))).state).toBe('paused');
  expect(fixture.events).toHaveLength(0);
 });
 it('refuses a service connection before BEGIN or DDL',async()=>{
  const fixture=installerFixture({absent:true,installer:false});
  expect((await upgradeMaterialEnforcement(fixture.client,buildBaseline().sql)).state).toBe('paused');expect(fixture.events).toHaveLength(2);
 });
 for(const [name,options] of [['partial source',{absent:true,partial:true}],['changed installed profile',{absent:true,failInstalledProfile:true}],['namespace ACL changed',{absent:true,changeNamespace:true}],['lost commit acknowledgement',{absent:true,failCommit:true}],['ROLLBACK commit acknowledgement',{absent:true,rollbackAck:true}]] as const)
  it(`pauses and rolls back for ${name}, without reporting success`,async()=>{
   const fixture=installerFixture(options);
   expect((await upgradeMaterialEnforcement(fixture.client,buildBaseline().sql)).state).toBe('paused');
   expect(fixture.events.at(-1)!.query).toBe('ROLLBACK');
   if(options.partial)expect(fixture.events.some(event=>event.query.startsWith('SET LOCAL check_function_bodies=false;'))).toBe(false);
  });
 it('external verification with incomplete history only reads metadata and never installs',async()=>{
  const fixture=installerFixture();
  expect((await verifyMaterialEnforcement(fixture.client)).state).toBe('paused');
  expect(fixture.events).toHaveLength(2);expect(fixture.events[1].query).toMatch(/^SELECT version,checksum/);
 });
 it('external verification requires both exact profile and completed history, with no DDL',async()=>{
  const fixture=installerFixture();fixture.history.push(CORE_SCHEMA_UPGRADES.find(step=>step.version==='material-source-enforcement-v1')!);
  expect((await verifyMaterialEnforcement(fixture.client)).state).toBe('verified');
  expect(fixture.events.every(event=>event.query.trim().startsWith('SELECT '))).toBe(true);
 });
});


describe('explicit qualified PostgreSQL major version (source mock; no server)',()=>{
 for(const version of [160000,170000,179999,190000,200000]){
  it(`external verification pauses PostgreSQL ${version} before catalogue/history access`,async()=>{
   const fixture=installerFixture({version});expect((await verifyMaterialEnforcement(fixture.client)).state).toBe('paused');
   expect(fixture.events).toHaveLength(1);expect(fixture.events[0].query).toContain("current_setting('server_version_num')");
  });
  it(`owned installer pauses PostgreSQL ${version} before BEGIN or DDL`,async()=>{
   const fixture=installerFixture({version});expect((await upgradeMaterialEnforcement(fixture.client,buildBaseline().sql)).state).toBe('paused');
   expect(fixture.events).toHaveLength(1);expect(fixture.events.some(event=>event.query==='BEGIN')).toBe(false);
  });
 }
 for(const version of [180000,180999,189999])it(`admits only the qualified major at ${version}`,async()=>{
  const fixture=installerFixture({version});expect((await upgradeMaterialEnforcement(fixture.client,buildBaseline().sql)).state).toBe('verified');
 });
 it('an unreadable version does not fall through to history, owner admission or DDL',async()=>{
  const events:string[]=[],client={query:async(sql:string)=>{events.push(sql);throw new Error('Synthetic version lookup failure');}};
  expect((await verifyMaterialEnforcement(client as never)).state).toBe('paused');
  expect((await upgradeMaterialEnforcement(client as never,buildBaseline().sql)).state).toBe('paused');
  expect(events).toHaveLength(2);expect(events.every(sql=>sql.includes("current_setting('server_version_num')"))).toBe(true);
 });
});
