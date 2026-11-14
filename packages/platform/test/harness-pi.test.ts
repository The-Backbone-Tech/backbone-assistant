// createHost on harness-pi, with the scripted model as its route: the J-01 core path through the
// real engine, Stop and crash during its write, route policy, and the credential canary.
// No network and no real key: every route here is the loopback. Canary values are random per run.
// Cites R-HARN-02, R-BASE-01, R-BASE-02, R-BASE-04, R-MODEL-02, R-MODEL-04, R-GOV-SECRET-01.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startScriptedModel, type ScriptedModel } from '../src/testing/scripted-model.ts';
import { b64, freshHome, idle, open, settings, value } from './helpers.ts';

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

const pi = (home?: string, extra: Parameters<typeof open>[1] = {}) => open(home, { harness: 'harness-pi', ...extra });
const XLSX = 'PK\u0003\u0004';

async function brief(ctx = pi()) {
  const { host } = ctx;
  const p = value(await host.call('projects.create', { name: 'Q4 review', kind: 'folder' }));
  const note = value(await host.call('material.attach', { projectId: p.id, name: 'note.md', base64: b64('# Revenue\nUp 4%.\n'), mediaType: 'text/markdown' }));
  const sheet = value(await host.call('material.attach', { projectId: p.id, name: 'data.xlsx', base64: b64(XLSX), mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Write an editable brief from these', attachments: [note.id, sheet.id], settings, clientKey: 'c1' }));
  return { ...ctx, p, sent, thread: await idle(host, sent.threadId) };
}

test('R-BASE-01, R-HARN-02, R-MODEL-04: Pi drafts brief.md through the gateway, and the turn names its engine, route and model', async () => {
  const { host, thread, p } = await brief();
  const turn = thread.turns[0];
  assert.equal(turn.status, 'done', turn.answer?.text ?? '');
  assert.match(turn.work.harness, /^Pi 1\.4\.0 · Local endpoint · scripted-model/);
  assert.deepEqual(turn.work.steps.map((s) => s.label), ['Read note.md v1', 'Read data.xlsx v1', 'Listed 2 file(s)', 'Write brief.md']);
  assert.equal(turn.effects.length, 1);
  assert.equal(turn.effects[0].outcome, 'DONE');
  assert.ok(turn.effects[0].key, 'the write is an effect the gateway carried');
  assert.equal(turn.answer?.files[0].name, 'brief.md');
  assert.match(turn.answer!.text, /brief\.md v1/);
  const entry = (await host.call('material.list', { projectId: p.id })).find((m) => m.name === 'brief.md')!;
  assert.deepEqual([entry.class, entry.versions[0].by], ['working', 'agent']);
  const text = value(await host.call('material.read', { id: entry.id })).text!;
  assert.match(text, /note\.md: # Revenue Up 4%\./);
  assert.ok(thread.card.changes.added > 0);
  assert.deepEqual(thread.card.sources.map((s) => s.name), ['note.md', 'data.xlsx']);
});

test('R-BASE-02: on Pi, a follow-up reads the version the person saved', async () => {
  const { host, thread, p } = await brief();
  const entry = (await host.call('material.list', { projectId: p.id })).find((m) => m.name === 'brief.md')!;
  value(await host.call('material.save', { id: entry.id, text: '# Brief\n\nPerson wording: we ship on Friday.\n', baseVersion: 1 }));
  value(await host.call('turns.send', { threadId: thread.summary.id, projectId: p.id, text: 'What does the brief say now?', attachments: [], settings, clientKey: 'c2' }));
  const last = (await idle(host, thread.summary.id)).turns.at(-1)!;
  assert.equal(last.status, 'done');
  assert.match(last.answer!.text, /brief\.md v2 \(recorded version\)/);
  assert.match(last.answer!.text, /we ship on Friday/);
  assert.equal(last.effects.length, 0);
});

test('R-BASE-04, J-01 A2: on Pi, Stop during a write records UNKNOWN, and the exact copy is not resent', async () => {
  let inWrite = () => {};
  const begun = new Promise<void>((resolve) => { inWrite = resolve; });
  const { host } = pi(undefined, { writeDelayMs: 1500, atPoint: (point) => { if (point === 'write.begun') inWrite(); } });
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Draft a brief for the launch', attachments: [], settings, clientKey: 'a' }));
  await begun; // Stop inside the write: earlier than this is a clean cancel, correctly REFUSED.
  value(await host.call('turns.stop', { threadId: sent.threadId }));
  const t = await idle(host, sent.threadId);
  assert.equal(t.turns[0].status, 'stopped');
  assert.equal(t.turns[0].effects[0].outcome, 'UNKNOWN');
  assert.match(t.turns[0].effects[0].detail ?? '', /will not be resent/);
  value(await host.call('turns.send', { threadId: sent.threadId, projectId: p.id, text: 'Draft a brief for the launch', attachments: [], settings, clientKey: 'b' }));
  const again = (await idle(host, sent.threadId)).turns[1];
  assert.equal(again.effects[0].outcome, 'REFUSED');
  assert.match(again.effects[0].detail ?? '', /is not resent/);
  assert.equal((await host.call('material.list', { projectId: p.id })).length, 0, 'nothing was written');
});

test('R-BASE-04: a kill during the dispatch of a Pi write leaves it UNKNOWN on restart, and it is not resent', async () => {
  const home = freshHome();
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-turn.ts'), home], {
    env: { ...process.env, BACKBONE_HARNESS: 'harness-pi', BACKBONE_CRASH_AT: 'write.begun' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b: Buffer) => (out += b.toString()));
  const code = await new Promise<number | string | null>((r) => child.on('exit', (c, s) => r(c ?? s)));
  assert.equal(code, 'SIGKILL', out);
  const { threadId } = JSON.parse(out.trim().split('\n').at(-1)!) as { threadId: string; projectId: string };
  const { host } = pi(home);
  await new Promise((r) => setTimeout(r, 7000)); // the dead run's lease lapses, then the turn resumes
  const t = await idle(host, threadId);
  const turn = t.turns[0];
  assert.equal(turn.status, 'stopped');
  assert.equal(turn.effects[0].outcome, 'UNKNOWN');
  assert.match(turn.effects[0].detail ?? '', /will not be resent/);
  assert.equal((await host.call('material.list', { projectId: t.summary.projectId })).filter((m) => m.name === 'brief.md').length, 0, 'never written twice, nor once by a replay');
});

test('R-MODEL-02: with no route set, a turn is refused with what to do, and nothing reaches a model', async () => {
  const saved = process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  try {
    const { host } = pi();
    const before = model.requests.length;
    const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
    const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Hello', attachments: [], settings, clientKey: 'x' }));
    const turn = (await idle(host, sent.threadId)).turns[0];
    assert.equal(turn.status, 'refused');
    assert.equal(turn.refusal?.reason, 'NOT_AVAILABLE');
    assert.match(turn.answer!.text, /Settings/);
    assert.equal(model.requests.length, before);
    const s = await host.call('settings.model.get', {});
    assert.equal(s.active, null);
    assert.match(s.hint ?? '', /paste your own/);
  } finally {
    process.env.BACKBONE_MODEL_ENDPOINT = saved ?? model.url;
  }
});

test('R-MODEL-02: the person’s own key comes before a gateway; clearing it moves to the gateway; there is no silent fallback', async () => {
  const { host } = pi();
  value(await host.call('settings.model.put', { change: { route: 'gateway', provider: 'vercel', key: `canary-${randomUUID()}` } }));
  let s = await host.call('settings.model.get', {});
  assert.match(s.active?.label ?? '', /^Vercel AI Gateway · anthropic\/claude-sonnet-5\.5/);
  value(await host.call('settings.model.put', { change: { route: 'own', provider: 'anthropic', key: `canary-${randomUUID()}` } }));
  s = await host.call('settings.model.get', {});
  assert.equal(s.active?.kind, 'own');
  assert.match(s.active?.label ?? '', /Anthropic API \(your key\) · claude-sonnet-5-5 · billed by Anthropic/);
  value(await host.call('settings.model.put', { change: { route: 'own', clear: true } }));
  s = await host.call('settings.model.get', {});
  assert.equal(s.active?.kind, 'gateway');
  assert.equal(s.own, null);
  const bad = await host.call('settings.model.put', { change: { route: 'own', provider: 'openai-compatible', model: 'm', baseUrl: 'http://example.com/v1', key: 'k' } });
  assert.equal(bad.ok, false, 'a plain-http endpoint off this computer is refused');
  const none = await host.call('settings.model.put', { change: { route: 'own', provider: 'openai', model: 'gpt-5.5' } });
  assert.equal(none.ok, false, 'a route needs a key');
});

test('R-MODEL-02: a loopback endpoint is the only one taken from the environment', async () => {
  const saved = process.env.BACKBONE_MODEL_ENDPOINT;
  process.env.BACKBONE_MODEL_ENDPOINT = 'https://attacker.example/v1';
  try {
    const { host } = pi();
    assert.equal((await host.call('settings.model.get', {})).active, null);
  } finally {
    process.env.BACKBONE_MODEL_ENDPOINT = saved ?? model.url;
  }
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isSocket()) return []; // The owner's socket holds no bytes.
    return stat.isDirectory() ? filesUnder(full) : [full];
  });
}

test('R-GOV-SECRET-01: a canary key reaches only the request header: never the model, the thread, the core or a log', async () => {
  const canary = `canary-${randomUUID()}`;
  const logged: string[] = [];
  const write = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  process.stdout.write = ((c: string | Uint8Array, ...r: never[]) => (logged.push(String(c)), write.out(c, ...r))) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array, ...r: never[]) => (logged.push(String(c)), write.err(c, ...r))) as typeof process.stderr.write;
  const ctx = pi();
  try {
    const put = value(await ctx.host.call('settings.model.put', { change: { route: 'own', provider: 'openai-compatible', model: model.model, baseUrl: model.url, key: canary } }));
    assert.equal(JSON.stringify(put).includes(canary), false, 'the settings never read a key back');
    assert.equal(put.own?.keySet, true);
    const from = model.requests.length;
    const { thread } = await brief(ctx);
    assert.equal(thread.turns[0].status, 'done', thread.turns[0].answer?.text ?? '');
    assert.match(thread.turns[0].work.harness, /OpenAI-compatible endpoint \(your key\)/);
    const sent = model.requests.slice(from);
    assert.ok(sent.length > 0);
    assert.ok(sent.every((r) => r.headers.authorization === `Bearer ${canary}`));
    assert.ok(sent.every((r) => !r.body.includes(canary)), 'never in what the model is sent');
    assert.equal(JSON.stringify(thread).includes(canary), false);
  } finally {
    process.stdout.write = write.out;
    process.stderr.write = write.err;
  }
  assert.equal(logged.join('').includes(canary), false, 'never in a log');
  // Nothing under the home holds the value in the clear: not the threads, the route settings, the
  // sealed record, or the core's database files.
  const hits = filesUnder(ctx.home).filter((f) => readFileSync(f).includes(canary));
  assert.deepEqual(hits, []);
});

test('an agent cannot replace a project file the store has never seen', async () => {
  const { host, home } = pi();
  const p = value(await host.call('projects.create', { name: 'Hand-kept', kind: 'folder' }));
  const path = join(home, 'projects', readdirSync(join(home, 'projects'))[0], 'brief.md');
  writeFileSync(path, 'Hand-written brief.\n');
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Write an editable brief', attachments: [], settings, clientKey: 'c1' }));
  const turn = (await idle(host, sent.threadId)).turns[0];
  assert.equal(readFileSync(path, 'utf8'), 'Hand-written brief.\n');
  assert.equal(turn.effects[0].outcome, 'REFUSED');
});
