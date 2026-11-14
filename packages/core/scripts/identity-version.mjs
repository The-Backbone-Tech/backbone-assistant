// Authoring helper for the unreleased identity bundle. Released predecessors are never rewritten.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, sha256 } from './closed-version-assembler.mjs';
import { functionDeclarations } from './closed-version-functions.mjs';
const root = new URL('../../../', import.meta.url).pathname;
const schema = join(root, 'packages/core/schema');
const tables = ['identity_accounts','identity_sessions','identity_invitations','identity_projects','identity_project_people','identity_agents'];
const functions = ['identity_invite','identity_accept','identity_sign_in','identity_session','identity_people','identity_remove','identity_change_role','identity_project_create','identity_project_access','identity_project_share','identity_runtime','identity_sign_out'];
const files = [...tables,...functions].map(name => `gov/${name}.sql`);
const catalogue = JSON.parse(readFileSync(join(schema,'versions.json'),'utf8'));
const requires = [...catalogue.historical,...catalogue.versions.filter(row=>row.version!=='identity-v1').map(({version,checksum})=>({version,checksum}))];
const sources = files.map(path=>({path,bytes:readFileSync(join(schema,'versions/identity-v1',path))}));
const parts = ['-- Core schema version identity-v1 (closed build artifact).'];
for (const [role,subset] of [['backbone_owner',sources.slice(0,tables.length)],['backbone_gov',sources.slice(tables.length)]]) parts.push(`SET ROLE ${role};`,...subset.flatMap(({path,bytes})=>[`-- ${path}`,bytes.toString('utf8').trim()]));
const sql = [...parts,'RESET ROLE;'].join('\n\n')+'\n';
const checksum = sha256(sql);
const manifest = {format:1,version:'identity-v1',requires,sections:[{role:'backbone_owner',files:sources.slice(0,tables.length).map(({path,bytes})=>({path,sha256:sha256(bytes)}))},{role:'backbone_gov',files:sources.slice(tables.length).map(({path,bytes})=>({path,sha256:sha256(bytes)}))}],changes:sources.flatMap(({path,bytes})=>
  tables.includes(path.slice(4,-4)) ? [{action:'add',object:`table app.${path.slice(4,-4)}`,file:path}] : functionDeclarations(bytes.toString()).map(signature=>({action:'add',object:`function ${signature}`,file:path}))),checksum};
writeFileSync(join(schema,'versions/identity-v1/manifest.json'),JSON.stringify(manifest,null,2)+'\n');
catalogue.versions = [...catalogue.versions.filter(row=>row.version!=='identity-v1'),{version:'identity-v1',checksum,manifestSha256:sha256(canonical(manifest))}];
writeFileSync(join(schema,'versions.json'),JSON.stringify(catalogue,null,2)+'\n');
const registry = join(root,'packages/core/src/db/schema-migrations.ts');
let text = readFileSync(registry,'utf8').replace(/\n  Object\.freeze\(\{version:'identity-v1',checksum:'[a-f0-9]+'\}\),/,'');
text = text.replace('\n]);',`\n  Object.freeze({version:'identity-v1',checksum:'${checksum}'}),\n]);`);
writeFileSync(registry,text);
