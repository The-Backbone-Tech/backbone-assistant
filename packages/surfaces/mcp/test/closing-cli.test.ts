import { spawnSyncHang, TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// The actual command exhausts its one pre-write retry and reports a known closing refusal.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {plaintextKeys,Vault} from '@backbone-next/platform/keys';
import type {DoorGrant} from '@backbone-next/platform/gateway';

for(const operation of ['grant','revoke'])test(`${operation} reports closing after two refused admissions without claiming success`,async t=>{
 const home=mkdtempSync(join(tmpdir(),'backbone-closing-cli-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 await Vault.open(home,plaintextKeys());
 if(operation==='revoke'){
  // A complete local historical record makes revoke enter Core; it supplies no native authority.
  const id='00000000-0000-4000-8000-000000000001';
  const grant:DoorGrant={name:'synthetic-closing-cli',agent:id,mandate:id,task:id,run:id,operations:['outbox.write'],ceiling:3,expiresAt:'2030-01-01T00:00:00.000Z',piece:{id,piece:'mcp',version:'0.0.0',digest:`sha256:${'0'.repeat(64)}`}};
  mkdirSync(join(home,'doors'));writeFileSync(join(home,'doors','synthetic-closing-cli.json'),JSON.stringify(grant));
 }
 const main=fileURLToPath(new URL('../src/main.ts',import.meta.url));
 const fixture=fileURLToPath(new URL('../../../platform/test/close-refusal-cli.ts',import.meta.url));
 const result=spawnSyncHang(process.execPath,[fixture,main,home,operation],{encoding:'utf8',timeout: TEST_HANG_MS,env:{...process.env,BACKBONE_KEYS:'plaintext'}});
 assert.equal(result.status,2,result.stderr);assert.equal(result.signal,null);
 assert.equal((result.stderr.match(/synthetic-close-admission:/g)??[]).length,2);
 assert.match(result.stderr,/data home is closing; nothing was granted or revoked by this attempt/i);
 assert.doesNotMatch(result.stderr,/CoreCloseWaitRefusal:|at personOperation|at asPerson/);
 assert.equal(result.stdout,'','no Granted/Revoked success is printed');
});
