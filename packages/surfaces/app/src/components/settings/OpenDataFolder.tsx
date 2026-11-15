import * as React from 'react';
import type { FolderOpenResult, FolderPick } from '../../../electron/data-folder-open';
import { brand } from '../../brand';
import { restore } from '../../lib/api';
import { Button } from '../ui/button';
import { SettingsRow } from './SettingsRow';

const quoted = (path: string) => `"${path.replace(/(["\\$`])/g, '\\$1')}"`;
export const openCommand = (folder: string) => `open -n -a ${quoted(brand.name)} --env BACKBONE_HOME=${quoted(folder)}`;

export type OpenFolderState = FolderOpenResult | {state:'starting'};
export function OpenFolderButton({ id, children }: { id: string; children: React.ReactNode }) {
  const [state,setState]=React.useState<OpenFolderState>();
  const open=async()=>{
    setState({state:'starting'});
    try { setState(await restore.open(id)); }
    catch { setState({state:'unknown',detail:'The launch result could not be confirmed. Check the other window before trying again.'}); }
  };
  return <div className="space-y-2">
    <p className="text-xs text-muted">An older data folder may be upgraded in place. Before the Team update, the app makes a verified export in that folder’s backups folder. To recover, restore that export into a new folder; reinstalling an older app does not undo the update.</p>
    <Button disabled={!!state} onClick={()=>void open()}>{state?.state==='starting'?'Starting…':children}</Button>
    {state?.state==='starting'&&<p role="status" className="text-xs text-muted">Starting another window. This window keeps its current data folder.</p>}
    {state?.state==='opened'&&<p role="status" className="text-xs text-committed">Opened in another window. Its title and Settings › General show the data folder.</p>}
    {state?.state==='already-open'&&<p role="status" className="text-xs text-muted">{state.current?'This data folder is the folder this window already shows.':'This data folder is already open; that window was brought forward where the system allows it.'}</p>}
    {(state?.state==='failed'||state?.state==='unknown')&&<p role="alert" className="text-xs text-danger">{state.state==='failed'?'Could not start.':'Opening could not be confirmed.'} {state.detail} You can use the terminal instructions below after checking the other window.</p>}
  </div>;
}
export function OpenAnotherDataFolder() {
  const [pick,setPick]=React.useState<Extract<FolderPick,{ok:true}>>();
  const [problem,setProblem]=React.useState<string>();
  const [busy,setBusy]=React.useState(false);
  if(!window.backbone?.chooseDataFolder)return null;
  const choose=async()=>{
    setBusy(true);setProblem(undefined);setPick(undefined);
    try {const result=await window.backbone!.chooseDataFolder!();if(result?.ok)setPick(result);else if(result)setProblem(result.detail);}
    catch(error){setProblem((error as Error).message);}finally{setBusy(false);}
  };
  return <SettingsRow title="Open another data folder" about="Choose an existing data folder to open in a separate app window. This window keeps its own folder.">
    <div className="max-w-sm space-y-2">
      <Button variant="outline" size="sm" disabled={busy} onClick={()=>void choose()}>{busy?'Checking…':'Open another data folder…'}</Button>
      {problem&&<p role="alert" className="text-xs text-danger">{problem}</p>}
      {pick&&<><p className="break-all font-mono text-xs text-muted">{pick.folder}</p><OpenFolderButton key={pick.id} id={pick.id}>Open this data folder</OpenFolderButton><details className="text-xs text-muted"><summary className="cursor-pointer">From a terminal</summary><pre className="mt-2 whitespace-pre-wrap break-all font-mono">{openCommand(pick.folder)}</pre></details></>}
    </div>
  </SettingsRow>;
}
