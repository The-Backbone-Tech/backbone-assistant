import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HarnessEvent, ToolHost, TurnRequest } from '@backbone-next/platform/ports';
import { WorkspaceRefusal } from '@backbone-next/platform/ports';
import { startScriptedModel } from '@backbone-next/platform/testing';
import { createPiHarness } from '../src/index.ts';

const request: TurnRequest = { threadId: 'thread', turnId: 'turn', text: 'Check the workspace boundary', history: [], attachments: [], effort: 2, resumed: false };

test('Pi distinguishes failed commands from unknown workspace outcomes and preserves the Host reply without persisting output', async () => {
  for (const [result, phase] of [
    [WorkspaceRefusal.beforeCommand(new WorkspaceRefusal('private output: policy refused')), 'refused'],
    [new WorkspaceRefusal('private output: post-dispatch invalidation'), 'unknown'],
    [new Error('A workspace source is no longer granted.'), 'unknown'],
    [{ code: null, stdout: '', stderr: '', refused: 'policy' }, 'refused'],
    [{ code: null, stdout: '', stderr: '', refused: 'setup' }, 'refused'],
    [{ code: 1, stdout: 'private output', stderr: 'Operation not permitted' }, 'failed'],
    [{ code: 2, stdout: 'private output', stderr: 'ordinary failure' }, 'failed'],
    [{ code: null, stdout: '', stderr: '', reason: 'stopped' }, 'unknown'],
    [{ code: null, stdout: '', stderr: '', reason: 'time limit' }, 'unknown'],
    [{ code: 0, stdout: 'private output', stderr: '', reason: 'workspace cleanup unconfirmed; scratch cannot be reused' }, 'unknown'],
    [{ stdout: 'private output' }, 'unknown'],
    ['Host plain text: private output', 'unknown'],
  ]) {
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    let calls = 0;
    const model = await startScriptedModel('workspace-outcomes', messages => messages.some(m => m.role === 'tool')
      ? { text: 'The workspace result was inspected.' }
      : { calls: [{ name: 'workspace_run', args: { command: 'owned boundary probe' } }] });
    try {
      const tools: ToolHost = { list: async () => [], read: async () => null, write: async () => { throw new Error('No document writes'); }, runWorkspace: async () => { calls++; if (result instanceof Error) throw result; return text; } };
      const turn = createPiHarness().start(request, { tools, route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: model.url, model: model.model, label: 'Local fixture', credential: null }, credential: async () => { throw new Error('No credentials'); } });
      const events: HarnessEvent[] = [];
      for await (const event of turn.events) events.push(event);
      assert.equal((await turn.outcome).status, 'done');
      assert.equal(calls, 1, 'one scripted tool request reaches the Host');
      const end = events.find(e => e.type === 'tool' && e.tool === 'workspace_run' && e.phase !== 'proposed');
      assert.equal(end?.type === 'tool' && end.phase, phase);
      assert.ok(end?.type === 'tool' && end.detail);
      assert.doesNotMatch(JSON.stringify(end), /private output|ordinary failure|Operation not permitted/);
      const reply = model.requests.flatMap(r => r.body ? (JSON.parse(r.body).messages ?? []) : []).find((m: { role: string }) => m.role === 'tool');
      if (result instanceof Error) assert.ok(reply.content.includes(result.message), 'the original rejection diagnostic reaches the model');
      else assert.equal(reply.content, text, 'the original Host text reaches the model');
    } finally { await model.close(); }
  }
});

test('Pi offers no shell without the Host workspace grant, or in bare and read-only turns', async () => {
  for (const mode of ['unavailable', 'bare', 'read-only']) {
    let calls = 0;
    const model = await startScriptedModel('workspace-grants', messages => messages.some(m => m.role === 'tool')
      ? { text: 'No shell was granted.' }
      : { calls: [{ name: 'workspace_run', args: { command: 'must not run' } }] });
    try {
      const tools: ToolHost = { list: async () => [], read: async () => null, write: async () => { throw new Error('No writes'); }, ...(mode === 'unavailable' ? {} : { runWorkspace: async () => { calls++; throw new Error('Must not run'); } }) };
      const turn = createPiHarness().start({ ...request, bare: mode === 'bare', readOnly: mode === 'read-only' }, { tools, route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: model.url, model: model.model, label: 'Local fixture', credential: null }, credential: async () => '' });
      assert.equal((await turn.outcome).status, 'done');
      assert.equal(calls, 0);
      const sent = JSON.parse(model.requests.find(r => r.body)?.body ?? '{}');
      assert.ok(!(sent.tools ?? []).some((t: { function: { name: string } }) => t.function.name === 'workspace_run'));
    } finally { await model.close(); }
  }
});

test('Pi records confirmed workspace execution as done and forwards its attachment and signal', async () => {
  const result = { code: 0, stdout: '23', stderr: '' };
  let calls = 0;
  const model = await startScriptedModel('workspace-success', messages => messages.some(m => m.role === 'tool')
    ? { text: 'Calculated in the workspace.' }
    : { calls: [{ name: 'workspace_run', args: { command: 'owned calculation', attachment: 'sales.csv' } }] });
  try {
    const tools: ToolHost = { list: async () => [], read: async () => null, write: async () => { throw new Error('No writes'); }, runWorkspace: async (params, signal) => {
      calls++;
      assert.deepEqual(params, { command: 'owned calculation', attachment: 'sales.csv' });
      assert.ok(signal instanceof AbortSignal);
      return JSON.stringify(result);
    } };
    const turn = createPiHarness().start(request, { tools, route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: model.url, model: model.model, label: 'Local fixture', credential: null }, credential: async () => '' });
    const events: HarnessEvent[] = [];
    for await (const event of turn.events) events.push(event);
    assert.equal((await turn.outcome).status, 'done');
    assert.equal(calls, 1);
    assert.ok(events.some(e => e.type === 'tool' && e.tool === 'workspace_run' && e.phase === 'done'));
  } finally { await model.close(); }
});
