// Memory: what every engine is given, in the person's hands. Their instructions and the project's,
// each remembered line with where it came from, to change or forget, imports from their other agents
// as copies, and their skills, with drafted ones and proposed edits waiting for an OK, archived ones
// to restore, and merges the curator proposes. It is all plain markdown in one folder, which they can
// also open in their own editor.
import type { MemoryEntry, MemoryView, TurnMemory } from '@backbone-next/platform';
import { memoryReferenceText } from '@backbone-next/platform';
import { Brain } from 'lucide-react';
import * as React from 'react';
import { call } from '../lib/api';
import { useApp, useLive } from '../lib/state';
import { SkillRow } from './SkillRow';
import { Button } from './ui/button';
import { Input } from './ui/input';

const EMPTY: MemoryView = { folder: '', instructions: { person: '', project: '' }, topics: [], entries: [], skills: [], learning: { auto: true, merges: [], curatedAt: null }, meaning: null, proposed: [], kept: [] };
const label = 'px-2 text-xs font-medium text-muted';
const area = 'w-full resize-y rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm';

function originOf(e: MemoryEntry): string {
  if (e.origin.kind === 'person') return 'Added by you';
  if (e.origin.kind === 'import') return `Copied from ${e.origin.source?.split('/').slice(-2).join('/') ?? 'an import'}`;
  if (e.judged) {
    const what = e.judged.op === 'hold' ? 'Waits for you' : e.judged.op === 'merge' ? `Would replace: ${(e.replaces ?? []).map((r) => `“${r.text}”`).join(' and ')}` : `Would take out: ${(e.replaces ?? []).map((r) => `“${r.text}”`).join(' and ')}${e.judged.by ? `, now that “${e.judged.by.text}”` : ''}`;
    return `${what} · ${e.judged.why}${e.judged.conflicts.length ? ` · It may contradict: ${e.judged.conflicts.map((c) => `“${c.text}”`).join(', ')}` : ''}`;
  }
  if (e.origin.kind === 'merge') return e.replaces ? `Would replace: ${e.replaces.map((r) => `“${r.text}”`).join(' and ')}` : 'Merged from lines that said the same';
  if (e.origin.kind === 'engine') return `Learned by an engine${e.sources.length ? ` · with ${e.sources.map((s) => `${s.name} v${s.version}`).join(', ')}` : ''}`;
  return `From a chat${e.sources.length ? ` · with ${e.sources.map((s) => `${s.name} v${s.version}`).join(', ')}` : ''}`;
}

function MemoryText({ text }: { text: string }) {
  const visible = memoryReferenceText(text);
  return <><span className="block">{text}</span>{visible !== text && <details data-testid="memory-format"><summary className="cursor-pointer text-xs text-muted">Show invisible characters</summary><pre className="whitespace-pre-wrap break-words text-xs">{visible}</pre></details>}</>;
}

function Entry({ entry, onProblem }: { entry: MemoryEntry; onProblem: (p?: string) => void }) {
  const { selectThread } = useApp();
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(entry.text);
  const save = async () => {
    try {
      const r = await call('memory.put', { id: entry.id, topic: entry.topic, text });
      if (r.ok) { setEditing(false); onProblem(undefined); } else onProblem(r.detail);
    } catch (error) { onProblem(error instanceof Error ? error.message : 'Memory could not be saved.'); }
  };
  return (
    <li className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-hover" data-testid="memory-entry">
      <span className="min-w-0 flex-1">
        {editing
          ? <Input aria-label="Memory text" autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
          : <MemoryText text={entry.text} />}
        <span className="block text-xs text-muted">{originOf(entry)}{entry.origin.threadId && <> · <button type="button" className="underline" onClick={() => selectThread(entry.origin.threadId!)}>open chat</button></>}</span>
        <span className="block text-xs text-muted" data-testid="memory-trust" data-trust={entry.trust ?? 'untrusted'}>
          {entry.trust === 'personal' ? 'Your own words' : entry.trust === 'imported' ? 'Imported copy · untrusted' : 'Derived or external · untrusted'} · Reference only
        </span>
        {entry.unsafe && <span className="block text-xs text-danger" data-testid="memory-unsafe">
          {entry.scanOverride ? 'Included by you as reference' : 'Withheld from recall'}: matches a {entry.unsafe === 'exfiltration' ? 'data exfiltration' : 'prompt injection'} pattern.
          {!entry.scanOverride && <> Review this line, edit or forget it, or <button type="button" className="underline" onClick={() => void call('memory.put', { id: entry.id, topic: entry.topic, text: entry.text }).then(r => onProblem(r.ok ? undefined : r.detail)).catch(error => onProblem(error instanceof Error ? error.message : 'Memory could not be saved.'))}>Use as reference</button>.</>}
        </span>}
      </span>
      {editing
        ? <Button size="sm" onClick={() => void save()}>Save</Button>
        : <Button variant="ghost" size="sm" onClick={() => { setText(entry.text); setEditing(true); }}>Edit</Button>}
      <Button variant="ghost" size="sm" onClick={() => void call('memory.forget', { id: entry.id }).then((r) => onProblem(r.ok ? undefined : r.detail))}>Forget</Button>
    </li>
  );
}

export function Memory() {
  const { prefs, projects } = useApp();
  const projectId = prefs.selectedProjectId;
  const view = useLive(() => call('memory.get', { projectId }).then((v) => v ?? EMPTY, () => EMPTY), [projectId], EMPTY);
  const [mine, setMine] = React.useState<string>();
  const [project, setProject] = React.useState<string>();
  const [query, setQuery] = React.useState('');
  const [fresh, setFresh] = React.useState('');
  const [path, setPath] = React.useState('');
  const [said, setSaid] = React.useState<string>();
  const [problem, setProblem] = React.useState<string>();
  const projectName = projects.find((p) => p.id === projectId)?.name;
  // A search is memory's own ranking (words, near misses and, with a route, meaning), best first.
  const [found, setFound] = React.useState<MemoryEntry[] | null>(null);
  React.useEffect(() => {
    const q = query.trim();
    if (!q) { setFound(null); return; }
    let live = true;
    const t = setTimeout(() => void call('memory.search', { query: q }).then((r) => { if (live) setFound(r); }), 150);
    return () => { live = false; clearTimeout(t); };
  }, [query, view.entries]);
  const shown = found ? [...found, ...view.entries.filter(e => e.unsafe && !e.scanOverride && !found.some(f => f.id === e.id))] : view.entries;
  const topics = [...new Set(shown.map((e) => e.topic))];
  const [baseUrl, setBaseUrl] = React.useState<string>();
  const [model, setModel] = React.useState<string>();
  const saveMeaning = async (route: { baseUrl: string; model: string } | null) => {
    const r = await call('memory.meaning.put', { route });
    if (r.ok) { setProblem(undefined); setBaseUrl(undefined); setModel(undefined); setSaid(r.value ? `Recall also asks ${r.value.model} by meaning.` : 'Recall is by words alone.'); } else setProblem(r.detail);
  };
  const titleOf = (slug: string) => view.topics.find((t) => t.slug === slug)?.title ?? slug;
  const saveInstructions = async (scope: 'person' | 'project', text: string) => {
    const r = await call('memory.instructions.put', { scope, projectId, text });
    if (r.ok) { setProblem(undefined); setSaid('Instructions saved.'); } else setProblem(r.detail);
  };
  const add = async () => {
    try {
      const r = await call('memory.put', { topic: 'notes', text: fresh });
      if (r.ok) { setFresh(''); setProblem(undefined); } else setProblem(r.detail);
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Memory could not be saved.'); }
  };
  const importFrom = async (from: 'codex' | 'claude' | 'file') => {
    const r = await call('memory.import', { from, path: from === 'file' ? path : undefined });
    if (r.ok) { setProblem(undefined); setSaid(`${r.value.added} added from ${from === 'file' ? path.split('/').pop() : from === 'codex' ? 'Codex' : 'Claude'}.${r.value.skipped?.length ? ` Skipped ${r.value.skipped.length}: ${r.value.skipped.map(s => `${s.source}, line ${s.line} (${s.reason})`).join('; ')}.` : ''}`); } else setProblem(r.detail);
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="memory">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 text-ui">
        <header>
          <h1 className="text-lg font-semibold">Memory</h1>
          <p className="text-muted">What every engine is given at the start of a turn, whichever runs it. Plain markdown in <code className="font-mono text-xs">{view.folder}</code>; edit it here or in your own editor.</p>
        </header>
        <section className="flex flex-col gap-2">
          <h2 className={label}>Your instructions</h2>
          <textarea aria-label="Your instructions" rows={3} className={area} value={mine ?? view.instructions.person} onChange={(e) => setMine(e.target.value)} placeholder="How you want work done, in your words." />
          <div><Button size="sm" variant="outline" onClick={() => void saveInstructions('person', mine ?? view.instructions.person)}>Save your instructions</Button></div>
          {projectId && <>
            <h2 className={label}>{projectName ?? 'This project'}'s instructions</h2>
            <textarea aria-label="Project instructions" rows={2} className={area} value={project ?? view.instructions.project} onChange={(e) => setProject(e.target.value)} placeholder="What holds only in this project." />
            <div><Button size="sm" variant="outline" onClick={() => void saveInstructions('project', project ?? view.instructions.project)}>Save project instructions</Button></div>
          </>}
        </section>
        <section className="flex flex-col gap-2">
          <h2 className={label}>Remembered</h2>
          <p className="px-2 text-xs text-muted">Kept from what you ask chats to remember, prefer or correct, and from imports. A line made with a document leaves if that document is withdrawn. Credentials are never kept.</p>
          <div className="flex gap-2 px-2">
            <Input aria-label="Search memory" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {shown.length === 0 && <p className="px-2 py-2 text-muted">Nothing remembered{query ? ' matches' : ' yet'}.</p>}
          {topics.map((t) => (
            <div key={t}>
              <h3 className="px-2 pt-2 text-xs font-medium">{titleOf(t)}</h3>
              <ul>{shown.filter((e) => e.topic === t).map((e) => <Entry key={e.id} entry={e} onProblem={setProblem} />)}</ul>
            </div>
          ))}
          <div className="flex gap-2 px-2">
            <Input aria-label="New memory" placeholder="Something to remember" value={fresh} onChange={(e) => setFresh(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && fresh.trim()) void add(); }} />
            <Button size="sm" variant="outline" onClick={() => void add()}>Add</Button>
          </div>
        </section>
        {view.proposed.length > 0 && <section className="flex flex-col gap-2" data-testid="memory-proposed">
          <h2 className={label}>Waiting for you</h2>
          <p className="px-2 text-xs text-muted">Changes that touch your own words, or lines that may contradict them. None is used until you keep it; each leaves if a document it came from is withdrawn.</p>
          <ul>{view.proposed.map((p) => (
            <li key={p.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-hover" data-testid="memory-proposal">
              <span className="min-w-0 flex-1"><MemoryText text={p.text} /><span className="block text-xs text-muted">{originOf(p)}</span>{p.unsafe && <span className="block text-xs text-muted" data-testid="memory-proposal-unsafe">Withheld from consolidation: {p.unsafe} pattern. Discard it and add corrected words.</span>}</span>
              <Button size="sm" variant="outline" disabled={!!p.unsafe} onClick={() => void call('memory.proposal.decide', { id: p.id, verdict: 'keep' }).then((r) => setProblem(r.ok ? undefined : r.detail))}>Keep</Button>
              <Button size="sm" variant="ghost" onClick={() => void call('memory.proposal.decide', { id: p.id, verdict: 'discard' }).then((r) => setProblem(r.ok ? undefined : r.detail))}>Discard</Button>
            </li>
          ))}</ul>
        </section>}
        {view.kept.length > 0 && <section className="flex flex-col gap-2" data-testid="memory-kept">
          <h2 className={label}>Tidied by itself</h2>
          <p className="px-2 text-xs text-muted">Lines engines learned, kept, merged or taken out by a model's judgement. Your own words are never changed without you. Undo puts things back as they were.</p>
          <ul>{view.kept.map((c) => (
            <li key={c.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-hover" data-testid="memory-change">
              <span className="min-w-0 flex-1"><span className="block">{c.added ? c.added.text : `Took out: ${c.removed.map((e) => `“${e.text}”`).join(' and ')}`}</span><span className="block text-xs text-muted">{c.op === 'keep' ? 'Kept' : c.op === 'merge' ? `Merged ${c.removed.length} lines` : c.op === 'supersede' ? 'Superseded' : 'Retired'} · {c.why}</span></span>
              <Button size="sm" variant="ghost" onClick={() => void call('memory.undo', { id: c.id }).then((r) => setProblem(r.ok ? undefined : r.detail))}>Undo</Button>
            </li>
          ))}</ul>
        </section>}
        <section className="flex flex-col gap-2">
          <h2 className={label}>Recall by meaning</h2>
          <p className="px-2 text-xs text-muted">Optional. Name an embeddings model running on this computer (Ollama, LM Studio, llama.cpp or vLLM), and recall also finds lines that mean the same with other words. Only an address on this computer is taken; nothing is downloaded, and a line holding a credential is never sent.</p>
          <div className="flex flex-wrap gap-2 px-2">
            <Input aria-label="Embeddings address" className="min-w-56 flex-1" placeholder="http://127.0.0.1:11434/v1" value={baseUrl ?? view.meaning?.baseUrl ?? ''} onChange={(e) => setBaseUrl(e.target.value)} />
            <Input aria-label="Embeddings model" className="min-w-40" placeholder="nomic-embed-text" value={model ?? view.meaning?.model ?? ''} onChange={(e) => setModel(e.target.value)} />
            <Button size="sm" variant="outline" onClick={() => void saveMeaning({ baseUrl: baseUrl ?? view.meaning?.baseUrl ?? '', model: model ?? view.meaning?.model ?? '' })}>Use it</Button>
            {view.meaning && <Button size="sm" variant="ghost" onClick={() => void saveMeaning(null)}>Words alone</Button>}
          </div>
        </section>
        <section className="flex flex-col gap-2">
          <h2 className={label}>Bring memories in</h2>
          <p className="px-2 text-xs text-muted">A read-only copy, each line with the file it came from. Only markdown is read, never credentials.</p>
          <div className="flex flex-wrap gap-2 px-2">
            <Button size="sm" variant="outline" onClick={() => void importFrom('codex')}>Import from Codex</Button>
            <Button size="sm" variant="outline" onClick={() => void importFrom('claude')}>Import from Claude</Button>
            <Input aria-label="Markdown file to import" className="min-w-64 flex-1" placeholder="/path/to/AGENTS.md" value={path} onChange={(e) => setPath(e.target.value)} />
            <Button size="sm" variant="outline" onClick={() => void importFrom('file')}>Import file</Button>
          </div>
        </section>
        <section className="flex flex-col gap-1">
          <h2 className={label}>Skills</h2>
          <p className="px-2 text-xs text-muted">SKILL.md folders from here and from your Claude, Codex and agents folders. One you enable is given to a turn whose words bear on it, as reference that cannot change what an agent may do. A skill changed after you enabled it waits for you again.</p>
          <label className="flex items-center gap-2 px-2 text-xs">
            <input type="checkbox" checked={view.learning.auto} onChange={(e) => void call('skills.learning.put', { auto: e.target.checked }).then((r) => setProblem(r.ok ? undefined : r.detail))} />
            Draft a skill after a complex finished task (at most one a day per project; each waits for your OK)
          </label>
          {view.skills.length === 0 && <p className="px-2 py-2 text-muted">No skills found.</p>}
          <ul>{view.skills.map((s) => <SkillRow key={s.id} skill={s} onProblem={setProblem} />)}</ul>
          {view.skillNotice && <p role="status" className="px-2 text-xs text-muted">{view.skillNotice}</p>}
          {!!view.skillChanges?.length && <section className="px-2" aria-label="Skill changes">
            <h3 className="text-xs font-medium text-muted">Recent skill changes</h3>
            <ul>{[...view.skillChanges].reverse().map(change => <li key={change.id} className="flex flex-wrap items-center gap-2 py-1 text-xs" data-testid="skill-change">
              <span className="min-w-0 flex-1 break-words">{change.op === 'edit' ? 'Edited' : 'Removed'} {change.name}</span>
              <Button size="sm" variant="ghost" onClick={() => void call('skills.undo', { id: change.id }).then(r => setProblem(r.ok ? undefined : r.detail)).catch(() => setProblem('Undo could not be confirmed. Review the current skill.'))}>Undo</Button>
            </li>)}</ul>
          </section>}
          {view.learning.merges.map((m) => (
            <p key={m.id} className="flex items-center gap-2 px-2 text-xs text-muted" data-testid="skill-merge">
              <span className="flex-1">{m.names.join(' and ')} look alike ({m.shared.join(', ')}). Merge them by hand if you want one.</span>
              <Button variant="ghost" size="sm" onClick={() => void call('skills.decide', { id: m.id, verdict: 'decline' }).then((r) => setProblem(r.ok ? undefined : r.detail))}>Dismiss</Button>
            </p>
          ))}
          <div className="px-2"><Button size="sm" variant="outline" onClick={() => void call('skills.curate', {}).then((r) => { if (r.ok) { setProblem(undefined); setSaid(r.value.archived.length ? `Archived ${r.value.archived.join(', ')}.` : 'Nothing to archive.'); } else setProblem(r.detail); })}>Tidy skills now</Button></div>
        </section>
        {said && <p role="status" className="break-words px-2 text-xs text-muted">{said}</p>}
        {problem && <p role="alert" className="px-2 text-xs text-danger">{problem}</p>}
      </div>
    </div>
  );
}

/** Under a turn: what it was given from memory and what it left there, read from memory by id. */
export function TurnMemoryCard({ memory }: { memory: TurnMemory }) {
  return memory.off
    ? <div className="rounded-lg border border-border px-3 py-2 text-xs text-muted" data-testid="turn-memory-off">Memory off for this task · nothing read or remembered.</div>
    : <RecalledTurnMemoryCard memory={memory} />;
}

function RecalledTurnMemoryCard({ memory }: { memory: TurnMemory }) {
  const { setPrefs } = useApp();
  const view = useLive(() => call('memory.get', {}).then((v) => v ?? EMPTY, () => EMPTY), [], EMPTY);
  const words = new Map(view.entries.map((e) => [e.id, e.text]));
  const kept = memory.remembered;
  if (!memory.used.length && !memory.skills.length && !memory.instructions && !kept.length) return null;
  const given = [
    memory.instructions ? 'your instructions' : '',
    memory.used.length ? `${memory.used.length} ${memory.used.length === 1 ? 'memory' : 'memories'}` : '',
    memory.skills.length ? `skill ${memory.skills.join(', ')}` : '',
  ].filter(Boolean);
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-xs" data-testid="turn-memory">
      <Brain className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1">
        {given.length > 0 && <span className="block text-muted" title={memory.used.map((id) => words.get(id) ?? 'forgotten').join('\n')}>Given {given.join(', ')}</span>}
        {kept.map((id) => (
          <span key={id} className="flex items-baseline gap-2">
            {words.has(id)
              ? <><span className="min-w-0 flex-1"><span className="text-muted">Remembered:</span> {words.get(id)}</span>
                <button type="button" className="text-muted underline" onClick={() => void call('memory.forget', { id })}>Forget</button></>
              : <span className="min-w-0 flex-1 text-muted">Remembered, since forgotten.</span>}
          </span>
        ))}
      </span>
      <Button variant="ghost" size="sm" onClick={() => setPrefs((p) => ({ ...p, view: 'memory', selectedThreadId: undefined }))}>Memory</Button>
    </div>
  );
}
