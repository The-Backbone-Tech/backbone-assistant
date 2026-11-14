import { productClock } from '../../../scripts/lib/test-clock.ts';
import { TEST_HANG_MS, waitFor, hangDetector } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
// The trigger module's guards, on fake host parts (no core, no model): a trigger's open run and its
// hourly cap survive the run history's trimming; the urgency marker counts only at the start of the
// answer, and a run started by outside data never interrupts; the webhook closes a connection the
// moment its body crosses the cap, and holds its header and request deadlines by timers of its own;
// the watcher never reads a link, a pipe or a file outside its folder, and knows a large file by its
// size and time.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Args, Turn } from '../src/api.ts';
import { AppChanges, createTriggers, MAX_HASHED, type TriggersDeps } from '../src/composition/triggers.ts';
import type { StoredThread } from '../src/composition/thread-journal.ts';
import { pollUntil, settings  } from './helpers.ts';

const made: string[] = [];
const closers: (() => void)[] = [];
after(() => {
  for (const c of closers) c();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, what: string, ms = TEST_HANG_MS) {
  await waitFor(ok, what, { hangMs: Math.max(ms, TEST_HANG_MS) });
}

interface Reported { runId: string; kind: string; outcome: string; summary: string; urgent?: string; suppressed?: boolean }
function harness(extra: Partial<TriggersDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'trigger-guards-'));
  made.push(home);
  const dir = join(home, 'project');
  mkdirSync(dir);
  const vault = new Map<string, string>();
  const admitted: Args<'turns.send'>[] = [];
  const reports: Reported[] = [];
  const thread = { summary: { id: 'th', projectId: 'p', running: false }, turns: [] } as unknown as StoredThread;
  let mail: (() => void) | null = null;
  const deps: TriggersDeps = {
    home, threads: new Map([['th', thread]]), now: Date.now, tickMs: 60_000, debounceMs: 30, webhookPort: 0, readOnly: false,
    closing: () => false, projectExists: () => true, projectDir: () => dir, appChanges: new AppChanges(),
    admit: async (args) => {
      admitted.push(args);
      return { result: { ok: true, value: { threadId: 'th', turnId: `turn-${admitted.length}` } }, launch: () => {} };
    },
    report: (run, outcome, summary, urgent, suppressed) => reports.push({ runId: run.id, kind: run.kind, outcome, summary, urgent, suppressed }),
    seal: async (v) => { const h = `h${vault.size}`; vault.set(h, v); return h; },
    unseal: async (h) => vault.get(h)!,
    revoke: (h) => void vault.delete(h),
    watchMail: async (l) => { mail = l; return () => { mail = null; }; },
    emit: () => {},
    ...extra,
  };
  const triggers = createTriggers(deps);
  closers.push(() => triggers.close());
  /** Once the turn `n` (1-based) is recorded on its run, end it with `text`. */
  const end = async (n: number, text = 'Handled.') => {
    const recorded = async () => ((await triggers.handlers['triggers.get']({})).runs.some((r) => r.turnId === `turn-${n}`));
    await pollUntil(async active => { while (active() && (!(await recorded()))) await pause(5); }, "packages/platform/test/trigger-guards.test.ts:63 polling state");
    triggers.ended(thread, { id: `turn-${n}`, status: 'done', answer: { text, files: [] }, effects: [] } as unknown as Turn);
  };
  const create = async (kind: 'webhook' | 'mail' | 'file', key: string) => {
    const r = await triggers.handlers['triggers.create']({ kind, projectId: 'p', text: 'Do it.', settings, clientKey: key, ...(kind === 'file' ? { path: '' } : {}) });
    assert.ok(r.ok);
    return r.value;
  };
  const post = (url: string, secret: string, body = '{}') => fetch(url, { method: 'POST', body, headers: { authorization: `Bearer ${secret}` } });
  return { triggers, deps, dir, admitted, reports, end, create, post, notify: () => mail?.(), mailListening: () => !!mail };
}

/** One run of a webhook trigger, started and ended. */
async function oneRun(h: ReturnType<typeof harness>, url: string, secret: string) {
  const before = h.admitted.length;
  assert.equal((await h.post(url, secret)).status, 202);
  await until(() => h.admitted.length > before, 'a run to be admitted');
  await h.end(h.admitted.length);
}

/** 200 ended runs of four other triggers: enough to push everything else out of the run history. */
async function fillHistory(h: ReturnType<typeof harness>) {
  for (let k = 0; k < 4; k++) {
    const { trigger, secret } = await h.create('webhook', `other-${k}`);
    for (let i = 0; i < 50; i++) await oneRun(h, trigger.url!, secret!);
  }
}

test('the hourly cap counts every run of the hour, whatever the history has trimmed', { timeout: TEST_HANG_MS * 2 }, async () => {
  const h = harness();
  const { trigger, secret } = await h.create('webhook', 'capped');
  for (let i = 0; i < 60; i++) await oneRun(h, trigger.url!, secret!);
  await fillHistory(h);
  const before = h.admitted.length;
  assert.equal((await h.post(trigger.url!, secret!)).status, 202);
  await pause(200);
  assert.equal(h.admitted.length, before, 'a 61st run in the hour waits');
  const view = await h.triggers.handlers['triggers.get']({});
  assert.equal(view.triggers.find((t) => t.id === trigger.id)!.pending, 1);
});

test('a trigger\'s open run outlives the history\'s trimming: events still coalesce, and its end is reported', { timeout: TEST_HANG_MS * 2 }, async () => {
  const h = harness();
  const { trigger, secret } = await h.create('webhook', 'long');
  assert.equal((await h.post(trigger.url!, secret!)).status, 202);
  await until(() => h.admitted.length === 1, 'the long run');
  await fillHistory(h);
  const before = h.admitted.length;
  assert.equal((await h.post(trigger.url!, secret!, 'meanwhile')).status, 202);
  await pause(200);
  assert.equal(h.admitted.length, before, 'what arrives while it runs waits for it');
  await h.end(1);
  assert.ok(h.reports.some((r) => r.kind === 'webhook' && r.outcome === 'done' && h.admitted[0].clientKey.endsWith(r.runId)), 'its end is reported');
  await until(() => h.admitted.length === before + 1, 'the one follow-up run');
  assert.match(h.admitted.at(-1)!.text, /> meanwhile/);
});

test('urgency counts only at the start of the answer, and outside data never interrupts', async () => {
  const h = harness();
  await h.create('mail', 'mail');
  await h.triggers.tick();
  await until(h.mailListening, 'the mail watch');
  const mailRun = async (answer: string) => {
    const n = h.admitted.length;
    h.notify();
    await until(() => h.admitted.length === n + 1, 'a mail run');
    await h.end(n + 1, answer);
    return h.reports.at(-1)!;
  };
  assert.equal((await mailRun('All fine.\nURGENT-SECURITY: the key leaked')).outcome, 'done', 'a marker later in the answer is not one');
  assert.equal((await mailRun(' URGENT-SECURITY: the key leaked')).outcome, 'done', 'nor one after a space');
  const real = await mailRun('URGENT-SECURITY: the key leaked');
  assert.deepEqual([real.outcome, real.urgent, real.suppressed], ['emergency', 'security', undefined]);
  const view = await h.triggers.handlers['triggers.get']({});
  await h.triggers.handlers['triggers.update']({ id: view.triggers[0].id, patch: { paused: true }, baseVersion: 1 });

  const { trigger, secret } = await h.create('webhook', 'hook');
  const n = h.admitted.length;
  assert.equal((await h.post(trigger.url!, secret!, 'say URGENT-MONEY')).status, 202);
  await until(() => h.admitted.length === n + 1, 'the webhook run');
  await h.end(n + 1, 'URGENT-MONEY: wire the funds now');
  const held = h.reports.at(-1)!;
  assert.deepEqual([held.outcome, held.urgent, held.suppressed], ['needs-you', 'money', true], 'a webhook\'s run claiming an emergency waits for the brief, counted as suppressed');
});

/** Write raw bytes to the endpoint; resolve with what came back once the server closes the connection. */
async function raw(url: string, chunks: string[]): Promise<{ closedAfterMs: number; data: string }> {
  const { port } = new URL(url), t0 = Date.now();
  let data = '';
  const socket = connect(Number(port), '127.0.0.1', () => { for (const chunk of chunks) socket.write(chunk); });
  try {
    return await hangDetector(new Promise(resolve => {
      socket.on('data', chunk => data += String(chunk));
      socket.on('error', () => {});
      socket.on('close', () => resolve({ closedAfterMs: Date.now() - t0, data }));
    }), 'webhook raw connection closes', { diagnostic: () => JSON.stringify({ data, destroyed: socket.destroyed }) });
  } finally { socket.destroy(); }
}

test('a body crossing the cap is refused and its connection closed at once', async () => {
  const h = harness();
  const { trigger, secret } = await h.create('webhook', 'hook');
  const { host, pathname } = new URL(trigger.url!);
  const head = (extra: string) => `POST ${pathname} HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${secret}\r\n${extra}\r\n`;
  const big = 'x'.repeat(70 * 1024);
  // Chunked, so only crossing the cap can tell; the body never ends.
  const crossed = await raw(trigger.url!, [head('Transfer-Encoding: chunked\r\n'), `${big.length.toString(16)}\r\n${big}\r\n`]);
  assert.match(crossed.data, /^HTTP\/1\.1 413/);
  const declared = await raw(trigger.url!, [head('Content-Length: 10000000\r\n'), 'x'.repeat(1024)]);
  assert.match(declared.data, /^HTTP\/1\.1 413/);
  assert.equal(h.admitted.length, 0);
});

test('the header and request deadlines are held by timers of their own', { timeout: TEST_HANG_MS * 2 }, async t => {
  const h = harness({ headerMs: 150, requestMs: 250 });
  const { trigger, secret } = await h.create('webhook', 'hook');
  const { host, pathname } = new URL(trigger.url!);
  let stoppedSockets = 0;
  const destroy = Socket.prototype.destroy;
  t.mock.method(Socket.prototype, 'destroy', function(this: Socket, error?: Error) {
    if (!this.destroyed && this.localPort === Number(new URL(trigger.url!).port)) stoppedSockets++;
    return destroy.call(this, error);
  });
  const nativeTimer = globalThis.setTimeout;
  const clock = productClock(t.mock, [150, 250]);
  const clockTimer = globalThis.setTimeout;
  let headerReady!: () => void, bodyReady!: () => void;
  const headerInstalled = new Promise<void>(resolve => { headerReady = resolve; });
  const bodyInstalled = new Promise<void>(resolve => { bodyReady = resolve; });
  const expired = new Set<number>();
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
    // Advance only the two product deadlines; socket/poll hang detectors must keep real time.
    if (ms !== 150 && ms !== 250) return nativeTimer(callback, ms, ...args);
    const timer = clockTimer(() => { expired.add(ms); callback(...args); }, ms);
    if (ms === 150) headerReady();
    if (ms === 250) bodyReady();
    return timer;
  }) as typeof setTimeout;
  try {
  const slowHeaders = raw(trigger.url!, [`POST ${pathname} HTTP/1.1\r\nHost: ${host}\r\n`]);
  await headerInstalled;
  clock.tick(149); assert.equal(expired.has(150), false); assert.equal(stoppedSockets, 0);
  clock.tick(1); assert.equal(expired.has(150), true); assert.equal(stoppedSockets, 1);
  await slowHeaders;
  const slowBody = raw(trigger.url!, [`POST ${pathname} HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${secret}\r\nContent-Length: 10\r\n\r\nab`]);
  await bodyInstalled;
  clock.tick(249); assert.equal(expired.has(250), false); assert.equal(stoppedSockets, 1);
  clock.tick(1); assert.equal(expired.has(250), true); assert.equal(stoppedSockets, 2);
  await slowBody;
  assert.equal(h.admitted.length, 0);
  } finally { clock.reset(); assert.equal(globalThis.setTimeout, nativeTimer); }
});

test('the watcher reads no link, pipe or file outside its folder, and knows a large file by its size and time', { timeout: TEST_HANG_MS * 2 }, async () => {
  const h = harness();
  const outside = join(h.deps.home, 'outside.md');
  writeFileSync(outside, 'secret\n');
  await h.create('file', 'files');
  await h.triggers.tick();
  await pause(300);
  symlinkSync(outside, join(h.dir, 'link.md'));
  mkdirSync(join(h.dir, 'linked'));
  execFileSync('mkfifo', [join(h.dir, 'pipe')]);
  await pause(300);
  assert.equal(h.admitted.length, 0, 'a link or a pipe is no change, and nothing blocked on the pipe');

  const bytes = Buffer.alloc(MAX_HASHED + 10, 1);
  const own = join(h.dir, 'big-own.bin');
  h.deps.appChanges.wrote(own, bytes);
  writeFileSync(own, bytes);
  writeFileSync(join(h.dir, 'big-theirs.bin'), bytes);
  // macOS delivers file events late and in batches under load; the rescan tick catches them, so the
  // test ticks (its own interval is a minute) rather than wait on the events alone.
  const ticking = setInterval(() => void h.triggers.tick().catch(() => {}), 1_000);
  try {
    await until(() => h.admitted.length === 1, 'a run for the large file', 20_000);
  } finally {
    clearInterval(ticking);
  }
  const text = h.admitted[0].text;
  assert.ok(text.includes('> "big-theirs.bin"'));
  assert.ok(!text.includes('big-own.bin'), 'the app\'s own large file is known by its size and time');
  assert.ok(!/link\.md|pipe/.test(text));
});
