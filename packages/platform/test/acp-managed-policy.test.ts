import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CredentialStore } from '../src/credentials/store.ts';
import { ModelRoutes } from '../src/models/route.ts';
import { PolicyRefused } from '../src/policy/index.ts';
import { acceptAcpTestConfiguration } from '../src/testing/acp.ts';
import { freshHome } from './helpers.ts';
import { document, systemFixture } from './policy-fixture.ts';

const credentials = { has: () => false } as unknown as CredentialStore;
const draft = { acceptsProcessVisibility: true as const, agent: 'policy-agent', command: process.execPath, args: [], environment: 'person-rights' as const };

for (const [name, requirements] of [
  ['engine', { harnesses: ['harness-stub'] }],
  ['process visibility', { acceptsProcessVisibility: false }],
  ['personal rights', { personRights: false }],
  ['model route', { modelRoutes: ['own'] }],
  ['model provider', { modelProviders: ['openai'] }],
] as const) test(`accepted ACP settings cannot override a managed ${name} requirement`, async t => {
  const home = freshHome(), policy = systemFixture(t, document());
  const configuration = acceptAcpTestConfiguration(home, draft);
  const path = join(home, 'settings.json'); writeFileSync(path, JSON.stringify({ unrelated: 42 }));
  const before = readFileSync(path, 'utf8');
  policy.update(document(requirements));
  const routes = new ModelRoutes(home, credentials, {});
  await assert.rejects(routes.change({ route: 'agent', configuration }), PolicyRefused);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(existsSync(join(home, 'model-route.json')), false);
});

test('managed policy can permit an explicitly accepted ACP engine and opaque agent route', async t => {
  const home = freshHome();
  systemFixture(t, document({ harnesses: ['harness-acp'], personRights: true, acceptsProcessVisibility: true, modelRoutes: ['agent'], modelProviders: ['acp:policy-agent'] }));
  const configuration = acceptAcpTestConfiguration(home, draft);
  const routes = new ModelRoutes(home, credentials, {});
  await routes.change({ route: 'agent', configuration });
  const stored = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  assert.equal(stored.harness, 'harness-acp');
  assert.deepEqual(stored.harnesses['harness-acp'], configuration);
});
