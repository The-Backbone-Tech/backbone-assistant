// backbone chat against a stand-in api: each line is sent in the current thread, the session carries
// its thread and settings between messages, slash commands go through the ordinary commands, and
// Ctrl-C stops only the turn in hand.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Thread, Turn } from '@backbone-next/platform';
import { runChat } from '../src/chat.ts';
import { EXIT, parse, type Api, type Io } from '../src/commands.ts';

const turnOf = (id: string, text: string, status: Turn['status'] = 'done'): Turn => ({
  id, side: false, user: { text, attachments: [], at: '2026-11-01T00:00:00.000Z' },
  work: { startedAt: '2026-11-01T00:00:00.000Z', steps: [], harness: 'fake' }, effects: [], status,
  answer: status === 'done' ? { text: `answer to ${text}`, files: [] } : undefined,
});

function session(lines: string[], hold?: { line: string }) {
  const sends: { threadId?: string; text: string; settings: { effort: number; permission: string } }[] = [];
  const stops: string[] = [];
  const threads = new Map<string, Thread>();
  let n = 0;
  const api = {
    async call(method: string, args: Record<string, unknown>) {
      if (method === 'projects.list') return [{ id: 'p1', name: 'One', kind: 'folder', createdAt: '' }];
      if (method === 'models.list') return [{ id: 'm', label: 'm', efforts: [3] }];
      if (method === 'turns.send') {
        sends.push(args as never);
        const id = (args.threadId as string | undefined) ?? `th${++n}`;
        const running = hold?.line === args.text;
        const t = threads.get(id) ?? { summary: { id, projectId: 'p1', title: '', pinned: false, unread: false, archived: false, running: false, updatedAt: '' }, turns: [], sideTurns: [], card: { project: 'One', changes: { added: 0, removed: 0, files: 0 }, subagents: { active: 0, done: 0 }, sources: [] } } as Thread;
        const turn = turnOf(`t${sends.length}`, args.text as string, running ? 'running' : 'done');
        t.turns.push(turn);
        t.summary.running = running;
        threads.set(id, t);
        return { ok: true, value: { threadId: id, turnId: turn.id } };
      }
      if (method === 'turns.stop') {
        stops.push(args.threadId as string);
        const t = threads.get(args.threadId as string)!;
        const last = t.turns.at(-1)!;
        Object.assign(last, { status: 'stopped' });
        t.summary.running = false;
        return { ok: true, value: { stopped: true } };
      }
      if (method === 'threads.get') { const t = threads.get(args.id as string); return t ? { ok: true, value: t } : { ok: false, reason: 'NOT_FOUND', detail: 'No such thread.', outcome: 'REFUSED' }; }
      throw new Error(`no answer for ${method}`);
    },
  } as unknown as Api;
  const out = { text: '', err: '' };
  let interrupt: (() => void) | undefined;
  const io: Io = { out: (t) => void (out.text += `${t}\n`), err: (t) => void (out.err += `${t}\n`), onInterrupt: (fn) => void (interrupt = fn), holding: () => {}, pollMs: 1, stopWaitMs: 200 };
  const queue = [...lines];
  const prompts: string[] = [];
  const statuses: string[] = [];
  const prompt = { status: (t: string) => void statuses.push(t), ask: async (p: string) => { prompts.push(p); if (hold && queue[0] === '<ctrl-c>') { queue.shift(); setTimeout(() => interrupt?.(), 5); } return queue.length ? queue.shift()! : null; } };
  return { api, io, prompt, sends, stops, out, prompts, statuses, interrupt: () => interrupt?.() };
}

test('lines are sent in one thread, settings carry between them, /new starts another, and /quit leaves', async () => {
  const s = session(['hello', '/effort 4', '/permission full', 'again', '/show', '/new', 'fresh start', '/quit', 'never sent']);
  const code = await runChat(parse(['chat', '--home', '/nowhere']), s.api, s.io, s.prompt);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(s.sends.map((x) => [x.threadId ?? null, x.text, x.settings.effort, x.settings.permission]), [
    [null, 'hello', 3, 'ask'],
    ['th1', 'again', 4, 'full'],
    [null, 'fresh start', 4, 'full'],
  ]);
  assert.match(s.out.text, /answer to hello[\s\S]*answer to again/);
  assert.deepEqual(s.prompts.slice(0, 2), ['new> ', 'th1> '], 'the prompt names the thread once there is one');
  assert.equal(s.prompts.at(-1), 'th2> ');
  assert.match(s.statuses[0], /new thread · m|new thread · default model/);
  assert.match(s.statuses.find((x) => x.includes('effort 4 · full'))!, /thread th1/, 'the header follows the thread and its settings');
});

test('a command it does not know, or a bad setting, is said and nothing is sent; end of input leaves', async () => {
  const s = session(['/frobnicate', '/effort 9', '/permission root', '/goal', '/thread nope']);
  assert.equal(await runChat(parse(['chat', '--home', '/nowhere']), s.api, s.io, s.prompt), EXIT.OK);
  assert.equal(s.sends.length, 0);
  assert.match(s.out.err, /No command \/frobnicate/);
  assert.match(s.out.err, /\/effort takes 1 to 5/);
  assert.match(s.out.err, /\/permission takes ask, auto-review, full/);
  assert.match(s.out.err, /\/goal needs/);
  assert.match(s.out.err, /No such thread/);
  assert.equal(s.prompts.at(-1), 'new> ', 'a thread that is not there is not taken on');
});

test('Ctrl-C while a turn runs stops that turn, and the session goes on', async () => {
  const s = session(['work slowly', '<ctrl-c>', 'next'], { line: 'work slowly' });
  // The interrupt is fired while the first send follows its turn.
  setTimeout(() => s.interrupt(), 20);
  assert.equal(await runChat(parse(['chat', '--home', '/nowhere']), s.api, s.io, s.prompt), EXIT.OK);
  assert.deepEqual(s.stops, ['th1']);
  assert.match(s.out.err, /STOPPED/);
  assert.deepEqual(s.sends.map((x) => x.text), ['work slowly', 'next']);
});
