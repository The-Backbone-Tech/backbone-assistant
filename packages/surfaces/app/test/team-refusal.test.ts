// A Team change refused by name reaches the page as a refused receipt, over the app's own bridge and over
// a workspace joined through the HTTP bridge; anything else stays not known.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { AutomationSetupRefused, CoreRefusal, IdentityRefused, IdentityUnavailable } from '@backbone-next/platform/composition';
import { RemoteClient, RemoteError } from '@backbone-next/platform/remote/client';
import { createServer } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callFromRenderer } from '../electron/renderer-api.ts';
import { changeFailure } from '../src/lib/refusal.ts';

const throwing = (error: unknown) => ({ call: async () => { throw error; } }) as never;
const create = { personId: 'colleague', projectId: 'project', name: 'Weekly helper' };

test('an automation refused for want of a shared-work model is a refused receipt that names Shared work', async () => {
  const answer = await callFromRenderer(throwing(new AutomationSetupRefused('Shared engine could not load: no key.')), 'identity.automation.create', create);
  assert.deepEqual(answer, { ok: false, reason: 'SHARED_WORK_REQUIRED', outcome: 'REFUSED', detail: 'Automation was not created. Configure Settings › AI and models › Shared work. Shared engine could not load: no key.' });
  assert.deepEqual(changeFailure(answer), { kind: 'refused', detail: 'Automation was not created. Configure Settings › AI and models › Shared work. Shared engine could not load: no key.', sharedWork: true });
});

test('the other named refusals of the identity family are refused receipts for every Team change', async () => {
  for (const method of ['identity.invite', 'identity.role', 'identity.remove', 'identity.share', 'identity.automation.revoke', 'identity.automation.run'] as const) {
    const answer = await callFromRenderer(throwing(new IdentityRefused('NOT_FOUND')), method, {});
    assert.deepEqual(answer, { ok: false, reason: 'NOT_FOUND', outcome: 'REFUSED', detail: new IdentityRefused().message }, method);
    assert.equal(changeFailure(answer).kind, 'refused', method);
  }
  const paused = await callFromRenderer(throwing(new IdentityUnavailable()), 'identity.role', {});
  assert.deepEqual(changeFailure(paused), { kind: 'refused', detail: new IdentityUnavailable().message, sharedWork: false });
});

test('a refusal from a workspace joined over the HTTP bridge is refused; its unknown answer stays not known', async () => {
  const refusedThere = new RemoteError('Your message was not sent. The workspace owner must configure a shared model for Pi.', 'REFUSED', 409);
  const answer = await callFromRenderer(throwing(refusedThere), 'identity.automation.create', create);
  assert.deepEqual(changeFailure(answer), { kind: 'refused', detail: refusedThere.message, sharedWork: false }, 'a colleague cannot set the owner\'s shared work, so no link is offered');
  const unknown = new RemoteError('The request outcome is unknown. Check the work, membership and receipts before sending it again.', 'UNKNOWN', 503);
  await assert.rejects(callFromRenderer(throwing(unknown), 'identity.automation.create', create), (error) => error === unknown);
  assert.deepEqual(changeFailure(unknown), { kind: 'unknown' });
});

test('an ordinary throw stays thrown and not known, even when its text names a refusal', async () => {
  const lost = new Error("Error invoking remote method 'api': AutomationSetupRefused: Automation was not created.");
  await assert.rejects(callFromRenderer(throwing(lost), 'identity.automation.create', create), (error) => error === lost);
  assert.deepEqual(changeFailure(lost), { kind: 'unknown' });
  // A database answer counts only when the server refused the statement; a dropped connection does not.
  const DatabaseError = createRequire(import.meta.resolve('@backbone-next/platform'))('pg').DatabaseError;
  const dropped = new DatabaseError('terminating connection', 0, 'error'); Object.assign(dropped, { severity: 'FATAL', code: '08006' });
  const droppedRefusal = new CoreRefusal('denied', 'terminating connection', { cause: dropped });
  await assert.rejects(callFromRenderer(throwing(droppedRefusal), 'identity.role', {}), (error) => error === droppedRefusal);
  const refusedRow = new DatabaseError('An owner must keep access to this workspace.', 0, 'error'); Object.assign(refusedRow, { severity: 'ERROR', code: 'P0001' });
  assert.equal(changeFailure(await callFromRenderer(throwing(new CoreRefusal('denied', refusedRow.message, { cause: refusedRow })), 'identity.role', {})).kind, 'refused');
});

test('a call that is not a Team change keeps its throw, and a refused receipt passes through as it came', async () => {
  const refusal = new IdentityRefused();
  await assert.rejects(callFromRenderer(throwing(refusal), 'identity.get', {}), (error) => error === refusal);
  await assert.rejects(callFromRenderer(throwing(refusal), 'turns.send', {}), (error) => error === refusal);
  const receipt = { ok: false, reason: 'INVALID', outcome: 'REFUSED', detail: 'An owner must keep access to this workspace.' };
  assert.equal(await callFromRenderer({ call: async () => receipt } as never, 'identity.role', {}), receipt);
  assert.deepEqual(changeFailure(receipt), { kind: 'refused', detail: receipt.detail, sharedWork: false });
  assert.deepEqual(changeFailure({ ok: false, reason: 'NOT_AVAILABLE', outcome: 'UNKNOWN', detail: 'The response could not be confirmed.' }), { kind: 'unknown' });
});

/** A Team change sent through the real remote client to a local HTTPS server answering `status` with `body`, as a joined window sends it. */
async function joinedAnswer(status: number, body: unknown): Promise<unknown> {
  const { sharedCertificate } = await import('@backbone-next/platform/composition/shared-certificate');
  const { plaintextKeys } = await import('@backbone-next/platform/keys');
  const home = mkdtempSync(join(tmpdir(), 'team-refusal-'));
  const tls = await sharedCertificate(home, plaintextKeys());
  const server = createServer(tls, (req, res) => { req.resume(); req.on('end', () => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new RemoteClient({ origin: `https://127.0.0.1:${(server.address() as { port: number }).port}`, fingerprint: tls.fingerprint }, 's'.repeat(40));
    return await callFromRenderer({ call: (method: never, args: never) => client.call(method, args) } as never, 'identity.automation.create', create).catch((error: unknown) => ({ thrown: error }));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
}

test('through the real remote client, only an explicit refusal reaches the page as refused', async () => {
  // A 500 that does not say what happened (a proxy, or a failure after the change committed) is not known.
  const lost = await joinedAnswer(500, { error: 'internal error' }) as { thrown?: unknown };
  assert.ok(lost.thrown instanceof RemoteError && lost.thrown.outcome === 'UNKNOWN', 'not turned into a refused receipt');
  assert.deepEqual(changeFailure(lost.thrown), { kind: 'unknown' });
  const refused = await joinedAnswer(409, { error: 'Your message was not sent. The workspace owner must configure a shared model for Pi.', outcome: 'REFUSED' });
  assert.deepEqual(changeFailure(refused), { kind: 'refused', detail: 'Your message was not sent. The workspace owner must configure a shared model for Pi.', sharedWork: false });
  const unknown = await joinedAnswer(503, { error: 'The request outcome is unknown.', outcome: 'UNKNOWN' }) as { thrown?: unknown };
  assert.deepEqual(changeFailure(unknown.thrown), { kind: 'unknown' });
});
