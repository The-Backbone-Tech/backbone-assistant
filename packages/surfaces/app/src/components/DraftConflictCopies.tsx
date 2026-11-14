// Conflict copies preserve local typing separately from the current shared draft.
import * as React from 'react';
import { discardConflictCopy, readConflictCopies, type DraftConflictCopy } from '../lib/drafts';

export function DraftConflictCopies({draftKey}: {draftKey:string}) {
  const [copies,setCopies] = React.useState<DraftConflictCopy[]>([]);
  const [opened,setOpened] = React.useState<string>();
  const [confirming,setConfirming] = React.useState<string>();
  const [error,setError] = React.useState<string>();
  const [busy,setBusy] = React.useState(false);
  React.useEffect(() => {
    let live=true; setCopies([]); setOpened(undefined); setConfirming(undefined); setError(undefined);
    void readConflictCopies(draftKey).then(value=>{if(live)setCopies(value);}).catch(()=>{if(live)setError('Saved conflict copies could not be read.');});
    return ()=>{live=false;};
  },[draftKey]);
  if (!copies.length && !error) return null;
  return <div role="status" className="border-b border-border px-3 py-2 text-xs text-muted">
    {error && <p role="alert">{error}</p>}
    {copies.map(copy=><div key={copy.id}>
      <p>A separate copy of an unconfirmed local draft was kept.</p>
      <button type="button" className="underline" onClick={()=>setOpened(opened===copy.id ? undefined : copy.id)}>{opened===copy.id ? 'Hide conflict copy' : 'Review conflict copy'}</button>
      {opened===copy.id && <div><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words">{copy.text || '(empty)'}</pre>
        {copy.meta && Object.keys(copy.meta).length>0 && <><p>Saved details:</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(copy.meta,null,2)}</pre></>}
        {!confirming ? <button type="button" className="underline" onClick={()=>setConfirming(copy.id)}>Discard conflict copy</button> : confirming===copy.id && <div>
          <p>Discard this separate copy? The current saved draft is not changed.</p>
          <button type="button" className="underline mr-2" onClick={()=>setConfirming(undefined)}>Cancel</button>
          <button type="button" className="underline" disabled={busy} onClick={()=>{setBusy(true);void discardConflictCopy(draftKey,copy.id).then(()=>{setCopies(current=>current.filter(item=>item.id!==copy.id));setConfirming(undefined);setOpened(undefined);}).catch((e:unknown)=>setError(`The copy could not be discarded: ${String(e)}`)).finally(()=>setBusy(false));}}>Discard this copy</button>
        </div>}
      </div>}
    </div>)}
  </div>;
}
