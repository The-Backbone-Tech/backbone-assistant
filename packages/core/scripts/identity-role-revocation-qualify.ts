import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { startTestPostgres } from '../src/db/testing.ts';
import { MATERIAL_CLOSURE_RELEASE as release } from '../src/db/identity-role-revocation-release.generated.ts';
import { captureIdentity, identityHash, verifyIdentity } from '../src/db/identity-catalogue.ts';
import { IDENTITY_ROLE_REVOCATION_PINS } from '../src/db/identity-role-revocation-pins.ts';
import { IDENTITY_WORK_PINS } from '../src/db/identity-work-pins.ts';

// No home or URL argument: both predecessor and successor come from shipped source.
const postgres = await startTestPostgres({ unqualifiedIdentityRoleRevocationBaseline: true });
await postgres.clone('identity_role_source');
const client = new pg.Client({ connectionString: postgres.adminUrl('identity_role_source') });
try {
  await client.connect();
  assert.equal((await verifyIdentity(client)).state, 'verified');
  const before = await captureIdentity(client);
  assert.equal(identityHash(JSON.stringify(before)), IDENTITY_WORK_PINS?.catalogue);
  await client.query('BEGIN'); await client.query(release.sql);
  const after = await captureIdentity(client);
  assert.equal(after.filter(row => row.kind === 'function').length, 29);
  assert.equal(after.filter(row => row.kind === 'table').length, 8);
  // Every old native definition, owner, ACL and relation family is retained byte for byte.
  for (const row of before) {
    const next = after.find(other => other.kind === row.kind && other.name === row.name);
    if (['gov.identity_project_share(uuid,uuid,text)','gov.identity_person_task_access(uuid,uuid,boolean)'].includes(row.name)) {
      // This version explicitly replaces its body to remove guest write authority while retaining ownership and audience history.
      const { definition: oldBody, ...oldAuthority } = row.definition;
      const { definition: newBody, ...newAuthority } = next!.definition;
      assert.notEqual(oldBody,newBody); assert.deepEqual(newAuthority,oldAuthority);
    } else assert.deepEqual(next,row);
  }
  const pins = { payload: release.checksum, predecessor: IDENTITY_WORK_PINS!.catalogue, catalogue: identityHash(JSON.stringify(after)) };
  if (process.argv.includes('--write')) {
    const path = new URL('../src/db/identity-role-revocation-pins.ts', import.meta.url), text = readFileSync(path, 'utf8');
    writeFileSync(path, text.slice(0, text.indexOf('export const')) + `export const IDENTITY_ROLE_REVOCATION_PINS: { payload: string; predecessor: string; catalogue: string } | null = ${JSON.stringify(pins)};\n`);
  } else assert.deepEqual(pins, IDENTITY_ROLE_REVOCATION_PINS);
  await client.query('ROLLBACK'); assert.deepEqual(await captureIdentity(client), before);
  console.log('Identity role revocation source preserves its predecessor and reproduces the exact native extension; rollback is complete.');
} finally { await client.end(); await postgres.drop('identity_role_source'); await postgres.stop(); }
