// Exercise dispatch in the owning module turn, beyond the extracted handoff functions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectorResult } from '@backbone-next/platform/ports';
import { hostDriver } from './host-tools-driver.ts';

test('a Host tool withdrawn after catalog admission fails the turn at dispatch', async () => {
  let searched = 0;
  const s = await hostDriver({ searchMemory: async () => { searched++; return 'must not return'; } });
  s.context.tools.proposeGoal = async () => { delete s.context.tools.searchMemory; };
  try {
    const outcome = await s.harness().start(s.request([
      { name: 'propose_goal', args: { text: 'Withdraw memory now' } },
      { name: 'memory_search', args: { query: 'launch' } },
    ]), s.context).outcome;
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /requested a tool the host did not offer/);
    assert.equal(searched, 0);
  } finally { await s.close(); }
});

test('a namespaced Host tool call is refused before dispatch', async () => {
  let searched = 0;
  const s = await hostDriver({ searchMemory: async () => { searched++; return 'must not return'; } });
  try {
    const outcome = await s.harness().start(s.request([{ name: 'memory_search', args: { query: 'launch' }, namespace: 'functions' }]), s.context).outcome;
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /requested a tool the host did not offer/);
    assert.equal(searched, 0);
  } finally { await s.close(); }
});

for (const result of [
  { outcome: 'UNKNOWN', detail: 'No definitive receipt.' },
  { outcome: 'SENT', state: 'unknown', detail: 'No definitive receipt.' },
] satisfies ConnectorResult[]) test(`connector ${result.outcome}${'state' in result ? '/' + result.state : ''} interrupts the module turn before any further dispatch`, async () => {
  const dispatched: string[] = [];
  const s = await hostDriver({
    connectors: () => ['first', 'second'].map(name => ({ name, server: 'fake', tool: name, description: 'Synthetic connector', kind: 'effect' as const, inputSchema: { type: 'object' } })),
    callConnector: async name => { dispatched.push(name); return name === 'first' ? result : { outcome: 'READ', status: 'complete', text: 'must not return' }; },
    searchMemory: async () => { dispatched.push('memory_search'); return 'must not return'; },
  });
  try {
    const outcome = await s.harness().start(s.request([
      { name: 'connector__first', args: {} },
      { name: 'connector__second', args: {} },
      { name: 'memory_search', args: { query: 'launch' } },
    ]), s.context).outcome;
    assert.equal(outcome.status, 'interrupted', outcome.error ?? '');
    assert.equal(outcome.answer, '');
    assert.deepEqual(dispatched, ['first']);
  } finally { await s.close(); }
});
