// Offline verification never asks a refused source home for write admission or keys.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {verifyAuditFile} from '../src/audit-file.ts';
import {CoreLink} from '../src/composition/core.ts';
import {collectAuditHome} from './fixtures/audit-collect.ts';
import {AUDIT_PERIOD} from './fixtures/audit-activity.ts';
import {freshDir,value} from './helpers.ts';
import {writePlaintextVault} from '../src/keys/vault.ts';
import {replaceHeldHomeLock} from './native-lock-observation.ts';
test('audit verify leaves source vault and export bytes identical even after root refusal',async()=>{
  const home=freshDir('audit-verify-admission-');writePlaintextVault(home);
  const link=await CoreLink.open({home});await link.close();
  const record=value(await collectAuditHome(home,AUDIT_PERIOD)),file=join(freshDir('audit-verify-file-'),'record.jsonl');writeFileSync(file,record.jsonl);
  await replaceHeldHomeLock(home);
  const vaultPath=join(home,'keys','vault.json'),vault=readFileSync(vaultPath),before=readFileSync(file);
  await verifyAuditFile(file);
  assert.equal(readFileSync(vaultPath).equals(vault),true);assert.equal(readFileSync(file).equals(before),true);
});
