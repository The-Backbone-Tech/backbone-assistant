import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpHarness } from '../src/index.ts';
import type { TurnContext, TurnRequest } from '@backbone-next/platform/ports';
const request: TurnRequest = { threadId: 'thread', turnId: 'turn', text: 'Work', history: [], attachments: [], effort: 3, resumed: false };
const context: TurnContext = { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'not granted' }) }, route: { kind: 'agent', provider: 'acp:fake', baseUrl: '', model: 'chosen-by-agent', label: 'Fake', credential: null }, credential: async () => { throw new Error('No credential'); } };
for (const mode of ['injected', 'idle', 'unsupported', 'lost']) test(`ACP native steering: ${mode}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'backbone-acp-steering-'));
  const harness = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [new URL('./fake-steering.mjs', import.meta.url).pathname], env: { ACP_STEERING_MODE: mode }, temporaryRoot: root, storage: root, environment: process.platform === 'darwin' ? 'restricted-writes' : 'person-rights', requestTimeoutMs: 2000, turnTimeoutMs: 5000 });
  try {
    assert.equal(harness.steers, true);
    const turn = harness.start(request, context);
    const events = turn.events[Symbol.asyncIterator]();
    const first = await events.next();
    assert.equal(first.value?.type, 'text');
    const delivered = await turn.deliver!('Use the blue plan');
    assert.equal(delivered.outcome, mode === 'injected' ? 'DELIVERED' : mode === 'lost' ? 'UNKNOWN' : 'NOT_DELIVERED');
    if (mode === 'unsupported') turn.stop();
    while (!(await events.next()).done) { /* drain native events */ }
    const outcome = await turn.outcome;
    if (mode === 'injected') { assert.equal(outcome.status, 'done'); assert.match(outcome.answer, /blue plan/); }
    if (mode === 'lost') assert.notEqual(outcome.status, 'done');
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});
