import { waitFor } from '../../../scripts/lib/test-hang.ts';
// Withdrawal must not interpret legacy read activity as a complete empty dependency set.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { MaterialEntry, Turn } from '../src/api.ts';
import { createMemory } from '../src/composition/memory.ts';
import { createParallelWork, type ParallelDeps, type StoredThread } from '../src/composition/parallel-work.ts';
import { ThreadJournal } from '../src/composition/thread-journal.ts';
import { replay } from '../src/composition/withdrawal.ts';
import { found } from '../src/memory/imports.ts';

const CANARY = 'synthetic source-derived answer';
const active: MaterialEntry = { id: 'active', projectId: 'p', name: 'active.md', class: 'original', hidden: false, mediaType: 'text/markdown', current: 1, versions: [{ n: 1, by: 'person', at: '2026-11-02', bytes: 1, sha256: 'fixture' }] };
const withdrawn: MaterialEntry = { ...active, id: 'gone', name: 'gone.md', hidden: true, withdrawals: [{ at: '2026-11-02', version: 1 }] };
const material = (entries: MaterialEntry[]) => ({ load: (id: string) => entries.find((e) => e.id === id) ?? null, list: () => entries });
const makeTurn = (reads: Turn['reads'], steps: Turn['work']['steps']): Turn => ({ id: 't', side: false, status: 'done', reads, user: { text: 'What have we got?', attachments: [], at: '2026-11-02' }, work: { startedAt: '2026-11-02', harness: 'controlled', steps }, answer: { text: CANARY, files: [] }, effects: [] });
const readStep = [{ kind: 'read' as const, label: 'Read gone.md v1' }];
const assistant = (turn: Turn, entries: MaterialEntry[]) => replay([turn], material(entries), 'p').history.filter((m) => m.role === 'assistant');

test('unbound read activity never revives a legacy answer after withdrawal or restoration', () => {
  const turn = makeTurn([], readStep);
  assert.equal(replay([turn], material([active]), 'p').unknown, true, 'before withdrawal its provenance must propagate as unknown');
  assert.deepEqual(assistant(turn, [active, withdrawn]), []);
  assert.deepEqual(assistant(turn, [active, { ...withdrawn, hidden: false, withdrawals: [{ ...withdrawn.withdrawals![0], restoredAt: '2026-11-03' }] }]), []);
});

test('inherited or told bindings do not account for fresh unbound read activity', () => {
  for (const provenance of [{ inherited: true }, { told: true }]) {
    const turn = makeTurn([{ id: active.id, name: active.name, version: 1, withdrawals: 0, ...provenance }], readStep);
    assert.deepEqual(assistant(turn, [active, withdrawn]), []);
  }
});

test('benign empty read sets and actual direct bindings keep their existing replay behavior', () => {
  const noReads = makeTurn([], [{ kind: 'note', label: 'Calculated without documents' }]);
  assert.equal(assistant(noReads, [withdrawn])[0].text, CANARY);
  const direct = makeTurn([{ id: active.id, name: active.name, version: 1, withdrawals: 0 }], [{ kind: 'read', label: 'Read active.md v1' }]);
  assert.equal(assistant(direct, [active, withdrawn])[0].text, CANARY, 'unrelated withdrawal does not invalidate known direct sources');
  assert.deepEqual(assistant(makeTurn(undefined, []), [withdrawn]), [], 'historical missing read sets retain the conservative fallback');
});

test('a merge turn keeps its answer: its sources are its plan\'s, checked against withdrawal there', () => {
  const merge = { ...makeTurn([], readStep), merge: { threadId: 'w', materialId: active.id, name: active.name, version: 1, receipts: [], reads: [] } } as unknown as Turn;
  assert.equal(assistant(merge, [active, withdrawn])[0].text, CANARY);
});

test('a stand-in harness binds each read, and saves it, before the text is handed over', async () => {
  const { runTurn } = await import('../src/stub/harness.ts');
  const order: string[] = [];
  const turn = makeTurn(undefined, []);
  turn.user.text = 'What does it say?';
  const material = { list: () => [active], bytes: () => new TextEncoder().encode('Fixture.'), load: () => active } as never;
  const gateway = { read: async () => { order.push(`read:${turn.reads?.length ?? 0}`); } } as never;
  await runTurn({ material, projectId: 'p', gateway, writeDelayMs: 0, signal: new AbortController().signal, progress: () => { order.push(`saved:${turn.reads?.length ?? 0}`); } }, turn, [active]);
  assert.deepEqual(order, ['saved:1', 'read:1'], 'on disk first, so a kill after the hand-over cannot lose it');
  assert.deepEqual(turn.reads, [{ id: active.id, name: active.name, version: 1, withdrawals: 0 }]);
});

// ---- Cold review of 9e10505: every path that carries a turn's words judges provenance as replay does.

const summary = (id: string) => ({ id, projectId: 'p', title: id, pinned: false, unread: false, archived: false, running: false, updatedAt: 'a' });
const settings = { model: 'stub', runsOn: 'here', permission: 'ask', mode: 'normal', effort: 3 } as never;
async function parallelUnit(t: TestContext, threads: StoredThread[], entries: MaterialEntry[]) {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'provenance-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const journal = new ThreadJournal(home);
  const map = new Map(threads.map((x) => [x.summary.id, x]));
  const work = createParallelWork({ home, journal, material: { ...material(entries), list: () => entries } as never, threads: map, running: new Map(), native: () => false, saveThread: async () => {},
    routeModel: () => 'stub', steers: () => false, link: async () => ({ createTask: async () => 'task' }) } as unknown as ParallelDeps);
  return { work, journal, threads: map };
}
const worker = (turns: Turn[]): StoredThread => ({ summary: summary('kid'), turns, sideTurns: [], clientKeys: [], child: { parentThreadId: 'top', role: 'worker', startedBy: 'person', settings, at: 'a', mandate: 'm', key: 'k' } });
const legacyChild = () => {
  const turn = makeTurn([], readStep);
  turn.id = 'legacy';
  turn.answer = { text: CANARY, files: [{ materialId: 'made', name: 'made.md', version: 1 }] };
  turn.effects = [{ key: 'e', kind: 'write-working-copy', target: 'made.md', outcome: 'DONE' }];
  return worker([turn]);
};
const made: MaterialEntry = { ...active, id: 'made', name: 'made.md', class: 'working', versions: [{ n: 1, by: 'agent', at: '2026-11-02', bytes: 1, sha256: 'fixture' }] };

test('a legacy child\'s answer is told as unknown provenance, held once anything is withdrawn, and its documents are not merged', async (t) => {
  const parentTurn = makeTurn([], []);
  parentTurn.status = 'running';
  const top: StoredThread = { summary: summary('top'), turns: [parentTurn], sideTurns: [], clientKeys: [] };
  const before = await parallelUnit(t, [top, legacyChild()], [active, made]);
  const told = before.work.tell(top, parentTurn);
  assert.match(told.text ?? '', new RegExp(CANARY), 'before any withdrawal its words may travel');
  const record = before.journal.read().filter((e) => e.kind === 'turn.told').at(-1) as { unknownSources?: true };
  assert.equal(record.unknownSources, true, 'but only with unknown provenance, which the parent then carries');
  assert.equal(before.work.projection(top).children?.[0]?.documents?.[0]?.state, 'blocked', 'its document is not brought back silently');

  const fresh = makeTurn([], []);
  fresh.status = 'running';
  const after = { ...top, turns: [fresh] };
  const withdrawnSince = await parallelUnit(t, [after, legacyChild()], [active, withdrawn, made]);
  assert.doesNotMatch(withdrawnSince.work.tell(after, fresh).text ?? '', new RegExp(CANARY), 'once anything is withdrawn it is held');
});

test('a fork keeps each read\'s binding, so an unrelated withdrawal does not hide the forked answer', async (t) => {
  const direct = makeTurn([{ id: active.id, name: active.name, version: 1, withdrawals: 0 }], [{ kind: 'read', label: 'Read active.md v1' }]);
  const source: StoredThread = { summary: summary('source'), turns: [direct], sideTurns: [], clientKeys: ['k'] };
  const { work, threads } = await parallelUnit(t, [source], [active, withdrawn]);
  const fork = await work.handlers['threads.fork']({ id: 'source', clientKey: 'f' });
  assert.ok(fork.ok);
  const forked = threads.get(fork.value.id)!;
  assert.equal(assistant(direct, [active, withdrawn])[0]?.text, CANARY);
  assert.equal(replay(forked.turns, material([active, withdrawn]), 'p').history.find((m) => m.role === 'assistant')?.text, CANARY);
});

for (const [name, turn] of [
  ['an unbound legacy turn', () => makeTurn([], readStep)],
  ['a turn marked unknownSources', () => ({ ...makeTurn([{ id: active.id, name: active.name, version: 1, withdrawals: 0 }], readStep), unknownSources: true as const })],
] as const) {
  test(`${name} seeds no skill, by hand or by itself`, async (t) => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const home = mkdtempSync(join(tmpdir(), 'provenance-skill-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const legacy: Turn = { ...turn(), id: 'legacy', effects: [{ key: 'e', kind: 'write-working-copy', target: 'brief.md', outcome: 'DONE' }], work: { startedAt: 'a', harness: 'pi', steps: [...readStep, { kind: 'list', label: 'Listed 1 file(s)' }, { kind: 'write', label: 'Write brief.md' }] } };
    const thread = { summary: summary('thread'), turns: [legacy], sideTurns: [], clientKeys: ['k'] } as unknown as StoredThread;
    const memory = createMemory({ home, userHome: join(home, 'user'), threads: new Map([['thread', thread]]), emit() {}, projectExists: () => true, credentials: async () => [], now: Date.now, material: material([active]) as never });
    const drafted = await memory.handlers['skills.draft']({ threadId: 'thread' });
    assert.equal(drafted.ok, false, 'drafting by hand is refused');
    await memory.learn(thread, legacy);
    assert.deepEqual(found(home, undefined).map((s) => s.name), [], 'and nothing drafted itself');
    // The same turn with its read bound drafts one, so the refusals above are provenance's.
    const bound: Turn = { ...legacy, reads: [{ id: active.id, name: active.name, version: 1, withdrawals: 0 }], unknownSources: undefined };
    thread.turns = [bound];
    await memory.learn(thread, bound);
    assert.equal(found(home, undefined).length, 1);
  });
}

test('a stand-in hands over no text when the read\'s binding cannot be saved', async () => {
  const { runTurn } = await import('../src/stub/harness.ts');
  const turn = makeTurn(undefined, []);
  turn.user.text = 'What does it say?';
  let handed = false;
  const store = { list: () => [active], bytes: () => new TextEncoder().encode('Fixture.'), load: () => active } as never;
  const gateway = { read: async () => { handed = true; } } as never;
  await assert.rejects(runTurn({ material: store, projectId: 'p', gateway, writeDelayMs: 0, signal: new AbortController().signal, progress: () => { throw new Error('disk full'); } }, turn, [active]));
  assert.equal(handed, false, 'the read is not handed over');
  assert.doesNotMatch(turn.answer?.text ?? '', /Fixture/, 'nor do its words reach an answer');
});

// ---- Cold review of a5fd244: words the host writes into a turn's own text carry their sources.

const goalThread = (turns: Turn[], reads: Turn['reads'] = []): StoredThread => ({ summary: summary('g'), turns, sideTurns: [], clientKeys: turns.map(() => 'k'), goal: { current: { text: 'Ship the plan', by: 'person', at: 'a', reads }, version: 1, proposals: [], history: [] } } as unknown as StoredThread);
async function goalRunUnit(t: TestContext, thread: StoredThread, entries: MaterialEntry[]) {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { createGoalRuns } = await import('../src/composition/goal-runs.ts');
  const home = mkdtempSync(join(tmpdir(), 'provenance-goal-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'goal-runs.json'), JSON.stringify({ g: { threadId: 'g', status: 'running', budget: 5, used: 1, phase: 'judge', startedAt: 'a', updatedAt: 'a' } }));
  const admitted: { text: string; turn: Turn }[] = [];
  const runs = createGoalRuns({ home, threads: new Map([['g', thread]]), closing: () => false, emit() {}, childrenRunning: () => false, material: material(entries) as never,
    admit: async (args, how) => { const turn = makeTurn([], []); how?.prepare?.(turn); admitted.push({ text: args.text, turn }); return { result: { ok: true, value: { threadId: 'g', turnId: turn.id } } } as never; } });
  runs.resume();
  // Resume may admit work or refuse it. Join the saved decision, not an event a refusal forbids.
  await waitFor(() => {
    const run = runs.view('g');
    return !!run && (run.status !== 'running' || run.phase === 'work');
  }, 'goal resume saves its admission decision', { diagnostic: () => JSON.stringify({ run: runs.view('g'), admitted: admitted.length }) });
  return { admitted, run: runs.view('g') };
}
const judgeTurn = (reads: Turn['reads']): Turn => ({ ...makeTurn(reads, [{ kind: 'read', label: 'Read it' }]), id: 'judge', judge: { verdict: 'not-met', detail: 'Obtain KESTREL approval' } });

test('a goal run does not write a withdrawn check\'s words into its next turn', async (t) => {
  const { admitted } = await goalRunUnit(t, goalThread([judgeTurn([{ id: withdrawn.id, name: withdrawn.name, version: 1, withdrawals: 0 }])]), [active, withdrawn]);
  assert.equal(admitted.length, 1, 'the run goes on');
  assert.doesNotMatch(admitted[0].text, /KESTREL/);
});

test('a goal run\'s next turn carries the sources of the words it was written from, and its text leaves history with them', async (t) => {
  const source = { id: active.id, name: active.name, version: 1, withdrawals: 0 };
  const { admitted } = await goalRunUnit(t, goalThread([judgeTurn([source])]), [active]);
  const { text, turn } = admitted[0];
  assert.match(text, /KESTREL/);
  assert.deepEqual(turn.textSources?.map((s) => s.id), [active.id]);
  assert.ok(turn.reads?.some((r) => r.id === active.id && r.told), 'they are what the turn was told, so the send-time gate checks them');
  turn.user.text = text;
  turn.answer = { text: 'Worked on it.', files: [] };
  const later = replay([turn], material([{ ...active, withdrawals: [{ at: 'b', version: 1 }] }]), 'p').history;
  assert.ok(!JSON.stringify(later).includes('KESTREL'), 'once withdrawn, the host-written words are not replayed');
});

test('a goal whose source was withdrawn starts no run turn and no scheduled turn', async (t) => {
  const goalSource = [{ id: withdrawn.id, name: withdrawn.name, version: 1, withdrawals: 0 }];
  const { admitted, run } = await goalRunUnit(t, goalThread([{ ...judgeTurn([]), judge: { verdict: 'not-met', detail: 'more' } }], goalSource), [active, withdrawn]);
  assert.equal(admitted.length, 0);
  assert.equal(run?.status, 'paused');
  assert.match(run?.detail ?? '', /withdrawn/);

  const { mkdtempSync, rmSync } = await import('node:fs');
  const { createProactivity } = await import('../src/composition/proactivity.ts');
  const home = mkdtempSync(join(tmpdir(), 'provenance-schedule-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sent: string[] = [];
  const thread = goalThread([], goalSource);
  const proactive = createProactivity({ home, threads: new Map([['g', thread]]), now: Date.now, tickMs: 60_000, readOnly: true, closing: () => false, projectExists: () => true, emit() {}, material: material([active, withdrawn]) as never,
    admit: async (args) => { sent.push(args.text); return { result: { ok: false, reason: 'NOT_AVAILABLE', detail: 'test', outcome: 'REFUSED' } } as never; } });
  const s = await proactive.handlers['schedules.create']({ projectId: 'p', threadId: 'g', text: '', when: 'every day at 9:00', settings: settings as never, clientKey: 'k' });
  assert.ok(s.ok);
  const ran = await proactive.handlers['schedules.run']({ id: s.value.id, clientKey: 'now' });
  assert.ok(ran.ok);
  assert.deepEqual(sent, [], 'nothing was admitted');
  assert.equal(ran.value.outcome, 'skipped');
  assert.match(ran.value.summary, /withdrawn/);
});
