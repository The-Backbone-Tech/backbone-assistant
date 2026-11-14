import { freshAcpExecutableDirectory } from '@backbone-next/platform/testing/acp';
// Explicit qualification of a separately installed adapter: ACP_UPSTREAM_ENTRY names its JS entry.
// Not part of the offline suite, which has no vendor dependency. No account or model is used.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentProcess } from '../src/transport.ts';
import { directoryIdentity } from '../src/directories.ts';

test('the installed Claude ACP adapter initializes on protocol v1 with machine-client configuration and no model call', { timeout: 20_000 }, async () => {
  assert.ok(process.env.ACP_UPSTREAM_ENTRY, 'name a separately installed Claude ACP entry');
  const root = freshAcpExecutableDirectory('claude-startup-');
  const work = join(root, 'work'), state = join(root, 'state'), person = join(root, 'person');
  for (const path of [work, state, person]) mkdirSync(path, { mode: 0o700 });
  const cli = join(person, 'claude');
  writeFileSync(cli, '#!/bin/sh\nprintf \'%s\' \'{"loggedIn":true,"authMethod":"claude.ai"}\'\n'); chmodSync(cli, 0o755);
  const previous = process.env.HOME;
  process.env.HOME = person;
  let agent: AgentProcess | undefined;
  try {
    agent = await AgentProcess.create({ acceptsProcessVisibility: true, machineClient: 'claude', environment: 'person-rights',
      command: process.execPath, args: [process.env.ACP_UPSTREAM_ENTRY], env: { CLAUDE_CODE_EXECUTABLE: cli, CLAUDE_CONFIG_DIR: join(person, '.claude') },
    }, directoryIdentity(work), directoryIdentity(state));
    const initialized = await agent.initialize();
    assert.equal(initialized.protocolVersion, 1);
    assert.equal(initialized.agentInfo?.name, '@agentclientprotocol/claude-agent-acp');
  } finally {
    await agent?.close();
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
