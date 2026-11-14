import { freshAcpExecutableDirectory } from '@backbone-next/platform/testing/acp';
import { acceptAcpTestConfiguration } from '@backbone-next/platform/testing/acp';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';

test('doctor reports the selected Claude machine client with a source and no account contents', async () => {
  const home = freshDataHome('doctor-claude'), person = freshAcpExecutableDirectory('doctor-claude-person-');
  const cli = join(person, 'claude');
  writeFileSync(cli, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 9.9.9; else printf \'%s\' \'{"loggedIn":false,"authMethod":"none","email":"private-account-canary"}\'; exit 1; fi\n'); chmodSync(cli, 0o755);
  const codex = join(person, 'codex'); writeFileSync(codex, '#!/bin/sh\nexit 1\n'); chmodSync(codex, 0o755);
  // The creating process must exit before synchronous doctor starts; Host.close drains asynchronously.
  const initialized = spawnSync(process.execPath, [new URL('../src/main.ts', import.meta.url).pathname, 'projects', 'create', 'Diagnosis'], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: person, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'harness-stub' },
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ harness: 'harness-acp', harnesses: { 'harness-acp': acceptAcpTestConfiguration(home, {
    acceptsProcessVisibility: true, agent: 'claude', command: process.execPath, args: [], machineClient: 'claude', environment: 'person-rights',
  }, { HOME: person, PATH: process.env.PATH, CLAUDE_CODE_EXECUTABLE: cli }) } }));
  try {
    const result = spawnSync(process.execPath, [new URL('../src/main.ts', import.meta.url).pathname, 'doctor', '--json'], {
      encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: `${person}:${process.env.PATH}`, HOME: person,
        CLAUDE_CODE_EXECUTABLE: cli, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'harness-acp' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!(result.stdout + result.stderr).includes('private-account-canary'));
    const checks = JSON.parse(result.stdout).checks;
    const check = checks.find((check: { name: string }) => check.name === 'engine-client');
    assert.ok(check);
    assert.equal(check.status, 'warn');
    assert.equal(check.source, 'claude auth status --json');
    assert.match(check.detail, /signed-out/);
  } finally { await removeDataHome(home); rmSync(person, { recursive: true, force: true }); }
});
