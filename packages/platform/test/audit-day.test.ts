import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditSha256, readAudit } from '../src/audit.ts';
import { coreAuditSource, exportAudit } from './fixtures/audit-collect.ts';
import { auditActivity } from './fixtures/audit-activity.ts';

// An independent small SIEM-style reader: only public event fields, never current Core state.
function effectsFromEvents(jsonl: string) {
  const result = new Map<string, { status: string; history: string[]; receipts: string[] }>();
  for (const event of readAudit(jsonl).events) {
    if (!event.effect) continue;
    const row = result.get(event.effect.id) ?? { status: '', history: [], receipts: [] };
    row.receipts.push(event.receipt.hash);
    if (event.disposition) {
      row.history.push(event.disposition);
      row.status = ({ held: 'awaiting_checker', approved: 'allowed', refused: 'denied', 'dispatch-started': 'dispatching' } as Record<string, string>)[event.disposition] ?? event.disposition;
    }
    result.set(event.effect.id, row);
  }
  return result;
}

test('a compressed scripted day of 24 work slots reads back every effect lifecycle and matches Core receipts one for one', { timeout: TEST_HANG_MS * 2 }, async () => {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const day = { since: start.toISOString(), until: new Date(start.getTime() + 86400000).toISOString() };
  const activity = await auditActivity();
  try {
    const { link } = activity;
    for (let hour = 0; hour < 24; hour++) {
      const task = await link.createTask(`Scheduled hour ${hour}`), run = await link.startRun(task);
      await link.say(task, `Scripted prompt for slot ${hour}`);
      const proposed = await link.proposeWrite(run, { fixture: hour }, `Scripted local effect ${hour}`, `audit-day-${hour}`);
      assert.equal(proposed.status, 'allowed');
      const claim = await link.claimEffect(proposed.id); assert.equal(await link.beginDispatch(proposed.id, claim), true);
      await link.observe(proposed.id, claim, hour % 3 === 0 ? 'unknown' : hour % 3 === 1 ? 'failed' : 'succeeded', 'a'.repeat(64), 'Scripted local dispatcher outcome.');
      await link.answer(run, task, `Scripted answer for slot ${hour}`); await link.finishRun(run, 'succeeded');
    }
    await link.call(link.person(), 'SELECT gov.revoke_mandate($1)', [link.id.mandate]);
    await link.call(link.person(),'SELECT gov.register_piece($1::jsonb)',[JSON.stringify({manifest:1,id:'test.invalid/guess-piece-label',kind:'module',version:'1.0.0',digest:'sha256:'+auditSha256('guess-piece-bytes'),capabilities:{planes:['personal'],operations:['workspace.write_document'],effectClasses:[2],network:[],secrets:'none'}})]);
    const made = await exportAudit(coreAuditSource(link), day), lifecycle = effectsFromEvents(made.jsonl);
    const receipts = (await link.read<{ id: string; status: string }>(link.person(), 'SELECT id, status FROM app.effects ORDER BY id')).rows;
    assert.deepEqual([...lifecycle.keys()].sort(), receipts.map(row => row.id));
    for (const receipt of receipts) assert.equal(lifecycle.get(receipt.id)!.status, receipt.status, `${receipt.id}: reconstructed from events alone`);
    const record = readAudit(made.jsonl);
    const candidates = new Set(['{}', ...Array.from({length:24},(_,i)=>`{"fixture": ${i}}`)].map(auditSha256));
    for(const event of record.events){
      for(const key of ['args_hash','proposal_hash','intent_hash']){
        assert.equal(key in event.data,false);assert.ok(event.omitted.includes(`payload.${key}`));
      }
    }
    for(const candidate of candidates)assert.equal(made.jsonl.includes(candidate),false,'known arguments cannot be confirmed by their unkeyed hash from the default export');
    const opted=readAudit((await exportAudit(coreAuditSource(link),{...day,includeContent:true})).jsonl);
    assert.equal(opted.events.filter(e=>e.kind==='effect.proposed'&&candidates.has(String(e.data.args_hash))&&e.effect?.class===2).length,24,'positive control: opt-in exposes all 24 guessable scripted arguments');

    // Give the attacker even the exact omitted values and microseconds. A real attack must
    // guess them; this stronger oracle reproduces the Core hash using public SQL primitives.
    const guessed=(await link.read<{sequence:string;hash:string;reproduced:string;keys:string[]}>(link.person(),`SELECT seq::text AS sequence,hash,
      encode(sha256(convert_to(prev_hash || '|' || jsonb_build_object('workspace',workspace_id,'seq',seq,'type',entry_type,'actor',actor_id,'subject',subject,
        'payload',payload,'at',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,'UTF8')),'hex') AS reproduced,
      ARRAY(SELECT jsonb_object_keys(payload)) AS keys FROM app.ledger ORDER BY seq`)).rows;
    const seen=new Set(guessed.flatMap(row=>row.keys));
    for(const key of ['args_hash','operation','slug','worker','piece','intent_hash'])assert.ok(seen.has(key),`attack covers omitted ${key}`);
    for(const row of guessed){
      assert.equal(row.reproduced,row.hash,'positive control: public primitives reproduce the exact ledger commitment');
      assert.equal(made.jsonl.includes(row.reproduced),false,'no receipt, previous hash, head or scan anchor confirms the correct guess');
      assert.equal(opted.events.find(event=>event.sequence===row.sequence)!.receipt.hash,row.reproduced,'raw opt-in exposes the guessing oracle');
    }
    assert.equal(record.header.receiptHashMode,'keyed-hmac-sha256');assert.equal(opted.header.receiptHashMode,'raw-sha256');
    assert.equal(await link.call(link.person(),"SELECT has_function_privilege(current_user,'sec.digest(text)','EXECUTE')"),false,'no unavailable Core privilege is assumed');

    assert.ok(record.events.some(event => event.kind === 'mandate.revoked'));
    assert.equal(record.events.filter(event => event.kind === 'effect.proposed').length, receipts.length);
    const ledger = (await link.read<{ sequence: string; hash: string }>(link.person(), 'SELECT seq::text AS sequence, hash FROM app.ledger ORDER BY app.ledger.seq')).rows;
    assert.deepEqual(record.events.map(event => [event.sequence, event.receipt.hash]), await Promise.all(ledger.map(async row => [row.sequence, await coreAuditSource(link).digester().redigest(row.hash)])));
    assert.ok(record.events.length > 250); assert.ok(receipts.length >= 30);
  } finally { await activity.close(); }
});
