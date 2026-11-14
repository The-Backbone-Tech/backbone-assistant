// The full-screen chat's side pane: the project's files, a document at a version, and the diff a
// turn produced, through files.list, material.read and changes.get and nothing else. First against a
// stand-in api with a scripted turn that writes a document, then the real host on a test home, and
// last the session drawn on a terminal at a wide and a narrow width.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Thread, Turn } from '@backbone-next/platform';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { runChat, type ChatKey, type Prompt } from '../src/chat.ts';
import { EXIT, parse, type Api, type Io } from '../src/commands.ts';
import { fullScreen, type PaneView } from '../src/screen.ts';
import { withHome } from '../src/session.ts';
import { Terminal } from './terminal.ts';

const PATCH = '--- a/brief.md\n+++ b/brief.md\n@@ -1,2 +1,2 @@\n # Brief\n-Request: first\n+Request: second\n';

/** A home with one project and one document, brief.md, which each "write" line makes a new version of. */
function standIn() {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const thread: Thread = { summary: { id: 'th1', projectId: 'p1', title: '', pinned: false, unread: false, archived: false, running: false, updatedAt: '' }, turns: [], sideTurns: [], card: { project: 'One', changes: { added: 0, removed: 0, files: 0 }, subagents: { active: 0, done: 0 }, sources: [] } } as Thread;
  let version = 1;
  const api = {
    async call(method: string, args: Record<string, unknown>) {
      calls.push({ method, args });
      if (method === 'projects.list') return [{ id: 'p1', name: 'One', kind: 'folder', createdAt: '' }];
      if (method === 'models.list') return [{ id: 'm', label: 'm', efforts: [3] }];
      if (method === 'turns.send') {
        const writes = /write/.test(args.text as string);
        if (writes) version += 1;
        const turn: Turn = {
          id: `t${thread.turns.length + 1}`, side: false, user: { text: args.text as string, attachments: [], at: '' },
          work: { startedAt: '', steps: [], harness: 'fake' }, status: 'done',
          effects: writes ? [{ key: 'k', kind: 'write-working-copy', target: 'brief.md', outcome: 'DONE', materialId: 'm-brief', version }] : [],
          answer: { text: writes ? `I drafted brief.md v${version}.` : 'Nothing to write.', files: [{ materialId: 'm-brief', name: 'brief.md', version }] },
        };
        thread.turns.push(turn);
        return { ok: true, value: { threadId: 'th1', turnId: turn.id } };
      }
      if (method === 'threads.get') return { ok: true, value: structuredClone(thread) };
      if (method === 'files.list') return [{ path: 'brief.md', group: 'documents', class: 'working', materialId: 'm-brief' }, { path: 'notes.txt', group: 'files', class: 'original', materialId: 'm-notes' }];
      if (method === 'material.read') {
        if (args.id !== 'm-brief' && args.id !== 'm-notes') return { ok: false, reason: 'NOT_FOUND', detail: 'No such material.', outcome: 'REFUSED' };
        const v = (args.version as number | undefined) ?? version;
        return { ok: true, value: { entry: { id: args.id, name: args.id === 'm-brief' ? 'brief.md' : 'notes.txt', current: version }, text: `# Brief\nRequest: v${v}\n` } };
      }
      if (method === 'changes.get') return { ok: true, value: { scope: 'last-turn', base: `v${(args.version as { version: number }).version - 1}`, bases: [], files: [{ path: 'brief.md', added: 1, removed: 1, patch: PATCH }] } };
      throw new Error(`no answer for ${method}`);
    },
  } as unknown as Api;
  return { api, calls };
}

interface Seen { out: string; err: string; views: (PaneView | null)[] }
/** A full-screen prompt without the terminal: lines and keys in order, and what the pane was given. */
function prompted(script: (string | { key: ChatKey })[], seen: Seen, withPane = true): Prompt {
  let onKey: ((key: ChatKey) => Promise<void>) | undefined;
  const queue = [...script];
  return {
    ...(withPane ? { pane: { show: (v: PaneView) => void seen.views.push(v), close: () => void seen.views.push(null) } } : {}),
    onKey: (fn) => void (onKey = fn),
    ask: async () => {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) return null;
        if (typeof next === 'string') return next;
        await onKey?.(next.key);
      }
    },
  };
}
const ioFor = (seen: Seen): Io => ({ out: (t) => void (seen.out += `${t}\n`), err: (t) => void (seen.err += `${t}\n`), onInterrupt: () => {}, holding: () => {}, pollMs: 1, stopWaitMs: 200 });
const text = (v: PaneView | null | undefined) => (v ? [v.title, ...v.lines.map((l) => l.text)].join('\n') : '');

test('/files opens the pane on the project\'s files, through files.list alone', async () => {
  const { api, calls } = standIn();
  const seen: Seen = { out: '', err: '', views: [] };
  assert.equal(await runChat(parse(['chat', '--home', '/nowhere']), api, ioFor(seen), prompted(['/files', { key: 'close' }], seen)), EXIT.OK);
  assert.match(text(seen.views[0]), /Files · One[\s\S]*working +brief\.md[\s\S]*original +notes\.txt/);
  assert.equal(seen.views[1], null, 'Esc closes it');
  assert.deepEqual([...new Set(calls.map((c) => c.method))], ['projects.list', 'files.list']);
  assert.doesNotMatch(seen.out, /brief\.md/, 'the list is in the pane, not the transcript');
});

test('a turn that writes a document shows its version in the transcript, and one key opens that version\'s diff', async () => {
  const { api, calls } = standIn();
  const seen: Seen = { out: '', err: '', views: [] };
  const script = ['please write the brief', { key: 'diff' as const }, '/open brief.md v1', '/diff brief.md v2', '/close'];
  assert.equal(await runChat(parse(['chat', '--home', '/nowhere']), api, ioFor(seen), prompted(script, seen)), EXIT.OK);
  assert.match(seen.out, /wrote brief\.md v2 · Ctrl-O shows the diff/);
  assert.match(text(seen.views[0]), /Diff · brief\.md v2 against v1[\s\S]*-Request: first\n\+Request: second/);
  assert.deepEqual(seen.views[0]!.lines.find((l) => l.text === '+Request: second')?.style, 'add');
  assert.deepEqual(seen.views[0]!.lines.find((l) => l.text === '-Request: first')?.style, 'remove');
  const diffs = calls.filter((c) => c.method === 'changes.get').map((c) => c.args);
  assert.deepEqual(diffs[0], { projectId: 'p1', threadId: 'th1', scope: 'last-turn', version: { materialId: 'm-brief', version: 2 } });
  assert.match(text(seen.views[1]), /^brief\.md v1 \(current v2\)\n# Brief\nRequest: v1/);
  assert.deepEqual(calls.find((c) => c.method === 'material.read')?.args, { id: 'm-brief', version: 1 });
  assert.match(text(seen.views[2]), /Diff · brief\.md v2/);
  assert.equal(seen.views.at(-1), null, '/close closes it');
  const methods = new Set(calls.map((c) => c.method));
  assert.deepEqual([...methods].sort(), ['changes.get', 'files.list', 'material.read', 'models.list', 'projects.list', 'threads.get', 'turns.send'], 'nothing beyond the reads and the send');
});

test('a read the platform refuses, as the app\'s line does for these, is said in the pane and nothing else is tried', async () => {
  const { api } = standIn();
  const refusing = { call: (method: string, args: never) => (method === 'material.read' || method === 'changes.get' ? Promise.resolve({ ok: false, reason: 'NOT_AVAILABLE', detail: 'That is not on the line to the app, so nothing was done. Use the app for it.', outcome: 'REFUSED' }) : api.call(method as never, args)) } as unknown as Api;
  const seen: Seen = { out: '', err: '', views: [] };
  await runChat(parse(['chat', '--home', '/nowhere']), refusing, ioFor(seen), prompted(['write it', { key: 'diff' }, '/open notes.txt', '/open nothing.md'], seen));
  assert.match(text(seen.views[0]), /REFUSED \(NOT_AVAILABLE\): That is not on the line/);
  assert.equal(seen.views[0]!.lines.at(-1)?.style, 'error');
  assert.match(text(seen.views[1]), /REFUSED \(NOT_AVAILABLE\)/);
  assert.match(text(seen.views[2]), /No file nothing\.md in One/);
});

test('without a pane (piped input) /files prints as it did, and a turn adds no line of its own', async () => {
  const { api } = standIn();
  const seen: Seen = { out: '', err: '', views: [] };
  await runChat(parse(['chat', '--home', '/nowhere']), api, ioFor(seen), prompted(['/files', 'write it'], seen, false));
  assert.equal(seen.views.length, 0);
  assert.match(seen.out, /^working  brief\.md\noriginal notes\.txt$/m);
  assert.doesNotMatch(seen.out, /wrote brief\.md|Ctrl-O/);
});

// The real platform on a test home, in this process: the stub engine writes brief.md twice.
const homes: string[] = [];
after(async () => { for (const h of homes) await removeDataHome(h); });

test('on a real home, the second write\'s diff is the platform\'s v1-to-v2 patch, and its v1 reads as it was', async () => {
  process.env.BACKBONE_KEYS = 'plaintext';
  process.env.BACKBONE_HARNESS = 'stub';
  const home = freshDataHome('cli-panes');
  homes.push(home);
  const seen: Seen = { out: '', err: '', views: [] };
  const code = await withHome(home, 'chat', async (api) => {
    await api.call('projects.create', { name: 'Demo', kind: 'folder' });
    return runChat(parse(['chat', '--home', home]), api, ioFor(seen), prompted(['Write a brief about the quarter', 'Write a brief about the year', { key: 'diff' }, '/open brief.md v1', '/files'], seen));
  }, { create: true, resume: true });
  assert.equal(code, EXIT.OK, seen.err);
  assert.match(seen.out, /wrote brief\.md v1 ·[\s\S]*wrote brief\.md v2 ·/);
  const diff = text(seen.views[0]);
  assert.match(diff, /Diff · brief\.md v2 against v1/);
  assert.match(diff, /^-Request: Write a brief about the quarter$/m);
  assert.match(diff, /^\+Request: Write a brief about the year$/m);
  assert.match(diff, /^ # Brief$/m, 'unchanged lines as context');
  assert.match(text(seen.views[1]), /^brief\.md v1 \(current v2\)\n# Brief[\s\S]*Request: Write a brief about the quarter/);
  assert.match(text(seen.views[2]), /Files · Demo[\s\S]*brief\.md/);
});

test('drawn on a terminal: the diff beside the transcript when wide, over it when narrow', async () => {
  for (const columns of [120, 70]) {
    const term = new Terminal(20, columns);
    const screen = fullScreen(term.write, () => ({ rows: term.rows, columns: term.columns }));
    const { api } = standIn();
    const seen: Seen = { out: '', err: '', views: [] };
    const prompt = prompted(['please write the brief', { key: 'diff' }], seen);
    prompt.pane = { show: (v) => screen.pane(v), close: () => screen.pane(null) };
    await runChat(parse(['chat', '--home', '/nowhere']), api, { ...ioFor(seen), out: screen.out, err: screen.err }, prompt);
    const all = term.dump();
    assert.match(all, /\+Request: second/, all);
    if (columns === 120) {
      assert.ok(all.includes('│'), `split at ${columns}:\n${all}`);
      assert.match(all, /wrote brief\.md v2/, 'the transcript stays in view');
    } else {
      assert.ok(!all.includes('│'), `whole screen at ${columns}:\n${all}`);
      assert.doesNotMatch(all, /wrote brief\.md v2/, 'the pane covers the transcript');
      screen.pane(null);
      assert.match(term.dump(), /wrote brief\.md v2/, 'and gives it back');
    }
    screen.close();
  }
});
