// 10 November 2026: the argument warning names the sending flags actually detected; it makes no unsupported claim about delete arguments.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { approvalFixture, approvalServer } from './connector-approval-fixture.ts';
import { value } from './helpers.ts';

test('the signing view shows bounded cleaned argument names and warns about a sending property beyond the visible twenty', async t => {
  const f = await approvalFixture(t, ['draft_note']);
  const names = ['body\n\u202etext', '\u001b[31mcolour', 'x'.repeat(400), f.control, ...Array.from({ length: 19 }, (_, i) => `field${i}`)];
  const properties: Record<string, unknown> = Object.fromEntries(names.map(name => [name, { type: 'string' }]));
  properties.nested = { type: 'object', properties: { sendNow: { type: 'boolean' } } };
  writeFileSync(f.control, JSON.stringify([{ name: 'draft_note', description: 'A draft', inputSchema: { type: 'object', properties }, annotations: { readOnlyHint: false } }]));
  value(await f.service.refresh(approvalServer)); value(await f.service.set(approvalServer, { tool: { name: 'draft_note', enabled: true } }));
  const shown = f.service.toolView(approvalServer, 'draft_note')!;
  assert.equal(shown.argumentNames.length, 20); assert.equal(shown.additionalArgumentNames, 5);
  assert.equal(shown.argumentNames[0], 'body text'); assert.equal(shown.argumentNames[1], 'colour');
  assert.ok(shown.argumentNames.every(name => name.length <= 120));
  assert.equal(JSON.stringify(shown.argumentNames).includes(f.control), false);
  assert.equal(shown.sendingArguments, true);
  assert.equal(shown.argumentWarning, 'This tool can also send, publish, post, share, deliver, notify or broadcast, depending on its arguments.');
  value(await f.sign('draft_note')); assert.equal((await f.call('draft_note', { nested: { sendNow: true } })).outcome, 'SENT', 'the schema warning is information, never a veto');
});

test('ordinary property names and combinator schemas are projected without inventing a sending warning', async t => {
  const f = await approvalFixture(t, ['draft_note']);
  writeFileSync(f.control, JSON.stringify([{ name: 'draft_note', description: 'A draft', inputSchema: { type: 'object', allOf: [{ properties: { body: { type: 'string' }, sender: { type: 'string' } } }] }, annotations: { readOnlyHint: false } }]));
  value(await f.service.refresh(approvalServer)); value(await f.service.set(approvalServer, { tool: { name: 'draft_note', enabled: true } }));
  const shown = f.service.toolView(approvalServer, 'draft_note')!;
  assert.deepEqual(shown.argumentNames, ['body', 'sender']); assert.equal(shown.additionalArgumentNames, 0);
  assert.equal(shown.sendingArguments, false); assert.equal(shown.argumentWarning, undefined);
});
