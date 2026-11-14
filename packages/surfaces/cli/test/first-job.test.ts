import { childHangTimer, observeChild } from '../../../../scripts/lib/test-child.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel } from '@backbone-next/platform/testing';

function run(home: string, args: string[], overrides: Record<string, string | undefined> = {}) {
  return new Promise<{ code: number | null; out: string; err: string }>(resolve => {
    const child = spawn(process.execPath, [new URL('../src/main.ts', import.meta.url).pathname, ...args], { env: { ...process.env, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: undefined, BACKBONE_CODEX_MODEL: undefined, BACKBONE_MODEL_ENDPOINT: undefined, BACKBONE_MODEL_ID: undefined, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer=childHangTimer(child,'first-job CLI command completion');
    let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
    child.on('close', code => {clearTimeout(timer);resolve({ code, out, err });});
  });
}

test('the guide path stores the shared engine/route, attaches, reads, saves and labels a revision', async t => {
  const home = freshDataHome('first-job'); t.after(() => removeDataHome(home));
  const source = mkdtempSync(join(tmpdir(), 'cli-source-')); t.after(() => rmSync(source, { recursive: true, force: true }));
  const file = join(source, 'sales.csv'); writeFileSync(file, 'region,revenue\nNorth,42\n');
  const server = await startScriptedModel(); t.after(() => server.close());
  const made = await run(home, ['projects', 'create', 'Sales']);
  assert.equal(made.code, 0, made.err);
  const [project] = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8'));
  assert.equal(made.out, `Created Sales (${project.id}).\n`);
  assert.deepEqual(readdirSync(join(home, 'projects')), [`sales-${project.id}`]);
  assert.deepEqual(readdirSync(join(home, 'projects', `sales-${project.id}`)), []);
  const selected = await run(home, ['engine', 'pi']); assert.equal(selected.code, 0, selected.err);
  assert.equal(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).harness, 'harness-pi');
  const route = await run(home, ['model', 'local', '--endpoint', server.url, '--model', server.model]); assert.equal(route.code, 0, route.err);
  const models = await run(home, ['models']); assert.match(models.out, /Engine: Pi/); assert.doesNotMatch(models.out, /Stub/);
  const doctor = await run(home, ['doctor']); assert.match(doctor.out, /engine: Pi/);
  const sent = await run(home, ['send', 'Write a summary document', '--attach', file, '--json']); assert.equal(sent.code, 0, sent.err);
  const turn = JSON.parse(sent.out); assert.equal(turn.user.attachments[0].name, 'sales.csv');
  const threads = JSON.parse((await run(home, ['threads', 'list', '--json'])).out);
  const opened = await run(home, ['files', 'read', 'brief.md', '--version', '1']); assert.match(opened.out, /North,42/);
  const edited = join(source, 'edited.md'); writeFileSync(edited, '# My summary\nNorth: 42\n');
  const saved = await run(home, ['files', 'save', 'brief.md', '--from', edited, '--base-version', '1']); assert.equal(saved.code, 0, saved.err);
  assert.match((await run(home, ['files'])).out, /accepted.*brief.md.*v2.*person/);
  const stale = await run(home, ['files', 'save', 'brief.md', '--base-version', '1']); assert.equal(stale.code, 1); assert.match(stale.err, /STALE_BASE/);
  const revised = await run(home, ['send', 'Write a shorter summary document', '--thread', threads[0].id]); assert.equal(revised.code, 0, revised.err);
  assert.match((await run(home, ['files'])).out, /working.*brief.md.*v3.*agent.*person saved v2/);
  const accepted = await run(home, ['files', 'save', 'brief.md', '--base-version', '3']); assert.equal(accepted.code, 0, accepted.err);
  assert.match((await run(home, ['files'])).out, /accepted.*brief.md.*v4.*person/);
  const override = await run(home, ['models'], { BACKBONE_HARNESS: 'stub' }); assert.match(override.out, /Stub/);
});

for (const finish of ['length', null] as const) test(`send exits nonzero and records an unfinished answer: ${finish}`, async t => {
  const home = freshDataHome('unfinished-answer'); t.after(() => removeDataHome(home));
  const server = await startScriptedModel('small', () => ({ text: 'North total: 8,', finish })); t.after(() => server.close());
  await run(home, ['projects', 'create', 'Sales']);
  const env = { BACKBONE_MODEL_ENDPOINT: server.url, BACKBONE_MODEL_ID: server.model };
  const sent = await run(home, ['send', 'Which region?', '--json'], env);
  assert.equal(sent.code, 7, sent.out + sent.err);
  const turn = JSON.parse(sent.out); assert.equal(turn.status, 'stopped'); assert.equal(turn.work.finishReason, finish ?? 'missing');
  assert.match(turn.answer.text, /North total: 8,/); assert.match(turn.answer.text, /cut off/i); assert.match(sent.err, /UNFINISHED/);
});

test('Stop from another terminal reports the stopped turn rather than an idle second stop', async t => {
  const home = freshDataHome('stop-record'); t.after(() => removeDataHome(home));
  const env = { BACKBONE_HARNESS: 'stub', BACKBONE_STUB_WRITE_DELAY_MS: '5000' };
  await run(home, ['projects', 'create', 'P'], env);
  const child = spawn(process.execPath, ['--import', new URL('./fixtures/hold-stub-write.ts',import.meta.url).href, new URL('../src/main.ts', import.meta.url).pathname, 'send', 'Write a summary document'], { env: { ...process.env, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
  const done = new Promise<number | null>(r => child.on('close', r));
  const output=observeChild(child,'CLI send before Stop');
  const timer=childHangTimer(child,'CLI send held until Stop');
  try {
    await output.waitForOutput(/^thread /m);
    const id = /^thread (\S+)/m.exec(out)?.[1]; assert.ok(id, out + err);
    const stopped = await run(home, ['stop', id, '--json'], env);
    const result = JSON.parse(stopped.out);
    assert.equal(result.stopped, true); assert.equal(result.status, 'stopped');
    assert.equal(stopped.code, result.unknown.length ? 4 : 0, stopped.out + stopped.err);
    assert.equal(await done, result.unknown.length ? 4 : 3);
  } finally {
    // Join our child before the earlier home-removal hook runs, including after a failed assertion.
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGINT');
    try {await done;} finally {clearTimeout(timer);}
  }
});
