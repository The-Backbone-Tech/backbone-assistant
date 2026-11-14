import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { testEnvironment } from './lib/test-environment.mjs';

// An inner test runner must not inherit Node's recursion marker or a denial supplied
// by this outer runner: exercise the wrappers themselves.
function innerEnvironment() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.BACKBONE_SYSTEM_STORE_UNAVAILABLE;
  delete env.BACKBONE_TEST_SYSTEM_KEYCHAIN;
  return env;
}

test('closing MCP commands and system Host tests never spawn a platform key store tool', { timeout: 660_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'backbone-store-spawn-'));
  try {
    const record = join(dir, 'spawns'); writeFileSync(record, '');
    const preload = new URL('./lib/record-store-spawns.mjs', import.meta.url).href;
    // The nested protected-home fixture has startup hang detectors, not a short speed budget.
    const result = spawnSync(process.execPath, ['scripts/no-leftovers.mjs', process.execPath, 'scripts/with-test-cluster.mjs', process.execPath, '--test', 'packages/surfaces/mcp/test/closing-cli.test.ts', 'packages/platform/test/system-key-host.test.ts'], {
      env: { ...innerEnvironment(), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`, BACKBONE_TEST_STORE_SPAWN_RECORD: record }, encoding: 'utf8', timeout: 650_000,
    });
    assert.equal(readFileSync(record, 'utf8'), '', 'a test tried to start a key store tool');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^# tests 3$/m, 'inner runner must execute all three fixture tests');
    assert.match(result.stdout, /^# pass 3$/m, 'inner runner must pass all three fixture tests');
    assert.match(result.stdout, /^# skipped 0$/m, 'inner runner must not skip fixtures');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('denial is unconditional even when the surrounding suite is opted in', () => {
  assert.equal(testEnvironment({ BACKBONE_TEST_SYSTEM_KEYCHAIN: '1' }).BACKBONE_SYSTEM_STORE_UNAVAILABLE, '1');
});

for (const wrapper of ['no-leftovers', 'with-test-cluster', 'guide-steps']) {
  test(`${wrapper} supplies the system-store refusal to a child`, { timeout: 30_000 }, () => {
    const check = "if(process.env.BACKBONE_SYSTEM_STORE_UNAVAILABLE!=='1'){console.error('child did not receive BACKBONE_SYSTEM_STORE_UNAVAILABLE=1');process.exit(1)}";
    const args = wrapper === 'guide-steps'
      ? ['--input-type=module', '-e', `import {runStep} from './scripts/guide-steps.mjs'; const failure=runStep(process.cwd(),{code:${JSON.stringify(JSON.stringify(process.execPath) + ' -e ' + "'" + check.replaceAll("'", "'\\''") + "'")}}); if(failure){console.error(failure);process.exit(1)}`]
      : [`scripts/${wrapper}.mjs`, process.execPath, '-e', check];
    const result = spawnSync(process.execPath, args, { env: innerEnvironment(), encoding: 'utf8', timeout: 25_000 });
    assert.equal(result.status, 0, `${wrapper} failed to supply BACKBONE_SYSTEM_STORE_UNAVAILABLE=1: ${result.stdout}${result.stderr}`);
  });
}
