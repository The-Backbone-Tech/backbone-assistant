// The released source guard must remain byte-identical as new additive schema steps are introduced.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {buildBaseline,materialGuardStep} from '@backbone/core/db';
import {CORE_SCHEMA_UPGRADES,CORE_SCHEMA_LOCK,baselineObject,schemaHistoryMatches} from '../../core/src/db/schema-migrations.ts';
const V1='aa19fe4ce8779ed4040f50b4a225cfb6e73d71b25787ab3f34aaae23f881cab7';
const base={version:'baseline',checksum:'a'.repeat(64)};

test('the released guard retains its exact executable step and immutable descriptor',()=>{
 const step=materialGuardStep(buildBaseline().sql);assert.ok(step);
 assert.equal(step.checksum,V1);
 assert.equal(createHash('sha256').update(step.sql).digest('hex'),V1);
 assert.deepEqual(CORE_SCHEMA_UPGRADES[0],{version:'material-source-guard-v1',checksum:V1});
 assert.equal(Reflect.set(CORE_SCHEMA_UPGRADES[0],'checksum','0'.repeat(64)),false);
 assert.equal(Reflect.set(CORE_SCHEMA_UPGRADES,'0',{version:'forged',checksum:V1}),false);
 assert.equal(CORE_SCHEMA_LOCK,'SELECT pg_advisory_xact_lock(1111573323, 2)');
});

test('history accepts only a complete declared dependency prefix, never unknown or fabricated receipts',()=>{
 const guard={version:'material-source-guard-v1',checksum:V1};
 assert.equal(schemaHistoryMatches([base]),true);
 for(let length=0;length<=CORE_SCHEMA_UPGRADES.length;length++)
  assert.equal(schemaHistoryMatches([base,...CORE_SCHEMA_UPGRADES.slice(0,length)]),true);
 if(CORE_SCHEMA_UPGRADES.length>1)assert.equal(schemaHistoryMatches([base,...CORE_SCHEMA_UPGRADES.slice(1)]),false);
 for(const rows of [[],[guard],[guard,base],[base,base],[base,guard,guard],
  [{version:'baseline',checksum:'not-a-digest'}],
  [base,{...guard,checksum:'0'.repeat(64)}],
  [base,{version:'material-source-link-v1',checksum:'b'.repeat(64)}],
  [base,guard,{version:'future-schema',checksum:'b'.repeat(64)}],
 ])assert.equal(schemaHistoryMatches(rows),false,JSON.stringify(rows));
});

test('the shared extractor preserves one baseline owner, normalizes line endings and refuses duplicate blocks',()=>{
 const source=buildBaseline().sql;
 const block=baselineObject(source,'gov/request_promotion.sql');assert.ok(block);
 assert.match(block,/CREATE FUNCTION gov\.request_promotion\(/);
 assert.equal(baselineObject(source.replace(/\n/g,'\r\n'),'gov/request_promotion.sql'),block);
 assert.equal(baselineObject(source,'gov/not-installed.sql'),null);
 assert.equal(baselineObject(source+'\n\n-- gov/request_promotion.sql\n\nSELECT 1;','gov/request_promotion.sql'),null);
});
