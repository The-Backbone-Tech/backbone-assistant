import { acceptAcpTestConfiguration } from '../src/testing/acp.ts';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { freshHome, idle, open, settings, value } from './helpers.ts';
import { saveAcpSettingsHeld } from '../src/composition/acp-settings.ts';
import { HomeWriteUnavailable, withHomeLock } from '../src/composition/home-lock.ts';
import { replaceHeldHomeLock } from './native-lock-observation.ts';

const fixture = new URL('../../modules/harness-acp/test/fake-agent.mjs', import.meta.url).pathname;
const configuration = {
  acceptsProcessVisibility: true as const, agent: 'owned-agent', command: process.execPath,
  args: [fixture], environment: process.platform === 'darwin' ? 'restricted-writes' as const : 'person-rights' as const,
  environmentVariables: ['ACP_FAKE_MODE'],
};

test('Settings saves an ACP route for the next Host; the agent writes through the ordinary receipts', async () => {
  const home = freshHome();
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ unrelated: 42, harnesses: { 'harness-codex': { environment: 'contained' } } }));
  const first = open(home, { harness: 'harness-stub' }).host;
  const before = await first.call('settings.model.get', {});
  const accepted = acceptAcpTestConfiguration(home, configuration);
  const result = value(await first.call('settings.model.put', { change: { route: 'agent', configuration: accepted } }));
  assert.deepEqual(result.active, before.active, 'saving does not swap a running engine');
  assert.match(result.hint ?? '', /restart/i);
  const stored = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  assert.equal(stored.harness, 'harness-acp');
  assert.deepEqual(stored.harnesses['harness-acp'], accepted);
  assert.equal(stored.unrelated, 42);
  assert.deepEqual(stored.harnesses['harness-codex'], { environment: 'contained' });
  first.close();

  const previous = process.env.ACP_FAKE_MODE;
  process.env.ACP_FAKE_MODE = 'mcp-write';
  try {
    const next = open(home).host;
    const model = await next.call('settings.model.get', {});
    assert.equal(model.active?.kind, 'agent');
    const project = value(await next.call('projects.create', { name: 'ACP journey', kind: 'folder' }));
    const sent = value(await next.call('turns.send', { projectId: project.id, text: 'Write a brief', settings: { ...settings, model: 'chosen-by-agent', permission: 'full' }, attachments: [], clientKey: 'acp-first' }));
    const turn = (await idle(next, sent.threadId)).turns[0];
    assert.equal(turn.status, 'done');
    assert.ok(turn.effects.some(effect => effect.outcome === 'DONE'));
    assert.ok((await next.call('material.list', { projectId: project.id })).some(file => file.name === 'brief.md'));
  } finally {
    if (previous === undefined) delete process.env.ACP_FAKE_MODE; else process.env.ACP_FAKE_MODE = previous;
  }
});

for (const invalid of [
  { ...configuration, acceptsProcessVisibility: false },
  { ...configuration, command: '' },
  { ...configuration, args: 'shell words' },
  { ...configuration, environmentVariables: ['PROVIDER_API_KEY'] },
  { ...configuration, env: { UNEXPECTED: 'must-not-persist' } },
]) test('invalid ACP settings leave the home unchanged: ' + Object.keys(invalid).at(-1), async () => {
  const home = freshHome(), host = open(home).host;
  const path = join(home, 'settings.json');
  writeFileSync(path, JSON.stringify({ unrelated: 42 }));
  const before = readFileSync(path, 'utf8');
  const result = await host.call('settings.model.put', { change: { route: 'agent', configuration: invalid } as never });
  assert.equal(result.ok, false);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('ACP route saving refuses an observed home lock loss before its synchronous write', async () => {
  const home = freshHome(), path = join(home, 'settings.json');
  writeFileSync(path, JSON.stringify({ unrelated: 42 }));
  const before = readFileSync(path, 'utf8');
  await withHomeLock(home, async () => {
    await replaceHeldHomeLock(home);
    assert.throws(() => saveAcpSettingsHeld(home, acceptAcpTestConfiguration(home, configuration)), HomeWriteUnavailable);
    assert.equal(readFileSync(path, 'utf8'), before);
  });
});
