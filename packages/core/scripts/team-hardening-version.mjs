// Append a closed hardening bundle; never rewrite an existing version.
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {canonical,sha256} from './closed-version-assembler.mjs';
import {functionDeclarations} from './closed-version-functions.mjs';
const version=process.argv[2],files=process.argv.slice(3);
if(!/^identity-[a-z-]+-v1$/.test(version??'')||!files.length)throw new Error('Name a new identity version and its exact ordered files.');
const schema=new URL('../schema/',import.meta.url).pathname,registry=new URL('../src/db/schema-migrations.ts',import.meta.url);
const catalogue=JSON.parse(readFileSync(join(schema,'versions.json'),'utf8'));
if(catalogue.versions.some(row=>row.version===version))throw new Error('Released bundles are immutable.');
const sources=files.map(path=>({path,bytes:readFileSync(join(schema,'versions',version,path))}));
const sql=[`-- Core schema version ${version} (closed build artifact).`,'SET ROLE backbone_gov;',...sources.flatMap(({path,bytes})=>[`-- ${path}`,bytes.toString().trim()]),'RESET ROLE;'].join('\n\n')+'\n';
const checksum=sha256(sql),manifest={format:1,version,requires:[...catalogue.historical,...catalogue.versions.map(({version,checksum})=>({version,checksum}))],sections:[{role:'backbone_gov',files:sources.map(({path,bytes})=>({path,sha256:sha256(bytes)}))}],changes:sources.flatMap(({path,bytes})=>functionDeclarations(bytes.toString()).map(signature=>({action:/^(gov.identity_(add_person|accept_legacy)|operator.identity_restore_device_access)\(/.test(signature)?'add':'replace',object:`function ${signature}`,file:path}))),checksum};
writeFileSync(join(schema,'versions',version,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
catalogue.versions.push({version,checksum,manifestSha256:sha256(canonical(manifest))});writeFileSync(join(schema,'versions.json'),JSON.stringify(catalogue,null,2)+'\n');
writeFileSync(registry,readFileSync(registry,'utf8').replace('\n]);',`\n  Object.freeze({version:'${version}',checksum:'${checksum}'}),\n]);`));
