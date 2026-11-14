// Rerunnable 4 November diagnostics: only disposable homes and loopback model servers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { open, idle, settings, value } from './helpers.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';

const closedPort = () => new Promise<number>((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    server.close(() => resolve(port));
  });
});

test('November diagnostics: the selected destination runs and verification keeps the original version', async () => {
  const configured = await startScriptedModel('configured-model');
  const local = await startScriptedModel('discovered-model');
  const previous = { endpoint: process.env.BACKBONE_MODEL_ENDPOINT, model: process.env.BACKBONE_MODEL_ID };
  process.env.BACKBONE_MODEL_ENDPOINT = configured.url;
  process.env.BACKBONE_MODEL_ID = configured.model;
  try {
    const ports = { ollama: Number(new URL(local.url).port), lmstudio: await closedPort(), llamacpp: await closedPort(), vllm: await closedPort() };
    const { host } = open(undefined, { harness: 'harness-pi', localModels: { ports } });
    value(await host.call('settings.model.put', { change: { route: 'local', provider: 'other', baseUrl: local.url, model: local.model } }));
    const projectId = value(await host.call('projects.create', { name: 'Diagnostic', kind: 'folder' })).id;
    const run = value(await host.call('solutions.run', { projectId, text: 'Write an editable brief', task: { needs: ['model', 'files'], network: false, spend: 'none' }, settings, clientKey: 'diagnostic' }));
    assert.ok(run.started, run.detail);
    const turn = (await idle(host, run.started.threadId)).turns.find((t) => t.id === run.started!.turnId)!;
    const requests = local.requests.filter((r) => r.body.includes('"messages"'));
    assert.ok(requests.length > 0);
    assert.ok(requests.every((r) => JSON.parse(r.body).model === local.model));
    assert.equal(configured.requests.length, 0);
    assert.equal(turn.selection?.ran?.baseUrl, local.url);
    console.log(JSON.stringify({ diagnostic: 'destination', status: 'fixed', chosenModel: local.model, chosenRequests: requests.length, configuredRequests: configured.requests.length, observedMatchesPinned: turn.selection?.ran?.baseUrl === turn.selection?.pinned.baseUrl }));
    const wrote = turn.effects.find((e) => e.target === 'brief.md' && e.outcome === 'DONE')!;
    assert.equal(wrote.version, 1);
    value(await host.call('material.save', { id: wrote.materialId!, baseVersion: 1, text: 'ok' }));
    const verified = value(await host.call('solutions.verify', { ...run.started, deliverables: ['brief.md'] }));
    const current = value(await host.call('material.read', { id: wrote.materialId! }));
    assert.equal(verified.complete, true);
    assert.equal(verified.checks[0].version, 1);
    assert.match(verified.checks[0].editedSince ?? '', /person/);
    assert.equal(current.text, 'ok');
    console.log(JSON.stringify({ diagnostic: 'readback', status: 'fixed', verifiedVersion: verified.checks[0].version, editedSince: verified.checks[0].editedSince, currentHumanRevisionPreserved: true, summary: verified.summary }));
  } finally {
    for (const [key, old] of [['BACKBONE_MODEL_ENDPOINT', previous.endpoint], ['BACKBONE_MODEL_ID', previous.model]]) {
      if (old === undefined) delete process.env[key!]; else process.env[key!] = old;
    }
    await configured.close();
    await local.close();
  }
});
