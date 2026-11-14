import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TurnContext, TurnRequest } from '@backbone-next/platform/ports';
import { createAcpHarness } from '../src/index.ts';
import { Session } from '../src/session.ts';
const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const request: TurnRequest = { threadId: 'opt-in', turnId: 'one', text: 'ready', history: [], attachments: [], effort: 3, resumed: false };
const context: TurnContext = { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'no grant' }) }, route: { kind: 'agent', provider: 'acp:fake', baseUrl: '', model: 'chosen-by-agent', label: 'fake', credential: null }, credential: async () => { throw new Error('No credential'); } };

test('ACP refuses all missing or non-true process visibility acceptance values before creating session state or a process', async () => {
  const original = Session.create; let created = 0;
  Session.create = async (...args) => { created++; return original(...args); };
  try {
    for (const acceptsProcessVisibility of [undefined, false, 'true', 1, null, {}, [true]]) {
      const h = createAcpHarness({ command: process.execPath, args: [fixture], acceptsProcessVisibility: acceptsProcessVisibility as boolean });
      try {
        assert.match(h.label, /An ACP agent runs as you/); assert.match(h.label, /environment variables and command lines.*API keys/);
        const turn = h.start(request, context), events = (async () => { for await (const _ of turn.events) assert.fail('No agent event is allowed'); })();
        const outcome = await turn.outcome; await events;
        assert.equal(outcome.status, 'failed'); assert.match(outcome.error ?? '', /harnesses.harness-acp.acceptsProcessVisibility: true/);
        assert.match(outcome.error ?? '', /environment variables and command lines.*API keys/); assert.equal(created, 0);
      } finally { await h.close(); }
    }
  } finally { Session.create = original; }
});

test('the transport itself refuses all non-true acceptance values before opening folders or starting an agent', async () => {
  const { AgentProcess } = await import('../src/transport.ts');
  const missing = { path: '/not-an-acp-session', dev: 0, ino: 0, mode: 0 };
  for (const acceptsProcessVisibility of [undefined, false, 'true', 1, null, {}, [true]]) {
    assert.throws(() => new AgentProcess({ acceptsProcessVisibility: acceptsProcessVisibility as boolean, command: process.execPath, args: [] }, missing, missing), /harnesses.harness-acp.acceptsProcessVisibility: true/);
  }
});
