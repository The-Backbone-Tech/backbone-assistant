import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CredentialStore } from '../src/credentials/store.ts';
import { ModelRoutes } from '../src/models/route.ts';
import { freshAcpExecutableDirectory } from '../src/testing/acp.ts';

test('Settings reads return a cached class while a slow native probe leaves the Host event loop available', async (t) => {
  const home = freshAcpExecutableDirectory('claude-cache-', t), cli = join(home, 'claude'), release = join(home, 'release'), calls = join(home, 'calls');
  writeFileSync(cli, `#!/bin/sh\necho probe >> '${calls}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\nprintf '%s' '{"loggedIn":false,"authMethod":"none","email":"private-canary"}'\nexit 1\n`); chmodSync(cli, 0o755);
  const env = { HOME: home, PATH: '/usr/bin:/bin', CLAUDE_CODE_EXECUTABLE: cli };
  const routes = new ModelRoutes(home, new CredentialStore(home, async () => { throw new Error('No Host credential'); }), env, false, false, {
    kind: 'agent', provider: 'acp:claude', model: 'chosen-by-agent', baseUrl: '', label: 'Claude', credential: null,
    machineClient: 'claude', machineClientEnvironment: env,
  });
  let heartbeat = false;
  const timer = setTimeout(() => { heartbeat = true; writeFileSync(release, 'release owned probe'); }, 30);
  try {
    assert.equal(routes.settings().machineClientState?.state, 'checking');
    for (let i = 0; i < 100; i++) assert.equal(routes.settings().machineClientState?.state, 'checking');
    const refreshed = await routes.change({ route: 'agent-refresh' } as never);
    assert.equal(heartbeat, true);
    assert.equal(refreshed.machineClientState?.state, 'signed-out');
    assert.ok(!JSON.stringify(refreshed).includes('private-canary'));
    assert.equal(existsSync(calls), true);
    const before = readFileSync(calls, 'utf8');
    for (let i = 0; i < 100; i++) assert.equal(routes.settings().machineClientState?.state, 'signed-out');
    assert.equal(readFileSync(calls, 'utf8'), before, 'API-line reads must not launch probes');
    await routes.change({ route: 'agent-refresh' } as never);
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 2, 'Settings can explicitly refresh after the initial probe');
  } finally { clearTimeout(timer); writeFileSync(release, 'release owned probe'); }
});
