import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { verifyPolicy, PolicyRefused, strictJson } from '../src/policy/verify.ts';
import { governedPolicy, policyFor, policyPaths, requirePolicy } from '../src/policy/source.ts';
import { auditDecision, engineDecision, harnessDecision, keyDecision, routeDecision, standingDecision, telemetryDecision, policyDescription } from '../src/policy/decisions.ts';
import { document, signed, verified, decisionFixture, systemFixture } from './policy-fixture.ts';

function code(input: Parameters<typeof verifyPolicy>[0], expected: string) {
  const result = verifyPolicy(input);
  assert.equal(result.status, 'refused', JSON.stringify(result));
  if (result.status === 'refused') assert.equal(result.code, expected);
}
test('exact signed bytes verify, immutable policy and safe fixed-setting description', () => {
  const result = verifyPolicy(signed(document({ auditContent: false })));
  assert.equal(result.status, 'verified');
  if (result.status !== 'verified') return;
  assert.equal(result.policy.id, 'test-company');
  assert.ok(Object.isFrozen(result.policy.requirements));
  assert.match(policyDescription(result).detail, /test-company version 2; fixed by policy: auditContent:/);
});
test('tampered, unsigned, wrong-key and non-Ed25519 signatures refuse', () => {
  const input = signed();
  code({ ...input, bytes: Buffer.concat([input.bytes, Buffer.from(' ')]) }, 'signature');
  code({ ...input, signature: Buffer.alloc(0) }, 'signature');
  const other = signed(); other.trust = Buffer.from(JSON.stringify({ ...JSON.parse(other.trust.toString()), keys: [generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' })] })); code(other, 'signature');
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  code({ ...input, trust: Buffer.from(JSON.stringify({ ...JSON.parse(input.trust.toString()), keys: [ec.publicKey.export({ type: 'spki', format: 'pem' })] })) }, 'signature');
});
test('unknown requirements refuse; unknown defaults warn without being applied', () => {
  code(signed(document({ imaginary: false })), 'unknown-requirement');
  const result = verifyPolicy(signed(document({}, { imaginary: 'secret-value' })));
  assert.equal(result.status, 'verified');
  if (result.status === 'verified') { assert.equal(result.policy.warnings.length, 1); assert.deepEqual(Object.keys(result.policy.defaults), []); assert.ok(!JSON.stringify(result).includes('secret-value')); }
});
test('strict JSON refuses duplicates, malformed documents, types, limits and unknown metadata', () => {
  for (const bytes of ['{"id":1,"id":2}', '{"x":{"a":1,"a":2}}', '{"x":1,}', '{/*comment*/}', 'null', '[]']) {
    if (bytes === 'null' || bytes === '[]') code(signed(bytes as never), 'format');
    else assert.throws(() => strictJson(Buffer.from(bytes)), PolicyRefused);
  }
  code(signed(document({}, {}, { unknown: true })), 'format');
  for (const requirements of [{ harnesses: 'pi' }, { harnesses: ['x', 'x'] }, { personRights: 'false' }, { keyHolders: ['unknown'] }, { modelRoutes: ['local'] }, { telemetryHost: 'https://bad' }, { telemetryEndpoint: 'http://remote.test/v1/traces' }, { telemetryEndpoint: 'https://ok.test/v1/traces?secret=x' }]) code(signed(document(requirements)), 'format');
  assert.throws(() => strictJson(Buffer.alloc(131073)), PolicyRefused);
  code({ ...signed(), trust: Buffer.from('{}') }, 'format');
  code(signed(document({}, {}, { version: 0 })), 'format');
});
test('expiry boundary, invalid calendar dates and machine/organisation scope', () => {
  code(signed(document({}, {}, { notAfter: '2026-11-10T00:00:00Z' })), 'expired');
  code(signed(document({}, {}, { notAfter: '2026-02-31T00:00:00Z' })), 'format');
  code(signed(document({}, {}, { scope: { machine: 'another-machine' } })), 'scope');
  code(signed(document({}, {}, { scope: { organisation: 'other-org' } })), 'scope');
  code(signed(document({}, {}, { scope: { typo: 'x' } })), 'format');
  assert.equal(verifyPolicy(signed(document({}, {}, { notAfter: '2026-11-11T00:00:00.001Z', scope: { organisation: 'test-org' } }))).status, 'verified');
});
test('protected floor, exact deployment pin and explicit pinned rollback prevent replay', () => {
  code(signed(document({}, {}, { version: 1 })), 'rollback');
  code(signed(document({}, {}, { version: 3 })), 'deployment');
  code(signed(document({}, {}, { id: 'other' })), 'deployment');
  code(signed(document({}, {}, { rollbackOf: 2 })), 'rollback');
  const rollback = signed(document({}, {}, { version: 1, rollbackOf: 2 }));
  assert.equal(verifyPolicy(rollback).status, 'verified');
  const alternate = signed(document({ auditContent: false }, {}, { version: 1, rollbackOf: 2 }));
  code({ ...alternate, trust: rollback.trust }, 'deployment');
});
test('pure decisions enforce ceilings and defaults yield to personal choice', () => {
  const p = decisionFixture({ harnesses: ['harness-pi'], acceptsProcessVisibility: false, personRights: false, keyHolders: ['keychain'], standingSignatures: false, standingServers: [], auditContent: false, modelProviders: ['openai'], modelRoutes: ['own'] }, { harnesses: ['harness-pi'] });
  assert.equal(harnessDecision(p, undefined), 'harness-pi');
  assert.equal(harnessDecision(decisionFixture({}, { harnesses: ['harness-pi'] }), 'harness-codex'), 'harness-codex');
  for (const action of [() => engineDecision(p, 'harness-acp'), () => engineDecision(verified({ personRights: false }), 'harness-acp', { environment: 'person-rights' }), () => engineDecision(verified({ acceptsProcessVisibility: false }), 'harness-acp'), () => keyDecision(p, 'plaintext'), () => standingDecision(p, 'mail'), () => standingDecision(decisionFixture({ standingServers: ['allowed'] }), 'other'), () => auditDecision(p, true), () => routeDecision(p, { kind: 'endpoint', provider: 'openai' }), () => routeDecision(p, { kind: 'own', provider: 'other' })]) assert.throws(action, PolicyRefused);
  keyDecision(p, 'keychain'); auditDecision(p, false);
  assert.equal(telemetryDecision(verified({ telemetryEndpoint: 'https://fixed.test/v1/traces' }), 'https://personal.test/v1/traces'), 'https://fixed.test/v1/traces');
  assert.equal(telemetryDecision(verified({}, { telemetryEndpoint: 'https://default.test/v1/traces' }), 'https://personal.test/v1/traces'), 'https://personal.test/v1/traces');
  assert.throws(() => telemetryDecision(decisionFixture({ telemetryRequired: true }), undefined), PolicyRefused);
  assert.throws(() => telemetryDecision(verified({ telemetryHost: 'fixed.test' }), 'https://other.test/v1/traces'), PolicyRefused);
});
test('system reader verifies every home, notices tampering and refuses missing companions', t => {
  const fixture = systemFixture(t, document({ auditContent: false }));
  assert.equal(policyFor('/unused-home').status, 'verified');
  fixture.tamper(); assert.throws(() => governedPolicy('/unused-home'), PolicyRefused);
  fixture.update(document()); fixture.remove(fixture.paths.policy);
  const missing = policyFor('/another-home'); assert.equal(missing.status, 'refused');
  if (missing.status === 'refused') assert.equal(missing.code, 'missing');
});
test('no artifacts is none; permission errors, unsafe ownership, symlinks and ACLs never become none', t => {
  const original = fs.lstatSync.bind(fs);
  const paths = policyPaths();
  const missing = Object.assign(new Error('absent'), { code: 'ENOENT' });
  const mock = t.mock.method(fs, 'lstatSync', (path: string) => String(path).startsWith(paths.root) ? (() => { throw missing; })() : original(path));
  assert.deepEqual(policyFor('unused'), { status: 'none' });
  mock.mock.restore();
  const fixture = systemFixture(t);
  const protectedStat = fs.lstatSync.bind(fs);
  t.mock.method(fs, 'lstatSync', (path: string) => { const s = protectedStat(path); if (String(path) === paths.trust) s.uid = 501; return s; });
  const result = policyFor('unused'); assert.equal(result.status, 'refused');
  if (result.status === 'refused') assert.equal(result.code, 'unsafe-trust');
  assert.throws(() => requirePolicy({ status: 'refused', code: 'io', detail: 'unreadable' }), PolicyRefused);
  assert.equal(policyDescription({ status: 'refused', code: 'io', detail: 'unreadable' }).status, 'fail');
  assert.ok(fixture);
});

test('IO denial remains a typed refusal rather than absence', t => {
  t.mock.method(fs, 'lstatSync', () => { throw Object.assign(new Error('do not echo this'), { code: 'EACCES' }); });
  const result = policyFor('unused'); assert.equal(result.status, 'refused');
  if (result.status === 'refused') { assert.equal(result.code, 'io'); assert.ok(!result.detail.includes('do not echo')); }
});
for (const attack of ['symlink', 'writable'] as const) test(`protected path refuses ${attack}`, t => {
  const fixture = systemFixture(t), lstat = fs.lstatSync.bind(fs);
  t.mock.method(fs, 'lstatSync', (path: string) => {
    const stat = lstat(path);
    if (String(path) === fixture.paths.trust) { if (attack === 'symlink') stat.isSymbolicLink = () => true; else stat.mode |= 0o020; }
    return stat;
  });
  const result = policyFor('unused'); assert.equal(result.status, 'refused');
  if (result.status === 'refused') assert.equal(result.code, 'unsafe-trust');
});
test('Windows paths are fixed and a present policy refuses without ACL qualification', t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  systemFixture(t);
  assert.match(policyPaths().root, /^C:\/ProgramData\/backbone$/);
  const result = policyFor('unused'); assert.equal(result.status, 'refused');
  if (result.status === 'refused') assert.equal(result.code, 'unsupported-platform');
});
