import type { ProjectKind } from '@backbone-next/platform';
import * as React from 'react';
import { call, clientKey } from '../lib/api';
import { useApp } from '../lib/state';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Dialog, DialogContent } from './ui/dialog';

type Intent = { key: string; name: string; kind: ProjectKind };
const INTENT_KEY = 'project-create:intent';
function parseIntent(text: string): Intent | null {
  if (!text) return null;
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object') throw new Error('The saved creation attempt could not be read.');
  const v = value as Record<string, unknown>;
  if (typeof v.key !== 'string' || !v.key || typeof v.name !== 'string' || !v.name || (v.kind !== 'folder' && v.kind !== 'git')) throw new Error('The saved creation attempt could not be read.');
  return {key:v.key,name:v.name,kind:v.kind};
}

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { selectProject } = useApp();
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<ProjectKind>('folder');
  const [intent, setIntent] = React.useState<Intent | null>(null);
  const [revision, setRevision] = React.useState<number>();
  const [error, setError] = React.useState<string>();
  const [creating, setCreating] = React.useState(false);
  const [confirmDiscard,setConfirmDiscard] = React.useState(false);
  const [leaveDetail,setLeaveDetail] = React.useState<string>();
  const inFlight = React.useRef(false);

  React.useEffect(() => {
    if (!open || inFlight.current) return;
    let live = true; setRevision(undefined); setError(undefined); setConfirmDiscard(false); setLeaveDetail(undefined);
    void (async () => {
      // Advance the exact observed revision before accepting it: an older request whose response
      // was lost can no longer arrive later and replace the value this dialog acts on.
      const saved = await call('drafts.get', {key:INTENT_KEY});
      const fenced = await call('drafts.put', {key:INTENT_KEY,text:saved?.text ?? '', ...(saved?.meta === undefined ? {} : {meta:saved.meta}),clientKey:clientKey(),baseRevision:saved?.revision ?? 0});
      if (!fenced.ok) throw new Error(fenced.detail);
      const pending=parseIntent(fenced.value.text);
      if (!live) return;
      setIntent(pending); setRevision(fenced.value.revision);
      if (pending) {setName(pending.name); setKind(pending.kind);}
    })().catch(() => {if(live)setError('The saved project attempt could not be checked. Close and reopen this dialog to try again.');});
    return () => {live=false;};
  }, [open]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || revision === undefined) return;
    inFlight.current = true; setCreating(true); setError(undefined);
    let dispatched = false;
    try {
      let attempt=intent, base=revision;
      if (!attempt) {
        attempt={key:clientKey(),name:name.trim(),kind};
        const encoded=JSON.stringify(attempt);
        const kept=await call('drafts.put',{key:INTENT_KEY,text:encoded,clientKey:clientKey(),baseRevision:base});
        if (!kept.ok) throw new Error('The creation attempt changed elsewhere. Close and reopen this dialog to review it.');
        const observed=await call('drafts.get',{key:INTENT_KEY});
        if (!observed || observed.revision!==kept.value.revision || observed.text!==encoded) throw new Error('The creation attempt could not be confirmed. Close and reopen this dialog to check it.');
        base=observed.revision;setRevision(base);setIntent(attempt);
      }
      dispatched=true;
      const result=await call('projects.create',{name:attempt.name,kind:attempt.kind,clientKey:attempt.key});
      if (!result.ok) {
        if (result.outcome==='UNKNOWN') {setLeaveDetail(result.detail);setError(`${result.detail} Check again uses this same attempt.`);return;}
        // Only a terminal refusal recorded for this identity settles an earlier attempt. A
        // general Host gate can refuse without reading it, so that refusal cannot forget it.
        if (result.reason!=='PROJECT_CREATE_FAILED') {setLeaveDetail('The Host refused this check without confirming the earlier attempt or its folder.');setError(`${result.detail} The earlier attempt remains saved.`);return;}
        const cleared=await call('drafts.put',{key:INTENT_KEY,text:'',clientKey:clientKey(),baseRevision:base});
        if (!cleared.ok) {setError(`${result.detail} The saved attempt could not be cleared; reopen this dialog before trying again.`);return;}
        setIntent(null);setRevision(cleared.value.revision);setError(result.detail);return;
      }
      const cleared=await call('drafts.put',{key:INTENT_KEY,text:'',clientKey:clientKey(),baseRevision:base});
      if (!cleared.ok) {setError('The project was created, but its saved attempt could not be cleared. Check again before creating another.');return;}
      setIntent(null);setRevision(cleared.value.revision);selectProject(result.value.id);setName('');setKind('folder');onOpenChange(false);
    } catch {
      if (dispatched) setLeaveDetail('The creation outcome and folder location could not be checked.');
      setError(dispatched ? 'Project creation could not be confirmed. Close and reopen this dialog to check the saved attempt before trying again.' : 'The creation attempt could not be saved or checked. No project was sent; close and reopen this dialog before trying again.');
    } finally {inFlight.current=false;setCreating(false);}
  }
  async function discard() {
    if (revision===undefined || inFlight.current) return;
    inFlight.current=true;setCreating(true);
    try {
      const result=await call('drafts.put',{key:INTENT_KEY,text:'',clientKey:clientKey(),baseRevision:revision});
      if (!result.ok) throw new Error(result.detail);
      setIntent(null);setRevision(result.value.revision);setConfirmDiscard(false);setLeaveDetail(undefined);setError(undefined);
    } catch {setError('The attempt could not be discarded. Close and reopen to check its current state.');}
    finally {inFlight.current=false;setCreating(false);}
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title="New project" description="A project holds chats and their files.">
      <form onSubmit={e=>void create(e)} className="space-y-4">
        {intent && <p className="text-sm">A previous project creation is unconfirmed. Check the same attempt before starting another.</p>}
        <label className="block text-sm"><span className="mb-1 block font-medium">Name</span><Input autoFocus disabled={creating || revision===undefined || !!intent} value={name} onChange={e=>setName(e.target.value)} /></label>
        <fieldset disabled={creating || revision===undefined || !!intent} className="text-sm"><legend className="mb-1 font-medium">Kind</legend>
          <label className="mr-4 inline-flex items-center gap-1.5"><input type="radio" name="kind" checked={kind==='folder'} onChange={()=>setKind('folder')} /> Folder</label>
          <label className="inline-flex items-center gap-1.5"><input type="radio" name="kind" checked={kind==='git'} onChange={()=>setKind('git')} /> Repository (git)</label>
        </fieldset>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        {intent && !leaveDetail && <p className="text-xs">Check again before leaving this attempt to see what is known.</p>}
        {intent && leaveDetail && !confirmDiscard && <button type="button" className="text-xs underline" onClick={()=>setConfirmDiscard(true)}>Leave files and forget attempt</button>}
        {intent && leaveDetail && confirmDiscard && <div className="text-xs"><p>{leaveDetail}</p><p>The earlier project may still exist or finish later. Leaving it does not undo anything; a new attempt could create another project. The attempt will no longer appear in this dialog.</p><button type="button" onClick={()=>setConfirmDiscard(false)}>Keep attempt</button> <button type="button" onClick={()=>void discard()}>Leave files and forget</button></div>}
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={()=>onOpenChange(false)}>{creating ? 'Close' : 'Cancel'}</Button><Button type="submit" disabled={creating || revision===undefined || !name.trim()}>{creating?'Creating…':intent?'Check again':'Create project'}</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}
