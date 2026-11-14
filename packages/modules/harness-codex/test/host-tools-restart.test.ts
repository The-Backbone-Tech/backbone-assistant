import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostCases, hostDriver } from './host-tools-driver.ts';

const calls = hostCases.map(c => ({ name: c.name, args: c.args }));

test('all four Host tools are rebuilt for follow-up turns and a restarted engine, using the current Host', async () => {
  const s = await hostDriver();
  const original = s.harness();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const seen: unknown[] = [];
      s.context.tools = {
        ...s.context.tools,
        searchMemory: async query => { seen.push(['searchMemory', query]); return `Memory from attempt ${attempt}`; },
        proposeMemory: async proposal => { seen.push(['proposeMemory', proposal]); return `Proposal held in attempt ${attempt}`; },
        proposeGoal: async text => { seen.push(['proposeGoal', text]); },
        messageCard: async message => { seen.push(['messageCard', message]); return { outcome: 'SENT', state: `attempt-${attempt}` }; },
      };
      // Each turn has its own ephemeral app server. The last also recreates the engine factory.
      const engine = attempt < 2 ? original : s.harness();
      const outcome = await engine.start(s.request(calls, { turnId: `turn-${attempt}` }), s.context).outcome;
      assert.equal(outcome.status, 'done', outcome.error ?? '');
      const answer = JSON.parse(outcome.answer);
      assert.deepEqual(answer.catalog.map((t: { name: string }) => t.name), ['memory_search', 'propose_memory', 'message_card', 'propose_goal']);
      assert.deepEqual(seen, hostCases.map(c => [c.method, c.argument]));
      assert.deepEqual(answer.results.map((r: { contentItems: { text: string }[]; success: boolean }) => { assert.equal(r.success, true); return r.contentItems[0].text; }), [
        `Memory from attempt ${attempt}`, `Proposal held in attempt ${attempt}`, 'Proposed. The goal stands until the person decides.', `Sent to card peer (attempt-${attempt}).`,
      ]);
    }
  } finally { await s.close(); }
});

test('interrupted-turn replay remains refused before any of the four Host methods is called', async () => {
  let invoked = 0;
  const s = await hostDriver({ searchMemory: async () => { invoked++; return ''; }, proposeMemory: async () => { invoked++; return ''; }, proposeGoal: async () => { invoked++; }, messageCard: async () => { invoked++; return { outcome: 'SENT', state: 'unexpected' }; } });
  try {
    const outcome = await s.harness().start(s.request(calls, { resumed: true }), s.context).outcome;
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /interrupted attempts cannot be replayed/);
    assert.equal(invoked, 0);
  } finally { await s.close(); }
});

for (const c of hostCases) for (const mode of ['bare', 'readOnly'] as const) test(`${mode} turns never offer ${c.name}, even if its Host method is present`, async () => {
  let invoked = 0;
  const s = await hostDriver({ stillGranted: () => true, [c.method]: async () => { invoked++; return c.reply; } });
  try {
    const outcome = await s.harness().start(s.request([{ name: c.name, args: c.args }], { [mode]: true }), s.context).outcome;
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /requested a tool the host did not offer/);
    assert.equal(invoked, 0);
  } finally { await s.close(); }
});
