import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectorHost, send, draft } from './connector-pause-fixture.ts';
import { value } from './helpers.ts';

for (const neutral of [false, true]) for (const engine of ['harness-pi', 'harness-codex', 'harness-acp'] as const) {
  test(`${neutral ? 'neutral' : 'Gmail-named'} ${engine}: an unresolved UNKNOWN on the connection holds a different send in a new turn`, { timeout: TEST_HANG_MS * 2 }, async t => {
    const f = await connectorHost(engine, true, neutral);
    try {
      value(await f.sign());
      const first = await f.run([send(), send('Same-turn different text.', 'same-turn@example.com')]);
      assert.equal(first.status, 'stopped');
      assert.deepEqual(f.calls().map(c => c.args), [send().args], 'same turn: engine stops before a different send');
      const original = (await f.held())[0];
      assert.equal(original.state, 'unknown');
      const different = send('New-turn different text.', 'new-turn@example.com');
      const later = await f.run([different]);
      const held = await f.held();
      t.diagnostic(JSON.stringify({ sameTurnDispatches: 1, totalDispatchesAfterNewTurn: f.calls().length, laterTurn: later.status, receipts: held.map(h => ({ state: h.state, standing: h.standing, body: h.args.body })) }));
      assert.equal(held.find(h => h.effect === original.effect)?.state, 'unknown', 'the first call was not settled');
      assert.equal(f.calls().filter(c => c.args.body === send().args.body).length, 1, 'the UNKNOWN call itself is never replayed');
      assert.deepEqual(f.calls().map(c => c.args), [send().args], 'connection pause: a standing signature must not dispatch a different effect until the connection UNKNOWN is settled');
      assert.equal(held.find(h => h.args.body === different.args.body)?.state, 'waiting');
    } finally { await f.close(); }
  });
  test(`${neutral ? 'neutral' : 'Gmail-named'} ${engine}: a signed draft after an UNKNOWN send on the same connection is released in a new turn`, { timeout: TEST_HANG_MS * 2 }, async t => {
    const f = await connectorHost(engine, true, neutral);
    try {
      value(await f.sign());
      value(await f.sign('draft_gmail_message', false));
      assert.equal((await f.run([send(), draft()])).status, 'stopped');
      assert.deepEqual(f.calls().map(c => c.tool), ['send_gmail_message'], 'same turn: UNKNOWN stops the signed draft too');
      const original = (await f.held()).find(h => h.tool === (neutral ? 'send_record_message' : 'send_gmail_message'))!;
      assert.equal(original.state, 'unknown');
      const later = await f.run([draft()]);
      const held = await f.held();
      const drafted = held.find(h => h.tool === (neutral ? 'draft_record_message' : 'draft_gmail_message'));
      t.diagnostic(JSON.stringify({ laterTurn: later.status, dispatchedTools: f.calls().map(c => c.tool), draftState: drafted?.state, draftStanding: drafted?.standing }));
      assert.equal(held.find(h => h.effect === original.effect)?.state, 'unknown', 'the send is still unresolved');
      assert.equal(f.calls().filter(c => c.tool === 'send_gmail_message').length, 1, 'the UNKNOWN send itself is never replayed');
      // 10 November 2026, owner direction: a send is a signed tool like any other; a draft is a different outside action.
      assert.equal(drafted?.state, 'sent', 'tool pause: an UNKNOWN send does not pause a separately signed draft');
      assert.deepEqual(f.calls().map(c => c.tool), ['send_gmail_message', 'draft_gmail_message'], 'the signed draft is dispatched once');
    } finally { await f.close(); }
  });

}
