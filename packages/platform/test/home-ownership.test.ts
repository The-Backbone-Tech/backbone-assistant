import { execFileSyncHang, TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// One host per data home, and opening is not resuming: a second opener is refused before any
// recovery runs, and an interrupted turn waits for an explicit step, so a read never starts a model call.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, unlinkSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { ownerSocket } from '../src/composition/home-owner.ts';
import { createHost, hostClosed, type Host } from '../src/composition/host.ts';
import { ownFolder } from '../src/doors/protocol.ts';
import { writePlaintextVault } from '../src/keys/vault.ts';
import { prepareDataHome } from '../src/testing/data-home.ts';
import { startScriptedModel, type ScriptedModel } from '../src/testing/scripted-model.ts';
import { freshHome, idle, settings, value } from './helpers.ts';

let model: ScriptedModel;
before(async () => {
  model = await startScriptedModel();
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  await model.close();
});

const script = join(import.meta.dirname, 'crash-turn.ts');
const sent = async (host: Host) => {
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  return value(await host.call('turns.send', { projectId: p.id, text: 'Draft a brief for the launch', attachments: [], settings, clientKey: 'k' }));
};
/** A turn a kill cut short at this point: the host is gone, and its thread still says running. */
async function killed(home: string, at: string) {
  const child = spawn(process.execPath, [script, home], { env: { ...process.env, BACKBONE_CRASH_AT: at, BACKBONE_HARNESS: 'harness-pi' }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; child.stdout.on('data', (d) => (out += d));
  await new Promise((resolve) => child.once('exit', resolve));
  return JSON.parse(out.trim().split('\n')[0]) as { threadId: string; projectId: string };
}
const shut = async (home: string, host: Host) => { host.close(); await hostClosed(home); };

test('a second opener in this process is refused, and the live turn is left alone', { timeout: TEST_HANG_MS }, async () => {
  const home = freshHome();
  const first = createHost({ home, writeDelayMs: 500 });
  const { threadId } = await sent(first);
  const second = createHost({ home });
  await assert.rejects(second.call('threads.list', {}), /in use by another host/);
  second.close();
  const turn = (await idle(first, threadId)).turns.at(-1)!;
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['DONE']);
  await shut(home, first);
});

test('a second opener in another process is refused with a clear error', { timeout: TEST_HANG_MS }, async () => {
  const home = freshHome();
  const first = createHost({ home });
  await first.call('projects.list', {});
  const said = execFileSync(process.execPath, [join(import.meta.dirname, 'second-opener.ts'), home], { encoding: 'utf8' });
  assert.match(said, /refused: This data folder is in use by another host/);
  await shut(home, first);
});

test('a closed home opens again at once', { timeout: TEST_HANG_MS }, async () => {
  const home = freshHome();
  const first = createHost({ home });
  await first.call('projects.list', {});
  first.close();
  const next = createHost({ home });
  assert.deepEqual(await next.call('projects.list', {}), []);
  await shut(home, next);
});

test('opening a home resumes nothing, until the explicit step', { timeout: TEST_HANG_MS }, async () => {
  const home = freshHome();
  const { threadId } = await killed(home, 'write.begun');
  const host = createHost({ home, harness: 'harness-pi' });
  await host.call('threads.list', {});
  await new Promise((r) => setTimeout(r, 300));
  const before = value(await host.call('threads.get', { id: threadId }));
  assert.equal(before.turns.at(-1)?.status, 'running', 'still as the kill left it');
  assert.equal(await host.resumeInterrupted(), 1);
  await new Promise((r) => setTimeout(r, 7_000));
  assert.notEqual((await idle(host, threadId)).turns.at(-1)?.status, 'running');
  assert.equal(await host.resumeInterrupted(), 0, 'once');
  await shut(home, host);
});

test('a read-only open settles nothing and refuses every change', { timeout: TEST_HANG_MS }, async () => {
  const home = freshHome();
  const { threadId, projectId } = await killed(home, 'write.begun');
  const host = createHost({ home, harness: 'harness-pi', readOnly: true });
  const stored = value(await host.call('threads.get', { id: threadId }));
  assert.equal(stored.turns.at(-1)?.status, 'running');
  assert.equal(await host.resumeInterrupted(), 0, 'a read-only host resumes nothing');
  const refused = await host.call('turns.send', { projectId, threadId, text: 'again', attachments: [], settings, clientKey: 'k2' });
  assert.equal(refused.ok, false);
  await shut(home, host);
  // It left the write for the next real open to settle.
  const next = createHost({ home, harness: 'harness-pi' });
  await next.call('threads.list', {});
  assert.equal(await next.resumeInterrupted(), 1);
  await new Promise((r) => setTimeout(r, 7_000));
  await idle(next, threadId);
  await shut(home, next);
});

test('a read-only open shows an interrupted save without settling it', { timeout: TEST_HANG_MS }, async () => {
  const home = freshHome();
  const first = createHost({ home });
  const p = value(await first.call('projects.create', { name: 'P', kind: 'folder' }));
  const entry = value(await first.call('material.attach', { projectId: p.id, name: 'note.md', base64: Buffer.from('one').toString('base64'), mediaType: 'text/markdown' }));
  await shut(home, first);
  // A kill between a Save's intent and its version.
  const intent = join(home, 'material', entry.id, 'intent.json');
  writeFileSync(intent, JSON.stringify({ version: entry.current + 1, at: '2026-11-02T00:00:00.000Z' }));
  const meta = readFileSync(join(home, 'material', entry.id, 'meta.json'), 'utf8');
  const host = createHost({ home, readOnly: true });
  const read = value(await host.call('material.read', { id: entry.id }));
  assert.equal(read.entry.interruptedSave?.version, entry.current + 1, 'the person still sees it');
  assert.equal((await host.call('material.list', { projectId: p.id }))[0].interruptedSave?.version, entry.current + 1);
  await shut(home, host);
  assert.ok(existsSync(intent), 'left for the next real open');
  assert.equal(readFileSync(join(home, 'material', entry.id, 'meta.json'), 'utf8'), meta);
});

test('a home too long for a socket is held in a folder only this user may enter', { timeout: TEST_HANG_MS }, async () => {
  const home = join(freshHome(), 'a'.repeat(100));
  mkdirSync(home);
  prepareDataHome(home);
  writePlaintextVault(home);
  const first = createHost({ home });
  await first.call('projects.list', {});
  const socket = ownerSocket(home);
  assert.ok(!dirname(socket).startsWith(home), 'outside the home, which has no room for it');
  assert.ok(ownFolder(socket), 'never a shared folder such as /tmp itself');
  assert.equal(statSync(socket).mode & 0o777, 0o600, 'as the door\'s and the api line\'s sockets beside it');
  const said = execFileSync(process.execPath, [join(import.meta.dirname, 'second-opener.ts'), home], { encoding: 'utf8' });
  assert.match(said, /refused: This data folder is in use by another host/);
  await shut(home, first);
});

test('a home reached through a link is the same home: its second opener is refused', { timeout: 240_000 }, async () => {
  // A long real path is held outside the home, a short link to it would be held inside: one home,
  // two spellings, and only one owner.
  const home = join(freshHome(), 'b'.repeat(100));
  mkdirSync(home);
  prepareDataHome(home);
  writePlaintextVault(home);
  const link = join(mkdtempSync(join(tmpdir(), 'ln-')), 'h');
  symlinkSync(home, link);
  const first = createHost({ home });
  try {
    await first.call('projects.list', {});
    assert.equal(ownerSocket(link), ownerSocket(home));
    // A second owner would hold on and never answer: bounded, so that fails rather than hangs.
    const said = execFileSyncHang(process.execPath, [join(import.meta.dirname, 'second-opener.ts'), link], { encoding: 'utf8', timeout: TEST_HANG_MS, killSignal: 'SIGTERM' });
    assert.match(said, /refused: This data folder is in use by another host/);
  } finally { await shut(home, first); }
});

test('a home whose owner folder is not this user\'s alone does not open', { timeout: TEST_HANG_MS }, async () => {
  const home = freshHome();
  const elsewhere = mkdtempSync(join(tmpdir(), 'elsewhere-'));
  symlinkSync(elsewhere, join(home, 'run'));
  const host = createHost({ home });
  await assert.rejects(host.call('projects.list', {}), /not this user's alone/);
  host.close();
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing was made where the link points');
});

test('a data home is entered only by its person\'s user, so projected documents stay private', { timeout: TEST_HANG_MS, skip: process.platform === 'win32' }, async () => {
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  chmodSync(home, 0o755);
  const host = createHost({ home });
  await host.call('projects.list', {});
  assert.equal(statSync(home).mode & 0o777, 0o700);
  await shut(home, host);
});

test('a data home that is a link makes the folder it points to private', { timeout: TEST_HANG_MS, skip: process.platform === 'win32' }, async () => {
  const target = freshHome();
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o755);
  const home = `${target}-link`;
  symlinkSync(target, home);
  const host = createHost({ home });
  await host.call('projects.list', {});
  assert.equal(statSync(target).mode & 0o777, 0o700);
  await shut(home, host);
  unlinkSync(home);
});

test('a data home loses an access list that let others read it (macOS)', { timeout: TEST_HANG_MS, skip: process.platform !== 'darwin' }, async () => {
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  execFileSync('/bin/chmod', ['+a', 'everyone allow list,search,read', home]);
  assert.match(execFileSync('/bin/ls', ['-led', home], { encoding: 'utf8' }), /^\s*0: /m, 'the synthetic access list is in place');
  const host = createHost({ home });
  await host.call('projects.list', {});
  assert.doesNotMatch(execFileSync('/bin/ls', ['-led', home], { encoding: 'utf8' }), /^\s*\d+: /m);
  await shut(home, host);
});
