// Durable projection ordering must follow observed progress even when the wall clock moves back.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadItems, saveItem } from '../src/triage/items.ts';
import type { Connection, Item } from '../src/triage/service.ts';

test('a later observation in the same run wins after a wall-clock correction', () => {
  const home = mkdtempSync(join(tmpdir(), 'triage-item-order-'));
  const connection = { provider: 'fake', account: 'owner@example.test', registration: { id: 'registration' } } as Connection;
  const mailbox = { provider: connection.provider, account: connection.account, registration: connection.registration.id };
  const first = { id: 'm01', version: '1', from: { name: 'Sender', address: 'sender@example.test' }, subject: 'Listed version', date: '2026-10-27T09:00:00Z', run: 'run', order: 1, revision: 1, startedAt: '2026-10-27T10:00:00Z', done: false, mailbox };
  const second = { ...first, version: '2', subject: 'Actual read version', revision: 2, startedAt: '2026-10-27T09:59:00Z', done: true };
  try {
    saveItem(home, first as Item); saveItem(home, second as Item);
    const current = loadItems(home, { connection, items: { m01: first } }, { connection, items: {} });
    assert.equal(current.items.m01.version, '2');
    assert.equal(current.items.m01.subject, second.subject);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
