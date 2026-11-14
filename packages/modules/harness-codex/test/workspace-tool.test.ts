import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOST_TOOLS, WorkspaceRefusal, type HarnessEvent } from '@backbone-next/platform/ports';
import { carryCodexHostTool, codexHostTools } from '../src/host-tools.ts';
import { hostDriver } from './host-tools-driver.ts';

test('Codex offers the same workspace declaration and forwards the command, original name and cancellation', async () => {
  const calls: unknown[] = [], signals: AbortSignal[] = [];
  const driver = await hostDriver({ runWorkspace: async (request, signal) => { calls.push(request); signals.push(signal!); return '{"code":0,"stdout":"23","stderr":""}'; } });
  try {
    assert.deepEqual(codexHostTools(driver.context.tools), [{ type: 'function', name: 'workspace_run', description: HOST_TOOLS.workspace_run.description, inputSchema: HOST_TOOLS.workspace_run.inputSchema }]);
    const run = driver.harness().start(driver.request([{ name: 'workspace_run', args: { command: 'sqlite3 data.db "select 23"', attachment: 'sales.csv' } }]), driver.context);
    const outcome = await run.outcome; assert.equal(outcome.status, 'done', outcome.error ?? '');
    assert.deepEqual(calls, [{ command: 'sqlite3 data.db "select 23"', attachment: 'sales.csv' }]); assert.ok(signals[0] instanceof AbortSignal);
    const invalid = await carryCodexHostTool(driver.context.tools, 'workspace_run', { arguments: { command: 42 } }, new AbortController().signal);
    assert.equal(invalid?.success, false); assert.equal(calls.length, 1);
    delete driver.context.tools.runWorkspace; assert.deepEqual(codexHostTools(driver.context.tools), []);
  } finally { await driver.close(); }
});

test('Codex workspace replies preserve original text while failed and unknown runs carry safe status events', async () => {
  for (const [text, phase] of [
    [WorkspaceRefusal.beforeCommand(new WorkspaceRefusal('private output: policy refused')), 'refused'],
    [new WorkspaceRefusal('private output: post-dispatch invalidation'), 'unknown'],
    [new Error('A workspace source is no longer granted.'), 'unknown'],
    [JSON.stringify({ code: null, stdout: '', stderr: '', refused: 'policy' }), 'refused'],
    [JSON.stringify({ code: 1, stdout: 'private output', stderr: 'Operation not permitted' }), 'failed'],
    [JSON.stringify({ code: 0, stdout: 'private output', stderr: '', reason: 'cleanup unconfirmed' }), 'unknown'],
    ['Host plain text: private output', 'unknown'],
  ] as const) {
    const driver = await hostDriver({ runWorkspace: async () => { if (text instanceof Error) throw text; return text; } });
    try {
      const result = await carryCodexHostTool(driver.context.tools, 'workspace_run', { arguments: { command: 'owned failure' } }, new AbortController().signal);
      assert.equal(result?.success, false);
      if (text instanceof Error) assert.doesNotMatch(JSON.stringify(result?.contentItems), /private output|no longer granted/);
      else assert.deepEqual(result?.contentItems, [{ type: 'inputText', text }]);
      const run = driver.harness().start(driver.request([{ name: 'workspace_run', args: { command: 'owned failure' } }]), driver.context);
      const events: HarnessEvent[] = [];
      for await (const event of run.events) events.push(event);
      assert.equal((await run.outcome).status, 'done');
      const end = events.find(event => event.type === 'tool' && event.tool === 'workspace_run' && event.phase !== 'proposed');
      assert.equal(end?.type === 'tool' && end.phase, phase);
      assert.doesNotMatch(JSON.stringify(end), /private output|Operation not permitted/);
    } finally { await driver.close(); }
  }
});
