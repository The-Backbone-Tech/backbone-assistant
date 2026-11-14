import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inventory } from '../src/selection/inventory.ts';
import { choose } from '../src/selection/choose.ts';
import { concreteRoute } from '../src/selection/pin.ts';
import { arenaEvidence } from '../src/selection/arena.ts';

test('every discovered option distinguishes current use, setup and an unobserved entitlement', () => {
  const routes = inventory({ codex: { status: 'warn', detail: 'signed out' }, settings: { own: null, gateway: null, active: null, harness: 'Pi', hint: null }, local: { runtimes: [] } });
  const selection = choose(routes, { needs: ['model'], network: true, spend: 'metered' });
  assert.equal(selection.excluded.find((o) => o.route.id === 'codex')?.route.availability?.state, 'setup');
  assert.equal(selection.excluded.find((o) => o.route.id === 'model-route')?.route.availability?.state, 'entitlement');
  for (const { route } of [...selection.feasible, ...selection.excluded]) assert.ok(route.availability?.detail);
});

test('Arena is queried through npm run ask; expired decisions require revalidation', async () => {
  let seen: unknown;
  const evidence = await arenaEvidence('agent-harness', { cwd: '/disposable/arena', run: async (command, args, options) => {
    seen = { command, args, cwd: options.cwd };
    return { stdout: JSON.stringify({ schema: 'arena-query/1', status: 'current', picks: [{ status: 'current', data: { asOf: '2026-01-01', revalidateBy: '2026-01-02', decision: 'old pick' } }] }) };
  } });
  assert.deepEqual(seen, { command: 'npm', args: ['run', '--silent', 'ask', '--', '--json', '--compare', 'agent-harness'], cwd: '/disposable/arena' });
  assert.equal(evidence.status, 'needs-revalidation');
  assert.match(evidence.detail, /revalidat/);
});

test('Arena never treats an undated current label or a future decision as current evidence', async () => {
  for (const records of [
    { schema: 'arena-query/1', status: 'current' },
    { schema: 'arena-query/1', status: 'current', picks: [{ status: 'current', data: { asOf: '2026-02-30', revalidateBy: '2999-01-02' } }] },
    { schema: 'arena-query/1', status: 'current', picks: [{ status: 'current', data: { asOf: '2999-01-01', revalidateBy: '2999-01-02' } }] },
  ]) {
    const evidence = await arenaEvidence('test', { cwd: '/disposable/arena', run: async () => ({ stdout: JSON.stringify(records) }) });
    assert.equal(evidence.status, 'needs-revalidation');
  }
});

test('API-key or unknown client billing cannot pass a plan-only task as an existing subscription', () => {
  for (const billing of ['metered', 'unknown', undefined] as const) {
    const routes = inventory({ codex: { status: 'ok', detail: 'signed in', billing }, claude: { status: 'warn', detail: 'absent' }, settings: { own: null, gateway: null, active: null, harness: 'Codex', hint: null }, local: { runtimes: [] } });
    assert.equal(choose(routes, { needs: ['model'], network: true, spend: 'plan' }).choice, null);
    assert.equal(routes.find((r) => r.id === 'codex')?.spends, 'metered');
  }
});

test('an available route names the concrete engine setup this home still needs', () => {
  const routes = inventory({ codex: { status: 'ok', detail: 'signed in', billing: 'plan' }, claude: { status: 'warn', detail: 'absent' }, settings: { own: null, gateway: null, active: null, harness: 'Pi', hint: null }, local: { runtimes: [] } });
  assert.equal(routes.find((r) => r.id === 'codex')?.availability?.state, 'setup');
  assert.match(routes.find((r) => r.id === 'codex')?.availability?.detail ?? '', /backbone engine codex/);
});

test('a setup route cannot displace a route that this home can run now', () => {
  const routes = inventory({ codex: { status: 'ok', detail: 'signed in', billing: 'plan' }, claude: { status: 'warn', detail: 'absent' }, settings: { own: null, gateway: null, active: { kind: 'gateway', label: 'Configured API' }, harness: 'Pi', hint: null }, local: { runtimes: [] } });
  const selection = choose(routes, { needs: ['model', 'files'], network: true, spend: 'metered', structured: true });
  assert.equal(selection.choice?.route.id, 'model-route');
  const client = selection.excluded.find((option) => option.route.id === 'codex')!;
  assert.equal(client.route.availability?.state, 'setup');
  assert.match(client.reasons.join(' '), /backbone engine codex/);
});

test('a signed-in native client still needs a configured model before it is usable now', () => {
  const routes = inventory({ codex: { status: 'ok', detail: 'signed in', billing: 'plan' }, claude: { status: 'warn', detail: 'absent' }, settings: { own: null, gateway: null, active: null, native: { provider: 'codex', model: '' }, harness: 'Codex', hint: 'Choose a model for this client.' }, local: { runtimes: [] } });
  assert.equal(routes.find((r) => r.id === 'codex')?.availability?.state, 'setup');
  assert.match(routes.find((r) => r.id === 'codex')?.availability?.detail ?? '', /Choose a model/);
});

test('the local Arena query disables npm network maintenance', async () => {
  let environment: NodeJS.ProcessEnv | undefined;
  await arenaEvidence('agent-harness', { cwd: '/disposable/arena', run: async (_command, _args, options) => {
    environment = options.env;
    return { stdout: JSON.stringify({ schema: 'arena-query/1', status: 'not_found' }) };
  } });
  assert.equal(environment?.npm_config_offline, 'true');
  assert.equal(environment?.npm_config_update_notifier, 'false');
});

test('an observed client is setup metadata and cannot advertise or become an executable agent route', () => {
  const routes = inventory({ codex: { status: 'warn', detail: 'absent' }, claude: { status: 'ok', detail: 'version found' }, settings: { own: null, gateway: null, active: null, harness: 'Pi', hint: null }, local: { runtimes: [] } });
  const client = routes.find((route) => route.id === 'claude-client')!;
  assert.equal(client.kind, 'client-setup');
  assert.equal(concreteRoute(client, { runtimes: [] }, { kind: 'agent', provider: 'acp:fixture', baseUrl: 'stdio://fixture', model: 'chosen-by-agent', label: 'Configured ACP', credential: null }), null);
  const selection = choose([{ ...client, eligible: true }], { needs: ['model'], network: true, spend: 'metered' });
  assert.equal(selection.choice, null, 'a discovery claim cannot turn an unconfigured client into an executor');
  assert.equal(selection.excluded[0].route.eligible, false);
  assert.equal(selection.excluded[0].route.availability?.state, 'setup');
});

test('a configured keyless loopback route is usable on a non-default port and is not inferred from stale local settings', async () => {
  const { startScriptedModel } = await import('../src/testing/scripted-model.ts');
  const { open, idle, settings, value } = await import('./helpers.ts');
  const configured = await startScriptedModel('configured-selection');
  const inactive = await startScriptedModel('inactive-selection');
  const previous = { endpoint: process.env.BACKBONE_MODEL_ENDPOINT, model: process.env.BACKBONE_MODEL_ID };
  process.env.BACKBONE_MODEL_ENDPOINT = configured.url;
  process.env.BACKBONE_MODEL_ID = configured.model;
  try {
    const { host } = open(undefined, { harness: 'harness-pi', localModels: { ports: { ollama: 0, lmstudio: 0, llamacpp: 0, vllm: 0 } } });
    value(await host.call('settings.model.put', { change: { route: 'local', provider: 'other', baseUrl: configured.url, model: configured.model } }));
    const task = { needs: ['model', 'files'] as ('model' | 'files')[], network: false, spend: 'none' as const };
    const options = await host.call('solutions.options', task);
    assert.equal(options.choice?.route.id, `local:other:${configured.model}`);
    const projectId = value(await host.call('projects.create', { name: 'Configured route', kind: 'folder' })).id;
    const run = value(await host.call('solutions.run', { projectId, text: 'Write an editable brief', task, settings, clientKey: 'configured-only' }));
    assert.ok(run.started, run.detail);
    const turn = (await idle(host, run.started.threadId)).turns[0];
    assert.equal(turn.selection?.ran?.baseUrl, configured.url);
    assert.ok(configured.requests.some((r) => r.body.includes('"messages"')));
    assert.equal(inactive.requests.length, 0);
    value(await host.call('settings.model.put', { change: { route: 'local', clear: true } }));
    // This is a configuration read only; the reserved invalid domain is never contacted.
    value(await host.call('settings.model.put', { change: { route: 'own', provider: 'openai-compatible', model: 'fake-model', key: 'fake-selection-key', baseUrl: 'https://example.invalid/v1' } }));
    const moved = await host.call('solutions.options', task);
    assert.equal(moved.choice, null, 'stored local settings cannot classify a different effective route as free or local');
  } finally {
    for (const [key, old] of [['BACKBONE_MODEL_ENDPOINT', previous.endpoint], ['BACKBONE_MODEL_ID', previous.model]]) {
      if (old === undefined) delete process.env[key!]; else process.env[key!] = old;
    }
    await configured.close(); await inactive.close();
  }
});
