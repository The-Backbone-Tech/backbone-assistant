import { TEST_HANG_MS, hangDetector, waitFor } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import { enableConnector } from '../src/testing/connectors.ts';
// C3: actual Host/Pi turns against disposable homes, scripted models and a byte-recording collector.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startTelemetry } from '@backbone-next/telemetry-otel';
import type { Turn } from '../src/api.ts';
import { startConfiguredTelemetry } from '../src/composition/telemetry.ts';
import { subscribeTelemetry } from '../src/composition/telemetry-observations.ts';
import { outsideHomeLocks } from '../src/composition/home-lock.ts';
import { putTelemetryEndpoint } from '../src/credentials/telemetry.ts';
import { startScriptedModel, type Message, type ScriptedModel, type Step } from '../src/testing/scripted-model.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { b64, freshDir, freshHome, idle, open, settings, value } from './helpers.ts';
import { attribute, fakeCollector } from './fake-telemetry-collector.ts';

const marker = 'telemetry_content_canary_7f4b';
const failureMarker = 'telemetry_failure_detail_canary_841d';
const refusalMarker = 'telemetry_refusal_detail_canary_a30e';
let model: ScriptedModel;
let priorEndpoint: string | undefined, priorModel: string | undefined;
const script = (messages: Message[]): Step => {
  const asked = JSON.stringify(messages.filter(message => message.role === 'user').at(-1)?.content ?? '');
  const results = messages.filter(message => message.role === 'tool').length;
  if (typeof asked === 'string' && asked.includes(marker)) {
    if (!results) return { calls: [{ name: 'read_file', args: { name: `${marker}.md` } }] };
    if (results === 1) return { calls: [{ name: `mcp__private__${marker}_read`, args: { text: `${marker} tool argument` } }] };
    if (results === 2) return { calls: [{ name: `mcp__private__${marker}_effect`, args: { text: `${marker} effect argument` } }] };
    return { text: `${marker} answer text` };
  }
  if (!results) return { calls: [{ name: 'list_files', args: {} }] };
  return { text: 'The local test turn finished.' };
};
before(async () => {
  priorEndpoint = process.env.BACKBONE_MODEL_ENDPOINT; priorModel = process.env.BACKBONE_MODEL_ID;
  model = await startScriptedModel('scripted-model', script, {
    before(messages) {
      if (JSON.stringify(messages.filter(message => message.role === 'user').at(-1)?.content ?? '').includes(failureMarker)) return { status: 400, message: `${failureMarker} private provider failure detail` };
    },
  });
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  if (priorEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = priorEndpoint;
  if (priorModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = priorModel;
  await model.close();
});

async function send(host: ReturnType<typeof open>['host'], projectId: string, text = 'List the files in this disposable project.') {
  const sent = value(await host.call('turns.send', { projectId, text, attachments: [], settings, clientKey: `test-${Date.now()}` }));
  return { sent, turn: (await idle(host, sent.threadId)).turns[0] };
}

function watchEndedTurn(host: ReturnType<typeof open>['host']) {
  let finish!: (turn: Turn | undefined) => void;
  const completed = new Promise<Turn | undefined>(resolve => { finish = resolve; });
  const stop = host.on(event => {
    if (event.topic !== 'threads' || !event.id) return;
    const id = event.id;
    outsideHomeLocks(() => {
      void host.call('threads.get', { id }).then(receipt => {
        const turn = receipt.ok ? receipt.value.turns.at(-1) : undefined;
        if (turn?.work.endedAt) { stop(); finish(turn); }
      }, () => {});
    });
  });
  return {
    async wait() { const turn = await hangDetector(completed, 'saved telemetry turn end'); assert.ok(turn, 'The lifecycle did not emit its saved turn end.'); return turn; },
    close() { stop(); finish(undefined); },
  };
}

test('configured telemetry exports one turn root and timed fixed-catalogue child spans with reported usage', { timeout: TEST_HANG_MS * 2 }, async t => {
  const collector = await fakeCollector(); t.after(() => collector.close());
  const home = freshHome(); await putTelemetryEndpoint(home, collector.endpoint);
  const { host } = open(home, { harness: 'harness-pi' });
  const telemetry = await startConfiguredTelemetry(host, home); assert.ok(telemetry); t.after(() => telemetry.close());
  const project = value(await host.call('projects.create', { name: 'Telemetry fixture', kind: 'folder' }));
  const { sent, turn } = await send(host, project.id);
  assert.equal(turn.status, 'done'); assert.ok(turn.work.usage);
  await telemetry.flush();
  const spans = collector.spans(), roots = spans.filter(span => span.name === 'invoke_agent'), tools = spans.filter(span => span.name === 'execute_tool');
  assert.equal(roots.length, 1); assert.equal(tools.filter(span => attribute(span, 'gen_ai.tool.name') === 'list').length, 1);
  assert.ok(tools.length >= 1);
  const root = roots[0];
  assert.equal(root.parentSpanId, undefined);
  assert.equal(attribute(root, 'backbone.thread.id'), sent.threadId); assert.equal(attribute(root, 'backbone.turn.id'), sent.turnId);
  assert.equal(attribute(root, 'backbone.outcome'), 'done');
  assert.equal(Number(attribute(root, 'gen_ai.usage.input_tokens')), turn.work.usage.input);
  assert.equal(Number(attribute(root, 'gen_ai.usage.output_tokens')), turn.work.usage.output);
  assert.match(String(attribute(root, 'backbone.run.id')), /^[0-9a-f-]{36}$/);
  for (const tool of tools) { assert.equal(tool.traceId, root.traceId); assert.equal(tool.parentSpanId, root.spanId); }
  assert.ok(BigInt(root.endTimeUnixNano) >= BigInt(root.startTimeUnixNano));
  assert.ok(BigInt(tools[0].endTimeUnixNano) >= BigInt(tools[0].startTimeUnixNano));
  assert.ok(collector.requests.every(request => request.method === 'POST' && request.url === '/v1/traces'));
});

test('collector receives no planted prompt, answer, file, tool argument, connector name or error content', { timeout: TEST_HANG_MS * 2 }, async t => {
  const collector = await fakeCollector(); t.after(() => collector.close());
  const personHome = freshDir('telemetry-person-'), log = join(personHome, 'calls.jsonl');
  writeFileSync(join(personHome, '.claude.json'), JSON.stringify({ mcpServers: { private: { command: process.execPath, args: [join(import.meta.dirname, 'fake-telemetry-mcp.ts')], env: { TELEMETRY_FIXTURE_LOG: log } } } }));
  const home = freshHome(); await putTelemetryEndpoint(home, collector.endpoint);
  const { host } = open(home, { harness: 'harness-pi', connectors: { env: defaultToolEnv({ HOME: personHome, PATH: process.env.PATH }), sources: ['claude-code'] } });
  const telemetry = await startConfiguredTelemetry(host, home); assert.ok(telemetry); t.after(() => telemetry.close());
  const listed = value(await host.call('connectors.refresh', { serverId: 'claude-code:private' }));
  assert.ok(listed.tools.every(tool => tool.name.includes(marker)));
  value(await enableConnector(host, 'claude-code:private'));
  for (const tool of listed.tools) value(await enableConnector(host, 'claude-code:private', tool.name));
  const project = value(await host.call('projects.create', { name: `${marker} project title`, kind: 'folder' }));
  const file = value(await host.call('material.attach', { projectId: project.id, name: `${marker}.md`, base64: b64(`${marker} file content`), mediaType: 'text/markdown' }));
  const before = model.requests.length;
  const sent = value(await host.call('turns.send', { projectId: project.id, text: `${marker} prompt text`, attachments: [file.id], settings, clientKey: 'redaction' }));
  const turn = (await idle(host, sent.threadId)).turns[0];
  assert.equal(turn.status, 'done'); assert.equal(turn.answer?.text, `${marker} answer text`);
  const requests = model.requests.slice(before).map(request => request.body).join('\n');
  for (const seeded of ['prompt text', 'file content', 'tool argument', 'connector error detail', 'effect argument']) assert.ok(requests.includes(`${marker} ${seeded}`), `the model actually saw the planted ${seeded}`);
  const calls = readFileSync(log, 'utf8'); assert.ok(calls.includes(`${marker}_read`)); assert.ok(calls.includes(`${marker} tool argument`));
  const held = (await host.call('connectors.list', {})).held;
  assert.equal(held.length, 1); assert.equal(held[0].tool, `${marker}_effect`); assert.equal(held[0].args.text, `${marker} effect argument`);
  value(await host.openConnectorDoor('claude-code:private', host.connectorDoorSeal('claude-code:private')!));
  const released = value(await host.releaseConnectorCall(held[0].effect, held[0].argsHash));
  assert.equal(released.state, 'sent', 'the released effect reached only the local fake server');
  assert.ok(readFileSync(log, 'utf8').includes(`${marker}_effect`));
  await telemetry.flush();
  assert.ok(collector.requests.length > 0);
  assert.ok(!JSON.stringify(collector.requests).includes(marker), 'scan every request URL, header and body received by collector');
  const spans = collector.spans(), root = spans.find(span => span.name === 'invoke_agent')!;
  assert.ok(root);
  const effects = spans.filter(span => span.name === 'effect');
  const phases = effects.map(span => attribute(span, 'backbone.effect.phase'));
  assert.deepEqual(phases.slice(0, 2), ['proposed', 'held']);
  assert.ok(phases.includes('released')); assert.ok(phases.includes('sent'));
  assert.ok(effects.every(span => attribute(span, 'backbone.effect.id') === held[0].effect));
  for (const span of spans.filter(span => span.name === 'execute_tool' || span.name === 'effect')) { assert.equal(span.traceId, root.traceId); assert.equal(span.parentSpanId, root.spanId); }
  assert.ok(spans.some(span => attribute(span, 'gen_ai.tool.name') === 'callConnector'));
});

test('a failed real turn retains its private provider detail without exporting it as a status message', { timeout: TEST_HANG_MS * 2 }, async t => {
  const collector = await fakeCollector(); t.after(() => collector.close());
  const home = freshHome(); await putTelemetryEndpoint(home, collector.endpoint);
  const { host } = open(home, { harness: 'harness-pi' });
  const telemetry = await startConfiguredTelemetry(host, home); assert.ok(telemetry); assert.equal(telemetry.status, 'on'); t.after(() => telemetry.close());
  const project = value(await host.call('projects.create', { name: 'Failed lifecycle fixture', kind: 'folder' }));
  const before = model.requests.length;
  const ended = watchEndedTurn(host); t.after(() => ended.close());
  const { sent } = await send(host, project.id, `${failureMarker} trigger a local scripted model failure`);
  const turn = await ended.wait();
  assert.equal(turn.id, sent.turnId);
  assert.equal(turn.status, 'stopped');
  assert.ok(turn.failure?.detail.includes(failureMarker), 'the real lifecycle stored the planted failure.detail');
  assert.ok(model.requests.slice(before).some(request => request.body.includes(failureMarker)), 'the failing model request actually happened');
  await telemetry.flush();
  const roots = collector.spans().filter(span => span.name === 'invoke_agent');
  assert.equal(roots.length, 1); assert.equal(attribute(roots[0], 'backbone.turn.id'), sent.turnId);
  assert.equal(attribute(roots[0], 'backbone.outcome'), 'failed');
  assert.ok(!JSON.stringify(collector.requests).includes(failureMarker), 'failure.detail must not enter any collector URL, header, attribute or status message');
  assert.equal((roots[0] as typeof roots[0] & { status?: { message?: string } }).status?.message, undefined);
});

test('a refused real turn retains its private route detail without exporting it as a status message', { timeout: TEST_HANG_MS * 2 }, async t => {
  const collector = await fakeCollector(); t.after(() => collector.close());
  const priorId = process.env.BACKBONE_MODEL_ID, priorPath = process.env.PATH;
  t.after(() => {
    if (priorId === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = priorId;
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
  });
  process.env.BACKBONE_MODEL_ID = refusalMarker;
  const home = freshHome(); await putTelemetryEndpoint(home, collector.endpoint);
  // Disable discovery for this fixture, so only the explicit local scripted route is eligible.
  const { host } = open(home, { harness: 'harness-pi', localModels: { ports: { ollama: 0, lmstudio: 0, llamacpp: 0, vllm: 0 } } });
  const telemetry = await startConfiguredTelemetry(host, home); assert.ok(telemetry); assert.equal(telemetry.status, 'on'); t.after(() => telemetry.close());
  const project = value(await host.call('projects.create', { name: 'Refused lifecycle fixture', kind: 'folder' }));
  let changed = false;
  const stop = host.on(event => {
    if (event.topic === 'threads' && !changed) {
      // A configuration change after reservation must be refused against the selected route.
      changed = true; process.env.BACKBONE_MODEL_ID = 'changed-after-route-reservation';
    }
  });
  t.after(stop);
  const before = model.requests.length;
  const ended = watchEndedTurn(host); t.after(() => ended.close());
  process.env.PATH = freshDir('telemetry-no-native-tools-');
  const run = value(await host.call('solutions.run', { projectId: project.id, text: 'Run the local route pin fixture.', task: { needs: ['model', 'files'], network: true, spend: 'metered' }, settings, clientKey: 'refused-lifecycle' }));
  process.env.PATH = priorPath;
  assert.ok(run.started, 'the selected turn was reserved before the route changed');
  await idle(host, run.started.threadId);
  const turn = await ended.wait();
  assert.equal(turn.id, run.started.turnId);
  assert.ok(changed); assert.equal(turn.status, 'refused');
  assert.ok(turn.refusal?.detail.includes(refusalMarker), 'the real route gate stored the planted refusal.detail');
  assert.equal(model.requests.length, before, 'the refused route made no model request');
  await telemetry.flush();
  const roots = collector.spans().filter(span => span.name === 'invoke_agent');
  assert.equal(roots.length, 1); assert.equal(attribute(roots[0], 'backbone.turn.id'), run.started.turnId);
  assert.equal(attribute(roots[0], 'backbone.outcome'), 'refused');
  assert.ok(!JSON.stringify(collector.requests).includes(refusalMarker), 'refusal.detail must not enter any collector URL, header, attribute or status message');
  assert.equal((roots[0] as typeof roots[0] & { status?: { message?: string } }).status?.message, undefined);
});

for (const mode of ['down', 'hang', '500'] as const) {
  test(`collector ${mode} cannot delay or change a normally completing turn and increases loss count`, { timeout: TEST_HANG_MS * 2 }, async t => {
    const collector = await fakeCollector(mode === 'down' ? 'ok' : mode); t.after(() => collector.close());
    if (mode === 'down') await collector.close();
    const { host, home } = open(undefined, { harness: 'harness-pi' });
    const project = value(await host.call('projects.create', { name: 'Failure isolation fixture', kind: 'folder' }));
    const baseline = await send(host, project.id);
    assert.equal(baseline.turn.status, 'done');
    const nativeTimer = globalThis.setTimeout;
    const deadlines: (() => void)[] = [], timers: ReturnType<typeof setTimeout>[] = [];
    // Hold only this fixture's explicit exporter clock; database/model/poll timers stay real.
    // A turn must finish while its collector is still pending, regardless of machine speed.
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
      if (ms !== 3000) return nativeTimer(callback, ms, ...args);
      const timer = nativeTimer(() => {}, TEST_HANG_MS); timer.unref(); timers.push(timer);
      deadlines.push(() => { clearTimeout(timer); callback(...args); });
      return timer;
    }) as typeof setTimeout;
    try {
      const telemetry = startTelemetry(host, { endpoint: collector.endpoint, timeoutMs: 3000, observe: listener => subscribeTelemetry(home, listener), dispatch: task => outsideHomeLocks(task) });
      assert.ok(telemetry); t.after(() => telemetry.close());
      const completed = await send(host, project.id);
      assert.equal(completed.turn.status, baseline.turn.status); assert.equal(completed.turn.answer?.text, baseline.turn.answer?.text);
      if (mode === 'hang') {
        await waitFor(() => collector.requests.length > 0, 'hanging collector receives the pending export');
        assert.ok(deadlines.length > 0, 'the exporter requested its own deadline');
        assert.equal(telemetry.stats.dropped, 0, 'the turn finished before the held exporter deadline fired');
      }
      let flushed = false;
      const flushing = telemetry.flush().finally(() => { flushed = true; });
      await waitFor(() => {
        for (const expire of deadlines.splice(0)) expire();
        return flushed;
      }, 'exporter clock expires all failed batches', { diagnostic: () => JSON.stringify(telemetry.stats) });
      await flushing;
      assert.ok(telemetry.stats.dropped > 0);
      assert.equal(telemetry.stats.exported, 0);
      if (mode !== 'down') assert.ok(collector.requests.length > 0);
    } finally {
      globalThis.setTimeout = nativeTimer;
      for (const expire of deadlines.splice(0)) expire();
      for (const timer of timers) clearTimeout(timer);
    }
  });
}

test('telemetry off sends nothing even when OTLP environment endpoints and headers are set', { timeout: TEST_HANG_MS * 2 }, async t => {
  const collector = await fakeCollector(); t.after(() => collector.close());
  const names = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS'] as const;
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; } });
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.endpoint; process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = collector.endpoint; process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=fake-header';
  const { host, home } = open(undefined, { harness: 'harness-pi' });
  assert.equal((await startConfiguredTelemetry(host, home)).status, 'off');
  const project = value(await host.call('projects.create', { name: 'Off fixture', kind: 'folder' }));
  assert.equal((await send(host, project.id)).turn.status, 'done');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(collector.requests, []);
});
