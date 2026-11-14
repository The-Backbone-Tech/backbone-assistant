import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { serveApiLine } from '@backbone-next/platform/composition/api-line';
import { createHost, hostClosed, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel } from '@backbone-next/platform/testing';

test('CLI selection compares options, runs the chosen local route and verifies its own deliverable', async () => {
  const model = await startScriptedModel('cli-selection');
  const home = freshDataHome('cli-selection');
  const host = createHost({ home, harness: 'harness-pi', localModels: { ports: { ollama: Number(new URL(model.url).port), lmstudio: 0, llamacpp: 0, vllm: 0 } } });
  const saved = await host.call('settings.model.put', { change: { route: 'local', provider: 'other', baseUrl: model.url, model: model.model } });
  assert.ok(saved.ok);
  const output: string[] = [];
  const line = await serveApiLine({ home, call: host.call, confirm: async () => true });
  const command = async (args: string[]) => {
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [new URL('../src/main.ts', import.meta.url).pathname, ...args, '--home', home, '--json']);
      output.push(stdout); return 0;
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      output.push(result.stdout || result.stderr); return result.code;
    }
  };
  try {
    assert.ok((await host.call('projects.create', { name: 'Selection', kind: 'folder' })).ok);
    assert.equal(await command(['solutions', 'options', '--network', 'false', '--spend', 'none']), 0);
    assert.equal(JSON.parse(output.pop()!).choice.route.id, `local:other:${model.model}`);
    assert.equal(await command(['solutions', 'run', 'Write an editable brief', '--network', 'false', '--spend', 'none']), 0, output.join('\n'));
    const shown = JSON.parse(output.pop()!);
    assert.equal(shown.selection?.ran?.baseUrl, model.url, 'the CLI output includes the observed route');
    assert.equal(shown.selection?.options?.choice?.route.id, `local:other:${model.model}`);
    const threads = await host.call('threads.list', {});
    const thread = await host.call('threads.get', { id: threads[0].id });
    assert.ok(thread.ok);
    const turn = thread.value.turns[0];
    assert.equal(turn.selection?.ran?.baseUrl, model.url);
    assert.equal(await command(['solutions', 'verify', turn.id, '--thread', threads[0].id, '--deliverable', 'brief.md']), 0);
    assert.equal(JSON.parse(output.pop()!).complete, true);
    assert.equal(await command(['solutions', 'verify', turn.id, '--thread', threads[0].id, '--deliverable', 'missing.md']), 7);
  } finally { await line.close(); host.close(); await hostClosed(home); await removeDataHome(home); await model.close(); }
});

test('selection constraints cannot be silently accepted by another CLI command', async () => {
  const { parse } = await import('../src/commands.ts');
  for (const flag of [['--network', 'false'], ['--spend', 'none'], ['--needs', 'files'], ['--structured'], ['--evidence', 'topic']]) {
    assert.ok(parse(['send', 'Write a brief', ...flag], { BACKBONE_HOME: 'disposable' }).usage, flag.join(' '));
  }
  assert.ok(parse(['solutions', 'options', '--deliverable', 'brief.md'], { BACKBONE_HOME: 'disposable' }).usage);
});

test('selection run defaults to no spend and preserves an explicit spend ceiling', async () => {
  const { parse } = await import('../src/commands.ts');
  const env = { BACKBONE_HOME: 'disposable' };
  assert.equal(parse(['solutions', 'run', 'Write a brief'], env).options.task?.spend, 'none');
  assert.equal(parse(['solutions', 'run', 'Write a brief', '--spend', 'metered'], env).options.task?.spend, 'metered');
  assert.equal(parse(['solutions', 'options'], env).options.task?.spend, 'metered');
});

test('CLI rejects evidence topics that cannot be displayed in native confirmation', async () => {
  const { parse } = await import('../src/commands.ts');
  for (const topic of ['', '-flag', 'x'.repeat(201), 'public\u2028topic', 'public\u2029topic']) {
    assert.ok(parse(['solutions', 'options', '--evidence', topic], { BACKBONE_HOME: 'disposable' }).usage);
  }
  assert.equal(parse(['solutions', 'options', '--evidence', 'agent-harness'], { BACKBONE_HOME: 'disposable' }).usage, undefined);
});
