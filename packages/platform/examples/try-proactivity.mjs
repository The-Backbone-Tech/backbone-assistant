// Disposable, account-free example: a quiet script check costs no model admission; a changed check
// starts an ordinary stub turn. Only fake signing material and a loopback HTTP request are used.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Webhook } from 'standardwebhooks';
import { createHost, removeDataHome } from '@backbone-next/platform/composition';
import { plaintextKeys } from '@backbone-next/platform/keys';

const home = mkdtempSync(join(tmpdir(), 'backbone-proactivity-'));
const host = createHost({ home, harness: 'harness-stub', keys: plaintextKeys(), schedules: { tickMs: 60_000 } });
const value = (receipt) => { assert.ok(receipt.ok, 'The local command was refused.'); return receipt.value; };
const settings = { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' };
try {
  const projectId = value(await host.call('projects.create', { name: 'Checks', kind: 'folder' })).id;
  for (const exit of [0, 10]) {
    const schedule = value(await host.call('schedules.create', {
      projectId, text: 'Summarise changes', when: 'every hour', settings, clientKey: `gate-${exit}`,
      wakeGate: { command: process.execPath, args: ['-e', `process.exit(${exit})`] },
    }));
    const run = value(await host.call('schedules.run', { id: schedule.id, clientKey: 'example' }));
    assert.equal(run.wakeGate, exit === 0 ? 'quiet' : 'wake');
    if (exit === 0) assert.equal(run.turnId, null);
    else assert.ok(run.turnId);
  }
  const made = value(await host.call('triggers.create', {
    kind: 'webhook', projectId, text: 'Inspect the event', settings, clientKey: 'signed',
    webhook: { authentication: 'standard' },
  }));
  const date = new Date();
  const body = '{"change":"example"}';
  const headers = { 'webhook-id': 'example-delivery', 'webhook-timestamp': String(Math.floor(date.getTime() / 1000)), 'webhook-signature': new Webhook(made.secret).sign('example-delivery', date, body) };
  assert.equal((await fetch(made.trigger.localUrl, { method: 'POST', headers, body })).status, 202);
  assert.equal((await fetch(made.trigger.localUrl, { method: 'POST', headers, body })).status, 409);
  console.log('OK: quiet check made no turn; changed check made a turn; signed delivery accepted once.');
} finally {
  host.close();
  await removeDataHome(home);
}
