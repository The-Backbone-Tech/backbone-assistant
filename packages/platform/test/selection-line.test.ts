import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serveApiLine, type LineAsk } from '../src/composition/api-line.ts';
import { attachApi } from '../src/doors/api-line.ts';
import { open, value, settings, idle } from './helpers.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';

test('selection on the API line shows task limits, refuses without confirmation and records the route', async () => {
  const model = await startScriptedModel('line-model');
  const { host, home } = open(undefined, { harness: 'harness-pi', localModels: { ports: { ollama: Number(new URL(model.url).port), lmstudio: 0, llamacpp: 0, vllm: 0 } } });
  value(await host.call('settings.model.put', { change: { route: 'local', provider: 'other', baseUrl: model.url, model: model.model } }));
  const projectId = value(await host.call('projects.create', { name: 'Line', kind: 'folder' })).id;
  const task = { needs: ['model', 'files'] as ('model' | 'files')[], network: false, spend: 'none' as const };
  const args = { projectId, text: 'Write an editable brief', task, settings, clientKey: 'line' };
  let server = await serveApiLine({ home, call: host.call });
  let line = await attachApi(home);
  assert.ok(line);
  try {
    const options = await line.call('solutions.options', task);
    assert.equal(options.choice?.route.id, `local:other:${model.model}`);
    assert.equal((await line.call('solutions.run', args)).ok, false);
    assert.equal(model.requests.filter((r) => r.body.includes('"messages"')).length, 0);
    line.close(); await server.close();
    const asks: LineAsk[] = [];
    server = await serveApiLine({ home, call: host.call, confirm: async (ask) => { asks.push(ask); return true; } });
    line = await attachApi(home); assert.ok(line);
    const run = value(await line.call('solutions.run', args));
    assert.ok(run.started, run.detail);
    await idle(host, run.started.threadId);
    assert.equal(asks[0].method, 'solutions.run');
    assert.ok('task' in asks[0] && asks[0].task.network === false);
    assert.equal(value(await line.call('solutions.verify', { ...run.started, deliverables: ['brief.md'] })).complete, true);
    const invalid = await line.call('solutions.options', { ...task, spend: 'anything' } as never);
    assert.equal((invalid as unknown as { ok: boolean }).ok, false);
  } finally { line?.close(); await server.close(); await model.close(); }
});

test('Unicode line separators in evidence topics never reach the Host or native confirmation', async () => {
  const { freshHome } = await import('./helpers.ts');
  const home = freshHome();
  const calls: string[] = [];
  let questions = 0;
  const call = (async (method: string) => {
    calls.push(method);
    return method === 'projects.list' ? [{ id: 'p', name: 'Project' }] : { ok: true, value: { started: null, detail: 'Not started' } };
  }) as never;
  const server = await serveApiLine({ home, call, confirm: async () => { questions++; return true; } });
  const line = await attachApi(home); assert.ok(line);
  try {
    for (const separator of ['\u2028', '\u2029']) {
      const result: import('../src/api.ts').Result<'solutions.run'> = await line.call('solutions.run', { projectId: 'p', text: 'Write a brief', task: { needs: ['model'], network: false, spend: 'none', evidenceQuery: `public${separator}topic` }, settings, clientKey: `invalid-${separator.codePointAt(0)}` });
      assert.equal(questions, 0);
      assert.equal(result.ok, false);
    }
    assert.deepEqual(calls, []);
  } finally { line.close(); await server.close(); }
});
