import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { engineChoices, settingsCheck, setEngine } from '../src/composition/engine-settings.ts';
import { codexCheckAsync } from '../src/composition/doctor.ts';
import { assertHomeWriteAdmission } from '../src/composition/home-lock.ts';
import { freshHome, open } from './helpers.ts';
import { normaliseViewerPrefs } from '../src/api.ts';
import { document, systemFixture } from './policy-fixture.ts';

const signedIn = async () => ({ name: 'codex', status: 'ok' as const, detail: 'machine client sign-in (codex login status): signed in' });
const absent = async () => ({ name: 'codex', status: 'warn' as const, detail: 'machine client sign-in (codex login status): absent' });
const signedOut = async () => ({ name: 'codex', status: 'warn' as const, detail: 'machine client sign-in (codex login status): signed out' });

function pieces(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'engine-pieces-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const id of ['harness-pi', 'harness-codex', 'harness-acp']) mkdirSync(join(root, id));
  return (id: string) => join(root, id);
}

test('Settings lists every engine with whether it can run here and why not', async t => {
  const home = mkdtempSync(join(tmpdir(), 'engine-choices-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const pieceDir = pieces(t);
  const choices = await engineChoices(home, 'harness-pi', { fallback: 'harness-pi', env: {}, codex: absent, pieceDir });
  assert.equal(choices.running, 'harness-pi');
  assert.equal(choices.next, 'harness-pi');
  assert.equal(choices.environment, false);
  assert.deepEqual(choices.options.map(o => o.name), ['pi', 'codex', 'acp', 'stub']);
  const byName = Object.fromEntries(choices.options.map(o => [o.name, o]));
  assert.equal(byName.pi.state, 'available');
  assert.equal(byName.codex.state, 'unavailable');
  assert.match(byName.codex.reason!, /not installed/);
  assert.equal(byName.acp.state, 'unavailable');
  assert.match(byName.acp.reason!, /No agent is set up/);
  assert.equal(byName.stub.state, 'available');
  for (const option of choices.options) assert.doesNotMatch(`${option.label} ${option.about} ${option.reason ?? ''}`, /harness|home\b/i);

  assert.match((await engineChoices(home, 'harness-pi', { fallback: 'harness-pi', env: {}, codex: signedOut, pieceDir })).options[1].reason!, /not signed in/);
  assert.equal((await engineChoices(home, 'harness-pi', { fallback: 'harness-pi', env: {}, codex: signedIn, pieceDir })).options[1].state, 'available');
  // A piece missing from this installation is named, not hidden.
  const missing = await engineChoices(home, 'harness-pi', { fallback: 'harness-pi', env: {}, codex: signedIn, pieceDir: id => join(home, 'absent', id) });
  assert.equal(missing.options.length, 4);
  assert.match(missing.options[1].reason!, /not included/);

  // The saved choice is what the next start uses; the running engine stays as it is until then.
  assertHomeWriteAdmission(home);
  assert.ok((await setEngine(home, 'stub', () => {})).ok);
  const after = await engineChoices(home, 'harness-pi', { fallback: 'harness-pi', env: {}, codex: absent, pieceDir });
  assert.equal(after.running, 'harness-pi'); assert.equal(after.next, 'harness-stub');
  // An environment choice wins over the saved one, and Settings says so.
  const fixed = await engineChoices(home, 'harness-pi', { fallback: 'harness-pi', env: { BACKBONE_HARNESS: 'pi' }, codex: absent, pieceDir });
  // The saved choice and the engine the next start really uses are told apart.
  assert.equal(fixed.environment, true); assert.equal(fixed.stored, 'harness-stub'); assert.equal(fixed.next, 'harness-pi');
  assert.equal(after.stored, 'harness-stub');
  // A configured agent that is still blocked says why.
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ harness: 'harness-stub', harnesses: { 'harness-acp': { agent: 'example', command: '/bin/false' } } }));
  const acp = (await engineChoices(home, 'harness-pi', { fallback: 'harness-pi', env: {}, codex: absent, pieceDir })).options[2];
  assert.equal(acp.state, 'unavailable'); assert.ok(acp.reason && !/No agent is set up/.test(acp.reason));
});

test('a managed policy keeps its refused engines visible but not offered', async t => {
  systemFixture(t, document({ harnesses: ['harness-stub'] }));
  const home = mkdtempSync(join(tmpdir(), 'engine-choices-policy-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const choices = await engineChoices(home, 'harness-stub', { fallback: 'harness-stub', env: {}, codex: signedIn, pieceDir: pieces(t) });
  // A save the policy refuses before writing is a refusal with the policy's reason, not an uncertain outcome.
  assertHomeWriteAdmission(home);
  const refusedSave = await setEngine(home, 'pi', () => {});
  assert.equal(refusedSave.ok, false);
  if (!refusedSave.ok) { assert.equal(refusedSave.outcome, 'REFUSED'); assert.match(refusedSave.detail, /policy/i); }
  const states = Object.fromEntries(choices.options.map(o => [o.name, o.state]));
  assert.deepEqual(states, { pi: 'refused', codex: 'refused', acp: 'refused', stub: 'available' });
  assert.match(choices.options[0].reason!, /policy/);
});

test('the Host answers settings.engines.get for its owner without changing anything', async () => {
  const { host } = open(freshHome());
  const choices = await host.call('settings.engines.get', {});
  assert.equal(typeof choices.running, 'string');
  assert.deepEqual(choices.options.map(o => o.name), ['pi', 'codex', 'acp', 'stub']);
});

test('the last Settings section is kept only when it names a section', async () => {
  const { host } = open(freshHome());
  const prefs = await host.call('viewer.get', {});
  const kept = await host.call('viewer.put', { prefs: { ...prefs, settingsSection: 'backup' } });
  assert.equal(kept.settingsSection, 'backup');
  assert.equal((await host.call('viewer.get', {})).settingsSection, 'backup');
  const dropped = await host.call('viewer.put', { prefs: { ...prefs, settingsSection: 'not-a-section' as never } });
  assert.equal('settingsSection' in dropped, false);
  assert.equal('settingsSection' in await host.call('viewer.get', {}), false);
  assert.equal(normaliseViewerPrefs({ ...prefs, settingsSection: { nested: true } as never }).settingsSection, undefined);
});

test('the Settings engine check runs once at a time, is reused briefly and can be forced fresh', async () => {
  let runs = 0, release!: () => void;
  const probe = () => { runs++; return new Promise<{ name: string; status: 'ok'; detail: string }>(resolve => { release = () => resolve({ name: 'codex', status: 'ok', detail: 'signed in' }); }); };
  let now = 1_000;
  const check = settingsCheck(probe, 30_000, () => now);
  const first = check(), second = check(true);
  assert.equal(runs, 1, 'a second request while one runs joins it');
  release(); assert.deepEqual(await first, await second);
  await check(); assert.equal(runs, 1, 'reused for the Settings display');
  now += 30_001; const later = check(); assert.equal(runs, 2, 'expires'); release(); await later;
  const forced = check(true); assert.equal(runs, 3, 'Check again asks afresh'); release(); await forced;
});

test('the asynchronous Codex check leaves the event loop free while the client answers', async t => {
  const bin = mkdtempSync(join(tmpdir(), 'slow-codex-')); t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nsleep 1\necho "Logged in using ChatGPT"\n', { mode: 0o755 });
  const prior = process.env.PATH; process.env.PATH = `${bin}:${prior}`;
  try {
    let ticks = 0; const timer = setInterval(() => ticks++, 50);
    const result = await codexCheckAsync();
    clearInterval(timer);
    assert.equal(result.status, 'ok');
    assert.ok(ticks >= 5, `the loop ran ${ticks} times while the check waited`);
  } finally { process.env.PATH = prior; }
});

test('a sign-in check that ended with a process error is an error, whatever the client printed or returned', async () => {
  const { classifyCodex } = await import('../src/composition/doctor.ts');
  const timedOut = Object.assign(new Error('spawnSync codex ETIMEDOUT'), { code: 'ETIMEDOUT' });
  // A client can print its sign-in line, be stopped at the time limit and still exit zero: that is not evidence of sign-in.
  assert.equal(classifyCodex(timedOut, 0, 'Logged in using ChatGPT').detail, 'machine client sign-in (codex login status): error');
  assert.equal(classifyCodex(timedOut, 0, 'Logged in using ChatGPT').billing, undefined);
  assert.equal(classifyCodex(timedOut, null, '').status, 'warn');
  assert.equal(classifyCodex(undefined, 0, 'Logged in using ChatGPT').status, 'ok');
});
