import { freshAcpExecutableDirectory } from '@backbone-next/platform/testing/acp';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HarnessEvent, TurnContext, TurnRequest } from '@backbone-next/platform/ports';
import { claudeMachineEnvironment } from '@backbone-next/platform/machine-client';
import { createAcpHarness, type AcpHarness } from '../src/index.ts';

for (const variant of ['host-write-and-load', 'native-permission', 'generic-agent'] as const) {
  test(`the adapter's Host-tool rule preserves the port boundary: ${variant}`, async () => {
    const root = freshAcpExecutableDirectory('acp-claude-tools-'), person = join(root, 'person');
    mkdirSync(person);
    const cli = join(person, 'claude'), record = join(root, 'requests.jsonl');
    writeFileSync(cli, '#!/bin/sh\nprintf \'%s\' \'{"loggedIn":true,"authMethod":"claude.ai"}\'\n'); chmodSync(cli, 0o755);
    const machine = claudeMachineEnvironment({ HOME: person, PATH: process.env.PATH, CLAUDE_CODE_EXECUTABLE: cli });
    const isClaude = variant !== 'generic-agent';
    const options = { acceptsProcessVisibility: true, command: process.execPath,
      args: [new URL('./claude-session-agent.mjs', import.meta.url).pathname,
        variant === 'native-permission' ? 'permission' : 'mcp-write', isClaude ? 'claude' : 'generic', record],
      environment: 'person-rights' as const, storageDir: join(root, 'storage'),
      ...(isClaude ? { machineClient: 'claude' as const, machineClientEnvironment: machine } : {}),
    };
    const harnesses: AcpHarness[] = [];
    let writes = 0;
    const context: TurnContext = {
      tools: { list: async () => [], read: async () => null,
        write: async (name, body) => { assert.match(body, /ACP brief/); return { outcome: 'DONE', name, version: ++writes }; } },
      route: { kind: 'agent', provider: 'acp:local', baseUrl: '', model: 'chosen-by-agent', label: 'Local ACP', credential: null },
      credential: async () => { throw new Error('No Host credential'); },
    };
    const request = (history: TurnRequest['history'] = []): TurnRequest => ({ threadId: 'thread', turnId: `turn-${writes}`,
      text: 'Write a brief.', history, attachments: [], effort: 3, resumed: false });
    try {
      const first = createAcpHarness(options); harnesses.push(first);
      const turn = first.start(request(), context), events: HarnessEvent[] = [];
      const consume = (async () => { for await (const event of turn.events) events.push(event); })();
      const result = await turn.outcome; await consume;
      assert.equal(result.status, 'done', result.error ?? 'The turn must complete.');
      if (variant === 'native-permission') {
        assert.equal(writes, 0);
        assert.ok(events.some(event => event.type === 'tool' && event.phase === 'refused'));
        assert.match(result.answer, /permission:reject/);
      } else {
        assert.equal(writes, 1);
        assert.match(result.answer, /DONE/);
      }
      if (variant === 'host-write-and-load') {
        await first.close();
        const next = createAcpHarness(options); harnesses.push(next);
        const result2 = await next.start(request([{ role: 'user', text: 'Write a brief.' }, { role: 'assistant', text: result.answer }]), context).outcome;
        assert.equal(result2.status, 'done', result2.error ?? 'The loaded turn must complete.');
        assert.equal(writes, 2);
      }
      const requests = readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(requests.map(item => item.method), variant === 'host-write-and-load' ? ['session/new', 'session/load'] : ['session/new']);
    } finally {
      await Promise.all(harnesses.map(harness => harness.close()));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
