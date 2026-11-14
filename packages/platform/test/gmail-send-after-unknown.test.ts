// Gmail preset acceptance on the qualified Host: UNKNOWN pauses this tool, not every
// action on the connection. Drafts create nothing visible to a recipient.
import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gmailHost, send, draft } from './gmail-send-fixture.ts';
import { value } from './helpers.ts';

for (const engine of ['harness-pi', 'harness-codex'] as const) {
  test(`${engine}: an unresolved UNKNOWN on the connection holds a different send in a new turn`, { timeout: TEST_HANG_MS * 2 }, async t => {
    const f = await gmailHost(engine, true);
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
      assert.deepEqual(f.calls().map(c => c.args), [send().args], 'a standing signature must not dispatch another send until this tool’s UNKNOWN is resolved');
      assert.equal(held.find(h => h.args.body === different.args.body)?.state, 'waiting');
    } finally { await f.close(); }
  });
  test(`${engine}: a signed draft after an UNKNOWN send stays available in a new turn`, { timeout: TEST_HANG_MS * 2 }, async t => {
    const f = await gmailHost(engine, true);
    try {
      value(await f.sign());
      value(await f.sign('draft_gmail_message', false));
      assert.equal((await f.run([send(), draft()])).status, 'stopped');
      assert.deepEqual(f.calls().map(c => c.tool), ['send_gmail_message'], 'same turn: UNKNOWN stops the signed draft too');
      const original = (await f.held()).find(h => h.tool === 'send_gmail_message')!;
      assert.equal(original.state, 'unknown');
      const later = await f.run([draft()]);
      const held = await f.held();
      const drafted = held.find(h => h.tool === 'draft_gmail_message');
      t.diagnostic(JSON.stringify({ laterTurn: later.status, dispatchedTools: f.calls().map(c => c.tool), draftState: drafted?.state, draftStanding: drafted?.standing }));
      assert.equal(held.find(h => h.effect === original.effect)?.state, 'unknown', 'the send is still unresolved');
      assert.equal(f.calls().filter(c => c.tool === 'send_gmail_message').length, 1, 'the UNKNOWN send itself is never replayed');
      assert.equal(drafted?.state, 'sent', 'a draft creates nothing visible to the recipient and is a different tool');
      assert.equal(drafted?.standing, true);
      assert.deepEqual(f.calls().map(c => c.tool), ['send_gmail_message', 'draft_gmail_message'], 'the separate signed draft is dispatched once');
    } finally { await f.close(); }
  });

}
