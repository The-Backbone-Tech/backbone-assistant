import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TurnContext, TurnRequest } from '@backbone-next/platform/ports';
import { createAcpHarness } from '../src/index.ts';
import { Session } from '../src/session.ts';
const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const request: TurnRequest = { threadId: 'cleanup-stop', turnId: 'one', text: 'ready', history: [], attachments: [], effort: 3, resumed: false };
const context: TurnContext = { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'no grant' }) }, route: { kind: 'agent', provider: 'acp:fake', baseUrl: '', model: 'chosen-by-agent', label: 'fake', credential: null }, credential: async () => { throw new Error('No credential'); } };

test('a Stop during failed-turn cleanup cannot arm a timer that kills the next turn', { timeout: 5000 }, async () => {
  const options = { acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: process.platform === 'darwin' ? 'restricted-writes' as const : 'person-rights' as const, env: { ACP_FAKE_MODE: 'die' }, stopTimeoutMs: 80 };
  const h = createAcpHarness(options), invalidate = Session.prototype.invalidate;
  let entered!: () => void, release!: () => void, hold = true;
  const held = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  Session.prototype.invalidate = async function () { if (hold) { entered(); await gate; } await invalidate.call(this); };
  try {
    const first = h.start(request, context); await held;
    first.stop(); hold = false; release();
    assert.equal((await first.outcome).status, 'failed');
    options.env.ACP_FAKE_MODE = 'wait';
    const next = h.start({ ...request, turnId: 'two' }, context);
    let running!: () => void, settled = false;
    const started = new Promise<void>(resolve => { running = resolve; });
    const stream = (async () => { for await (const event of next.events) if (event.type === 'text' && event.delta === 'rea') running(); })();
    void next.outcome.then(() => { settled = true; });
    await started; await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(settled, false, 'the cleanup-time Stop must not kill the next session agent');
    next.stop(); assert.equal((await next.outcome).status, 'interrupted'); await stream;
  } finally { hold = false; release(); Session.prototype.invalidate = invalidate; await h.close(); }
});
