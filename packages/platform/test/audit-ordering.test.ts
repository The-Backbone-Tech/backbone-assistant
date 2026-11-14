import { TEST_HANG_MS, waitFor } from '../../../scripts/lib/test-hang.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { coreAuditSource, exportAudit } from './fixtures/audit-collect.ts';
import { CoreLink } from '../src/composition/core.ts';
import { readAudit } from '../src/audit.ts';
import { freshHome } from './helpers.ts';
import { AUDIT_PERIOD } from './fixtures/audit-activity.ts';

test('two concurrent writers commit in ledger order even when the later commit has an earlier event time', { timeout: TEST_HANG_MS }, async () => {
  const home = freshHome(), link = await CoreLink.open({ home });
  const { appUrl } = JSON.parse(readFileSync(join(home, 'pg', 'external.json'), 'utf8')) as { appUrl: string };
  const a = new pg.Client({ connectionString: appUrl, application_name: 'audit-writer-a', statement_timeout: 240000 });
  const b = new pg.Client({ connectionString: appUrl, application_name: 'audit-writer-b', statement_timeout: 240000 });
  let pending: Promise<pg.QueryResult> | undefined;
  try {
    await a.connect(); await b.connect();
    for (const c of [a, b]) {
      await c.query('BEGIN');
      await c.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true)", [link.id.workspace, link.id.person]);
    }
    const source = coreAuditSource(link), first = await exportAudit(source, AUDIT_PERIOD);
    const firstId = (await a.query("SELECT gov.create_agent('A first', 'worker') AS id")).rows[0].id;
    pending = b.query("SELECT gov.create_agent('B blocked', 'worker') AS id"); void pending.catch(() => {});
    let blocked = false;
    await waitFor(async()=>{
      blocked = !!(await link.read(link.person(), "SELECT 1 FROM pg_stat_activity WHERE application_name='audit-writer-b' AND wait_event_type='Lock'")).rows.length;

      await new Promise(resolve => setTimeout(resolve, 10));
    return !!blocked;},'audit-ordering: SQL lock observation',{diagnostic:()=>`blocked=${blocked}`});
    assert.equal(blocked, true, 'B reached the ledger head lock after capturing its event time');
    const secondId = (await a.query("SELECT gov.create_agent('A second after B blocked', 'worker') AS id")).rows[0].id;
    const whileOpen = await exportAudit(source, { ...AUDIT_PERIOD, after: first.trailer.cursor!.id });
    assert.equal(whileOpen.header.count, 0, 'neither uncommitted writer leaks into a snapshot');
    await a.query('COMMIT'); const bId = (await pending).rows[0].id;
    const middle = await exportAudit(source, { ...AUDIT_PERIOD, after: first.trailer.cursor!.id });
    assert.deepEqual(readAudit(middle.jsonl, first.jsonl).events.map(e => e.subjectId), [firstId, secondId]);
    await b.query('COMMIT');
    const last = await exportAudit(source, { ...AUDIT_PERIOD, after: middle.trailer.cursor!.id });
    const late = readAudit(last.jsonl, middle.jsonl);
    assert.deepEqual(late.events.map(e => e.subjectId), [bId], 'cursor collects the later commit exactly once');
    assert.ok(late.events[0].at < readAudit(middle.jsonl).events[1].at, 'the late commit really has an earlier timestamp');
    assert.equal(late.events[0].receipt.previousHash, middle.trailer.cursor!.receiptHash);
    const full=await exportAudit(source,AUDIT_PERIOD);
    const raw=full.jsonl.trimEnd().split('\n').map(line=>JSON.parse(line)).filter(row=>row.type==='event');
    assert.deepEqual(raw.map(row=>row.sequence),[...raw].sort((x,y)=>BigInt(x.sequence)<BigInt(y.sequence)?-1:1).map(row=>row.sequence),'full export is in numeric ledger sequence order, not wall-clock order');
    assert.deepEqual(raw.slice(-3).map(row=>row.subjectId),[firstId,secondId,bId]);
    readAudit(full.jsonl);

  } finally {
    await a.query('ROLLBACK').catch(() => {}); await b.query('ROLLBACK').catch(() => {});
    await pending?.catch(() => {}); await a.end(); await b.end(); await link.close();
  }
});
