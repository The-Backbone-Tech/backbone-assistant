import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.ts';

test('pairing is one use, expires, and revocation applies to pending messages', () => {
  const home = mkdtempSync(join(tmpdir(), 'channels-'));
  try {
    const db = new Ledger(home);
    const code = db.invite(1000);
    assert.equal(db.pair('telegram', 'person', code, 1001), true);
    assert.equal(db.pair('telegram', 'other', code, 1002), false);
    assert.equal(db.bound('telegram', 'person'), true);
    assert.equal(db.pair('slack', 'late', db.invite(1000), 601001), false);
    assert.equal(db.receive({ provider: 'telegram', id: '1', conversation: 'chat', sender: 'person', text: 'one' }), true);
    assert.equal(db.receive({ provider: 'telegram', id: '1', conversation: 'chat', sender: 'person', text: 'one' }), false);
    db.unbind('telegram', 'person');
    assert.equal(db.bound('telegram', 'person'), false);
    db.close();
    const reopened = new Ledger(home);
    assert.equal(reopened.pending().length, 1);
    assert.equal(reopened.bound('telegram', 'person'), false);
    reopened.close();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a sending delivery becomes unknown on reopen, and known failure is recorded', () => {
  const home = mkdtempSync(join(tmpdir(), 'channels-'));
  try {
    const db = new Ledger(home);
    assert.equal(db.createDelivery('d1', 'slack', 'room', 'answer'), true);
    assert.equal(db.beginDelivery('d1'), true);
    db.close();
    const reopened = new Ledger(home);
    reopened.recoverDeliveries();
    assert.equal(reopened.delivery('d1')?.state, 'unknown');
    assert.equal(reopened.beginDelivery('d1'), false);
    reopened.createDelivery('d2', 'telegram', 'chat', 'answer');
    assert.equal(reopened.beginDelivery('d2'), true);
    reopened.finishDelivery('d2', 'failed');
    assert.equal(reopened.beginDelivery('d2'), true);
    reopened.finishDelivery('d2', 'delivered');
    assert.deepEqual(reopened.delivery('d2'), { state: 'delivered', attempts: 2 });
    assert.equal(reopened.beginDelivery('d2'), false);
    reopened.close();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
