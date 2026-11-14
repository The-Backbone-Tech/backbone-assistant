import assert from 'node:assert/strict';
import { test } from 'node:test';
import cp, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercise the real doctor entry without allowing client or key-store programs to run.
test('stub doctor never starts a machine client or a key-store program', () => {
  const home = mkdtempSync(join(tmpdir(), 'doctor-engine-'));
  const guard = `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    for (const method of ['spawn','spawnSync','execFile','execFileSync']) {
      const original=cp[method]; cp[method]=function(file,...args) {
        if (/(?:^|\\/)(?:codex|claude|security|secret-tool)$/.test(String(file))) throw new Error('Unexpected machine-client/key-store access: '+file);
        return original.call(this,file,...args);
      };
    } syncBuiltinESMExports();`;
  try {
    const result = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(guard), new URL('../src/main.ts', import.meta.url).pathname, 'doctor', '--home', home, '--json'], {
      env: { ...process.env, BACKBONE_HARNESS: 'stub', BACKBONE_KEYS: 'plaintext' }, encoding: 'utf8',
    });
    assert.ok(result.stdout, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.ok(report.checks.some((c: {name:string}) => c.name === 'home'));
    assert.doesNotMatch(result.stderr, /Unexpected machine-client/);
    assert.equal(result.status, 1, 'the empty home must be refused without client inspection');
    const args = ['--import', 'data:text/javascript,' + encodeURIComponent(guard), new URL('../src/main.ts', import.meta.url).pathname];
    const env = { ...process.env, BACKBONE_HARNESS: 'stub', BACKBONE_KEYS: 'plaintext' };
    const made = spawnSync(process.execPath, [...args, 'projects', 'create', 'Doctor fixture', '--home', home], { env, encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const existing = spawnSync(process.execPath, [...args, 'doctor', '--home', home, '--json'], { env, encoding: 'utf8' });
    assert.equal(existing.status, 0, existing.stderr);
    const checks = JSON.parse(existing.stdout).checks;
    for (const name of ['codex', 'claude']) assert.match(checks.find((c: {name:string}) => c.name === name).detail, /not checked/);

  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('only the selected engine checks its machine client; status is content-free and names its source', async t => {
  const { engineClientChecks } = await import('../src/doctor-engine.ts');
  const original = cp.spawnSync, calls: string[] = [];
  cp.spawnSync = ((file: string) => { calls.push(file); return { status: 0, stdout: 'PRIVATE_ACCOUNT_DETAIL', stderr: '' }; }) as typeof cp.spawnSync;
  syncBuiltinESMExports();
  t.after(() => { cp.spawnSync = original; syncBuiltinESMExports(); });
  for (const engine of ['stub', 'Stub harness (no model called)', 'harness-pi', 'Pi', 'ACP', 'Hermes', 'ACP (Codex agent)', 'Pi with Claude route', undefined]) engineClientChecks(engine);
  assert.deepEqual(calls, []);
  const codex = engineClientChecks('Codex');
  assert.deepEqual(calls, ['codex']);
  assert.match(codex[0].detail, /machine.*client sign-in/);
  assert.doesNotMatch(JSON.stringify(codex), /PRIVATE_ACCOUNT_DETAIL/);
  const claude = engineClientChecks('harness-claude');
  assert.deepEqual(calls, ['codex', 'claude']);
  assert.match(claude[1].detail, /machine.*version.*sign-in.*not checked/);
});
