import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TurnContext, TurnRequest } from '@backbone-next/platform/ports';
import { createAcpHarness } from '../src/index.ts';
import { AcpRefusal } from '../src/refusal.ts';
import { Session } from '../src/session.ts';

const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const request: TurnRequest = { threadId: 'stop-ordering', turnId: 'one', text: 'ready', history: [], attachments: [], effort: 3, resumed: false };

for (const cleanupFailure of [false, true]) test(`a recorded Stop wins over ${cleanupFailure ? 'a later cleanup failure' : 'completion during session persistence'}`, async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'acp-stop-ordering-'));
  const context: TurnContext = { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'no grant' }) }, route: { kind: 'agent', provider: 'acp:fake', baseUrl: '', model: 'chosen-by-agent', label: 'fake', credential: null }, credential: async () => { throw new Error('No credential'); } };
  const harness = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: 'person-rights', temporaryRoot });
  const { remember, idle, invalidate } = Session.prototype;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
  let failedCleanup = false;
  Session.prototype.remember = async function (history) {
    enter(); await resume;
    return remember.call(this, history);
  };
  if (cleanupFailure) {
    // Fail either cleanup branch: interruption must survive a cleanup refusal too.
    const refuse = () => { failedCleanup = true; throw new AcpRefusal('Owned cleanup refusal.'); };
    Session.prototype.idle = refuse;
    Session.prototype.invalidate = async function () { await invalidate.call(this); refuse(); };
  }
  try {
    const turn = harness.start(request, context);
    await entered;
    turn.stop(); release();
    const outcome = await turn.outcome;
    assert.equal(outcome.status, 'interrupted');
    if (cleanupFailure) { assert.equal(failedCleanup, true); assert.ok(outcome.error, 'cleanup uncertainty remains visible'); }
  } finally {
    release();
    Session.prototype.remember = remember; Session.prototype.idle = idle; Session.prototype.invalidate = invalidate;
    await harness.close(); await rm(temporaryRoot, { recursive: true, force: true });
  }
});
