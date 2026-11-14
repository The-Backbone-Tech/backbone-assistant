// Authoring helper for the append-only identity admission correction.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, sha256 } from './closed-version-assembler.mjs';
import { functionDeclarations } from './closed-version-functions.mjs';
const root = new URL('../../../', import.meta.url).pathname, schema = join(root,'packages/core/schema');
const version = 'identity-admission-closure-v1';
const read = paths => paths.map(path=>({path,bytes:readFileSync(join(schema,'versions',version,path))}));
const sections = [
 {role:'backbone_gov',sources:read(['gov/identity_budget_totals.sql','gov/_mandate_standing.sql','gov/identity_bind_task.sql','gov/_task_read_beyond.sql','gov/_quote_run.sql','gov/quote_marks.sql','gov/unregister_piece.sql','gov/give_connector_signature.sql','gov/_may_answer.sql','gov/identity_effect_decider_access.sql','gov/identity_material_scope.sql'])},
 {role:'backbone_owner',sources:read(['app/identity_document_policies.sql'])},
 {role:'backbone_gov',sources:read(['gov/identity_document_access.sql'])},
];
const added=new Set(['gov.identity_budget_totals(uuid)','gov.identity_material_scope(uuid,boolean)']);
const sources = sections.flatMap(s=>s.sources);
const catalogue = JSON.parse(readFileSync(join(schema,'versions.json'),'utf8'));
const requires = [...catalogue.historical,...catalogue.versions.filter(row=>row.version!==version).map(({version,checksum})=>({version,checksum}))];
const parts = [`-- Core schema version ${version} (closed build artifact).`];
for (const {role,sources:subset} of sections) parts.push(`SET ROLE ${role};`,...subset.flatMap(({path,bytes})=>[`-- ${path}`,bytes.toString('utf8').trim()]));
const sql = [...parts,'RESET ROLE;'].join('\n\n')+'\n',checksum=sha256(sql);
const manifest = {format:1,version,requires,sections:sections.map(({role,sources})=>({role,files:sources.map(({path,bytes})=>({path,sha256:sha256(bytes)}))})),changes:sources.flatMap(({path,bytes})=>[
 ...functionDeclarations(bytes.toString()).map(signature=>({action:added.has(signature)?'add':'replace',object:`function ${signature}`,file:path})),
 // Earlier manifests grouped these policies with their task-project table.
 // Replace their exact addresses using the indexed historical definitions.
 ...(path==='app/identity_document_policies.sql'?['documents','episodes'].flatMap(table=>['read','crossing_read','insert','update'].map(suffix=>({action:'replace',object:`policy app.${table}.identity_project_${suffix}`,file:path}))):[]),
]),checksum};
writeFileSync(join(schema,'versions',version,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
catalogue.versions = [...catalogue.versions.filter(row=>row.version!==version),{version,checksum,manifestSha256:sha256(canonical(manifest))}];
writeFileSync(join(schema,'versions.json'),JSON.stringify(catalogue,null,2)+'\n');
const registry = join(root,'packages/core/src/db/schema-migrations.ts');
let text = readFileSync(registry,'utf8').replace(/\n  Object\.freeze\(\{version:'identity-admission-closure-v1',checksum:'[a-f0-9]+'\}\),/,'');
text = text.replace('\n]);',`\n  Object.freeze({version:'${version}',checksum:'${checksum}'}),\n]);`);
writeFileSync(registry,text);
