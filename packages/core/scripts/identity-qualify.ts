// Source-only native qualification. This script accepts no database URL or data home.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { startTestPostgres } from '../src/db/testing.ts';
import { MATERIAL_CLOSURE_RELEASE as release } from '../src/db/identity-release.generated.ts';
import { captureIdentity, identityHash } from '../src/db/identity-catalogue.ts';
import { verifyMaterialClosureHardeningCatalogue } from '../src/db/material-closure-hardening-profile.ts';
import { IDENTITY_PINS } from '../src/db/identity-pins.ts';

const postgres = await startTestPostgres({ unqualifiedIdentityBaseline: true });
await postgres.clone('identity_source');
const client = new pg.Client({ connectionString: postgres.adminUrl('identity_source') });
try {
  await client.connect();
  assert.equal((await verifyMaterialClosureHardeningCatalogue(client)).state, 'verified');
  assert.equal(identityHash(release.sql), release.checksum);
  await client.query('BEGIN');
  await client.query(release.sql);
  const rows = await captureIdentity(client);
  assert.equal(rows.filter(row => row.kind === 'function').length, 12);
  assert.equal(rows.filter(row => row.kind === 'table').length, 6);
  const pins = { payload: release.checksum, catalogue: identityHash(JSON.stringify(rows)) };
  if (process.argv.includes('--write')) {
    const path = new URL('../src/db/identity-pins.ts', import.meta.url);
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, text.slice(0, text.indexOf('export const')) + `export const IDENTITY_PINS: { payload: string; catalogue: string } | null = ${JSON.stringify(pins)};\n`);
  } else assert.deepEqual(pins, IDENTITY_PINS);
  await client.query('ROLLBACK');
  assert.deepEqual(await captureIdentity(client), [], 'rollback leaves no identity object behind');
  console.log('Closed identity source reproduces its native catalogue; rollback removes every addition.');
} finally { await client.end(); await postgres.drop('identity_source'); await postgres.stop(); }
