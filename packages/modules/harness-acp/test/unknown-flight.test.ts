import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TurnContext, TurnRequest } from '@backbone-next/platform/ports';
import { createAcpHarness } from '../src/index.ts';
import { Session } from '../src/session.ts';
const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const request: TurnRequest = { threadId: 'unknown-flight', turnId: 'one', text: 'ready', history: [], attachments: [], effort: 3, resumed: false };
const base: TurnContext = { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'no grant' }) }, route: { kind: 'agent', provider: 'acp:fake', baseUrl: '', model: 'chosen-by-agent', label: 'fake', credential: null }, credential: async () => { throw new Error('No credential'); } };
for (const ending of ['timeout', 'death', 'cancel'] as const) test(`${ending} retains UNKNOWN from a signed connector call that resolves during cleanup`, { timeout: 5000 }, async () => {
  let entered!: () => void, calls = 0, session: Session | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; }), originalConnect = Session.prototype.connect;
  Session.prototype.connect = function (...args) { session = this; return originalConnect.apply(this, args); };
  const detail = `Signed connector ${ending}: UNKNOWN; inspect the original receipt and never resend.`;
  const context: TurnContext = { ...base, tools: { ...base.tools,
    connectors: () => [{ name: 'mcp__notes__search', server: 'notes', tool: 'search', kind: 'effect', description: 'Owned signed fake', inputSchema: { type: 'object' } }],
    callConnector: async (_name, _args, signal) => {
      calls++; entered();
      await new Promise<void>(resolve => { const finish = () => setTimeout(resolve, 50); if (signal.aborted) finish(); else signal.addEventListener('abort', finish, { once: true }); });
      return { outcome: 'SENT', state: 'unknown', detail };
    },
  } };
  const h = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: process.platform === 'darwin' ? 'restricted-writes' : 'person-rights', env: { ACP_FAKE_MODE: 'connector-in-flight' }, turnTimeoutMs: ending === 'timeout' ? 200 : 2000, stopTimeoutMs: 200 });
  try {
    const turn = h.start(request, context), stream = (async () => { for await (const _ of turn.events) { /* Must close. */ } })();
    await started;
    if (ending === 'death') session!.agent!.process.kill('SIGKILL');
    if (ending === 'cancel') turn.stop();
    const outcome = await turn.outcome; await stream;
    assert.equal(outcome.status, ending === 'cancel' ? 'interrupted' : 'failed');
    assert.ok(outcome.error?.includes(detail), outcome.error ?? ''); assert.equal(calls, 1);
    if (ending === 'cancel') assert.match(outcome.answer, /cancel-observed/, 'the agent answered cancel before the delayed connector receipt');
  } finally { Session.prototype.connect = originalConnect; await h.close(); }
});

for (const kind of ['connector', 'write'] as const) for (const receipt of ['recorded', 'pending'] as const) test(`early end_turn with a ${receipt} UNKNOWN ${kind} interrupts and discards native state`, { timeout: 5000 }, async () => {
  let entered!: () => void, calls = 0, session: Session | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; }), originalConnect = Session.prototype.connect;
  Session.prototype.connect = function (...args) { session = this; return originalConnect.apply(this, args); };
  const detail = `${kind} receipt UNKNOWN: inspect before resending.`;
  const unresolved = async (signal: AbortSignal) => {
    calls++; entered();
    if (receipt === 'pending') await new Promise<void>(() => {});
    else await new Promise<void>(resolve => { if (signal.aborted) setTimeout(resolve, 10); else signal.addEventListener('abort', () => setTimeout(resolve, 10), { once: true }); });
  };
  const context: TurnContext = { ...base, tools: { ...base.tools,
    write: async (_name, _body, signal) => { await unresolved(signal); return { outcome: 'UNKNOWN', detail }; },
    connectors: () => [{ name: 'mcp__notes__search', server: 'notes', tool: 'search', kind: 'effect', description: 'Owned signed fake', inputSchema: { type: 'object' } }],
    callConnector: async (_name, _args, signal) => { await unresolved(signal); return { outcome: 'SENT', state: 'unknown', detail }; },
  } };
  const h = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: process.platform === 'darwin' ? 'restricted-writes' : 'person-rights', env: { ACP_FAKE_MODE: 'tool-in-flight', ACP_FAKE_TOOL: kind === 'write' ? 'write_file' : 'connector_mcp__notes__search' }, stopTimeoutMs: 30 });
  try {
    const turn = h.start(request, context), stream = (async () => { for await (const _ of turn.events) { /* Must close. */ } })();
    await Promise.race([started, turn.outcome.then(value => { throw new Error('Agent ended before dispatch: ' + JSON.stringify(value)); })]); session!.agent!.process.kill('SIGUSR1');
    const outcome = await turn.outcome; await stream;
    assert.equal(outcome.status, 'interrupted'); assert.equal(calls, 1);
    assert.ok(outcome.error?.includes(receipt === 'recorded' ? detail : 'still in flight'), outcome.error ?? '');
    assert.equal(session!.saved, undefined); assert.equal(session!.agent, undefined); assert.equal(session!.bridge, undefined);
    const { readdir } = await import('node:fs/promises'); assert.deepEqual(await readdir(session!.state), []); assert.deepEqual(await readdir(session!.work), []);
  } finally { Session.prototype.connect = originalConnect; await h.close(); }
});
