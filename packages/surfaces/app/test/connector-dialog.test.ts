// Native questions keep the app's decision ahead of bounded, single-line server text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectorServer, ConnectorTool, HeldCall } from '@backbone-next/platform';
import { connectorText, enableDialog, toolsDialog, openDialog, readDialog, releaseDialog, standingDialog, resolutionDialog, exactText } from '../electron/connector-dialog.ts';

const hostile = 'first\nsecond\r\u202e' + 'x'.repeat(10_000);
const tool = { name: hostile, title: hostile, description: hostile, annotated: 'read', kind: 'read', enabled: false } as ConnectorTool;
const server = { name: hostile, shown: hostile, tools: [tool] } as ConnectorServer;

test('server text strips controls and bidi, remains one line and clips with a visible ellipsis', () => {
  for (const limit of [120, 600]) {
    const shown = connectorText(hostile, limit);
    assert.equal(shown.length, limit);
    assert.ok(shown.endsWith('…'));
    assert.doesNotMatch(shown, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  }
});

test('every native connector question puts its own decisive sentence before hostile server text', () => {
  const cases = [
    [enableDialog(server, tool), 'This tool will run as a read without asking each time.'],
    [enableDialog(server), 'This lets every engine use this server’s enabled tools.'],
    [openDialog({ name: hostile, shown: hostile }), 'Permitted calls are sent once; permitted tools may act without asking.'],
    [readDialog(server, tool), 'Every call will run without waiting for you and bypass the egress door.'],
    [releaseDialog({ serverName: hostile, tool: hostile, statement: hostile, args: { text: hostile } } as unknown as HeldCall, true), 'This approves only the recorded call identified below.'],
    [standingDialog(tool.name, { name: hostile, description: hostile, shown: hostile, blocklisted: true }), 'Every call to this tool goes out without asking you each time, including sending arguments.'],
  ] as const;
  for (const [question, decisive] of cases) {
    assert.ok(question.detail!.startsWith(decisive));
    if (question.title === 'Permit an action') assert.match(question.detail!, /full call is in Connected tools/);
    else assert.ok(question.detail!.includes(connectorText(hostile, 600)));
    assert.doesNotMatch(`${question.title} ${question.message} ${question.detail}`, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u);
    // 10 November 2026, review M1: large releases are explicitly bounded previews, never claimed complete.
    assert.ok(question.detail!.length < 4_000);
    assert.equal(question.defaultId, 1);
    assert.equal(question.cancelId, 1);
  }
});

test('one capped server-tools question states both server annotations and effective kinds before descriptions', () => {
  const question = toolsDialog(server, [tool, { ...tool, name: 'draft', annotated: 'effect', kind: 'effect' }], 12);
  assert.equal(question.message, 'Turn on these 2 tools?');
  assert.ok(question.detail!.startsWith('Read tools will run without asking; tools that change things stay held unless separately permitted.'));
  assert.match(question.detail!, /The server says it only reads/);
  assert.match(question.detail!, /The server says it can change things/);
  assert.match(question.detail!, /12 more tools stay off/);
  assert.match(question.detail!, /Turn on its tools/);
  assert.doesNotMatch(question.detail!, /\u202e/);
  assert.ok(question.detail!.length < 2_500);
  assert.equal(toolsDialog(server, [tool], 0).message, 'Turn on this tool?');
});

test('a long body before a recipient leaves that recipient visible, reports hash/length, and never claims complete', () => {
  const args = { body: 'x'.repeat(4000), to: 'person@example.test' }, statement = `Call send_note on Notes with exactly: ${JSON.stringify(args)}`;
  const held = { serverName: 'Notes', tool: 'send_note', statement, args, argsHash: 'a'.repeat(64) } as unknown as HeldCall;
  const dialog = releaseDialog(held, true);
  assert.ok(dialog.detail!.includes('"to": "person@example.test"'));
  assert.ok(dialog.detail!.indexOf('"to"') < dialog.detail!.indexOf('Argument hash:'));
  assert.ok(dialog.detail!.includes('Argument hash: ' + held.argsHash));
  assert.ok(dialog.detail!.includes(`Arguments length: ${exactText(args).length} JSON characters`));
  assert.match(dialog.detail!, /full call is in Connected tools/); assert.doesNotMatch(dialog.detail!, /complete/i);
  assert.equal(dialog.detail!.includes('x'.repeat(1000)), false); assert.ok(dialog.detail!.length < 2000);
  assert.deepEqual(Object.keys(args), ['body', 'to'], 'display ordering never changes the call');
  assert.equal(dialog.defaultId, 1); assert.equal(dialog.cancelId, 1);
});

test('small calls list short scalar fields first and keep exact reversible escaping', () => {
  const args = { body: 'line\n\u202eTail\u{e0001}', to: 'person@example.test', id: 7 }, statement = `exact ${JSON.stringify(args)}`;
  const dialog = releaseDialog({ serverName: 'Notes', tool: 'send_note', statement, args } as unknown as HeldCall, true);
  assert.match(dialog.detail!, /complete/); assert.ok(dialog.detail!.includes(exactText(statement)));
  const argumentsText = dialog.detail!.split('\nArguments: ')[1];
  assert.ok(argumentsText.indexOf('"to"') < argumentsText.indexOf('"body"'));
  assert.deepEqual(JSON.parse(argumentsText), args); assert.deepEqual(JSON.parse(exactText(args)), args);
  assert.equal(argumentsText.includes('\u202e'), false);
});

test('either total argument length or one oversized value selects the bounded preview', () => {
  const make = (args: Record<string, unknown>) => releaseDialog({ serverName: 'Notes', tool: 'action', statement: 'Recorded call', args, argsHash: 'b'.repeat(64) } as HeldCall, true);
  assert.doesNotMatch(make({ body: 'x'.repeat(601), to: ['a@example.test'] }).detail!, /complete/i);
  assert.match(make({ body: 'x'.repeat(600) }).detail!, /complete/);
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field${i}`, 'x'.repeat(100)]));
  const large = make({ ...many, to: 'person@example.test' });
  assert.doesNotMatch(large.detail!, /complete/i); assert.ok(large.detail!.includes('"to": "person@example.test"'));
  assert.ok(large.detail!.length < 2300);
  assert.ok(make({ ...many, to: ['person@example.test'] }).detail!.includes('"to": ["person@example.test"]'), 'compact recipient lists also precede other fields');
  assert.doesNotMatch(releaseDialog({ serverName: 'Notes', tool: 'action', statement: 'x'.repeat(4000), args: { id: 7 } } as unknown as HeldCall, true).detail!, /complete/i);
});

test('resolution displays retained dispatch time and signature, never invents missing evidence, and defaults to cancel', () => {
  const view = { effect: 'call-id', argsHash: 'hash', statement: 'Recorded statement' };
  const question = resolutionDialog(view, { dispatchedAt: '2026-11-10T12:00:00.000Z', standingSignatureId: '10000000-0000-4000-8000-000000000001' });
  assert.deepEqual(question.buttons, ['It did happen', 'It did not happen', 'I do not know, keep it closed', 'Cancel']);
  assert.equal(question.defaultId, 3); assert.equal(question.cancelId, 3);
  assert.match(question.detail!, /Core dispatch admitted: 2026-11-10T12:00:00.000Z/);
  assert.match(question.detail!, /Permission: 10000000-0000-4000-8000-000000000001/);
  assert.match(question.detail!, /not proof of delivery/);
  assert.match(resolutionDialog(view).detail!, /Core dispatch admitted: Not available/);
  assert.match(resolutionDialog(view).detail!, /Permission: Not available/);
  assert.ok(question.detail!.includes(exactText(view.statement))); assert.match(question.detail!, /never sends the original/);
});
