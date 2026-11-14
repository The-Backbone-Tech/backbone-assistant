import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, runCommand, EXIT, type Api } from '../src/commands.ts';
import { serveApiLine } from '@backbone-next/platform/composition/api-line';
const q = { revision: 'a'.repeat(64), steps: [{ label: 'Codex connector mail / send', at: '2026-11-13T12:00:00.000Z' }] };

test('checked command requires an exact turn', () => {
  assert.equal(parse(['threads', 'checked', 'thread', '--turn', 'turn', '--home', '/unused']).options.turnId, 'turn');
  assert.ok(parse(['threads', 'checked', 'thread', '--home', '/unused']).usage);
});
for (const running of [false, true]) test(`CLI checked with app running=${running} never checks without the native question`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'checked-cli-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  let checks = 0, confirmations = 0;
  const line = running ? await serveApiLine({ home,
    call: async () => ({ ok: true, value: { turns: [{ id: 'turn', unknownCheck: q }] } }) as never,
    unknownChecks: { question: async () => ({ ok: true, value: q }), check: async () => { checks++; return { ok: true, value: { ...q, by: 'owner', at: q.steps[0].at } }; } },
    confirm: async ask => { confirmations++; assert.equal(ask.method, 'threads.checked'); return true; },
  }) : undefined;
  t.after(() => line?.close());
  const child = spawn(process.execPath, [join(import.meta.dirname, '../src/main.ts'), 'threads', 'checked', 'thread', '--turn', 'turn', '--home', home], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, running ? EXIT.OK : EXIT.REFUSED, err);
  assert.equal(checks, running ? 1 : 0); assert.equal(confirmations, checks);
  if (running) assert.match(out, /unknown, checked by owner/);
  else { assert.match(err, /open the desktop app/); assert.deepEqual(readdirSync(home), []); }
});
test('threads show keeps checked outcomes unknown and displays the inspection', async () => {
  const turn = { id: 'turn', side: false, status: 'stopped', user: { text: 'Send', at: '', attachments: [] }, work: { harness: 'fake', startedAt: '', steps: [] }, effects: [], unknownOutcome: true, unknownChecked: { ...q, by: 'owner', at: q.steps[0].at } };
  const api = { call: async () => ({ ok: true, value: { summary: { id: 'thread', title: 'Mail' }, turns: [turn] } }) } as unknown as Api;
  let out = '';
  const code = await runCommand(parse(['threads', 'show', 'thread', '--home', '/unused']), api, { out: s => { out += s; }, err() {}, onInterrupt() {}, holding() {}, pollMs: 5, stopWaitMs: 100 });
  assert.equal(code, EXIT.OK); assert.match(out, /\[unknown\]/); assert.match(out, /unknown, checked by owner/); assert.match(out, /mail \/ send/);
});


test('threads show labels a changed turn as an earlier check and keeps the unknown exit', async () => {
  const turn = { id: 'turn', side: false, status: 'stopped', user: { text: 'Send', at: '', attachments: [] }, work: { harness: 'fake', startedAt: '', steps: [] }, effects: [], unknownOutcome: true,
    unknownCheckedCurrent: false, unknownChecked: { ...q, by: 'owner-id', byName: 'Alex', at: q.steps[0].at } };
  const api = { call: async () => ({ ok: true, value: { summary: { id: 'thread', title: 'Mail' }, turns: [turn] } }) } as unknown as Api;
  let out = '';
  const code = await runCommand(parse(['threads', 'show', 'thread', '--home', '/unused']), api, { out: s => { out += s; }, err() {}, onInterrupt() {}, holding() {}, pollMs: 5, stopWaitMs: 100 });
  assert.equal(code, EXIT.UNKNOWN); assert.match(out, /earlier check by Alex.*no longer applies/i);
  assert.doesNotMatch(out, /unknown, checked by/); assert.match(out, /Checker ID: owner-id/);
});

test('threads show uses the known checker name and leaves the id in detail', async () => {
  const turn = { id: 'turn', side: false, status: 'stopped', user: { text: 'Send', at: '', attachments: [] }, work: { harness: 'fake', startedAt: '', steps: [] }, effects: [], unknownOutcome: true,
    unknownCheckedCurrent: true, unknownChecked: { ...q, by: 'owner-id', byName: 'Alex', at: q.steps[0].at } };
  const api = { call: async () => ({ ok: true, value: { summary: { id: 'thread', title: 'Mail' }, turns: [turn] } }) } as unknown as Api;
  let out = '';
  await runCommand(parse(['threads', 'show', 'thread', '--home', '/unused']), api, { out: s => { out += s; }, err() {}, onInterrupt() {}, holding() {}, pollMs: 5, stopWaitMs: 100 });
  assert.match(out, /unknown, checked by Alex/); assert.doesNotMatch(out, /checked by owner-id/); assert.match(out, /Checker ID: owner-id/);
});

test('the checked command shows the known person name with the id in detail', async t => {
  const home = mkdtempSync(join(tmpdir(), 'checked-cli-name-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const line = await serveApiLine({ home,
    call: async () => ({ ok: true, value: { turns: [{ id: 'turn', unknownCheck: q }] } }) as never,
    unknownChecks: { question: async () => ({ ok: true, value: q }), check: async () => ({ ok: true, value: { ...q, by: 'owner-id', byName: 'Alex', at: q.steps[0].at } }) },
    confirm: async () => true,
  });
  t.after(() => line.close());
  const child = spawn(process.execPath, [join(import.meta.dirname, '../src/main.ts'), 'threads', 'checked', 'thread', '--turn', 'turn', '--home', home], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, EXIT.OK, err); assert.match(out, /unknown, checked by Alex/);
  assert.doesNotMatch(out, /checked by owner-id/); assert.match(out, /Checker ID: owner-id/);
});
