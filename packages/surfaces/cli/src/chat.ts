// backbone chat: an interactive session in the terminal, as the app's composer is in its window. Each
// line is sent in the current thread and followed as it works; slash commands do the rest through the
// same commands a script uses (commands.ts), so nothing here decides anything the platform does not.
// Ctrl-C stops the turn in hand; with none running, /quit (or end of input) leaves.
//
// At a full-screen terminal a side pane shows the project's files, a document at a version and the
// diff a turn produced, from files.list, material.read and changes.get (with the version): reads the
// platform already serves, so the pane adds no authority. Each turn's written documents are named in
// the transcript with their version, and Ctrl-O opens their diff.
import type { FileLink, Turn } from '@backbone-next/platform';
import { EXIT, runCommand, type Api, type Io, type Parsed } from './commands.ts';
import type { PaneLine, PaneView } from './screen.ts';

/** A key the session acts on: Ctrl-O opens the last written documents' diff, Esc closes the pane. */
export type ChatKey = 'diff' | 'close';

/** Where the person's lines come from: null at the end of input. */
export interface Prompt {
  ask(prompt: string): Promise<string | null>;
  /** Where the session says which thread it is on and the settings the next message goes with (the full-screen header). */
  status?(text: string): void;
  /** The side pane, at a full-screen terminal only: piped input has none and its output is unchanged. */
  pane?: { show(view: PaneView): void; close(): void };
  /** Registers what a key does; the returned promise ends when its pane is drawn. */
  onKey?(fn: (key: ChatKey) => Promise<void>): void;
}

export const CHAT_HELP = `Type to send in this thread. Commands:
  /new                     a new thread for the next message
  /thread <id>             carry on in that thread
  /threads                 the threads in this data folder
  /show                    this thread so far
  /goal <text>             set this thread's goal and run it until a check finds it met
  /stop                    stop the turn in hand (Ctrl-C does the same while one runs)
  /model <id>  /effort 1-5  /permission ask|auto-review|full  /plan on|off
  /models  /now            what the data folder offers and holds
  /files                   the project's files (in the side pane at a full screen)
  /open <name> [vN]        a document's text, at a version
  /diff [<name> [vN]]      what the last turn wrote (Ctrl-O), or that document's version
  /close                   close the pane (Esc does the same)
  /quit                    leave (the thread stays)`;

const PERMISSIONS = ['ask', 'auto-review', 'full'] as const;
const SETTLE_MS = 10_000;
/** The most lines a pane is given: a giant document is cut, and says so. */
const PANE_LINES = 5_000;

type Written = FileLink;
/** The documents a turn wrote, each at the exact version its write made; a write that did not land is not one. */
export function written(turn: Turn): Written[] {
  return turn.effects.flatMap((e) => {
    if (e.outcome !== 'DONE') return [];
    const link = e.materialId && e.version ? { materialId: e.materialId, name: e.target, version: e.version } : turn.answer?.files.find((f) => f.name === e.target);
    return link ? [link] : [];
  });
}

/** A name and an optional trailing `vN`. */
function named(arg: string): { name: string; version?: number } {
  const m = /^(.*\S)\s+v(\d+)$/.exec(arg);
  return m ? { name: m[1], version: Number(m[2]) } : { name: arg };
}

const lines = (text: string): PaneLine[] => {
  const all = text.replace(/\n$/, '').split('\n');
  const cut = all.length > PANE_LINES ? [{ text: `(${all.length - PANE_LINES} more lines not shown)`, style: 'dim' as const }] : [];
  return [...all.slice(0, PANE_LINES).map((t) => ({ text: t })), ...cut];
};
const patchLines = (patch: string): PaneLine[] => lines(patch).map((l) => ({
  text: l.text,
  ...(l.style ? { style: l.style } : /^(---|\+\+\+|@@)/.test(l.text) ? { style: 'meta' as const } : l.text.startsWith('+') ? { style: 'add' as const } : l.text.startsWith('-') ? { style: 'remove' as const } : {}),
}));
const problem = (title: string, text: string): PaneView => ({ title, lines: [{ text, style: 'error' }] });
const said = (r: { reason: string; detail: string; outcome: string }) => `${r.outcome} (${r.reason}): ${r.detail}`;

/** A turn's answer comes before its thread is idle (what is learned from it is written after): wait, within a bound, so the next line is not refused. */
async function settled(api: Api, threadId: string | undefined, pollMs: number) {
  if (!threadId) return;
  for (const end = Date.now() + SETTLE_MS; Date.now() < end; await new Promise((r) => setTimeout(r, pollMs))) {
    const t = await api.call('threads.get', { id: threadId }).catch(() => null);
    if (!t || !t.ok || !t.value.summary.running) return;
  }
}

export async function runChat(parsed: Parsed, api: Api, io: Io, prompt: Prompt): Promise<number> {
  const options = { ...parsed.options };
  let current = options.thread;
  // Each command run here holds its own interrupt; the session passes the person's Ctrl-C to it.
  const run = (name: string, target?: string, extra: Partial<Parsed['options']> = {}) => runCommand(
    { ...parsed, name, target, json: false, options: { ...options, thread: current, ...extra } },
    api,
    { ...io, holding: (thread) => { current = thread; io.holding(thread); } },
  );
  // The pane's reads. Each view is drawn in the pane, or printed when there is none (piped input).
  const show = (view: PaneView) => {
    if (prompt.pane) return prompt.pane.show(view);
    io.out(view.title);
    for (const l of view.lines) (l.style === 'error' ? io.err : io.out)(l.text);
  };
  /** What the last turn here wrote: Ctrl-O's diff. */
  let lastWritten: { projectId: string; threadId: string; files: Written[] } | undefined;
  const threadOf = async (id: string) => { const r = await api.call('threads.get', { id }); return r.ok ? r.value : null; };
  /** The project this session works in: its thread's, or the one named or only one. */
  const projectOf = async (): Promise<{ id: string; name: string } | string> => {
    const all = await api.call('projects.list', {});
    const id = current ? (await threadOf(current))?.summary.projectId : undefined;
    const p = id ? all.find((x) => x.id === id) : options.project ? all.find((x) => x.id === options.project || x.name === options.project) : all.length === 1 ? all[0] : undefined;
    return p ?? (options.project ? `No project ${options.project}.` : all.length ? `Name one of ${all.length} projects with --project.` : 'There is no project yet.');
  };
  const reading = async (title: string, fn: () => Promise<PaneView>) => {
    try {
      show(await fn());
    } catch (error) {
      show(problem(title, `The read did not complete: ${(error as Error).message}`));
    }
  };
  const files = () => reading('Files', async () => {
    const p = await projectOf();
    if (typeof p === 'string') return problem('Files', p);
    const all = await api.call('files.list', { projectId: p.id });
    return { title: `Files · ${p.name}`, lines: all.length ? [...all.map((f) => ({ text: `${f.class.padEnd(8)} ${f.path}` })), { text: '' }, { text: '/open <name> [vN] shows one; /diff <name> its last change', style: 'dim' as const }] : [{ text: 'No files.', style: 'dim' as const }] };
  });
  /** A file of the project by its path or name, as files.list gives it. */
  const fileNamed = async (projectId: string, name: string) => (await api.call('files.list', { projectId })).find((f) => f.path === name || f.path.endsWith(`/${name}`));
  const open = (arg: string) => reading(arg, async () => {
    const { name, version } = named(arg);
    const p = await projectOf();
    if (typeof p === 'string') return problem(name, p);
    const file = await fileNamed(p.id, name);
    if (!file) return problem(name, `No file ${name} in ${p.name}. /files lists them.`);
    if (!file.materialId) return problem(name, `${file.path} is not a document the platform keeps versions of.`);
    const r = await api.call('material.read', { id: file.materialId, ...(version ? { version } : {}) });
    if (!r.ok) return problem(name, said(r));
    const { entry } = r.value;
    const v = version ?? entry.current;
    const title = `${entry.name} v${v} (current${v === entry.current ? '' : ` v${entry.current}`})`;
    return { title, lines: r.value.text !== undefined ? lines(r.value.text) : [{ text: `${entry.mediaType}, ${Buffer.from(r.value.base64 ?? '', 'base64').length} bytes: not text.`, style: 'dim' }] };
  });
  /** The diff of each version given, from changes.get with that version. */
  const diffOf = async (projectId: string, threadId: string | undefined, docs: Written[]): Promise<PaneView> => {
    const out: PaneLine[] = [];
    for (const d of docs) {
      const r = await api.call('changes.get', { projectId, ...(threadId ? { threadId } : {}), scope: 'last-turn', version: { materialId: d.materialId, version: d.version } });
      if (out.length) out.push({ text: '' });
      if (!r.ok) { out.push({ text: `${d.name} v${d.version}: ${said(r)}`, style: 'error' }); continue; }
      out.push(...(r.value.files.length ? r.value.files.flatMap((f) => patchLines(f.patch)) : [{ text: `${d.name} v${d.version}: no text diff (not a text document).`, style: 'dim' as const }]));
    }
    const base = docs.length === 1 ? ` against ${docs[0].version > 1 ? `v${docs[0].version - 1}` : 'nothing'}` : '';
    return { title: `Diff · ${docs.map((d) => `${d.name} v${d.version}`).join(', ')}${base}`, lines: out };
  };
  const diff = (arg: string) => reading('Diff', async () => {
    const t = current ? await threadOf(current) : null;
    const turns = [...(t?.turns ?? [])].reverse();
    if (!arg) {
      // Ctrl-O: what the last turn here wrote, or the last turn of this thread that wrote anything.
      const last = lastWritten && (!current || lastWritten.threadId === current) ? lastWritten : undefined;
      const docs = last?.files ?? turns.map(written).find((w) => w.length) ?? [];
      if (!docs.length || !t && !last) return { title: 'Diff', lines: [{ text: 'No turn in this thread has written a document yet.', style: 'dim' }] };
      return diffOf(last?.projectId ?? t!.summary.projectId, last?.threadId ?? t!.summary.id, docs);
    }
    const { name, version } = named(arg);
    const inThread = turns.flatMap(written).find((w) => w.name === name && (version === undefined || w.version === version));
    if (inThread && t) return diffOf(t.summary.projectId, t.summary.id, [inThread]);
    const p = await projectOf();
    if (typeof p === 'string') return problem(name, p);
    const file = await fileNamed(p.id, name);
    if (!file?.materialId) return problem(name, file ? `${file.path} is not a document the platform keeps versions of.` : `No file ${name} in ${p.name}. /files lists them.`);
    let v = version;
    if (v === undefined) {
      const r = await api.call('material.read', { id: file.materialId });
      if (!r.ok) return problem(name, said(r));
      v = r.value.entry.current;
    }
    return diffOf(p.id, current, [{ materialId: file.materialId, name: file.path, version: v }]);
  });
  const closePane = () => { if (prompt.pane) prompt.pane.close(); else io.err('No pane is open.'); };
  prompt.onKey?.(async (key) => {
    if (key === 'close') prompt.pane?.close();
    if (key === 'diff') await diff('');
  });
  /** After a message: name each document its turns wrote, at the version made, so Ctrl-O can open it. */
  const noteWritten = async (before: number) => {
    if (!prompt.pane || !current) return;
    const t = await threadOf(current).catch(() => null);
    if (!t) return;
    const docs = t.turns.slice(before).flatMap(written);
    if (!docs.length) return;
    lastWritten = { projectId: t.summary.projectId, threadId: t.summary.id, files: docs };
    io.out(`  wrote ${docs.map((d) => `${d.name} v${d.version}`).join(', ')} · Ctrl-O shows the diff`);
  };

  io.out(`backbone chat${current ? ` · thread ${current}` : ''}. /help for commands, /quit to leave.`);
  for (;;) {
    prompt.status?.(`backbone chat · ${current ? `thread ${current.slice(0, 8)}` : 'new thread'} · ${options.model ?? 'default model'} · effort ${options.effort} · ${options.permission}${options.plan ? ' · plan' : ''} · /help`);
    const line = await prompt.ask(current ? `${current.slice(0, 8)}> ` : 'new> ');
    if (line === null) return EXIT.OK;
    const text = line.trim();
    if (!text) continue;
    const [head, ...rest] = text.split(/\s+/);
    const arg = text.slice(head.length).trim();
    if (!head.startsWith('/') || head === '/goal') {
      if (head === '/goal' && !arg) { io.err('/goal needs the goal\'s words.'); continue; }
      const before = prompt.pane && current ? (await threadOf(current).catch(() => null))?.turns.length ?? 0 : 0;
      await run(head === '/goal' ? 'goal' : 'send', head === '/goal' ? arg : text);
      await settled(api, current, io.pollMs);
      await noteWritten(before);
      continue;
    }
    switch (head) {
      case '/quit': case '/exit': return EXIT.OK;
      case '/help': io.out(CHAT_HELP); break;
      case '/new': current = undefined; io.out('The next message starts a new thread.'); break;
      case '/thread':
        if (!arg) { io.err('/thread needs a thread id.'); break; }
        if ((await run('threads show', arg)) === EXIT.OK) current = arg;
        break;
      case '/threads': await run('threads list'); break;
      case '/show':
        if (!current) io.err('No thread yet: send a message first.');
        else await run('threads show', current);
        break;
      case '/stop':
        if (!current) io.err('No thread yet.');
        else await run('stop', current);
        break;
      case '/models': await run('models'); break;
      case '/now': await run('now'); break;
      case '/files': if (prompt.pane) await files(); else await run('files'); break;
      case '/open':
        if (!arg) io.err('/open needs a file\'s name, as /files lists them.');
        else await open(arg);
        break;
      case '/diff': await diff(arg); break;
      case '/close': closePane(); break;
      case '/model':
        if (!arg) io.err('/model needs a model id, as /models lists them.');
        else { options.model = arg; io.out(`Model: ${arg}.`); }
        break;
      case '/effort': {
        const n = Number(rest[0]);
        if (!Number.isInteger(n) || n < 1 || n > 5) io.err('/effort takes 1 to 5.');
        else { options.effort = n as Parsed['options']['effort']; io.out(`Effort: ${n}.`); }
        break;
      }
      case '/permission':
        if (!(PERMISSIONS as readonly string[]).includes(arg)) io.err(`/permission takes ${PERMISSIONS.join(', ')}.`);
        else { options.permission = arg as Parsed['options']['permission']; io.out(`Permission: ${arg}.`); }
        break;
      case '/plan':
        if (arg !== 'on' && arg !== 'off') io.err('/plan takes on or off.');
        else { options.plan = arg === 'on'; io.out(`Plan mode ${arg}.`); }
        break;
      default: io.err(`No command ${head}. /help lists them.`);
    }
  }
}
