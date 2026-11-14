// Admission assertions use synthetic results. Real OS enforcement is exercised by sandbox-probe.mjs.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nativePlatform, capture, type NativeEnvironment } from '../src/native.ts';
import { verifySandbox } from '../src/staging.ts';

const observed = (environment: NativeEnvironment) => ({ inside_read: 'allowed', inside_write: environment === 'readOnly' ? 'denied' : 'allowed', outside_read: environment === 'full' ? 'allowed' : 'denied', outside_write: 'denied', denied_read: 'denied', symlink_read: 'denied', child_inside_read: 'allowed', child_read: 'denied', alias_read: 'denied', network: 'denied', temp_read: environment === 'full' ? 'allowed' : 'denied', temp_write: 'denied', var_temp_read: environment === 'full' ? 'allowed' : 'denied', var_temp_write: 'denied' });
async function owned(run: (root: string, stage: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'codex-policy-test-')), stage = join(root, 'stage');
  await mkdir(stage);
  try { await run(root, stage); } finally { await rm(root, { recursive: true, force: true }); }
}
test('native platform admission binds the reported client OS to this host', () => {
  assert.equal(nativePlatform('darwin'), 'macos');
  assert.equal(nativePlatform('linux'), 'linux');
  for (const platform of ['win32', 'freebsd', 'unknown']) assert.throws(() => nativePlatform(platform), /macOS or Linux/);
});
for (const environment of ['full', 'contained', 'bare', 'readOnly'] as const) {
  test(`${environment}: the complete macOS refusal probe admits only its environment`, () => owned(async (root, stage) => {
    await verifySandbox(async args => {
      assert.equal(args[0], 'sandbox'); assert.ok(args.includes('permissions.backbone-native-staged.network.enabled=false'));
      assert.ok(args.some(arg => arg.includes('":workspace_roots"="' + (environment === 'readOnly' ? 'read' : 'write') + '"')));
      return JSON.stringify(observed(environment));
    }, root, stage, environment, process.execPath, 'darwin');
  }));
  for (const property of Object.keys(observed(environment))) test(`${environment}: ${property} failure refuses admission`, () => owned(async (root, stage) => {
    const result = observed(environment);
    (result as Record<string, string>)[property] = (result as Record<string, string>)[property] === 'allowed' ? 'denied' : 'allowed';
    await assert.rejects(verifySandbox(async () => JSON.stringify(result), root, stage, environment, process.execPath, 'darwin'), new RegExp(property));
  }));
}
for (const result of ['{}', 'null', '[]', 'not-json']) test(`missing or malformed sandbox evidence refuses (${result})`, () => owned(async (root, stage) => {
  await assert.rejects(verifySandbox(async () => result, root, stage), /Native.*sandbox/);
}));
test('unexpected sandbox evidence refuses without exposing its contents', () => owned(async (root, stage) => {
  await assert.rejects(verifySandbox(async () => JSON.stringify({ ...observed('contained'), privateCanary: 'never print this' }), root, stage), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /unexpected properties/); assert.doesNotMatch(error.message, /privateCanary|never print/); return true;
  });
}));
for (const diagnostic of ['namespace-refused', 'bubblewrap-missing', 'seccomp-refused', 'executable-hidden']) test(`Linux sandbox prerequisite failure is actionable and sanitized (${diagnostic})`, () => owned(async (_root, stage) => {
  const fixture = join(import.meta.dirname, 'fixtures/native.mjs');
  await assert.rejects(capture({ command: [process.execPath, fixture, diagnostic] }, ['sandbox'], stage, new AbortController().signal), error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /secret-canary/);
    assert.match(error.message, diagnostic === 'executable-hidden' ? /restricted view/ : diagnostic === 'namespace-refused' ? /administrator.*AppArmor/i : diagnostic === 'bubblewrap-missing' ? /bubblewrap/i : /seccomp/i);
    return true;
  });
}));

// A lying profile/probe never reaches source disclosure, inference or conditional import.
for (const mode of ['symlink-escape', 'child-escape', 'alias-escape', 'network-escape', 'namespace-refused', 'bubblewrap-missing', 'seccomp-refused', 'executable-hidden', 'wrong-platform']) test(`native turn refuses before model/import (${mode})`, () => owned(async (root, _stage) => {
  const { createCodexHarness } = await import('../src/index.ts');
  let reads = 0, writes = 0;
  const harness = createCodexHarness({ command: [process.execPath, join(import.meta.dirname, 'fixtures/native.mjs'), mode], temporaryRoot: root });
  const outcome = await harness.start({ threadId: 't', turnId: 'u', text: 'Synthetic', history: [], attachments: [], effort: 3, resumed: false }, {
    tools: { list: async () => { reads++; return []; }, read: async () => null, write: async () => { writes++; throw Error('never'); } },
    route: { kind: 'native', provider: 'codex', model: 'test-model', credential: null, baseUrl: '', label: 'Fake' }, credential: async () => { throw Error('No account'); },
  }).outcome;
  assert.equal(outcome.status, 'failed'); assert.equal(writes, 0);
  const expected = { 'symlink-escape': /symlink_read/, 'child-escape': /child_read/, 'alias-escape': /alias_read/, 'network-escape': /network/, 'namespace-refused': /administrator.*AppArmor/i, 'bubblewrap-missing': /requires bubblewrap/, 'seccomp-refused': /seccomp restrictions/, 'executable-hidden': /restricted view/, 'wrong-platform': /client platform did not match/ };
  assert.match(outcome.error ?? '', expected[mode as keyof typeof expected], 'the intended admission boundary was reached');
  if (mode !== 'wrong-platform') assert.equal(reads, 0);
  assert.doesNotMatch(outcome.error ?? '', /secret-canary/);
}));
