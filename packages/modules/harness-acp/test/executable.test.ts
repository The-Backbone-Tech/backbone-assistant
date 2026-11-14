import { freshAcpExecutableDirectory } from '@backbone-next/platform/testing/acp';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAcpHarness } from '../src/index.ts';
import { AgentProcess } from '../src/transport.ts';
import { directoryIdentity } from '../src/directories.ts';

test('changed executable bytes revoke the factory acceptance before an agent can start', async () => {
  const root = freshAcpExecutableDirectory('acp-entry-'), command = join(root, 'agent'), marker = join(root, 'launched');
  const body = `#!/bin/sh\necho launched > '${marker}'\nsleep 10\n`;
  writeFileSync(command, body, { mode: 0o755 });
  const h = createAcpHarness({ acceptsProcessVisibility: true, command, args: [], environment: 'person-rights', storageDir: join(root, 'storage') });
  writeFileSync(command, body + '# changed after acceptance\n');
  try {
    const result = await h.start({ threadId: 'entry', turnId: 'entry', text: 'ready', history: [], attachments: [], effort: 3, resumed: false }, {
      tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'No write granted' }) },
      route: { kind: 'agent', provider: 'acp:owned', baseUrl: '', model: 'agent', label: 'Owned', credential: null }, credential: async () => { throw new Error('No credential'); },
    }).outcome;
    assert.equal(result.status, 'failed'); assert.match(result.error ?? '', /accept.*again/i); assert.equal(existsSync(marker), false);
  } finally { await h.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const action of ['changed', 'machine-changed', 'cancelled'] as const) test(`a pending sign-in probe cannot launch an adapter after it is ${action}`, async () => {
  const root = freshAcpExecutableDirectory('acp-probe-admission-'), work = join(root, 'work'), state = join(root, 'state');
  for (const p of [work, state]) mkdirSync(p, { mode: 0o700 });
  const command = join(root, 'adapter'), cli = join(root, 'claude'), started = join(root, 'probe-started'), release = join(root, 'release'), marker = join(root, 'adapter-started');
  writeFileSync(command, `#!/bin/sh\ntouch '${marker}'\nsleep 10\n`, { mode: 0o755 });
  writeFileSync(cli, `#!/bin/sh\ntouch '${started}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\nprintf '%s' '{"loggedIn":true,"authMethod":"claude.ai"}'\n`, { mode: 0o755 });
  let cancelled = false;
  const pending = AgentProcess.create({ acceptsProcessVisibility: true, command, args: [], environment: 'person-rights', machineClient: 'claude',
    machineClientEnvironment: { HOME: root, PATH: '/usr/bin:/bin', CLAUDE_CODE_EXECUTABLE: cli } }, directoryIdentity(work), directoryIdentity(state), undefined, () => { if (cancelled) throw new Error('Cancelled before adapter admission'); });
  const refusal = assert.rejects(pending);
  try {
    for (let i = 0; i < 200 && !existsSync(started); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(existsSync(started), true);
    if (action === 'changed') { writeFileSync(command, `#!/bin/sh\ntouch '${marker}'\n# changed\n`); chmodSync(command, 0o755); }
    else if (action === 'machine-changed') writeFileSync(cli, '#!/bin/sh\nexit 1\n');
    else cancelled = true;
    writeFileSync(release, 'release owned probe');
    await refusal;
    assert.equal(existsSync(marker), false);
  } finally { writeFileSync(release, 'release owned probe'); await refusal; rmSync(root, { recursive: true, force: true }); }
});
