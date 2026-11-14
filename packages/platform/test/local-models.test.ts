import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// A local model the person chooses in Settings (scorecard row 10): a stored keyless route to a server
// on this computer, found by probing the usual ports on 127.0.0.1 only. Every server here is a
// stand-in on a random loopback port; nothing is started, installed or downloaded.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CredentialStore } from '../src/credentials/store.ts';
import type { KeychainReader } from '../src/credentials/keychain.ts';
import { detectLocalModels, LOCAL_PORTS, MAX_LOCAL_MODEL } from '../src/models/local.ts';
import { ModelRoutes, ROUTE_ORDER } from '../src/models/route.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import { b64, idle, open, settings, value } from './helpers.ts';

const homes: string[] = [];
const servers: Server[] = [];
after(async () => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

function routes(env: NodeJS.ProcessEnv = {}, keychain = false) {
  const home = mkdtempSync(join(tmpdir(), 'local-route-')); homes.push(home);
  const reader: KeychainReader = { has: (service) => service === 'backbone-openrouter', read: async () => 'sk-or-keychain' };
  const master = randomBytes(32);
  const store = new CredentialStore(home, async () => master, keychain ? reader : undefined);
  return { home, routes: new ModelRoutes(home, store, env, false, keychain) };
}

/** A loopback server answering each request with `answer`; it counts what reached it. */
async function serve(answer: (url: string) => { status: number; body?: string; headers?: Record<string, string> }) {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const a = answer(req.url ?? '');
    res.writeHead(a.status, { 'content-type': 'application/json', ...a.headers });
    res.end(a.body ?? '');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, hits };
}

/** A port on 127.0.0.1 with nothing listening. */
async function closedPort() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise((r) => server.close(r));
  return port;
}

// Stack 25 correction: only the person's saved local choice overrides saved keys.
// An ambient/test endpoint must not hide the route or spending category they configured.
test('a saved local model precedes keys, and saved keys precede an ambient endpoint', async () => {
  assert.deepEqual(ROUTE_ORDER, ['local', 'own', 'gateway', 'keychain', 'endpoint']);
  const env: NodeJS.ProcessEnv = { BACKBONE_MODEL_ENDPOINT: 'http://127.0.0.1:9/v1', BACKBONE_MODEL_ID: 'scripted' };
  const { routes: r } = routes(env);
  assert.equal(r.resolve()?.baseUrl, 'http://127.0.0.1:9/v1', 'an ambient endpoint is a fallback with no saved choice');
  await r.change({ route: 'gateway', provider: 'openrouter', key: 'sk-or-pasted', model: 'some/model' });
  await r.change({ route: 'own', provider: 'openai', key: 'sk-own', model: 'gpt-x' });
  await r.change({ route: 'local', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2:3b' });
  const seen = () => { const x = r.resolve(); return x && `${x.kind}:${x.baseUrl}:${x.model}`; };
  assert.equal(seen(), 'endpoint:http://127.0.0.1:11434/v1:llama3.2:3b');
  const local = r.resolve()!;
  assert.equal(local.credential, null);
  assert.match(local.label, /^Ollama · llama3\.2:3b · on this computer/);
  assert.deepEqual(r.settings().local, { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2:3b' });
  await r.change({ route: 'local', clear: true });
  assert.equal(seen(), 'own:https://api.openai.com/v1:gpt-x');
  await r.change({ route: 'own', clear: true });
  assert.equal(seen(), 'gateway:https://openrouter.ai/api/v1:some/model');
  await r.change({ route: 'gateway', clear: true });
  assert.equal(seen(), 'endpoint:http://127.0.0.1:9/v1:scripted', 'without any saved key, the ambient endpoint is used');
  env.BACKBONE_MODEL_ENDPOINT = '';
  assert.equal(r.resolve(), null, 'an empty ambient endpoint is unset');
  delete env.BACKBONE_MODEL_ENDPOINT;
  assert.equal(r.resolve(), null, 'an unset ambient endpoint has no route');
  assert.equal(r.settings().local, null);
});

test('a local route takes a loopback address only, and a refused one leaves nothing behind', async () => {
  const { home, routes: r } = routes();
  for (const baseUrl of ['https://example.com/v1', 'http://10.0.0.5:11434/v1', 'http://192.168.1.2:1234/v1', 'http://127.0.0.1.example.com:80/v1', 'http://localhost:1234@example.com/v1', 'http://127.0.0.1/v1', 'ftp://127.0.0.1:21/', '']) {
    await assert.rejects(r.change({ route: 'local', provider: 'other', baseUrl, model: 'm' }), /this computer/, baseUrl);
  }
  await assert.rejects(r.change({ route: 'local', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: '' }), /model/);
  await assert.rejects(r.change({ route: 'local', provider: 'nope' as never, baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' }), /runtime/);
  assert.equal(existsSync(join(home, 'model-route.json')), false, 'nothing was written');
  assert.equal(r.resolve(), null);
  // A hand-edited file that names another host is not a route either.
  await r.change({ route: 'local', provider: 'vllm', baseUrl: 'http://[::1]:8000/v1/', model: 'qwen' });
  assert.equal(r.resolve()?.baseUrl, 'http://[::1]:8000/v1', 'the trailing slash is dropped');
  const path = join(home, 'model-route.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, readFileSync(path, 'utf8').replace('http://[::1]:8000/v1', 'https://attacker.example/v1'));
  assert.throws(() => r.resolve(), /local model setting.*invalid/i, 'an invalid stored choice refuses instead of selecting another route');
});

test('detection reads /v1/models from what runs on the probe ports, and says nothing runs otherwise', async () => {
  const long = 'x'.repeat(MAX_LOCAL_MODEL + 50);
  const stand = await serve((url) => url === '/v1/models'
    ? { status: 200, body: JSON.stringify({ object: 'list', data: [{ id: 'llama3.2:3b' }, { id: 'qwen3\u0000‮:8b' }, { id: long }, { id: 42 }, {}] }) }
    : { status: 404 });
  const junk = await serve(() => ({ status: 200, body: 'not json' }));
  const ports = { ollama: stand.port, lmstudio: junk.port, llamacpp: await closedPort(), vllm: await closedPort() };
  const found = await detectLocalModels({ ports, timeoutMs: 500 });
  assert.deepEqual(found.runtimes.map((x) => [x.provider, x.baseUrl]), [['ollama', `http://127.0.0.1:${stand.port}/v1`]]);
  const models = found.runtimes[0].models;
  assert.equal(models[0], 'llama3.2:3b');
  assert.equal(models[1], 'qwen3:8b', 'control and format characters are dropped');
  assert.equal(models[2].length, MAX_LOCAL_MODEL, 'a name is length-capped');
  assert.equal(models.length, 3, 'only string ids are names');
  assert.deepEqual(stand.hits, ['/v1/models'], 'one read, nothing else');
  assert.deepEqual(await detectLocalModels({ ports: { ollama: await closedPort(), lmstudio: await closedPort(), llamacpp: await closedPort(), vllm: await closedPort() } }), { runtimes: [] });
  assert.deepEqual(LOCAL_PORTS, { ollama: 11434, lmstudio: 1234, llamacpp: 8080, vllm: 8000 });
});

test('a probe that never answers is given up quickly', { timeout: TEST_HANG_MS * 2 }, async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const signals:AbortSignal[]=[];
  t.mock.method(AbortSignal,'timeout',(ms:number)=>{
    assert.equal(ms,200);
    const controller=new AbortController();
    setTimeout(()=>controller.abort(),ms);
    return controller.signal;
  });
  const probing=detectLocalModels({timeoutMs:200,fetch:((_url:unknown,options:RequestInit)=>new Promise((_resolve,reject)=>{
    const signal=options.signal!;signals.push(signal);
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  })) as typeof fetch});
  assert.equal(signals.length,4,'all probes start before any deadline expires');
  t.mock.timers.tick(199);assert.ok(signals.every(signal=>!signal.aborted));
  t.mock.timers.tick(1);assert.ok(signals.every(signal=>signal.aborted));
  const found = await probing;
  assert.deepEqual(found, { runtimes: [] });
});

test('no probe goes anywhere but 127.0.0.1, and a redirect is not followed', async () => {
  const elsewhere = await serve(() => ({ status: 200, body: JSON.stringify({ data: [{ id: 'should-not-see' }] }) }));
  const redirect = await serve(() => ({ status: 302, headers: { location: `http://localhost:${elsewhere.port}/v1/models` } }));
  const asked: { url: string; redirect?: string }[] = [];
  const spy: typeof fetch = (input, init) => { asked.push({ url: String(input), redirect: init?.redirect }); return fetch(input, init); };
  const found = await detectLocalModels({ ports: { ollama: redirect.port, lmstudio: await closedPort(), llamacpp: await closedPort(), vllm: await closedPort() }, fetch: spy });
  assert.deepEqual(found, { runtimes: [] });
  assert.deepEqual(elsewhere.hits, [], 'the redirect target was never reached');
  assert.equal(asked.length, 4);
  for (const a of asked) {
    const u = new URL(a.url);
    assert.equal(u.hostname, '127.0.0.1', a.url);
    assert.equal(u.protocol, 'http:');
    assert.equal(u.pathname, '/v1/models');
    assert.equal(a.redirect, 'error');
  }
  // With the default ports, the same: only 127.0.0.1, never a name that could resolve elsewhere.
  asked.length = 0;
  await detectLocalModels({ timeoutMs: 100, fetch: (input) => { asked.push({ url: String(input) }); return Promise.reject(new Error('refused')); } });
  assert.deepEqual(asked.map((a) => a.url).sort(), ['http://127.0.0.1:11434/v1/models', 'http://127.0.0.1:1234/v1/models', 'http://127.0.0.1:8000/v1/models', 'http://127.0.0.1:8080/v1/models'].sort());
});

test('a Pi turn on the stored local route reaches the local model, with no key, after one click from detection', async () => {
  const saved = { endpoint: process.env.BACKBONE_MODEL_ENDPOINT, id: process.env.BACKBONE_MODEL_ID };
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  const model = await startScriptedModel('local-llama');
  try {
    const ports = { ollama: Number(new URL(model.url).port), lmstudio: await closedPort(), llamacpp: await closedPort(), vllm: await closedPort() };
    const { host } = open(undefined, { harness: 'harness-pi', localModels: { ports } });
    assert.equal((await host.call('settings.model.get', {})).active, null, 'nothing set up yet');
    const found = await host.call('models.local', {});
    assert.deepEqual(found.runtimes.map((x) => [x.provider, x.models]), [['ollama', ['local-llama']]]);
    const runtime = found.runtimes[0];
    const set = value(await host.call('settings.model.put', { change: { route: 'local', provider: runtime.provider, baseUrl: runtime.baseUrl, model: runtime.models[0] } }));
    assert.equal(set.active?.kind, 'endpoint');
    assert.match(set.active?.label ?? '', /^Ollama · local-llama · on this computer/);
    const p = value(await host.call('projects.create', { name: 'Local', kind: 'folder' }));
    const note = value(await host.call('material.attach', { projectId: p.id, name: 'note.md', base64: b64('# Plan\nShip Friday.\n'), mediaType: 'text/markdown' }));
    const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Write an editable brief from these', attachments: [note.id], settings, clientKey: 'c1' }));
    const turn = (await idle(host, sent.threadId)).turns[0];
    assert.equal(turn.status, 'done', turn.answer?.text ?? '');
    assert.match(turn.work.harness, /Ollama · local-llama/);
    const chats = model.requests.filter((r) => r.body.includes('"messages"'));
    assert.ok(chats.length > 0, 'the turn reached the local model');
    assert.ok(chats.every((r) => r.headers.authorization === undefined || !/Bearer \S{8,}/.test(r.headers.authorization)), 'no key is sent');
    assert.ok(chats.every((r) => JSON.parse(r.body).model === 'local-llama'));
  } finally {
    if (saved.endpoint !== undefined) process.env.BACKBONE_MODEL_ENDPOINT = saved.endpoint;
    if (saved.id !== undefined) process.env.BACKBONE_MODEL_ID = saved.id;
    await model.close();
  }
});

test('saving an API key replaces an older saved local preference for ordinary chats', async () => {
  const { routes: r } = routes();
  for (const change of [
    { route: 'own', provider: 'openai', key: 'fake-key', model: 'key-chat' },
    { route: 'gateway', provider: 'openrouter', key: 'fake-key', model: 'gateway-chat' },
  ] as const) {
    await r.change({ route: 'local', provider: 'other', baseUrl: 'http://127.0.0.1:9/v1', model: 'local-chat' });
    assert.equal(r.resolve()?.model, 'local-chat');
    // Clear the preceding own route so this case exercises the saved gateway choice.
    if (change.route === 'gateway') await r.change({ route: 'own', clear: true });
    await r.change(change);
    assert.equal(r.settings().local, null);
    assert.equal(r.resolve()?.model, change.model);
  }
});
