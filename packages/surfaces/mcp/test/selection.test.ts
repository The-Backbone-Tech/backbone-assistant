import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createHost, hostClosed, removeDataHome } from '@backbone-next/platform/composition';
import { serveApiLine, askWords, type LineAsk } from '@backbone-next/platform/composition/api-line';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel } from '@backbone-next/platform/testing';
import type { Thread } from '@backbone-next/platform';

test('MCP selection compares, runs and verifies through the same app line with an observed local route', async () => {
  const model = await startScriptedModel('mcp-selection');
  const home = freshDataHome('mcp-selection');
  const host = createHost({ home, harness: 'harness-pi', localModels: { ports: { ollama: Number(new URL(model.url).port), lmstudio: 0, llamacpp: 0, vllm: 0 } } });
  const saved = await host.call('settings.model.put', { change: { route: 'local', provider: 'other', baseUrl: model.url, model: model.model } });
  assert.ok(saved.ok);
  let allow = false;
  const questions: LineAsk[] = [];
  const line = await serveApiLine({ home, call: host.call, confirm: async ask => { questions.push(ask); return allow; } });
  const client = new Client({ name: 'selection-test', version: '0.0.0' });
  try {
    const project = await host.call('projects.create', { name: 'Selection', kind: 'folder' });
    assert.ok(project.ok);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL('../src/main.ts', import.meta.url).pathname, 'serve', '--home', home, '--grant', 'none'], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? tmpdir() }, stderr: 'pipe' }));
    const task = { needs: ['model', 'files'], network: false, spend: 'none' };
    const options = await client.callTool({ name: 'solutions_options', arguments: task });
    const choice = (options.structuredContent as { value: { choice: { route: { id: string } } } }).value.choice;
    assert.equal(choice.route.id, `local:other:${model.model}`);
    const args = { projectId: project.value.id, text: 'Write an editable brief', task, settings: { permission: 'ask', model: 'none', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'mcp-selection' };
    // A native No refuses execution and sends no model request.
    const blocked = await client.callTool({ name: 'solutions_run', arguments: args });
    assert.equal(blocked.isError, true);
    const question = questions[0];
    assert.equal(question.method, 'solutions.run');
    assert.ok('caller' in question && question.caller?.mcp === 'selection-test');
    assert.ok('permission' in question && question.permission === 'ask');
    assert.ok(askWords(question, 'App').detail.includes('selection-test'));
    assert.equal(model.requests.filter((r) => r.body.includes('"messages"')).length, 0);
    // A No closes asked calls until the app reopens, so reopen that line with the person's answer.
    await line.close();
    allow = true;
    const reopened = await serveApiLine({ home, call: host.call, confirm: async () => allow });
    try {
      const run = await client.callTool({ name: 'solutions_run', arguments: args });
      assert.equal(run.isError, false, JSON.stringify(run));
      const started = (run.structuredContent as { value: { started: { threadId: string; turnId: string } } }).value.started;
      for (let i = 0; i < 400; i++) {
        const thread = await host.call('threads.get', { id: started.threadId });
        assert.ok(thread.ok);
        if (!thread.value.summary.running) {
          assert.equal(thread.value.turns[0].selection?.ran?.baseUrl, model.url);
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      const verified = await client.callTool({ name: 'solutions_verify', arguments: { ...started, deliverables: ['brief.md'] } });
      assert.equal((verified.structuredContent as { value: { complete: boolean } }).value.complete, true);
      const observed = await client.callTool({ name: 'read_thread', arguments: { threadId: started.threadId } });
      assert.equal(observed.isError, false);
      const recorded = (observed.structuredContent as { value: Thread }).value.turns.find((turn) => turn.id === started.turnId);
      assert.equal(recorded?.selection?.ran?.baseUrl, model.url, 'the MCP client can inspect the observed route');
      const requestsBeforeReplay = model.requests.filter(r => r.body.includes('"messages"')).length;
      const repeated = await client.callTool({ name: 'solutions_run', arguments: args });
      assert.deepEqual((repeated.structuredContent as { value: { started: unknown } }).value.started, started);
      assert.equal(model.requests.filter(r => r.body.includes('"messages"')).length, requestsBeforeReplay, 'read-only revalidation may query the catalogue; the repeated key starts no inference');
    } finally { await reopened.close(); }
  } finally { await client.close(); await line.close(); host.close(); await hostClosed(home); await removeDataHome(home); await model.close(); }
});

test('a lost MCP selection run reports UNKNOWN and dispatches only once', async () => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { createDoorServer } = await import('../src/server.ts');
  let calls = 0;
  const server = createDoorServer({} as never, { open: async () => ({ call: async () => { calls++; throw new Error('lost after admission'); }, close() {} }) });
  const client = new Client({ name: 'lost-selection', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const result = await client.callTool({ name: 'solutions_run', arguments: { projectId: 'p', text: 'Write a brief', task: { needs: ['model'], network: false, spend: 'none' }, settings: { permission: 'ask', model: 'none', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'lost' } });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { outcome: string }).outcome, 'UNKNOWN');
    assert.equal(calls, 1);
  } finally { await client.close(); await server.close(); }
});
