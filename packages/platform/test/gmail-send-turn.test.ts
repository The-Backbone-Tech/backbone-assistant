import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gmailHost, send, draft } from './gmail-send-fixture.ts';
import { value } from './helpers.ts';

for (const engine of ['harness-pi', 'harness-codex'] as const) {
  test(`${engine}: unsigned Gmail send is held even with the door open`, { timeout: TEST_HANG_MS * 2 }, async () => {
    const f = await gmailHost(engine);
    try {
      assert.equal((await f.run([send()])).status, 'done');
      assert.deepEqual(f.calls(), []);
      assert.deepEqual((await f.held()).map(h => [h.tool, h.state, h.standing]), [['send_gmail_message', 'waiting', undefined]]);
      assert.equal((await f.host.call('work.now', { projectId: f.project.id })).needsYou.filter(n => n.kind === 'connector').length, 1);
    } finally { await f.close(); }
  });
  test(`${engine}: the person's tool signature deduplicates identical same-turn sends and keeps a standing receipt`, { timeout: TEST_HANG_MS * 2 }, async () => {
    const f = await gmailHost(engine);
    try {
      // A permission covers this tool; the draft tool has its own separate permission.
      value(await f.sign());
      const turn = await f.run([send(), send()]);
      assert.equal(turn.status, 'done');
      assert.deepEqual(f.calls().map(c => [c.tool, c.args]), [['send_gmail_message', send().args]]);
      const held = await f.held();
      assert.equal(held.length, 1);
      assert.equal(held[0].state, 'sent');
      assert.equal(held[0].standing, true);
      assert.ok(held[0].effect);
      assert.ok(turn.work?.steps.some(s => s.kind === 'note' && s.label.includes('send_gmail_message')));
      assert.ok(held[0].standingSignatureId);
      assert.ok(held[0].dispatchReceipt);
      assert.deepEqual((await f.host.call('work.now', { projectId: f.project.id })).needsYou.filter(n => n.kind === 'connector'), []);
    } finally { await f.close(); }
  });
  test(`${engine}: implicit and explicit signature controls share one send and receipt in either order`, { timeout: TEST_HANG_MS * 2 }, async () => {
    const f = await gmailHost(engine);
    try {
      value(await f.sign());
      for (const explicitFirst of [false, true]) {
        const implicit = send('Variant ' + explicitFirst); delete implicit.args.include_signature;
        const explicit = send('Variant ' + explicitFirst);
        // Also move the fixed control to the first key: field order cannot create another intent.
        explicit.args = { include_signature: false, ...explicit.args };
        const pair = explicitFirst ? [explicit, implicit] : [implicit, explicit];
        assert.equal((await f.run(pair)).status, 'done');
      }
      assert.equal(f.calls().length, 2);
      assert.equal(f.deliveries().length, 2);
      assert.equal((await f.held()).length, 2);
      assert.ok((await f.held()).every(h => h.state === 'sent'));
    } finally { await f.close(); }
  });
  test(`${engine}: UNKNOWN Gmail send stops the turn, leaves its standing receipt and is never replayed`, { timeout: TEST_HANG_MS * 2 }, async () => {
    const f = await gmailHost(engine, true);
    try {
      value(await f.sign());
      const turn = await f.run([send(), send('Different text.', 'other@example.com')]);
      assert.equal(turn.status, 'stopped');
      assert.match(turn.answer?.text ?? '', /UNKNOWN/);
      assert.deepEqual(f.calls().map(c => c.args), [send().args]);
      const held = await f.held();
      assert.deepEqual(held.map(h => [h.state, h.standing]), [['unknown', true]]);
      assert.equal(f.continuations(), 0);
      // Reopening preserves the receipt; person-side release cannot retry its dispatch.
      await f.reopen();
      assert.equal((await f.held())[0].effect, held[0].effect);
      value(await f.host.releaseConnectorCall(held[0].effect, held[0].argsHash));
      assert.deepEqual(f.calls().map(c => c.args), [send().args]);
      assert.equal((await f.held())[0].state, 'unknown');
    } finally { await f.close(); }
  });
  test(`${engine}: signing a draft does not sign the separate send tool`, { timeout: TEST_HANG_MS * 2 }, async () => {
    const f = await gmailHost(engine);
    try {
      value(await f.sign('draft_gmail_message'));
      assert.equal((await f.run([draft(), send()])).status, 'done');
      assert.deepEqual(f.calls().map(c => [c.tool, c.args]), [['draft_gmail_message', draft().args]]);
      const held = await f.held();
      assert.equal(held.find(h => h.tool === 'draft_gmail_message')?.state, 'sent');
      assert.equal(held.find(h => h.tool === 'send_gmail_message')?.state, 'waiting');
    } finally { await f.close(); }
  });
  test(`${engine}: a local Gmail stand-in sends only the reviewed recipients, body and inline attachment once`, { timeout: TEST_HANG_MS * 2 }, async () => {
    const f = await gmailHost(engine);
    try {
      const call = send();
      delete call.args.include_signature; // Exercise the upstream true default: Host must disable it before showing the call.
      Object.assign(call.args, { cc: 'copy@example.com', bcc: 'blind@example.com',
        attachments: [{ filename: 'reviewed.txt', mime_type: 'text/plain', content: Buffer.from('Reviewed attachment bytes.').toString('base64') }] });
      const turn = await f.run([call]);
      const held = (await f.held())[0];
      const reviewed = JSON.parse(held.statement.slice(held.statement.indexOf('{')));
      const expected: Record<string, unknown> = { ...call.args, include_signature: false };
      assert.deepEqual(reviewed, expected);
      assert.deepEqual(held.args, reviewed);
      assert.equal(held.turnId, turn.id);
      assert.equal(held.state, 'waiting');
      assert.deepEqual(f.calls(), []);
      assert.ok(turn.work?.steps.some(s => s.kind === 'note' && s.label.includes('send_gmail_message')));
      // The native person action releases this statement, never a reusable tool grant.
      const released = value(await f.host.releaseConnectorCall(held.effect, held.argsHash));
      assert.equal(released.state, 'sent');
      assert.equal(released.standing, undefined);
      assert.ok(released.personReleasedAt);
      assert.ok(released.dispatchReceipt);
      assert.deepEqual(f.calls().map(c => c.args), [reviewed], 'raw wire arguments equal the released view');
      assert.deepEqual(f.deliveries(), [{ from: reviewed.user_google_email, to: reviewed.to, cc: reviewed.cc, bcc: reviewed.bcc,
        subject: reviewed.subject, body: reviewed.body, attachments: [{ filename: 'reviewed.txt', mime_type: 'text/plain',
          bytes: [...Buffer.from('Reviewed attachment bytes.')] }] }], 'decoded bytes and recipients match the review, without a saved footer');
      assert.deepEqual((await f.host.call('work.now', { projectId: f.project.id })).needsYou.filter(n => n.kind === 'connector'), []);
      await f.reopen();
      const receipt = (await f.held()).find(h => h.effect === held.effect)!;
      assert.equal(receipt.state, 'sent');
      assert.equal(receipt.turnId, turn.id);
      assert.equal(receipt.personReleasedAt, released.personReleasedAt);
      assert.deepEqual(receipt.dispatchReceipt, released.dispatchReceipt);
      value(await f.host.releaseConnectorCall(receipt.effect, receipt.argsHash));
      assert.equal(f.calls().length, 1, 'releasing the retained receipt cannot dispatch it again');
      await f.run([send('Another message.', 'another@example.com')]);
      assert.equal((await f.held()).find(h => h.args.body === 'Another message.')?.state, 'waiting');
      assert.equal(f.calls().length, 1, 'one person release authorizes no subsequent send');
    } finally { await f.close(); }
  });
}
