import { acceptAcpTestConfiguration } from '../src/testing/acp.ts';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { HARNESSES, harnessConfiguration, harnessDenies } from '../src/composition/harnesses.ts';
import { inventory } from '../src/selection/inventory.ts';
import { choose } from '../src/selection/choose.ts';
import { pinFor, turnRoute } from '../src/selection/pin.ts';
import { freshDir } from './helpers.ts';

test('per-home ACP configuration resolves only named variables and identifies an agent-owned route', () => {
  const home = freshDir('acp-config-');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ harnesses: { 'harness-acp': acceptAcpTestConfiguration(home, { acceptsProcessVisibility: true, agent: 'fake', command: '/bin/echo', args: [], environmentVariables: ['FAKE_MODE'] }) } }));
  const config = harnessConfiguration(home, HARNESSES['harness-acp'], { FAKE_MODE: 'test-fixture', UNNAMED_SECRET: 'withheld' });
  assert.deepEqual((config.options as { env: unknown }).env, { FAKE_MODE: 'test-fixture' });
  assert.equal(config.route?.provider, 'acp:fake'); assert.equal(config.route?.kind, 'agent');
  assert.equal(config.route?.model, 'chosen-by-agent'); assert.equal(config.route?.credential, null);
  const local = { runtimes: [] };
  const routes = inventory({ settings: { own: null, gateway: null, local: null, active: { kind: 'agent', label: config.route!.label }, hint: null, harness: 'ACP' }, codex: { status: 'warn', detail: 'not checked' }, local });
  const task = { needs: ['model' as const], network: true, spend: 'metered' as const };
  const selection = choose(routes, task);
  assert.equal(selection.choice?.route.kind, 'agent-engine');
  const pin = pinFor(selection.choice!.route, [], task, local, config.route!);
  assert.ok('selection' in pin);
  assert.equal(choose(routes, { ...task, network: false }).choice, null);
  assert.equal(choose(routes, { ...task, spend: 'none' }).choice, null);
  assert.ok('refused' in turnRoute(undefined, 'specific-model', config.route!, false)!);
});

test('ACP cannot admit a reviewer or ask child as if it could enforce narrower native tools', async () => {
  const { createParallelWork } = await import('../src/composition/parallel-work.ts');
  const { settings } = await import('./helpers.ts');
  const native = () => !!HARNESSES['harness-acp'].nativeCoordination;
  const work = createParallelWork({ native, journal: { read: () => [] }, threads: new Map(), running: new Map() } as unknown as Parameters<typeof createParallelWork>[0]);
  const child = (role: 'worker' | 'reviewer', permission: 'ask' | 'full') => ({ turns: [], child: { role, settings: { ...settings, permission } } }) as unknown as Parameters<typeof work.refuseTurn>[0];
  assert.equal(work.refuseTurn(child('reviewer', 'full'), settings)?.ok, false);
  assert.equal(work.refuseTurn(child('worker', 'ask'), settings)?.ok, false);
});
test('per-home raw credential environment configuration is rejected', () => {
  const home = freshDir('acp-secret-config-');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ harnesses: { 'harness-acp': { acceptsProcessVisibility: true, agent: 'fake', command: '/bin/true', environmentVariables: ['PROVIDER_API_KEY'] } } }));
  assert.throws(() => harnessConfiguration(home, HARNESSES['harness-acp'], { PROVIDER_API_KEY: 'owned-fixture' }), /allowed variables/);
});


test('Codex has no implicit full setting; explicit per-home full and contained choices are validated', () => {
  const home = freshDir('codex-config-');
  assert.deepEqual(harnessConfiguration(home, HARNESSES['harness-codex']), {});
  for (const environment of ['full', 'contained']) {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ harnesses: { 'harness-codex': { environment } } }));
    assert.deepEqual(harnessConfiguration(home, HARNESSES['harness-codex']), { options: { environment } });
  }
  for (const environment of ['bare', 'readOnly', 'danger-full-access', 1]) {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ harnesses: { 'harness-codex': { environment } } }));
    assert.throws(() => harnessConfiguration(home, HARNESSES['harness-codex']), /full or contained/);
  }
  assert.deepEqual(harnessDenies(home, HARNESSES['harness-codex'], ['/owned/denied', home]), ['/owned/denied', home]);
});
