// Authoring helper for the append-only resource security bundle.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, sha256 } from './closed-version-assembler.mjs';
import { functionDeclarations } from './closed-version-functions.mjs';
const root = new URL('../../../', import.meta.url).pathname, schema = join(root,'packages/core/schema');
const version = 'identity-resource-guard-v1';
const read = paths => paths.map(path=>({path,bytes:readFileSync(join(schema,'versions',version,path))}));
const sections = [
 {role:'backbone_gov',sources:read(['gov/identity_task_access.sql','gov/identity_person_task_access.sql','gov/identity_bind_new_task.sql','gov/identity_run_lookup.sql','gov/identity_effect_decider_access.sql','gov/identity_run_decider_access.sql','gov/identity_cancel_mandate_work.sql','gov/claim_run.sql','gov/claim_next_run.sql','gov/claim_next_effect.sql','gov/claim_next_verification.sql','gov/revoke_mandate.sql'])},
 {role:'backbone_owner',sources:read(['app/identity_directory_deleted.sql','app/identity_workspace_projects.sql','app/identity_resource_policies.sql'])},
 {role:'backbone_gov',sources:read(['gov/identity_create_task.sql','gov/identity_bind_task.sql','gov/identity_project_access.sql','gov/join_channel_thread.sql','gov/share_task.sql','gov/identity_directory_list.sql','gov/identity_directory_delete.sql'])},
];
const added = new Set(['gov.identity_effect_decider_access(uuid)','gov.identity_run_decider_access(uuid)','gov.identity_bind_new_task()','gov.identity_run_lookup(uuid,bigint)','gov.identity_cancel_mandate_work(uuid[],uuid)','gov.identity_directory_delete(text,uuid,bigint)']);
const sources = sections.flatMap(s=>s.sources);
const catalogue = JSON.parse(readFileSync(join(schema,'versions.json'),'utf8'));
const requires = [...catalogue.historical,...catalogue.versions.filter(row=>row.version!==version).map(({version,checksum})=>({version,checksum}))];
const parts = [`-- Core schema version ${version} (closed build artifact).`];
for (const {role,sources:subset} of sections) parts.push(`SET ROLE ${role};`,...subset.flatMap(({path,bytes})=>[`-- ${path}`,bytes.toString('utf8').trim()]));
const sql = [...parts,'RESET ROLE;'].join('\n\n')+'\n',checksum=sha256(sql);
const manifest = {format:1,version,requires,sections:sections.map(({role,sources})=>({role,files:sources.map(({path,bytes})=>({path,sha256:sha256(bytes)}))})),changes:sources.flatMap(({path,bytes})=>[
 ...functionDeclarations(bytes.toString()).map(signature=>({action:added.has(signature)?'add':'replace',object:`function ${signature}`,file:path})),
 ...(['app/identity_directory_deleted.sql','app/identity_workspace_projects.sql'].includes(path)?[{action:'add',object:'table '+path.slice(0,-4).replace('/','.'),file:path}]:[]),
 ...(path==='app/identity_resource_policies.sql'?[{action:'add',object:'trigger app.tasks.identity_task_project_binding',file:path}]:[]),
]),checksum};
writeFileSync(join(schema,'versions',version,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
catalogue.versions = [...catalogue.versions.filter(row=>row.version!==version),{version,checksum,manifestSha256:sha256(canonical(manifest))}];
writeFileSync(join(schema,'versions.json'),JSON.stringify(catalogue,null,2)+'\n');
const registry = join(root,'packages/core/src/db/schema-migrations.ts');
let text = readFileSync(registry,'utf8').replace(/\n  Object\.freeze\(\{version:'identity-resource-guard-v1',checksum:'[a-f0-9]+'\}\),/,'');
text = text.replace('\n]);',`\n  Object.freeze({version:'${version}',checksum:'${checksum}'}),\n]);`);
writeFileSync(registry,text);
