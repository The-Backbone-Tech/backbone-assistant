// A joined workspace's error reply is a refusal only on explicit evidence: the body says outcome REFUSED,
// or access ended (401, or accessEnded). Any other reply, from the workspace or from something in between
// (a proxy's 500 or 502, a 404 from another server, a body that does not parse), leaves the outcome not known.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sharedCertificate } from '../src/composition/shared-certificate.ts';
import { plaintextKeys } from '../src/keys/vault.ts';
import { ACCESS_ENDED, RemoteClient, RemoteError } from '../src/remote/client.ts';

/** Sends one change through the real client to a local HTTPS server that answers `status` with `body`. */
async function answered(status: number, body: string): Promise<RemoteError> {
  const home = mkdtempSync(join(tmpdir(), 'remote-reply-'));
  const tls = await sharedCertificate(home, plaintextKeys());
  const server = createServer(tls, (req, res) => { req.resume(); req.on('end', () => res.writeHead(status, { 'content-type': 'application/json' }).end(body)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new RemoteClient({ origin: `https://127.0.0.1:${(server.address() as { port: number }).port}`, fingerprint: tls.fingerprint }, 's'.repeat(40));
    try { await client.call('identity.role', { personId: 'colleague', role: 'admin' }); } catch (error) { assert.ok(error instanceof RemoteError, String(error)); return error; }
    throw new Error('the reply was taken as success');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
}
const unknownWords = /outcome is (unknown|not known).*Read the work before sending it again/;

test('a 500 without an outcome, as a proxy or a failing server sends after a commit, is not known', async () => {
  const error = await answered(500, JSON.stringify({ error: 'internal error' }));
  assert.equal(error.outcome, 'UNKNOWN');
  assert.equal(error.accessEnded, false);
  assert.match(error.message, unknownWords);
  assert.doesNotMatch(error.message, /internal error/, 'text the workspace did not mark is not shown as its reason');
});

test('error replies without an explicit outcome are not known, whatever their status', async () => {
  for (const status of [400, 403, 404, 409, 502]) {
    const error = await answered(status, JSON.stringify({ error: 'The request was refused.' }));
    assert.equal(error.outcome, 'UNKNOWN', String(status));
    assert.match(error.message, unknownWords, String(status));
  }
  // The workspace's own "No such endpoint." carries no outcome either: the client only asks for endpoints the
  // workspace has, so a 404 means something else answered, and nothing proves the change was not made.
  assert.equal((await answered(404, JSON.stringify({ error: 'No such endpoint.' }))).outcome, 'UNKNOWN');
});

test('an explicit refusal is refused, with the workspace\'s reason', async () => {
  for (const status of [403, 409]) {
    const error = await answered(status, JSON.stringify({ error: 'This request is not permitted for this workspace or project.', outcome: 'REFUSED' }));
    assert.equal(error.outcome, 'REFUSED', String(status));
    assert.equal(error.status, status);
    assert.equal(error.message, 'This request is not permitted for this workspace or project.');
  }
});

test('an explicit unknown outcome stays not known, with the workspace\'s words', async () => {
  const error = await answered(503, JSON.stringify({ error: 'The request outcome is unknown. Check the work, membership and receipts before sending it again.', outcome: 'UNKNOWN' }));
  assert.equal(error.outcome, 'UNKNOWN');
  assert.match(error.message, /Check the work, membership and receipts/);
});

test('access that ended is a refusal and says so', async () => {
  for (const [status, body] of [[401, JSON.stringify({ error: 'A workspace session is required.' })], [403, JSON.stringify({ error: 'Access ended.', accessEnded: true, outcome: 'REFUSED' })]] as const) {
    const error = await answered(status, body);
    assert.deepEqual([error.outcome, error.accessEnded, error.message], ['REFUSED', true, ACCESS_ENDED], String(status));
  }
});

test('a reply that does not parse is not known', async () => {
  for (const status of [200, 409, 502]) {
    const error = await answered(status, '<html>Bad Gateway</html>');
    assert.equal(error.outcome, 'UNKNOWN', String(status));
    assert.match(error.message, unknownWords);
  }
});

/** Opens the event stream through the real client against a server that answers `status` with `body`. */
async function streamAnswered(status: number, body: string): Promise<RemoteError> {
  const home = mkdtempSync(join(tmpdir(), 'remote-stream-'));
  const tls = await sharedCertificate(home, plaintextKeys());
  const server = createServer(tls, (req, res) => { req.resume(); req.on('end', () => res.writeHead(status, { 'content-type': 'application/json' }).end(body)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new RemoteClient({ origin: `https://127.0.0.1:${(server.address() as { port: number }).port}`, fingerprint: tls.fingerprint }, 's'.repeat(40));
    try { for await (const _ of client.events()) throw new Error('the reply was taken as an event'); } catch (error) { assert.ok(error instanceof RemoteError, String(error)); return error; }
    throw new Error('the stream ended as if it had opened');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
}

test('the event stream follows the same rule: refused only on the workspace\'s explicit word', async () => {
  for (const [status, body] of [[404, JSON.stringify({ error: 'No such endpoint.' })], [403, '<html>Forbidden</html>'], [409, JSON.stringify({ error: 'busy', outcome: 'UNKNOWN' })]] as const) {
    const error = await streamAnswered(status, body);
    assert.equal(error.outcome, 'UNKNOWN', String(status));
    assert.equal(error.accessEnded, false, String(status));
  }
  const refused = await streamAnswered(403, JSON.stringify({ error: 'The workspace event stream is not permitted.', outcome: 'REFUSED' }));
  assert.deepEqual([refused.outcome, refused.message], ['REFUSED', 'The workspace event stream is not permitted.']);
  assert.equal((await streamAnswered(429, JSON.stringify({ error: 'Temporary problem.', outcome: 'UNKNOWN' }))).outcome, 'UNKNOWN');
  const ended = await streamAnswered(401, JSON.stringify({ error: 'A workspace session is required.' }));
  assert.deepEqual([ended.outcome, ended.accessEnded], ['REFUSED', true]);
});
