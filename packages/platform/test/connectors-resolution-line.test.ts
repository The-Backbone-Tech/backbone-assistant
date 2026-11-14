// 10 November 2026, owner direction: a send is a signed tool like any other; resolution controls that tool’s pause.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serveApiLine, askWords, type LineAsk } from '../src/composition/api-line.ts';
import { attachApi, API_LINE_READS } from '../src/doors/api-line.ts';
import { pauseFixture } from './connector-pause-service-fixture.ts';
import { value } from './helpers.ts';

for (const answer of ['happened', 'did_not_happen', 'keep_closed'] as const) test(`API line asks the person for ${answer}, then records only that exact inspection`, async t => {
  const f = await pauseFixture(t); await f.call('draft_note', { text: 'unknown' }); const held = f.held()[0];
  const asks: LineAsk[] = [];
  const line = await serveApiLine({ home: f.home, call: async () => { throw Error('General API cannot resolve connector effects'); },
    confirm: async ask => { asks.push(ask); return true; },
    connectorEffects: { question: (e, h) => f.service.unknownQuestion(e, h), resolve: a => f.service.resolveUnknown(a.effect, a.argsHash, a.answer) },
  });
  t.after(() => line.close());
  const client = (await attachApi(f.home))!; t.after(() => client.close());
  const receipt = value(await client.resolveConnectorEffect({ effect: held.effect, argsHash: held.argsHash, answer }));
  assert.equal(receipt.answer, answer); assert.equal(asks.length, 1);
  const ask = asks[0]; assert.equal(ask.method, 'connectors.resolveEffect');
  if (ask.method !== 'connectors.resolveEffect') throw Error('wrong question');
  assert.equal(ask.statement, held.statement); assert.equal(ask.argsHash, held.argsHash); assert.equal(ask.answer, answer);
  assert.match(askWords(ask, 'App').detail, /never sends the call again/);
  assert.deepEqual(f.calls().map(c => c.tool), ['draft_note']);
  assert.equal((API_LINE_READS as readonly string[]).includes('connectors.resolveEffect'), false);
});

for (const mode of ['no-confirm', 'read-only', 'no-person-binding', 'denied'] as const) test(`API line ${mode} cannot resolve an UNKNOWN`, async t => {
  const f = await pauseFixture(t); await f.call('draft_note', { text: 'unknown' }); const held = f.held()[0];
  let decisions = 0;
  const line = await serveApiLine({ home: f.home, call: async () => { throw Error('Not an engine API method'); },
    ...(mode === 'no-confirm' ? {} : { confirm: async () => mode !== 'denied' }), readOnly: mode === 'read-only',
    ...(mode === 'no-person-binding' ? {} : { connectorEffects: { question: (e: string, h: string) => f.service.unknownQuestion(e, h), resolve: async (a: { effect: string; argsHash: string; answer: 'happened' }) => { decisions++; return f.service.resolveUnknown(a.effect, a.argsHash, a.answer); } } }),
  });
  t.after(() => line.close()); const client = (await attachApi(f.home))!; t.after(() => client.close());
  const result = await client.resolveConnectorEffect({ effect: held.effect, argsHash: held.argsHash, answer: 'happened' });
  assert.equal(result.ok, false); assert.equal(decisions, 0);
  assert.equal((await f.call('draft_note', { text: mode })).outcome, 'HELD');
});
