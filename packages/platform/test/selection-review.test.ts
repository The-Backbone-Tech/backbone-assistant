import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inventory } from '../src/selection/inventory.ts';
import { choose } from '../src/selection/choose.ts';
import { arenaEvidence } from '../src/selection/arena.ts';
import { pinFor, pinnedRoute } from '../src/selection/pin.ts';
import { routeFingerprint } from '../src/selection/route-identity.ts';

const local = { runtimes: [{ provider: 'ollama' as const, name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['nomic-embed-text', 'qwen3:32b'] }] };
const clients = { codex: { status: 'warn' as const, detail: 'absent' }, claude: { status: 'warn' as const, detail: 'absent' } };
test('a saved route wins over a discovered server, including its embedding model', () => {
  for (const kind of ['endpoint', 'own', 'gateway'] as const) {
    const routes = inventory({ ...clients, local, settings: { own: null, gateway: null, active: { kind, label: 'Saved route', keylessLoopback: kind === 'endpoint' }, harness: 'Pi', hint: null } });
    assert.equal(choose(routes, { needs: ['model', 'files'], network: true, spend: 'metered' }).choice?.route.id, 'model-route');
    for (const route of routes.filter(r => r.kind === 'local-model')) assert.equal(route.availability?.state, 'setup');
  }
});
test('discovery alone never selects a server or promises no-charge chat capability', () => {
  const routes = inventory({ ...clients, local, settings: { own: null, gateway: null, active: null, harness: 'Pi', hint: null } });
  assert.equal(choose(routes, { needs: ['model'], network: true, spend: 'metered' }).choice, null);
  assert.ok(routes.filter(r => r.kind === 'local-model').every(r => r.spends !== 'none' && !r.eligible));
});
test('a configured embedding model cannot be selected for chat', () => {
  const routes = inventory({ ...clients, local: { runtimes: [] }, settings: { own: null, gateway: null, active: { kind: 'endpoint', label: 'Embeddings', model: 'nomic-embed-text', keylessLoopback: true }, harness: 'Pi', hint: null } });
  assert.equal(choose(routes, { needs: ['model'], network: false, spend: 'none' }).choice, null);
});
test('Arena receives no provider environment and withholds expired decision text', async () => {
  const prior = process.env.SELECTION_PROVIDER_CANARY;
  process.env.SELECTION_PROVIDER_CANARY = 'fake-private-environment';
  try {
    const result = await arenaEvidence('public-topic', { cwd: '/disposable/arena', run: async (_command, _args, options) => {
      assert.equal(options.env.SELECTION_PROVIDER_CANARY, undefined);
      assert.equal(options.env.NODE_OPTIONS, undefined);
      return { stdout: JSON.stringify({ schema: 'arena-query/1', status: 'not_current', picks: [{ status: 'not_current', data: { decision: 'stale-choice-do-not-print' } }] }) };
    } });
    assert.equal(result.status, 'needs-revalidation');
    assert.ok(!JSON.stringify(result).includes('stale-choice-do-not-print'));
  } finally { if (prior === undefined) delete process.env.SELECTION_PROVIDER_CANARY; else process.env.SELECTION_PROVIDER_CANARY = prior; }
});

test('an approved route binds its account through admission and does not persist the one-call constraint', () => {
  const configured = { kind: 'own' as const, provider: 'openai-compatible' as const, baseUrl: 'https://example.invalid/v1', model: 'chat-model', label: 'Saved route', credential: 'fake-handle-a' };
  const choice = { id: 'model-route', kind: 'model-route' as const, label: configured.label, capabilities: ['model' as const], network: true, spends: 'metered' as const, eligible: true };
  const pin = pinFor(choice, [], { needs: ['model'], network: true, spend: 'metered', approvedRoute: { routeId: choice.id, model: configured.model, fingerprint: routeFingerprint(configured), spend: choice.spends } }, { runtimes: [] }, configured);
  assert.ok('selection' in pin);
  assert.equal(pin.selection.task.approvedRoute, undefined);
  assert.ok('refused' in pinnedRoute(pin.selection, { ...configured, credential: 'fake-handle-b' }));
  assert.ok(!JSON.stringify(pin.selection).includes('fake-handle-a'));
});

test('a historical discovered route needs an explicit current selection and cannot resume an embedding model', () => {
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen', label: 'Old discovery', credential: null };
  const selection = { task: { needs: ['model' as const], network: false, spend: 'none' as const }, routeId: 'local:ollama:qwen', reasons: [], pinned: route };
  assert.ok('refused' in pinnedRoute(selection, null));
  assert.ok('route' in pinnedRoute(selection, route));
  const embedding = { ...route, model: 'nomic-embed-text' };
  assert.ok('refused' in pinnedRoute({ ...selection, pinned: embedding }, embedding));
});

test('saved keys then an explicit saved local model receive tasks while a scanned embedding server receives none', async () => {
  const { startScriptedModel } = await import('../src/testing/scripted-model.ts');
  const { open, value, settings, idle } = await import('./helpers.ts');
  const key = await startScriptedModel('saved-key-chat'), ambient = await startScriptedModel('ambient-chat'), discovered = await startScriptedModel('nomic-embed-text');
  const prior = { endpoint: process.env.BACKBONE_MODEL_ENDPOINT, model: process.env.BACKBONE_MODEL_ID };
  process.env.BACKBONE_MODEL_ENDPOINT = ambient.url; process.env.BACKBONE_MODEL_ID = ambient.model;
  const chats = (server: typeof key) => server.requests.filter(r => r.body.includes('"messages"')).length;
  try {
    const { host } = open(undefined, { harness: 'harness-pi', localModels: { ports: { ollama: Number(new URL(discovered.url).port), lmstudio: 0, llamacpp: 0, vllm: 0 } } });
    value(await host.call('settings.model.put', { change: { route: 'own', provider: 'openai-compatible', baseUrl: key.url, model: key.model, key: 'fake-selection-key' } }));
    const projectId = value(await host.call('projects.create', { name: 'Saved precedence', kind: 'folder' })).id;
    const first = value(await host.call('solutions.run', { projectId, text: 'Write an editable brief', task: { needs: ['model', 'files'], network: true, spend: 'metered' }, settings, clientKey: 'saved-key' }));
    assert.ok(first.started, first.detail); await idle(host, first.started.threadId);
    assert.ok(chats(key) > 0); assert.equal(chats(ambient), 0); assert.equal(chats(discovered), 0);
    const keyRequests = chats(key);
    value(await host.call('settings.model.put', { change: { route: 'local', provider: 'other', baseUrl: ambient.url, model: ambient.model } }));
    const second = value(await host.call('solutions.run', { projectId, text: 'Write an editable brief', task: { needs: ['model', 'files'], network: false, spend: 'none' }, settings, clientKey: 'saved-local' }));
    assert.ok(second.started, second.detail);
    const selected = (await idle(host, second.started.threadId)).turns[0].selection!;
    assert.equal(second.selection.choice?.route.id, `local:other:${ambient.model}`);
    assert.equal(selected.routeId, second.selection.choice?.route.id);
    assert.equal(selected.pinned.baseUrl, ambient.url);
    assert.deepEqual(selected.ran, selected.pinned);
    assert.ok(chats(ambient) > 0); assert.equal(chats(key), keyRequests); assert.equal(chats(discovered), 0);
  } finally {
    if (prior.endpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = prior.endpoint;
    if (prior.model === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = prior.model;
    await key.close(); await ambient.close(); await discovered.close();
  }
});

test('saved local identity comes from the effective destination, not a matching discovered name', () => {
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:12435/v1', model: 'saved-chat', label: 'Saved local', credential: null };
  const settings = { own: null, gateway: null, hint: null, harness: 'Pi', local: { provider: 'ollama' as const, baseUrl: route.baseUrl, model: route.model }, active: { kind: route.kind, label: route.label, model: route.model, keylessLoopback: true, fingerprint: routeFingerprint(route) } };
  const scanned = { runtimes: [{ provider: 'ollama' as const, name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: [route.model] }] };
  const task = { needs: ['model' as const], network: false, spend: 'none' as const };
  const compared = choose(inventory({ ...clients, settings, local: scanned }), task);
  assert.equal(compared.choice?.route.id, 'local:ollama:saved-chat');
  assert.equal(compared.choice?.route.kind, 'model-route', 'the saved choice uses the configured executor, never a scanned endpoint');
  assert.equal(compared.feasible.length, 1);
  assert.ok(compared.excluded.some(option => option.route.id === 'discovered:local:ollama:saved-chat' && !option.route.eligible));
  const pin = pinFor(compared.choice!.route, [], task, scanned, route);
  assert.ok('selection' in pin);
  assert.equal(pin.selection.pinned.baseUrl, route.baseUrl);
  const stale = inventory({ ...clients, settings: { ...settings, local: { ...settings.local, baseUrl: 'http://127.0.0.1:9/v1' } }, local: scanned });
  assert.equal(choose(stale, task).choice?.route.id, 'model-route', 'stale local settings cannot rename another effective destination');
  const sameServer = inventory({ ...clients, settings, local: { runtimes: [{ ...scanned.runtimes[0], baseUrl: route.baseUrl }] } });
  assert.equal(sameServer.filter(option => option.id === 'local:ollama:saved-chat').length, 1, 'the saved server is compared once');
});
