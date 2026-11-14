import { acceptAcpTestConfiguration } from '../src/testing/acp.ts';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeMachineEnvironment, claudeMachineState, selectedMachineClientCheck } from '../src/machine-client.ts';
import { freshAcpExecutableDirectory } from '../src/testing/acp.ts';
import { CredentialStore } from '../src/credentials/store.ts';
import { ModelRoutes } from '../src/models/route.ts';
import { acpConfiguration } from '../src/composition/harnesses.ts';

for (const [code, answer, state] of [
  [0, { loggedIn: true, authMethod: 'claude.ai', email: 'private-canary' }, 'signed-in'],
  [1, { loggedIn: false, authMethod: 'none', email: 'private-canary' }, 'signed-out'],
  [0, { loggedIn: true, authMethod: 'api_key', email: 'private-canary' }, 'different-auth'],
  [0, { loggedIn: true }, 'error'],
  [0, 'private-canary', 'error'],
] as const) test(`Claude's own status command supplies a content-free ${state} class`, async (t) => {
  const home = freshAcpExecutableDirectory('claude-machine-', t), command = join(home, 'claude');
  writeFileSync(command, `#!/bin/sh\nprintf '%s' '${JSON.stringify(answer)}'\nexit ${code}\n`); chmodSync(command, 0o755);
  const result = await claudeMachineState({ HOME: home, PATH: process.env.PATH, CLAUDE_CODE_EXECUTABLE: command });
  assert.equal(result.state, state);
  assert.equal(result.source, 'claude auth status --json');
  assert.ok(!JSON.stringify(result).includes('private-canary'));
  const check = await selectedMachineClientCheck({ machineClient: 'claude' }, { HOME: home, PATH: process.env.PATH, CLAUDE_CODE_EXECUTABLE: command });
  assert.equal(check?.name, 'engine-client');
  assert.equal(check?.status, state === 'signed-in' ? 'ok' : 'warn');
  assert.equal(check?.source, result.source);
  assert.ok(check?.detail.includes(state));
  assert.ok(!JSON.stringify(check).includes('private-canary'));
});

test('a missing machine CLI is absent and an ordinary ACP agent does not probe any account', async (t) => {
  const home = freshAcpExecutableDirectory('claude-absent-', t);
  assert.equal((await claudeMachineState({ HOME: home, PATH: home })).state, 'absent');
  assert.equal(await selectedMachineClientCheck({}, { HOME: home, PATH: home }), null);
});

test('the status probe and adapter get one absolute CLI path; relative configuration is refused', (t) => {
  const home = freshAcpExecutableDirectory('claude-path-', t), cli = join(home, 'claude');
  writeFileSync(cli, '#!/bin/sh\nexit 0\n'); chmodSync(cli, 0o755);
  assert.equal(claudeMachineEnvironment({ HOME: home, PATH: home }).CLAUDE_CODE_EXECUTABLE, cli);
  assert.throws(() => claudeMachineEnvironment({ HOME: home, CLAUDE_CONFIG_DIR: 'relative-config' }));
  assert.throws(() => claudeMachineEnvironment({ HOME: home, CLAUDE_CODE_EXECUTABLE: './claude' }));
});

test('doctor uses the selected Host machine class when its own terminal environment differs', async (t) => {
  const home = freshAcpExecutableDirectory('claude-host-source-', t), cli = join(home, 'claude');
  writeFileSync(cli, '#!/bin/sh\nprintf \'%s\' \'{"loggedIn":false,"authMethod":"none"}\'\nexit 1\n'); chmodSync(cli, 0o755);
  const env = { HOME: home, PATH: home, CLAUDE_CODE_EXECUTABLE: cli };
  const accepted = acceptAcpTestConfiguration(home, { acceptsProcessVisibility: true, agent: 'claude', command: process.execPath, machineClient: 'claude', environment: 'person-rights' }, env);
  const config = acpConfiguration(home, accepted, env);
  const routes = new ModelRoutes(home, new CredentialStore(home, async () => { throw new Error('No Host credential'); }), {}, false, false, config.route);
  const shown = await routes.change({ route: 'agent-refresh' });
  assert.equal(shown.machineClientState?.state, 'signed-out');
  assert.match((await selectedMachineClientCheck(shown, { HOME: home, PATH: '/missing-terminal-cli' }))?.detail ?? '', /signed-out/);
  assert.ok(!JSON.stringify(shown).includes(home), 'machine paths stay inside the Host');
  assert.equal(JSON.stringify(config.options).includes('ANTHROPIC_API_KEY'), false);
});

test('a denied-folder floor blocks machine diagnostics before any native client is invoked', (t) => {
  const home = freshAcpExecutableDirectory('claude-deny-floor-', t), cli = join(home, 'claude'), marker = join(home, 'invoked');
  writeFileSync(cli, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(cli, 0o755);
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ deniedFolders: [join(home, 'private')] }));
  const config = acpConfiguration(home, { acceptsProcessVisibility: true, agent: 'claude', command: process.execPath, machineClient: 'claude', environment: 'person-rights' }, {
    HOME: home, PATH: home, CLAUDE_CODE_EXECUTABLE: cli,
  });
  assert.ok(config.blocked);
  assert.equal(config.route, undefined);
  const routes = new ModelRoutes(home, new CredentialStore(home, async () => { throw new Error('No Host credential'); }), {}, false, false, config.route, config.blocked);
  assert.equal(routes.settings().active, null);
  assert.equal(existsSync(marker), false);
});
