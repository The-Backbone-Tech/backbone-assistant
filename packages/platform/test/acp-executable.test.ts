import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { freshAcpExecutableDirectory } from '../src/testing/acp.ts';
import { inspectExecutable, resolveExecutable, verifyExecutable, verifyExecutableAccess, assertTrustedExecutableEntry } from '../src/executable-identity.ts';
import { prepareAcpConfiguration, verifyAcpAcceptance } from '../src/composition/acp-executable.ts';
import { acpConfiguration } from '../src/composition/harnesses.ts';
import { claudeMachineState } from '../src/machine-client.ts';

test('a Finder PATH finds the installed adapter and binds its real path and bytes', (t) => {
  const home = freshAcpExecutableDirectory('acp-finder-', t), bin = join(home, '.local/bin'); mkdirSync(bin, { recursive: true });
  const target = join(bin, 'adapter.mjs'), alias = join(bin, 'claude-agent-acp');
  writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); symlinkSync(target, alias);
  const identity = resolveExecutable('claude-agent-acp', { HOME: home, PATH: '/usr/bin:/bin' });
  assert.equal(identity.path, realpathSync(target)); assert.match(identity.sha256, /^[a-f0-9]{64}$/);
  const cli = join(bin, 'claude'), marker = join(home, 'must-not-probe');
  writeFileSync(cli, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const prepared = prepareAcpConfiguration(home, { agent: 'claude', command: 'claude-agent-acp', machineClient: 'claude', environment: 'person-rights' }, { HOME: home, PATH: '/usr/bin:/bin' });
  assert.equal(prepared.acceptance.machineExecutable?.path, realpathSync(cli));
  assert.equal(existsSync(marker), false, 'resolving a program must not run it');
  verifyExecutable(identity);
  writeFileSync(target, '#!/bin/sh\nexit 1\n');
  assert.throws(() => verifyExecutable(identity));
});

test('relative commands and relative PATH entries never select an agent from its work folder', (t) => {
  const home = freshAcpExecutableDirectory('acp-relative-', t);
  assert.throws(() => resolveExecutable('./agent', { HOME: home, PATH: '.' }));
  assert.throws(() => resolveExecutable('bin/agent', { HOME: home, PATH: home }));
  assert.throws(() => resolveExecutable('absent-owned-agent', { HOME: home, PATH: ':.:relative' }));
});

test('unsafe files, ancestors and symlink targets refuse even when their contents match', (t) => {
  const home = freshAcpExecutableDirectory('acp-modes-', t), parent = join(home, 'bin'); mkdirSync(parent);
  const target = join(parent, 'agent'), alias = join(home, 'alias');
  writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); symlinkSync(target, alias);
  inspectExecutable(alias);
  chmodSync(target, 0o775); assert.throws(() => inspectExecutable(alias));
  chmodSync(target, 0o755); chmodSync(parent, 0o777);
  try { assert.throws(() => inspectExecutable(alias)); } finally { chmodSync(parent, 0o700); }
  const uid = process.getuid!();
  assert.doesNotThrow(() => assertTrustedExecutableEntry({ uid, mode: 0o755 }, uid));
  assert.doesNotThrow(() => assertTrustedExecutableEntry({ uid: 0, mode: 0o755 }, uid));
  assert.throws(() => assertTrustedExecutableEntry({ uid: uid + 1, mode: 0o755 }, uid));
});

test('acceptance is bound to the resolved executable, arguments and rights', (t) => {
  const home = freshAcpExecutableDirectory('acp-acceptance-', t), command = join(home, 'agent');
  writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prepared = prepareAcpConfiguration(home, { agent: 'owned', command, args: ['--stdio'], environment: 'person-rights' }, { HOME: home });
  const accepted = { ...prepared.configuration, acceptsProcessVisibility: true as const, acceptsPersonRights: true as const, acceptance: prepared.acceptance };
  assert.doesNotThrow(() => verifyAcpAcceptance(accepted));
  assert.throws(() => verifyAcpAcceptance({ ...accepted, args: ['--other'] }));
  assert.throws(() => verifyAcpAcceptance({ ...accepted, acceptsPersonRights: undefined }));
  writeFileSync(command, '#!/bin/sh\nexit 2\n');
  assert.throws(() => verifyAcpAcceptance(accepted));
  assert.ok(acpConfiguration(home, accepted).blocked);
  const changed = prepareAcpConfiguration(home, prepared.configuration, { HOME: home });
  assert.notEqual(changed.acceptance.executable.sha256, accepted.acceptance.executable.sha256);
  assert.equal('acceptsProcessVisibility' in changed.configuration, false);
});

test('foreign write ACLs on an executable or ancestor revoke access even when POSIX mode stays safe', async (t) => {
  const home = freshAcpExecutableDirectory('acp-acl-', t), parent = join(home, 'bin'); mkdirSync(parent);
  const command = join(parent, 'agent'); writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const identity = inspectExecutable(command);
  await verifyExecutableAccess(identity);
  for (const path of [command, parent]) {
    if (process.platform === 'darwin') execFileSync('/bin/chmod', ['+a', 'everyone allow write', path]);
    else chmodSync(path, 0o777);
    try { await assert.rejects(verifyExecutableAccess(identity)); }
    finally {
      if (process.platform === 'darwin') execFileSync('/bin/chmod', ['-a', 'everyone allow write', path]);
      else chmodSync(path, 0o755);
    }
    await verifyExecutableAccess(identity);
  }
});

test('a Finder-launched machine diagnostic finds the installed Node interpreter without a login shell', async (t) => {
  const home = freshAcpExecutableDirectory('acp-finder-runtime-', t), bin = join(home, '.nvm/versions/node/fixture/bin');
  mkdirSync(bin, { recursive: true }); symlinkSync(process.execPath, join(bin, 'node'));
  const cli = join(bin, 'claude');
  writeFileSync(cli, '#!/usr/bin/env node\nconsole.log(JSON.stringify({loggedIn:false,authMethod:"none"}));process.exit(1);\n', { mode: 0o755 });
  const env = { HOME: home, PATH: '/usr/bin:/bin', CLAUDE_CODE_EXECUTABLE: cli };
  const identity = resolveExecutable('claude', env);
  assert.equal((await claudeMachineState(env, identity)).state, 'signed-out');
});
