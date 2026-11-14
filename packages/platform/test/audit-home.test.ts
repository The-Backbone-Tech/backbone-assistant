import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readAudit } from '../src/audit.ts';
import {collectAuditHome as exportAuditHome} from './fixtures/audit-collect.ts';
import { CoreLink } from '../src/composition/core.ts';
import { freshHome, value } from './helpers.ts';
import { AUDIT_PERIOD } from './fixtures/audit-activity.ts';

function fingerprint(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (dir: string, rel = '') => { for (const name of readdirSync(dir)) {
    const file = join(dir, name), st = lstatSync(file), key = join(rel, name);
    if (st.isDirectory()) visit(file, key);
    else if (st.isFile()) result[key] = `${st.mode}:${st.mtimeMs}:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
  } }; visit(root); return result;
}
test('a stopped real embedded database is exported from a temporary copy; source files and a revoked grant never change', { timeout: TEST_HANG_MS * 2 }, async () => {
  const home = freshHome();
  // This single focused case intentionally exercises the installed embedded-database path.
  rmSync(join(home, 'pg', 'external.json'), { force: true });
  const link = await CoreLink.open({ home });
  let head: string;
  try {
    await link.createTask('Audit a stopped database');
    await link.call(link.person(), 'SELECT gov.revoke_mandate($1)', [link.id.mandate]);
    head = await link.call<string>(link.person(), 'SELECT max(seq)::text FROM app.ledger');
  } finally { await link.close(); }
  assert.equal(existsSync(join(home, 'pg', 'data', 'postmaster.pid')), false);
  const before = fingerprint(home), made = value(await exportAuditHome(home, AUDIT_PERIOD));
  const record = readAudit(made.jsonl);
  assert.equal(made.trailer.cursor!.sequence, head!);
  assert.ok(record.events.some(event => event.kind === 'mandate.revoked'));
  assert.equal(record.events.at(-1)!.kind, 'mandate.revoked', 'no replacement grant was synthesized in the snapshot');
  assert.deepEqual(fingerprint(home), before, 'not even a lock, PG control byte, vault or PID was written in the source home');
});
