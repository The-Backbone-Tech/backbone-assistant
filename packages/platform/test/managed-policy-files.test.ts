import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { createProtectedReader, openPolicyFile } from '../src/policy/secure-files.ts';
import { policyFor } from '../src/policy/source.ts';
import { document, systemFixture } from './policy-fixture.ts';
import { freshDir } from './helpers.ts';

// No mocked metadata, opens or ACL command in this test. The boundary is current-user-owned.
test('real temporary tree rejects linked files, linked parents, writable ancestors and no-follow opens', () => {
  const root = fs.realpathSync(freshDir('policy-real-walk-'));
  const owner = process.getuid!(), reader = createProtectedReader(root, owner);
  fs.chmodSync(root, 0o700);
  const folder = join(root, 'protected'), target = join(folder, 'policy.json');
  fs.mkdirSync(folder, { mode: 0o700 }); fs.writeFileSync(target, '{}', { mode: 0o600 });
  assert.equal(reader.read(target).toString(), '{}');
  const linkedFile = join(folder, 'linked.json'); fs.symlinkSync(target, linkedFile);
  assert.throws(() => reader.read(linkedFile), /not be symlinks/);
  // Directly exercise the real fd boundary: removing O_NOFOLLOW makes this assertion fail.
  assert.throws(() => openPolicyFile(linkedFile), error => (error as NodeJS.ErrnoException).code === 'ELOOP');
  const linkedParent = join(root, 'linked-parent'); fs.symlinkSync(folder, linkedParent);
  assert.throws(() => reader.read(join(linkedParent, 'policy.json')), /not be symlinks/);
  fs.chmodSync(folder, 0o770);
  assert.throws(() => reader.read(target), /be protected/);
  fs.chmodSync(folder, 0o700);
  assert.equal(reader.read(target).toString(), '{}');
  assert.throws(() => createProtectedReader(root, owner + 1).read(target), /trusted owner/);
});
test('cache reuses checked bytes and ACL work, then invalidates on same-size content, trust and ancestor metadata changes', t => {
  const fixture = systemFixture(t), read = fs.readFileSync.bind(fs), exec = childProcess.execFileSync.bind(childProcess);
  let reads = 0, acl = 0;
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => { reads++; return read(...args); });
  t.mock.method(childProcess, 'execFileSync', (...args: Parameters<typeof childProcess.execFileSync>) => { acl++; return exec(...args); });
  assert.equal(policyFor('a').status, 'verified'); const first = { reads, acl };
  assert.equal(policyFor('b').status, 'verified'); assert.deepEqual({ reads, acl }, first);
  const path = fixture.mapping.get(fixture.paths.policy)!;
  const bytes = fs.readFileSync(path, 'utf8').replace('test-company', 'evil-company'); fs.writeFileSync(path, bytes);
  assert.equal(policyFor('a').status, 'refused'); assert.ok(reads > first.reads);
  fixture.update(document()); assert.equal(policyFor('a').status, 'verified');
  // chmod on an ancestor invalidates even if the three policy files did not change.
  const before = reads, parent = join(path, '..'); fs.chmodSync(parent, 0o750);
  assert.equal(policyFor('a').status, 'verified'); assert.ok(reads > before);
  fs.writeFileSync(fixture.mapping.get(fixture.paths.trust)!, '{}'); assert.equal(policyFor('a').status, 'refused');
});
test('a cached valid signature still expires at the signed instant', t => {
  systemFixture(t, document({}, {}, { notAfter: '2027-01-01T00:00:00Z' }));
  const clock = t.mock.method(Date, 'now', () => Date.parse('2026-11-10T00:00:00Z'));
  assert.equal(policyFor('a').status, 'verified');
  clock.mock.mockImplementation(() => Date.parse('2027-01-01T00:00:00Z'));
  const result = policyFor('b'); assert.equal(result.status, 'refused');
  if (result.status === 'refused') assert.equal(result.code, 'expired');
});
