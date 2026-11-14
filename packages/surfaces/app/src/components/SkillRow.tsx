// Keep the reviewed version while editing: live updates must not replace a person's unsaved text.
import type { Skill } from '@backbone-next/platform';
import { Sparkles } from 'lucide-react';
import * as React from 'react';
import { call } from '../lib/api';
import { useApp } from '../lib/state';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

export function SkillRow({ skill, onProblem }: { skill: Skill; onProblem: (p?: string) => void }) {
  const { selectThread } = useApp();
  const [edit, setEdit] = React.useState<{ text: string; base: string }>();
  const [busy, setBusy] = React.useState(false);
  const act = async (fn: () => Promise<{ ok: boolean; detail?: string }>) => {
    if (busy) return;
    setBusy(true);
    try { const r = await fn(); onProblem(r.ok ? undefined : r.detail); if (r.ok) setEdit(undefined); }
    catch { onProblem('That skill change could not be confirmed. Review the current skill before trying again.'); }
    finally { setBusy(false); }
  };
  const decide = (verdict: 'accept' | 'decline' | 'enable' | 'disable' | 'restore') => void act(() => call('skills.decide', { id: skill.id, verdict }));
  const editable = skill.origin === 'backbone' && (skill.state === 'proposed' || skill.state === 'active') && skill.revision && skill.body !== undefined;
  return <li className="flex flex-wrap items-start gap-2 rounded-md px-2 py-1.5 hover:bg-hover" data-testid="skill" data-state={skill.state}>
    <Sparkles className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
    <div className="min-w-0 flex-1 basis-48">
      <span className="flex flex-wrap items-center gap-2"><strong className="font-medium">{skill.name}</strong><span className="text-xs text-muted">{skill.origin === 'backbone' ? 'here' : skill.plugin ? `${skill.origin} plugin ${skill.plugin}` : skill.origin}</span>
        {skill.state === 'proposed' && <Badge tone="draft">Waiting for your OK</Badge>}
        {skill.state === 'available' && <Badge>Not used until you enable it</Badge>}
        {skill.state === 'edit' && <Badge tone="draft">Edit waiting for your OK</Badge>}
        {skill.state === 'archived' && <Badge>Archived · not used</Badge>}
      </span>
      {skill.description && <span className="block text-muted">{skill.description}</span>}
      {skill.blocked && <span className="block text-xs text-danger">{skill.blocked}</span>}
      {skill.sourceTurns?.map(source => <button key={`${source.threadId}:${source.turnId ?? ''}`} type="button" className="block break-all text-left text-xs text-muted underline" data-testid="skill-source" onClick={() => selectThread(source.threadId)}>
        Open source chat{source.turnId ? ` · turn ${source.turnId}` : ''}
      </button>)}
      {edit ? <div className="mt-2 flex flex-col gap-2">
        <textarea aria-label="Skill text" className="min-h-48 w-full resize-y rounded-md border border-border bg-transparent px-2 py-1 font-mono text-xs" value={edit.text} onChange={e => setEdit({ ...edit, text: e.target.value })} />
        <p className="text-xs text-muted">Keep the name and description at the top. Saving a draft leaves it waiting for your acceptance.</p>
        <div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => void act(() => call('skills.put', { id: skill.id, base: edit.base, text: edit.text }))}>Save skill</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setEdit(undefined)}>Cancel edit</Button></div>
      </div> : skill.body && <details className="mt-1" open={skill.state === 'proposed'}><summary className="cursor-pointer text-xs text-muted">{skill.state === 'proposed' ? 'The whole draft, to read before you accept it' : 'Read skill'}</summary><pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border px-2 py-1 font-mono text-xs" data-testid="skill-body">{skill.body}</pre></details>}
      {skill.edit && <pre className="mt-1 overflow-x-auto rounded-md border border-border px-2 py-1 font-mono text-xs" data-testid="skill-diff">{skill.edit.diff}</pre>}
    </div>
    <div className="flex flex-wrap gap-1">
      {editable && !edit && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEdit({ text: skill.body!, base: skill.revision! })}>Edit skill</Button>}
      {skill.state === 'active' && skill.origin === 'backbone' && skill.revision && !edit && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => call('skills.remove', { id: skill.id, base: skill.revision! }))}>Remove skill</Button>}
      {skill.state === 'archived' && <Button size="sm" variant="outline" disabled={busy} onClick={() => decide('restore')}>Restore</Button>}
      {(skill.state === 'proposed' || skill.state === 'edit') && !edit && <><Button size="sm" disabled={busy || !!skill.blocked} onClick={() => decide('accept')}>Accept</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => decide('decline')}>Decline</Button></>}
      {skill.state === 'available' && !skill.blocked && <Button size="sm" variant="outline" disabled={busy} onClick={() => decide('enable')}>Enable</Button>}
      {skill.state === 'active' && skill.origin !== 'backbone' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide('disable')}>Disable</Button>}
    </div>
  </li>;
}
