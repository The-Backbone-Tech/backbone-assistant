import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOST_TOOLS, type ToolHost } from '@backbone-next/platform/ports';
import { hostCases, hostDriver } from './host-tools-driver.ts';
import { carryCodexHostTool } from '../src/host-tools.ts';

for (const c of hostCases) {
  test(`${c.name}: offered only when the Host supplies it; same description, schema and result as Pi`, async () => {
    const calls: unknown[] = [];
    const s = await hostDriver({ [c.method]: async (args: unknown) => { calls.push(args); return c.reply; } });
    try {
      const turn = s.harness().start(s.request([{ name: c.name, args: c.args }]), s.context);
      const events = (async () => { const result = []; for await (const event of turn.events) result.push(event); return result; })();
      const outcome = await turn.outcome;
      assert.equal(outcome.status, 'done', outcome.error ?? '');
      const answer = JSON.parse(outcome.answer);
      assert.deepEqual(answer.catalog, [{ type: 'function', name: c.name, description: HOST_TOOLS[c.name].description, inputSchema: HOST_TOOLS[c.name].inputSchema }]);
      assert.deepEqual(answer.results, [{ contentItems: [{ type: 'inputText', text: c.expected }], success: true }]);
      assert.deepEqual(calls, [c.argument]);
      assert.deepEqual((await events).filter(e => e.type === 'tool').map(e => [e.tool, e.phase]), [[c.name, 'proposed'], [c.name, 'done']]);
      delete s.context.tools[c.method];
      assert.equal((await s.harness().start(s.request([{ name: c.name, args: c.args }]), s.context).outcome).status, 'failed');
      assert.equal(calls.length, 1);
    } finally { await s.close(); }
  });

  test(`${c.name}: validates arguments before the Host and reports the agent's own error`, async () => {
    let calls = 0;
    const s = await hostDriver({ [c.method]: async () => { calls++; return c.reply; } });
    try {
      const args = [...c.invalid, null, 'not an object', []];
      const outcome = await s.harness().start(s.request(args.map(args => ({ name: c.name, args }))), s.context).outcome;
      assert.equal(outcome.status, 'done', outcome.error ?? '');
      const answer = JSON.parse(outcome.answer);
      assert.equal(answer.continued, true);
      assert.equal(answer.results.length, args.length);
      for (const result of answer.results) { assert.equal(result.success, false); assert.match(result.contentItems[0].text, /Invalid tool arguments/); }
      assert.equal(calls, 0);
    } finally { await s.close(); }
  });

  test(`${c.name}: a Host refusal is tool data and the agent continues`, async () => {
    let calls = 0;
    const s = await hostDriver({ [c.method]: async () => {
      calls++;
      if (c.method === 'proposeGoal') throw new Error('Refused');
      return c.method === 'messageCard' ? { outcome: 'REFUSED', reason: 'unavailable', detail: 'Host refusal.' } : 'Host refusal.';
    } });
    try {
      const outcome = await s.harness().start(s.request([{ name: c.name, args: c.args }]), s.context).outcome;
      assert.equal(outcome.status, 'done', outcome.error ?? '');
      const answer = JSON.parse(outcome.answer);
      assert.equal(answer.continued, true);
      assert.equal(calls, 1);
      assert.match(answer.results[0].contentItems[0].text, /Host refus/);
      assert.equal(answer.results[0].success, c.method === 'searchMemory' || c.method === 'proposeMemory');
    } finally { await s.close(); }
  });

  test(`${c.name}: Stop during the Host call interrupts the turn and discards late data`, async () => {
    let begun!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { begun = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const s = await hostDriver({ [c.method]: async () => { calls++; begun(); await pending; return c.reply; } });
    try {
      const turn = s.harness().start(s.request([{ name: c.name, args: c.args }]), s.context);
      const events = (async () => { const all = []; for await (const event of turn.events) all.push(event); return all; })();
      await started;
      turn.stop();
      const outcome = await turn.outcome;
      assert.equal(outcome.status, 'interrupted');
      assert.equal(outcome.answer, '');
      assert.equal(calls, 1);
      assert.deepEqual((await events).filter(e => e.type === 'tool').map(e => [e.tool, e.phase]), [[c.name, 'proposed'], [c.name, 'unknown']]);
      release();
      // The same handoff suppresses data even if its Host resolves after cancellation.
      const abort = new AbortController();
      const result = carryCodexHostTool({ [c.method]: async () => { abort.abort(); return c.reply; } } as unknown as ToolHost, c.name, { arguments: c.args }, abort.signal);
      assert.equal(await result, null);
    } finally { release(); await s.close(); }
  });
}

for (const c of hostCases.filter(c => c.method === 'proposeMemory' || c.method === 'messageCard')) test(`${c.name}: only declared argument keys reach the Host`, async () => {
  const received: unknown[] = [];
  const s = await hostDriver({ [c.method]: async (args: unknown) => { received.push(args); return c.reply; } });
  try {
    const outcome = await s.harness().start(s.request([{ name: c.name, args: { ...c.args, unexpected: 'model-added field' } }]), s.context).outcome;
    assert.equal(outcome.status, 'done', outcome.error ?? '');
    assert.deepEqual(received, [c.argument]);
  } finally { await s.close(); }
});
