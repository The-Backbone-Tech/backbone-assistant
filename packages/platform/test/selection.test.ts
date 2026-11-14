// Solution selection, its choice step, on the J-solution method's three profiles (backbone-way
// acceptance/J-solution/method-v1): the same task gets different justified choices under different
// access, a restricted task that only code can do is done in code, and an impossible one is a
// concrete limitation, never a fabricated winner.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choose, type Route, type TaskNeeds } from '../src/selection/choose.ts';
import { inventory } from '../src/selection/inventory.ts';
import { open, value } from './helpers.ts';

const codex: Route = { id: 'codex', label: 'Codex (signed in)', kind: 'native-engine', capabilities: ['model', 'code', 'files'], network: true, spends: 'plan', eligible: true };
const openrouter = (eligible: boolean): Route => ({ id: 'pi-openrouter', label: 'Pi on OpenRouter', kind: 'model-route', capabilities: ['model', 'files'], network: true, spends: 'metered', eligible, ...(eligible ? {} : { blocked: 'no OpenRouter key in the Keychain (backbone-openrouter)' }) });
const codexContained: Route = { id: 'codex-contained', label: 'Codex, contained', kind: 'native-engine', capabilities: ['model', 'code', 'files'], network: true, spends: 'plan', eligible: true };
const ledgerTool: Route = { id: 'tool:ledger', label: 'A maintained ledger converter', kind: 'code-only', capabilities: ['code', 'files'], network: false, spends: 'none', eligible: true };
const localModel: Route = { id: 'saved-local', label: 'Saved qwen3 on Ollama', kind: 'model-route', capabilities: ['model', 'files'], network: false, spends: 'none', eligible: true };

const T2: TaskNeeds = { needs: ['model', 'files'], network: true, spend: 'metered', structured: true };
// No maintained converter exists for T3, so it needs a model to write the transformation; code to run it is preferred.
const T3: TaskNeeds = { needs: ['model', 'files'], network: true, spend: 'metered', structured: true };
const T3withTool: TaskNeeds = { needs: ['code', 'files'], network: true, spend: 'metered', structured: true };
const restricted = (t: TaskNeeds): TaskNeeds => ({ ...t, network: false, spend: 'none' });

test('P1: the signed-in tool the person has is chosen, with its reasons; a blocked route says why', () => {
  const s = choose([codex, openrouter(false), ledgerTool], T2);
  assert.equal(s.choice?.route.id, 'codex');
  assert.ok(s.choice!.reasons.includes('a tool the person already uses'));
  assert.match(s.excluded.find((o) => o.route.id === 'pi-openrouter')!.reasons.join(' '), /no OpenRouter key/);
  assert.match(s.excluded.find((o) => o.route.id === 'tool:ledger')!.reasons.join(' '), /cannot reason over text/);
});

test('the same transformation gets different justified choices under different access', () => {
  const p1 = choose([codex, openrouter(false)], T3);
  assert.equal(p1.choice?.route.id, 'codex', 'P1: Codex, which can also run the code it writes');
  assert.ok(p1.choice!.reasons.includes('supports computing figures in code; verify the inputs and calculation'));
  const p2 = choose([openrouter(true)], T3);
  assert.equal(p2.choice?.route.id, 'pi-openrouter', 'P2: the model route, without code, so its figures are not computed in code');
  assert.ok(!p2.choice!.reasons.includes('supports computing figures in code; verify the inputs and calculation'));
  assert.equal(choose([codex, ledgerTool], T3withTool).choice?.route.id, 'tool:ledger', 'with a maintained converter for the job, it wins at no cost');
});

test('P3 restricted: a local model or a maintained tool does it; with neither, a stated limitation', () => {
  assert.equal(choose([codexContained, openrouter(true), localModel], restricted(T3)).choice?.route.id, 'saved-local');
  assert.equal(choose([codexContained, ledgerTool], restricted(T3withTool)).choice?.route.id, 'tool:ledger');
  const none = choose([codexContained, openrouter(true)], restricted(T2));
  assert.equal(none.choice, null);
  assert.match(none.limitation!, /No route here can do this task/);
  assert.match(none.limitation!, /reaches the network, which this task may not/);
});

test('with nothing configured, the limitation says so', () => {
  assert.match(choose([], T2).limitation!, /none is configured/);
});


test('the inventory says which routes are here and why one is not: signed out, no key, nothing local', () => {
  const routes = inventory({ codex: { status: 'warn', detail: 'signed out' }, settings: { own: null, gateway: null, active: null, hint: 'Add an OpenRouter key in the Keychain.', harness: 'Pi' }, local: { runtimes: [] } });
  const by = Object.fromEntries(routes.map((r) => [r.id, r]));
  assert.equal(by.codex.eligible, false);
  assert.match(by.codex.blocked!, /signed out; the person signs in/);
  assert.equal(by['model-route'].eligible, false);
  assert.match(by['model-route'].blocked!, /OpenRouter key/);
  const withLocal = inventory({ codex: { status: 'ok', detail: 'signed in' }, settings: { own: null, gateway: null, active: { kind: 'gateway', label: 'OpenRouter' }, hint: null, harness: 'Pi' }, local: { runtimes: [{ provider: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen3'] }] } });
  assert.deepEqual(withLocal.filter((r) => r.eligible).map((r) => r.id), ['codex', 'model-route']);
  assert.ok(!routes.some((r) => r.kind === 'code-only'), 'no code runs here without a model unless a maintained tool is named');
});

test('solutions.options answers from this host: every route with its eligibility, and a reasoned choice', async () => {
  const { host } = open();
  const s = await host.call('solutions.options', { needs: ['model', 'files'], network: false, spend: 'none', structured: true });
  // No local model here and no network allowed: the honest answer names why each route cannot.
  if (!s.choice) assert.match(s.limitation!, /No route here can do this task/);
  assert.ok([...s.feasible, ...s.excluded].some((o) => o.route.id === 'codex'), 'the native tool is in the inventory, eligible or not');
});

test('a task is done only when its deliverables were written by the turn and read back as their kind', async () => {
  const { verifyDeliverables } = await import('../src/selection/verify.ts');
  const turn = (effects: { target: string; outcome: 'DONE' | 'UNKNOWN' | 'REFUSED' }[], status = 'done') => ({ status, effects: effects.map((e, i) => ({ key: `k${i}`, kind: 'write-working-copy', ...e })) }) as never;
  const files: Record<string, string> = {
    'ledger.csv': 'date,vendor,amount_eur\n2026-10-03,Papelería Norte,1250.40\n',
    'totals.csv': 'vendor,total_eur\nCloudly Inc,1881.95\nTOTAL\n',
    'brief.md': '# Renewals\n\nFive exceptions need the VP; two are urgent.\n',
  };
  const read = (n: string) => files[n];
  const ok = verifyDeliverables(turn([{ target: 'ledger.csv', outcome: 'DONE' }, { target: 'brief.md', outcome: 'DONE' }]), ['ledger.csv', 'brief.md'], read);
  assert.equal(ok.complete, true);
  const bad = verifyDeliverables(turn([{ target: 'ledger.csv', outcome: 'DONE' }, { target: 'totals.csv', outcome: 'DONE' }]), ['ledger.csv', 'totals.csv'], read);
  assert.equal(bad.complete, false);
  assert.match(bad.summary, /totals.csv row 2 has 1 columns, its header 2/);
  const claimed = verifyDeliverables(turn([]), ['brief.md'], read);
  assert.match(claimed.summary, /brief.md this turn did not write it/, 'a file that exists but was not written by this turn is not its deliverable');
  assert.match(verifyDeliverables(turn([{ target: 'brief.md', outcome: 'UNKNOWN' }]), ['brief.md'], read).summary, /UNKNOWN/);
  assert.equal(verifyDeliverables(turn([{ target: 'brief.md', outcome: 'DONE' }], 'stopped'), ['brief.md'], read).complete, false);
  assert.equal(verifyDeliverables(turn([]), [], read).complete, false, 'nothing named, nothing claimed');
});

test('solutions.run starts only on this home\'s engine or says why; solutions.verify reads back what the turn wrote', async () => {
  const { idle, settings, value } = await import('./helpers.ts');
  const { host } = open();
  const projectId = value(await host.call('projects.create', { name: 'P', kind: 'folder' })).id;
  // This test home runs the stand-in engine, so whatever route is best here, it is not this home's engine.
  const run = value(await host.call('solutions.run', { projectId, text: 'Write an editable brief', task: { needs: ['model', 'files'], network: true, spend: 'metered' }, settings, clientKey: 'r1' }));
  assert.equal(run.started, null);
  assert.ok(run.detail.length > 0, 'it says why it did not start');
  // A turn that writes a brief, verified as the task's deliverable; one it did not write is caught.
  const sent = value(await host.call('turns.send', { projectId, text: 'Write an editable brief', attachments: [], settings, clientKey: 's1' }));
  await idle(host, sent.threadId);
  const done = value(await host.call('solutions.verify', { threadId: sent.threadId, turnId: sent.turnId, deliverables: ['brief.md'] }));
  assert.equal(done.complete, true, done.summary);
  const missing = value(await host.call('solutions.verify', { threadId: sent.threadId, turnId: sent.turnId, deliverables: ['brief.md', 'ledger.csv'] }));
  assert.equal(missing.complete, false);
  assert.match(missing.summary, /ledger.csv this turn did not write it/);
});

test('solutions.verify judges the version the turn wrote; a later edit by a person is reported and decides nothing', async () => {
  const { idle, settings, value } = await import('./helpers.ts');
  const { host } = open();
  const projectId = value(await host.call('projects.create', { name: 'P', kind: 'folder' })).id;
  const sent = value(await host.call('turns.send', { projectId, text: 'Write an editable brief', attachments: [], settings, clientKey: 'v1' }));
  const turn = (await idle(host, sent.threadId)).turns[0];
  const wrote = turn.effects.find((e) => e.target === 'brief.md' && e.outcome === 'DONE')!;
  assert.equal(wrote.version, 1, 'the write records the version it made');
  assert.ok(wrote.materialId && wrote.sha256, 'and which document, and the hash of what it wrote');
  // A person then saves a v2 that would not pass as the deliverable on its own.
  value(await host.call('material.save', { id: wrote.materialId!, text: 'ok', baseVersion: 1 }));
  const checked = value(await host.call('solutions.verify', { threadId: sent.threadId, turnId: sent.turnId, deliverables: ['brief.md'] }));
  assert.equal(checked.complete, true, checked.summary);
  assert.equal(checked.checks[0].version, 1, 'v1, the turn\'s own, is the one judged');
  assert.match(checked.checks[0].editedSince ?? '', /person/);
  assert.match(checked.summary, /brief\.md v1 was edited since by person/);
});

test('a later edit cannot make a turn\'s failing output pass', async () => {
  const { verifyDeliverables } = await import('../src/selection/verify.ts');
  const turn = { status: 'done', effects: [{ key: 'k', kind: 'write-working-copy', target: 'brief.md', outcome: 'DONE', materialId: 'm', version: 1, sha256: 'x' }] } as never;
  const v = verifyDeliverables(turn, ['brief.md'], () => ({ text: '#', version: 1, editedSince: 'person (now v2)' }));
  assert.equal(v.complete, false);
  assert.match(v.summary, /brief\.md has almost no words/);
  assert.match(v.summary, /edited since by person/);
});

test('a selected turn runs only on the route it pinned, and a restricted task only on the loopback', async () => {
  const { pinnedRoute, pinFor } = await import('../src/selection/pin.ts');
  const gateway = { kind: 'gateway' as const, provider: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v1', model: 'a', label: 'OpenRouter · a', credential: 'h' };
  const metered: TaskNeeds = { needs: ['model'], network: true, spend: 'metered' };
  const pinned = pinFor({ ...openrouter(true), id: 'model-route', kind: 'model-route' }, [], metered, { runtimes: [] }, gateway);
  assert.ok('selection' in pinned);
  assert.ok('route' in pinnedRoute(pinned.selection, gateway));
  assert.match((pinnedRoute(pinned.selection, { ...gateway, model: 'b', label: 'OpenRouter · b' }) as { refused: string }).refused, /no longer the configured route \(now OpenRouter · b\)/);
  const offline: TaskNeeds = { needs: ['model'], network: false, spend: 'none' };
  assert.match((pinnedRoute({ task: offline, routeId: 'local:ollama:q', reasons: [], pinned: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'https://example.com/v1', model: 'q', label: 'Elsewhere' } }, null) as { refused: string }).refused, /reaches the network/);
  assert.match((pinFor(codex, [], offline, { runtimes: [] }, null) as { refused: string }).refused, /not set up as a route/);
});

test('solutions.run runs the local model it chose, not the configured route: the requests reach the chosen server only', async () => {
  const { createServer } = await import('node:net');
  const { startScriptedModel } = await import('../src/testing/scripted-model.ts');
  const { idle, settings, value } = await import('./helpers.ts');
  const closedPort = () => new Promise<number>((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); }); });
  const configured = await startScriptedModel('configured-model');
  const chosen = await startScriptedModel('local-qwen');
  process.env.BACKBONE_MODEL_ENDPOINT = configured.url;
  process.env.BACKBONE_MODEL_ID = configured.model;
  try {
    const ports = { ollama: Number(new URL(chosen.url).port), lmstudio: await closedPort(), llamacpp: await closedPort(), vllm: await closedPort() };
    const { host } = open(undefined, { harness: 'harness-pi', localModels: { ports, timeoutMs: 1000 } });
    value(await host.call('settings.model.put', { change: { route: 'local', provider: 'other', baseUrl: chosen.url, model: chosen.model } }));
    const projectId = value(await host.call('projects.create', { name: 'P', kind: 'folder' })).id;
    const task: TaskNeeds = { needs: ['model', 'files'], network: false, spend: 'none' };
    const run = value(await host.call('solutions.run', { projectId, text: 'Write an editable brief', task, settings, clientKey: 'local-1' }));
    assert.equal(run.selection.choice?.route.id, 'local:other:local-qwen');
    assert.ok(run.started, run.detail);
    const turn = (await idle(host, run.started.threadId)).turns[0];
    assert.equal(turn.status, 'done', turn.answer?.text ?? '');
    const chats = (m: typeof chosen) => m.requests.filter((r) => r.body.includes('"messages"'));
    assert.ok(chats(chosen).length > 0, 'the chosen local server did the work');
    assert.ok(chats(chosen).every((r) => JSON.parse(r.body).model === 'local-qwen'));
    assert.equal(configured.requests.length, 0, 'the configured route received nothing');
    assert.deepEqual(turn.selection?.task, task);
    assert.equal(turn.selection?.routeId, 'local:other:local-qwen');
    assert.ok(turn.selection?.reasons.includes('costs nothing'));
    assert.equal(turn.selection?.pinned.baseUrl, chosen.url);
    assert.deepEqual(turn.selection?.ran, turn.selection?.pinned, 'what ran is what was chosen');
    assert.match(turn.work.harness, /local-qwen/);
  } finally {
    delete process.env.BACKBONE_MODEL_ENDPOINT;
    delete process.env.BACKBONE_MODEL_ID;
    await configured.close();
    await chosen.close();
  }
});

/** A Pi home whose configured route is one scripted server, with local runtimes probed only on the ports given (closed otherwise). */
async function piHome(configuredUrl: string, configuredModel: string, local: { ollama?: number; fetch?: typeof fetch } = {}) {
  const { createServer } = await import('node:net');
  const closedPort = () => new Promise<number>((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); }); });
  process.env.BACKBONE_MODEL_ENDPOINT = configuredUrl;
  process.env.BACKBONE_MODEL_ID = configuredModel;
  const ports = { ollama: local.ollama ?? await closedPort(), lmstudio: await closedPort(), llamacpp: await closedPort(), vllm: await closedPort() };
  const opened = open(undefined, { harness: 'harness-pi', localModels: { ports, timeoutMs: 1000, ...(local.fetch ? { fetch: local.fetch } : {}) } });
  // H1: the fixture explicitly selects its local chat model; scanned endpoints grant nothing.
  if (local.ollama) value(await opened.host.call('settings.model.put', { change: { route: 'local', provider: 'other', baseUrl: `http://127.0.0.1:${local.ollama}/v1`, model: 'local-qwen' } }));
  return opened;
}
const unsetRoute = () => { delete process.env.BACKBONE_MODEL_ENDPOINT; delete process.env.BACKBONE_MODEL_ID; };
const chatsOf = (m: { requests: { body: string }[] }) => m.requests.filter((r) => r.body.includes('"messages"'));
const toolsOf = (body: string) => ((JSON.parse(body) as { tools?: { function: { name: string } }[] }).tools ?? []).map((t) => t.function.name);

test('a spend:none task on a free local model delegates nothing: no child or card can reach the configured paid route', async () => {
  const { startScriptedModel } = await import('../src/testing/scripted-model.ts');
  const { idle, settings, value } = await import('./helpers.ts');
  const configured = await startScriptedModel('paid-model');
  // The local model tries to hand the work to a child; a child would run on the configured route.
  const chosen = await startScriptedModel('local-qwen', (messages) => messages.some((m) => m.role === 'tool') ? { text: 'Done.' } : { calls: [{ name: 'start_child', args: { brief: 'Draft the appendix', role: 'worker' } }] });
  try {
    const { host } = await piHome(configured.url, configured.model, { ollama: Number(new URL(chosen.url).port) });
    value(await host.call('settings.model.put', { change: { route: 'local', provider: 'other', baseUrl: chosen.url, model: chosen.model } }));
    const projectId = value(await host.call('projects.create', { name: 'P', kind: 'folder' })).id;
    const run = value(await host.call('solutions.run', { projectId, text: 'Summarise the notes', task: { needs: ['model', 'files'], network: true, spend: 'none' }, settings, clientKey: 'free-1' }));
    assert.equal(run.selection.choice?.route.id, 'local:other:local-qwen');
    await idle(host, run.started!.threadId);
    await new Promise((r) => setTimeout(r, 200));
    const offered = toolsOf(chatsOf(chosen)[0].body);
    for (const name of ['start_child', 'add_card', 'propose_goal']) assert.ok(!offered.includes(name), `${name} is not offered`);
    assert.equal((await host.call('threads.list', {})).filter((t) => t.parentId).length, 0, 'no child started');
    assert.equal(configured.requests.length, 0, 'the configured paid route received nothing');
  } finally {
    unsetRoute();
    await configured.close();
    await chosen.close();
  }
});

test('a local route that redirects its model request elsewhere is not followed: nothing reaches the other host', async () => {
  const { createServer } = await import('node:http');
  const { startScriptedModel } = await import('../src/testing/scripted-model.ts');
  const { idle, settings, value } = await import('./helpers.ts');
  const configured = await startScriptedModel('paid-model');
  const external = await startScriptedModel('external-model');
  let redirected = 0;
  // Answers the model list like a local runtime, then bounces each model request to another host.
  const bouncer = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'local-qwen', object: 'model' }] }));
    redirected++;
    res.writeHead(307, { location: `${external.url}/chat/completions` }).end();
  });
  await new Promise<void>((r) => bouncer.listen(0, '127.0.0.1', () => r()));
  try {
    const { host } = await piHome(configured.url, configured.model, { ollama: (bouncer.address() as { port: number }).port });
    const projectId = value(await host.call('projects.create', { name: 'P', kind: 'folder' })).id;
    const run = value(await host.call('solutions.run', { projectId, text: 'Write an editable brief', task: { needs: ['model', 'files'], network: false, spend: 'none' }, settings, clientKey: 'bounce-1' }));
    assert.equal(run.selection.choice?.route.id, 'local:other:local-qwen');
    const turn = (await idle(host, run.started!.threadId)).turns[0];
    assert.ok(redirected > 0, 'the model request reached the local route, which redirected it');
    assert.notEqual(turn.status, 'done');
    assert.equal(external.requests.length, 0, 'the redirect was not followed');
    assert.equal(configured.requests.length, 0);
  } finally {
    unsetRoute();
    bouncer.closeAllConnections();
    await new Promise((r) => bouncer.close(r));
    await configured.close();
    await external.close();
  }
});

test('the route a choice is pinned to is the one it was made on, even if the configured route changes while the choice is made', async () => {
  const { startScriptedModel } = await import('../src/testing/scripted-model.ts');
  const { idle, settings, value } = await import('./helpers.ts');
  const a = await startScriptedModel('model-a');
  const b = await startScriptedModel('model-b');
  const path = process.env.PATH;
  // The configured route moves from A to B while local runtimes are being probed, mid-choice.
  const moving: typeof fetch = async () => { process.env.BACKBONE_MODEL_ENDPOINT = b.url; process.env.BACKBONE_MODEL_ID = b.model; throw new Error('no local runtime'); };
  try {
    const { host } = await piHome(a.url, a.model, { fetch: moving });
    const projectId = value(await host.call('projects.create', { name: 'P', kind: 'folder' })).id;
    // Codex is made absent for this choice, so the configured model route is the best one on any machine.
    process.env.PATH = '/nonexistent';
    const run = value(await host.call('solutions.run', { projectId, text: 'Write an editable brief', task: { needs: ['model', 'files'], network: true, spend: 'metered' }, settings, clientKey: 'move-1' }));
    process.env.PATH = path;
    assert.equal(run.selection.choice?.route.id, 'model-route');
    const turn = (await idle(host, run.started!.threadId)).turns[0];
    assert.ok(run.selection.choice!.route.label.includes(turn.selection!.pinned.label), `chosen on "${run.selection.choice!.route.label}", pinned to "${turn.selection!.pinned.label}"`);
    assert.deepEqual(turn.selection?.ran, turn.selection?.pinned);
    const pinnedServer = turn.selection!.pinned.baseUrl === a.url ? a : b;
    assert.equal(chatsOf(a).length + chatsOf(b).length, chatsOf(pinnedServer).length, 'only the pinned route was asked');
  } finally {
    process.env.PATH = path;
    unsetRoute();
    await a.close();
    await b.close();
  }
});

test('solutions.run waiting at admission: a Stop meanwhile starts nothing, and a route changed meanwhile is refused', async () => {
  const { withHomeLock } = await import('../src/composition/home-lock.ts');
  const { startScriptedModel } = await import('../src/testing/scripted-model.ts');
  const { idle, settings, value } = await import('./helpers.ts');
  const configured = await startScriptedModel('paid-model');
  const chosen = await startScriptedModel('local-qwen');
  const local: TaskNeeds = { needs: ['model', 'files'], network: false, spend: 'none' };
  const path = process.env.PATH;
  try {
    const { host, home } = await piHome(configured.url, configured.model, { ollama: Number(new URL(chosen.url).port) });
    const projectId = value(await host.call('projects.create', { name: 'P', kind: 'folder' })).id;
    const first = value(await host.call('solutions.run', { projectId, text: 'Write an editable brief', task: local, settings, clientKey: 'held-0' }));
    const threadId = first.started!.threadId;
    await idle(host, threadId);
    const asked = chatsOf(chosen).length;
    const holdLock = async () => {
      let release!: () => void;
      const holding = new Promise<void>((resolve) => { release = resolve; });
      let held!: () => void;
      const taken = new Promise<void>((resolve) => { held = resolve; });
      const lock = withHomeLock(home, async () => { held(); await holding; });
      await taken;
      return async () => { release(); await lock; };
    };
    // Stop arrives while the run waits on the home lock.
    let release = await holdLock();
    const stopped = host.call('solutions.run', { projectId, threadId, text: 'Write an editable brief again', task: local, settings, clientKey: 'held-1' });
    await new Promise((r) => setTimeout(r, 400));
    value(await host.call('turns.stop', { threadId }));
    await release();
    const r1 = await stopped;
    assert.equal(r1.ok, false, 'a Stop while it waited starts nothing');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(chatsOf(chosen).length, asked, 'no model request after the Stop');
    // A pinned model route that moves while the run waits is refused at admission. In a home with no local
    // model, and Codex made absent, the configured model route is the choice.
    const other = await piHome(configured.url, configured.model);
    const otherProject = value(await other.host.call('projects.create', { name: 'Q', kind: 'folder' })).id;
    let releaseOther!: () => void;
    const holdingOther = new Promise<void>((resolve) => { releaseOther = resolve; });
    let heldOther!: () => void;
    const takenOther = new Promise<void>((resolve) => { heldOther = resolve; });
    const otherLock = withHomeLock(other.home, async () => { heldOther(); await holdingOther; });
    await takenOther;
    release = async () => { releaseOther(); await otherLock; };
    process.env.PATH = '/nonexistent';
    const moved = other.host.call('solutions.run', { projectId: otherProject, text: 'Write an editable brief', task: { needs: ['model', 'files'], network: true, spend: 'metered' }, settings, clientKey: 'held-2' });
    await new Promise((r) => setTimeout(r, 400));
    process.env.PATH = path;
    process.env.BACKBONE_MODEL_ID = 'paid-model-2';
    await release();
    const r2 = await moved;
    assert.equal(r2.ok, false);
    assert.match(r2.ok ? '' : r2.detail, /no longer the configured route/);
    assert.equal(configured.requests.length, 0);
  } finally {
    process.env.PATH = path;
    unsetRoute();
    await configured.close();
    await chosen.close();
  }
});

test('the route and the settings a choice is made on come from one read of the configuration', async () => {
  const { ModelRoutes } = await import('../src/models/route.ts');
  const { CredentialStore } = await import('../src/credentials/store.ts');
  const { freshHome } = await import('./helpers.ts');
  const home = freshHome();
  // Another process changes the configured model between any two reads: each read sees the next one.
  let reads = 0;
  const env = new Proxy({ BACKBONE_MODEL_ENDPOINT: 'http://127.0.0.1:9/v1' } as NodeJS.ProcessEnv, {
    get: (target, key) => (key === 'BACKBONE_MODEL_ID' ? `model-${++reads}` : target[key as string]),
  });
  const { route, settings: described } = new ModelRoutes(home, new CredentialStore(home, async () => Buffer.alloc(32)), env).snapshot();
  assert.ok(route);
  assert.equal(reads, 1, 'the configuration is read once');
  assert.ok(described.active?.label.includes(route.model), `settings describe "${described.active?.label}", the route is ${route.model}`);
});

test('a bounded selected turn proposes no memory and sets off no consolidation on the configured route', async () => {
  const { startScriptedModel } = await import('../src/testing/scripted-model.ts');
  const { idle, settings, value } = await import('./helpers.ts');
  const configured = await startScriptedModel('paid-model');
  // The free local model tries to keep a line in memory; consolidating it would call the configured route.
  const chosen = await startScriptedModel('local-qwen', (messages) => messages.some((m) => m.role === 'tool') ? { text: 'Done.' } : { calls: [{ name: 'propose_memory', args: { text: 'The person prefers short briefs.', topic: 'preferences' } }] });
  try {
    const { host } = await piHome(configured.url, configured.model, { ollama: Number(new URL(chosen.url).port) });
    value(await host.call('settings.model.put', { change: { route: 'local', provider: 'other', baseUrl: chosen.url, model: chosen.model } }));
    const projectId = value(await host.call('projects.create', { name: 'P', kind: 'folder' })).id;
    const run = value(await host.call('solutions.run', { projectId, text: 'Summarise the notes', task: { needs: ['model', 'files'], network: true, spend: 'none' }, settings, clientKey: 'mem-1' }));
    assert.equal(run.selection.choice?.route.id, 'local:other:local-qwen');
    await idle(host, run.started!.threadId);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!toolsOf(chatsOf(chosen)[0].body).includes('propose_memory'), 'propose_memory is not offered');
    assert.equal(configured.requests.length, 0, 'no consolidation reached the configured route');
    // Nothing is learned from it either, so its words do not reach later turns on other routes through memory.
    const told = value(await host.call('solutions.run', { projectId, text: 'Remember that the vendor code is Bluefin.', task: { needs: ['model', 'files'], network: false, spend: 'none' }, settings, clientKey: 'mem-2' }));
    await idle(host, told.started!.threadId);
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotMatch(JSON.stringify(await host.call('memory.get', {})), /Bluefin/);
  } finally {
    unsetRoute();
    await configured.close();
    await chosen.close();
  }
});

test('solutions.run again with a key already used answers that turn and the selection it ran on, not a new choice', async () => {
  const { startScriptedModel } = await import('../src/testing/scripted-model.ts');
  const { idle, settings, value } = await import('./helpers.ts');
  const configured = await startScriptedModel('paid-model');
  const chosen = await startScriptedModel('local-qwen');
  const ollama = new URL(chosen.url).port;
  // Other local runtimes appear after the first call; one sorts first, so a new choice would be it.
  let appeared = false;
  const probe: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(`:${ollama}/`)) return fetch(input, init);
    if (appeared) return new Response(JSON.stringify({ data: [{ id: 'other-model' }] }), { headers: { 'content-type': 'application/json' } });
    throw new Error('nothing listens here');
  };
  try {
    const { host } = await piHome(configured.url, configured.model, { ollama: Number(ollama), fetch: probe });
    const projectId = value(await host.call('projects.create', { name: 'P', kind: 'folder' })).id;
    const task: TaskNeeds = { needs: ['model', 'files'], network: false, spend: 'none' };
    const first = value(await host.call('solutions.run', { projectId, text: 'Write an editable brief', task, settings, clientKey: 'K' }));
    assert.equal(first.selection.choice?.route.id, 'local:other:local-qwen');
    await idle(host, first.started!.threadId);
    const asked = chatsOf(chosen).length;
    appeared = true;
    value(await host.call('settings.model.put', { change: { route: 'local', provider: 'other', baseUrl: configured.url, model: configured.model } }));
    assert.equal((await host.call('solutions.options', task)).choice?.route.model, configured.model, 'an explicit saved choice changes the next recommendation');
    const again = value(await host.call('solutions.run', { projectId, text: 'Write an editable brief', task, settings, clientKey: 'K' }));
    assert.equal(again.selection.choice?.route.id, 'local:other:local-qwen', 'the recorded selection, which is what ran');
    assert.deepEqual(again.started, first.started, 'the same turn');
    assert.match(again.detail, /nothing new was started/);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(value(await host.call('threads.get', { id: first.started!.threadId })).turns.length, 1);
    assert.equal(chatsOf(chosen).length, asked, 'no new model request');
  } finally {
    unsetRoute();
    await configured.close();
    await chosen.close();
  }
});

test('a key already used in one project is refused in another, as admission refuses it', async () => {
  const { startScriptedModel } = await import('../src/testing/scripted-model.ts');
  const { idle, settings, value } = await import('./helpers.ts');
  const configured = await startScriptedModel('paid-model');
  const chosen = await startScriptedModel('local-qwen');
  try {
    const { host } = await piHome(configured.url, configured.model, { ollama: Number(new URL(chosen.url).port) });
    const p1 = value(await host.call('projects.create', { name: 'P1', kind: 'folder' })).id;
    const p2 = value(await host.call('projects.create', { name: 'P2', kind: 'folder' })).id;
    const task: TaskNeeds = { needs: ['model', 'files'], network: false, spend: 'none' };
    const first = value(await host.call('solutions.run', { projectId: p1, text: 'Write an editable brief', task, settings, clientKey: 'K' }));
    await idle(host, first.started!.threadId);
    const other = await host.call('solutions.run', { projectId: p2, text: 'Write an editable brief', task, settings, clientKey: 'K' });
    assert.equal(other.ok, false, 'P1\'s turn is not the answer for P2');
    assert.match(other.ok ? '' : other.detail, /Use the active chat project/);
  } finally {
    unsetRoute();
    await configured.close();
    await chosen.close();
  }
});

test('a retry whose own choice fails after the same key was admitted meanwhile answers that turn, not "nothing started"', async () => {
  const { startScriptedModel } = await import('../src/testing/scripted-model.ts');
  const { idle, settings, value } = await import('./helpers.ts');
  const configured = await startScriptedModel('paid-model');
  const chosen = await startScriptedModel('local-qwen');
  const ollama = new URL(chosen.url).port;
  // The retry's probes (the first four) wait, then find no runtime; every later probe sees the local model.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let probes = 0;
  const probe: typeof fetch = async (input, init) => {
    if (probes++ < 4) { await gate; throw new Error('no runtime answers'); }
    if (String(input).includes(`:${ollama}/`)) return fetch(input, init);
    throw new Error('nothing listens here');
  };
  try {
    const { host } = await piHome(configured.url, configured.model, { ollama: Number(ollama), fetch: probe });
    const projectId = value(await host.call('projects.create', { name: 'P', kind: 'folder' })).id;
    const task: TaskNeeds = { needs: ['model', 'files'], network: false, spend: 'none' };
    const retry = host.call('solutions.run', { projectId, text: 'Write an editable brief', task: { ...task, approvedRoute: { routeId: 'local:other:local-qwen', model: chosen.model, fingerprint: '0'.repeat(64), spend: 'none' } }, settings, clientKey: 'K' });
    while (probes < 4) await new Promise((r) => setTimeout(r, 10));
    const first = value(await host.call('solutions.run', { projectId, text: 'Write an editable brief', task, settings, clientKey: 'K' }));
    assert.equal(first.selection.choice?.route.id, 'local:other:local-qwen');
    release();
    const answered = value(await retry);
    assert.deepEqual(answered.started, first.started, 'the retry answers the turn its key started');
    assert.equal(answered.selection.choice?.route.id, 'local:other:local-qwen', 'with the selection recorded on it');
    await idle(host, first.started!.threadId);
    assert.equal(value(await host.call('threads.get', { id: first.started!.threadId })).turns.length, 1);
  } finally {
    release();
    unsetRoute();
    await configured.close();
    await chosen.close();
  }
});

test('the inventory reads the class at the end of a check that names its source', () => {
  const settings = { own: null, gateway: null, active: null, hint: null, harness: 'Pi' }, local = { runtimes: [] };
  const blocked = (detail: string) => inventory({ codex: { status: 'warn', detail }, settings, local }).find(route => route.id === 'codex')!.blocked;
  assert.match(blocked('machine client sign-in (codex login status): signed out')!, /signed out; the person signs in/);
  assert.equal(blocked('machine client sign-in (codex login status): absent'), 'Codex is not installed here');
  assert.equal(blocked('machine client sign-in (codex login status): error'), 'Codex could not be checked');
});
