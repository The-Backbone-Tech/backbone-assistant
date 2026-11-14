import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { systemFixture, document } from '../../../platform/test/policy-fixture.ts';
import { freshDir } from '../../../platform/test/helpers.ts';
import { withHome } from '../src/session.ts';
import { runDaemon } from '../src/daemon.ts';
import { auditCommand } from '../src/audit.ts';
import { channelsCommand } from '../src/channels.ts';
import { parse, EXIT } from '../src/commands.ts';

for (const entry of ['session', 'daemon', 'audit', 'channels'] as const) test(`${entry} refuses BACKBONE_KEYS=plaintext under a policy forbidding plaintext`, async t => {
  const home = freshDir('policy-entrypoint-');
  const prior = process.env.BACKBONE_KEYS; process.env.BACKBONE_KEYS = 'plaintext';
  t.after(() => { if (prior === undefined) delete process.env.BACKBONE_KEYS; else process.env.BACKBONE_KEYS = prior; });
  systemFixture(t, document({ keyHolders: ['keychain'] }));
  mkdirSync(join(home, 'pg')); writeFileSync(join(home, 'pg', 'external.json'), '{}');
  mkdirSync(join(home, 'keys')); writeFileSync(join(home, 'keys', 'vault.json'), JSON.stringify({ format: 1, holder: 'plaintext', wrap: 'none' }));
  // Holder metadata alone: no vault is opened, Core starts or home lock is created.
  for (const [name, value] of [['core.json', {}], ['projects.json', []], ['kernel.json', {}]] as const) writeFileSync(join(home, name), JSON.stringify(value));
  const output: string[] = [], io = { out: (s: string) => output.push(s), err: (s: string) => output.push(s), onInterrupt: () => {}, holding: () => {}, pollMs: 1, stopWaitMs: 1 };
  if (entry === 'session') await assert.rejects(withHome(home, 'policy-test', async () => assert.fail('Host must not start'), { create: true }), /key holder is forbidden by policy/);
  if (entry === 'daemon') await assert.rejects(runDaemon(home, io.out), /key holder is forbidden by policy/);
  if (entry === 'audit') {
    const parsed = parse(['audit', 'export', '--home', home, '--since', '2026-01-01T00:00:00Z', '--until', '2027-01-01T00:00:00Z']);
    assert.equal(await auditCommand(parsed, io), EXIT.REFUSED);
    assert.match(output.join('\n'), /key holder is forbidden by policy/);
  }
  if (entry === 'channels') {
    await assert.rejects(channelsCommand(parse(['channels', 'connect', 'telegram', '--home', home]), io, Readable.from(['test-token\ntest-secret\n'])), /key holder is forbidden by policy/);
  }
  assert.equal(existsSync(join(home, '.lock')), false);
  assert.equal(existsSync(join(home, 'keys', '.lock')), false);
});

test('every CLI key reader uses governed selection and no CLI file calls raw environment keys', () => {
  const root = new URL('../src/', import.meta.url);
  const raw = readdirSync(root).filter(name => name.endsWith('.ts') && /\bkeysFromEnvironment\b/.test(readFileSync(new URL(name, root), 'utf8')));
  assert.deepEqual(raw, []);
  for (const name of ['session.ts', 'daemon.ts', 'audit.ts', 'channels.ts']) assert.match(readFileSync(new URL(name, root), 'utf8'), /\bchooseKeys\(/, `${name} must select through policy`);
});
