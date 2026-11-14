import { freshAcpExecutableDirectory } from '@backbone-next/platform/testing/acp';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentProcess } from '../src/transport.ts';
import { directoryIdentity } from '../src/directories.ts';
import { Session } from '../src/session.ts';

for (const signedIn of [false, true]) test(`Claude machine login starts only after a sourced signed-in class: ${signedIn}`, async () => {
  const root = freshAcpExecutableDirectory('acp-machine-'), machine = join(root, 'person'), work = join(root, 'work'), state = join(root, 'state');
  for (const path of [machine, work, state]) mkdirSync(path, { mode: 0o700 });
  const cli = join(machine, 'claude'), observed = join(root, 'environment.json');
  writeFileSync(cli, `#!/bin/sh\nprintf '%s' '${JSON.stringify({ loggedIn: signedIn, authMethod: signedIn ? 'claude.ai' : 'none', email: 'private-account-canary' })}'\nexit ${signedIn ? 0 : 1}\n`); chmodSync(cli, 0o755);
  const previous = process.env.HOME, previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.HOME = machine; process.env.ANTHROPIC_API_KEY = 'private-host-key-canary';
  let agent: AgentProcess | undefined;
  try {
    const create = () => AgentProcess.create({ acceptsProcessVisibility: true, machineClient: 'claude', environment: 'person-rights',
      command: process.execPath, args: ['-e', `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(observed + '.pending')}, JSON.stringify(process.env)); fs.renameSync(${JSON.stringify(observed + '.pending')}, ${JSON.stringify(observed)}); setInterval(()=>{},1000);`],
      env: { CLAUDE_CODE_EXECUTABLE: cli } }, directoryIdentity(work), directoryIdentity(state));
    if (!signedIn) {
      await assert.rejects(create, error => error instanceof Error && error.message.includes('signed-out') && error.message.includes('claude auth status --json') && !error.message.includes('private-account-canary'));
      assert.equal(existsSync(observed), false);
    } else {
      agent = await create();
      for (let i = 0; i < 100 && !existsSync(observed); i++) await new Promise(resolve => setTimeout(resolve, 10));
      const env = JSON.parse(readFileSync(observed, 'utf8'));
      assert.equal(env.HOME, machine);
      assert.equal(env.CLAUDE_CONFIG_DIR, join(machine, '.claude'));
      assert.equal(env.CLAUDE_CODE_EXECUTABLE, realpathSync(cli));
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.XDG_CONFIG_HOME, state);
      assert.equal(env.TMPDIR, work);
    }
  } finally {
    await agent?.close();
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const variant of ['restricted-writes', 'denied-folder', 'provider-override'] as const) test(`machine mode refuses ${variant} before invoking the installed CLI`, async () => {
  const root = freshAcpExecutableDirectory('acp-machine-refusal-');
  const cli = join(root, 'claude'), marker = join(root, 'invoked');
  writeFileSync(cli, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(cli, 0o755);
  try {
    await assert.rejects(() => AgentProcess.create({ acceptsProcessVisibility: true, machineClient: 'claude', command: process.execPath, args: [],
      environment: variant === 'restricted-writes' ? 'restricted-writes' : 'person-rights',
      ...(variant === 'denied-folder' ? { extraDenies: [root] } : {}),
      env: { CLAUDE_CODE_EXECUTABLE: cli, ...(variant === 'provider-override' ? { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } : {}) },
    }, directoryIdentity(root), directoryIdentity(root)));
    assert.equal(existsSync(marker), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('isolated state and different machine homes never share a retained session identity', async () => {
  const root = freshAcpExecutableDirectory('acp-machine-identity-'), previous = process.env.HOME;
  const options = { command: process.execPath, args: [], environment: 'person-rights' as const, storageDir: join(root, 'storage') };
  const sessions: Session[] = [];
  try {
    process.env.HOME = join(root, 'person-one');
    sessions.push(await Session.create(options, 'same-thread'));
    sessions.push(await Session.create({ ...options, machineClient: 'claude' }, 'same-thread'));
    process.env.HOME = join(root, 'person-two');
    sessions.push(await Session.create({ ...options, machineClient: 'claude' }, 'same-thread'));
    assert.equal(new Set(sessions.map(session => session.configuration)).size, 3);
    assert.equal(new Set(sessions.map(session => session.root)).size, 3);
  } finally {
    await Promise.all(sessions.map(session => session.close(true)));
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
