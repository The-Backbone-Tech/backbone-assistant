import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Host } from '@backbone-next/platform/composition';
import { unknownCheckConfirmation } from '@backbone-next/platform';
import { confirmUnknownCheck } from '../electron/unknown-check.ts';

for (const response of [0, 1]) test(`native check response ${response} binds the displayed turn and revision`, async () => {
  const calls: unknown[] = [];
  const q = { revision: 'a'.repeat(64), steps: [{ label: 'Codex connector mail / send', at: '2026-11-13T12:00:00.000Z' }] };
  const host = { unknownChecks: { question: async (input: unknown) => { calls.push(input); return { ok: true, value: q }; }, check: async (input: unknown) => { calls.push(input); return { ok: true, value: { ...q, by: 'person', at: q.steps[0].at } }; } } } as unknown as Host;
  const result = await confirmUnknownCheck(host, { threadId: 'thread', turnId: 'turn', revision: 'forged', by: 'forged' }, async options => {
    assert.equal(options.message, unknownCheckConfirmation('Backbone'));
    assert.equal(options.message, 'Mark as checked? Backbone will not repeat this action; continuing may ask the assistant to try again.');
    assert.match(options.detail!, /mail \/ send/); assert.match(options.detail!, /2026-11-13/);
    assert.deepEqual(options.buttons, ['Mark as checked', 'Cancel']); assert.equal(options.cancelId, 1);
    return { response };
  }, 'Backbone');
  assert.equal(result.ok, response === 0);
  assert.deepEqual(calls, [{ threadId: 'thread', turnId: 'turn' }, ...(response === 0 ? [{ threadId: 'thread', turnId: 'turn', revision: q.revision }] : [])]);
});
test('thread renders an inspectable unknown, checked history, and only eligible actions', async () => {
  const { createServer } = await import('vite');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { UnknownOutcome } = await server.ssrLoadModule('/src/components/UnknownOutcome.tsx');
    const base = { id: 'turn', unknownOutcome: true };
    const q = { revision: 'a'.repeat(64), steps: [{ label: 'Codex connector mail / send', at: '2026-11-13T12:00:00.000Z' }] };
    const render = (turn: unknown) => renderToStaticMarkup(createElement(UnknownOutcome, { turn, threadId: 'thread' }));
    assert.doesNotMatch(render(base), /I checked this myself/);
    const eligible = render({ ...base, unknownCheck: q });
    assert.match(eligible, /I checked this myself/); assert.match(eligible, /mail \/ send/);
    const checked = render({ ...base, unknownChecked: { ...q, by: 'owner', at: q.steps[0].at } });
    assert.match(checked, /unknown, checked by owner/); assert.doesNotMatch(checked, /I checked this myself|succeeded/);
    const named = render({ ...base, unknownCheckedCurrent: true, unknownChecked: { ...q, by: 'owner-id', byName: 'Alex', at: q.steps[0].at } });
    assert.match(named, /unknown, checked by Alex/); assert.doesNotMatch(named, /checked by owner-id/); assert.match(named, /Checker ID: owner-id/);
    const earlier = render({ ...base, unknownCheckedCurrent: false, unknownChecked: { ...q, by: 'owner-id', byName: 'Alex', at: q.steps[0].at } });
    assert.match(earlier, /Earlier check by Alex.*no longer applies/); assert.doesNotMatch(earlier, /unknown, checked by/);
    assert.equal(render({ id: 'ordinary' }), '');
  } finally { await server.close(); }
});

test('an account switch while the native check question is open cannot mark through the old device binding', async () => {
  let marked = 0;
  const signal = new AbortController();
  const host = { unknownChecks: {
    question: async () => ({ ok: true, value: { revision: 'current', steps: [] } }),
    check: async () => { marked++; throw new Error('An ended device binding must never reach the check.'); },
  } } as unknown as Host;
  const result = await confirmUnknownCheck(host, { threadId: 'thread', turnId: 'turn' }, async () => {
    signal.abort(); return { response: 0 };
  }, 'Backbone', signal.signal);
  assert.equal(result.ok, false); assert.equal(marked, 0);
});
