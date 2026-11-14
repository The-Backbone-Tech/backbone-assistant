// Authoring helper for the append-only identity admission correction.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, sha256 } from './closed-version-assembler.mjs';
import { functionDeclarations } from './closed-version-functions.mjs';
const root = new URL('../../../', import.meta.url).pathname, schema = join(root,'packages/core/schema');
const version = 'identity-guarantees-v1';
const read = paths => paths.map(path=>({path,bytes:readFileSync(join(schema,'versions',version,path))}));
const sections = [
 {role:'backbone_gov',sources:read(['gov/identity_task_exists.sql','gov/identity_effect_owner.sql','gov/queue_run.sql','gov/propose_undo.sql','gov/propose_candidate.sql','gov/_promotion_sources_allowed.sql','sec/t_candidate_input_capture_v1.sql'])},
 {role:'backbone_owner',sources:read(['owner/identity_store_guarantees.sql'])},
];
const added=new Set(['gov.identity_task_exists(uuid)','gov.identity_effect_owner(uuid)']);
const sources = sections.flatMap(s=>s.sources);
const catalogue = JSON.parse(readFileSync(join(schema,'versions.json'),'utf8'));
const requires = [...catalogue.historical,...catalogue.versions.filter(row=>row.version!==version).map(({version,checksum})=>({version,checksum}))];
const parts = [`-- Core schema version ${version} (closed build artifact).`];
for (const {role,sources:subset} of sections) parts.push(`SET ROLE ${role};`,...subset.flatMap(({path,bytes})=>[`-- ${path}`,bytes.toString('utf8').trim()]));
const sql = [...parts,'RESET ROLE;'].join('\n\n')+'\n',checksum=sha256(sql);
const manifest = {format:1,version,requires,sections:sections.map(({role,sources})=>({role,files:sources.map(({path,bytes})=>({path,sha256:sha256(bytes)}))})),changes:sources.flatMap(({path,bytes})=>[
 ...functionDeclarations(bytes.toString()).map(signature=>({action:added.has(signature)?'add':'replace',object:`function ${signature}`,file:path})),
 ...((path==='gov/identity_store_guarantees.sql'||path==='owner/identity_store_guarantees.sql')?[...bytes.toString().matchAll(/CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app\.([a-z_]+)/g)].flatMap(([,table])=>[{action:'replace',object:`policy app.${table}.tenant_wall`,file:path},{action:'add',object:`trigger app.${table}.no_truncate`,file:path}]):[]),
]),checksum};
writeFileSync(join(schema,'versions',version,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
catalogue.versions = [...catalogue.versions.filter(row=>row.version!==version),{version,checksum,manifestSha256:sha256(canonical(manifest))}];
writeFileSync(join(schema,'versions.json'),JSON.stringify(catalogue,null,2)+'\n');
const registry = join(root,'packages/core/src/db/schema-migrations.ts');
let text = readFileSync(registry,'utf8').replace(/\n  Object\.freeze\(\{version:'identity-guarantees-v1',checksum:'[a-f0-9]+'\}\),/,'');
text = text.replace('\n]);',`\n  Object.freeze({version:'${version}',checksum:'${checksum}'}),\n]);`);
writeFileSync(registry,text);
