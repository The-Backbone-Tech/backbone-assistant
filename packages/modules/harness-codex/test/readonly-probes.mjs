// Run every pre-existing standalone probe/adverse variant with synthetic state only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(await realpath(homedir()), '.backbone-readonly-probes-'));
try {
  const home = join(root, 'home'), codex = join(home, '.codex');
  await mkdir(codex, { recursive: true, mode: 0o700 });
  await writeFile(join(codex, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
  const cases = [
    ['sandbox', 'readonly-sandbox-probe.mjs', {}],
    ['catalog', 'readonly-catalog-probe.mjs', {}],
    ['roundtrip', 'readonly-roundtrip-probe.mjs', {}],
    ['denial', 'readonly-roundtrip-probe.mjs', { PROBE_DENY_TOOL: '1' }],
    ...['write_file', 'delete_file', 'send_message', 'execute_command'].map(tool => [
      `unoffered-${tool}`, 'readonly-roundtrip-probe.mjs', { PROBE_BAD_TOOL: '1', PROBE_TOOL_NAME: tool },
    ]),
  ];
  const failures = [];
  for (const [name, script, flags] of cases) {
    try {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, script)], {
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codex, LANG: 'C.UTF-8', ...flags },
      encoding: 'utf8', timeout: 30000, maxBuffer: 1000000,
    });
    assert.equal(result.signal, null, `${name}: probe timed out`);
    assert.equal(result.status, 0, `${name}: ${result.stderr}\n${result.stdout}`);
    const evidence = JSON.parse(result.stdout.trim());
    // The old catalog probe can report an exception while exiting zero; never grade that as success.
    assert.equal(evidence.error, undefined, `${name}: ${result.stdout}`);
    console.log(`PASS legacy ${name}: ${result.stdout.trim()}`);
    } catch (error) { failures.push({ name, error: error.message }); console.log(`FAIL legacy ${name}: ${error.message}`); }
  }
  console.log(JSON.stringify({ platform: process.platform, passed: cases.length - failures.length, failed: failures.length, failures, account: false, model: false }));
  assert.equal(failures.length, 0, 'Every legacy probe must pass; no property is waived.');
} finally { await rm(root, { recursive: true, force: true }); }
