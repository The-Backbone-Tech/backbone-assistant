import type { Project } from '@backbone-next/platform';
import * as React from 'react';
import { call } from '../lib/api';
import { useApp } from '../lib/state';
import { projectArchiveSelection } from '../lib/project-selection';
import { Button } from './ui/button';
import {Notice} from './ui/notice';

type Patch=Partial<Pick<Project,'name'|'archived'>>;
const Context=React.createContext<{change(id:string,patch:Patch):Promise<boolean>;busy?:string}|null>(null);
export function useProjectActions(){const actions=React.useContext(Context);if(!actions)throw new Error('Project actions need their provider.');return actions;}
/** One window holds an unanswered request across every entry point. A check never sends it again. */
export function ProjectActionsProvider({children}:{children:React.ReactNode}) {
  const {projects,threads,setPrefs,refresh}=useApp();
  const [busy,setBusy]=React.useState<string>();
  const [focusRestored,setFocusRestored]=React.useState<string>();
  const [focusArchived,setFocusArchived]=React.useState<string>();
  const [notice,setNotice]=React.useState<{id:string;patch:Patch;detail:string;unknown:boolean}>();
  const [success,setSuccess]=React.useState<{id:string;detail:string;undo:boolean}>();
  const pending=React.useRef(false),held=React.useRef(false),generation=React.useRef(0);
  React.useLayoutEffect(()=>{
    if(!focusArchived||projects.some(project=>project.id===focusArchived&&!project.archived))return;
    if(document.activeElement===document.body)(document.querySelector<HTMLElement>('[data-project-id]')??document.querySelector<HTMLElement>('[aria-label="New project"]')??document.querySelector<HTMLElement>('[data-project-archive-place]'))?.focus();
    setFocusArchived(undefined);
  },[projects,focusArchived]);
  React.useLayoutEffect(()=>{
    if(!focusRestored||!projects.some(project=>project.id===focusRestored&&!project.archived))return;
    if(document.activeElement===document.body)document.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(focusRestored)}"]`)?.focus();
    setFocusRestored(undefined);
  },[projects,focusRestored]);
  const dismiss=React.useCallback(()=>setSuccess(undefined),[]);
  const announceArchive=(id:string,name:string,attempt:number,checked=false)=>{
    const detail=`Archived ${name}.${checked?' The project list confirms this state. Nothing was sent again.':''}`;
    setSuccess({id,detail,undo:true});
    // These are the viewer's own projections. Missing access never becomes a guessed count.
    void Promise.allSettled([call('schedules.get',{}),call('identity.sharing',{projectId:id})]).then(([scheduled,sharing])=>{
      if(generation.current!==attempt)return;
      const schedules=scheduled.status==='fulfilled'?scheduled.value?.schedules?.filter(s=>s.projectId===id&&!s.paused).length??0:0;
      const running=threads.filter(t=>t.projectId===id&&t.running).length;
      const parts:string[]=[];
      if(schedules)parts.push(`Its ${schedules} ${schedules===1?'schedule keeps':'schedules keep'} running.`);
      if(running)parts.push(`${running} ${running===1?'chat keeps':'chats keep'} running.`);
      if(sharing.status==='fulfilled'&&sharing.value.ok&&sharing.value.value.access==='owner'){
        const view=sharing.value.value;
        const people=view.grants.flatMap(grant=>{const person=view.people.find(p=>p.id===grant.person&&p.status==='active');return person?[{name:person.name,access:grant.access}]:[];});
        if(people.length>3)parts.push(`${people.length} people keep their existing access.`);
        else for(const person of people)parts.push(`${person.name} keeps ${person.access} access.`);
      }
      if(scheduled.status==='rejected'||!Array.isArray(scheduled.value?.schedules)||sharing.status==='rejected'||!sharing.value.ok)parts.push('Running work, schedules and access are unchanged.');
      setSuccess(current=>current?.id===id?{...current,detail:[detail,...parts].join(' ')}:current);
    });
  };
  const change=async(id:string,patch:Patch)=>{
    if(pending.current||held.current)return false;
    const attempt=++generation.current;
    pending.current=true;setBusy(id);setNotice(undefined);setSuccess(undefined);
    if(patch.archived)setFocusArchived(id);
    try {
      const result=await call('projects.update',{id,patch});
      if(!result.ok){held.current=result.outcome==='UNKNOWN';if(!held.current)setFocusArchived(undefined);setNotice({id,patch,detail:result.detail,unknown:held.current});return false;}
      if(patch.archived){
        setPrefs(current=>projectArchiveSelection(current,id,projects));
        announceArchive(id,result.value.name,attempt);
      }else if(patch.archived===false)setSuccess({id,detail:`Restored ${result.value.name}.`,undo:false});
      await refresh().catch(()=>{});
      return true;
    }catch(error){
      // Only named pre-dispatch refusals establish that nothing was attempted. Transport loss does not.
      const refusal=error instanceof Error&&['IdentityRefused','HomeHeld','HomeOwned','HomeBusy','HomeWriteUnavailable','SharedEngineRequired'].includes(error.name);
      held.current=!refusal;if(refusal)setFocusArchived(undefined);
      setNotice({id,patch,detail:refusal?'The project change was refused. Check your project access and whether this data folder is available. Nothing was changed.':'The project change could not be confirmed. Check the project list before another attempt.',unknown:!refusal});return false;
    }finally{pending.current=false;setBusy(undefined);}
  };
  const check=async()=>{
    if(!notice||pending.current)return;
    pending.current=true;setBusy(notice.id);
    try{
      const list=await refresh();if(!list)throw new Error('Access ended');
      const current=list.find(project=>project.id===notice.id);
      const matches=current&&Object.entries(notice.patch).every(([key,value])=>current[key as keyof Project]=== (typeof value==='string'?value.trim():value));
      held.current=false;setFocusArchived(undefined);setNotice(undefined);
      if(matches&&notice.patch.archived===true)announceArchive(notice.id,current!.name,++generation.current,true);
      else setSuccess({id:notice.id,undo:false,detail:matches?'The project list confirms the requested change. Nothing was sent again.':'The project list is readable. The requested change is not present. Nothing was sent again.'});
    }catch{setNotice({...notice,detail:'The project list could not be checked. Nothing was sent again.'});}
    finally{pending.current=false;setBusy(undefined);}
  };
  return <Context.Provider value={{change,busy:busy??(held.current?'held':undefined)}}>
    {children}
    {(busy||notice||success)&&<div className="fixed bottom-4 right-4 z-50 w-[min(28rem,calc(100vw-2rem))] space-y-2">
      {busy&&<p role="status" className="rounded-md border border-border bg-surface p-3 text-sm text-muted">{notice?.unknown?'Checking project list…':'Saving project…'}</p>}
      {notice&&<div role="alert" className="rounded-md border border-border bg-surface p-3 text-sm">
        <p>{notice.unknown?'Outcome not known. ':''}{notice.detail}</p>
        {notice.unknown?<Button size="sm" variant="ghost" disabled={!!busy} onClick={()=>void check()}>Check project list</Button>:<Button size="sm" variant="ghost" onClick={()=>setNotice(undefined)}>Dismiss</Button>}
      </div>}
      {success&&<Notice key={`${success.id}:${success.undo}`} onDismiss={dismiss}><p>{success.detail}</p>{success.undo&&<Button size="sm" variant="ghost" disabled={!!busy||held.current} onClick={()=>{const id=success.id;void change(id,{archived:false}).then(ok=>{if(ok)setFocusRestored(id);});}}>Undo</Button>}</Notice>}
    </div>}
  </Context.Provider>;
}

export function ArchivedProjectNotice({projectId}:{projectId:string}){
  const {projects}=useApp(),actions=useProjectActions();const project=projects.find(p=>p.id===projectId);
  if(!project?.archived)return null;
  return <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-sm"><p>This project is archived. Running work, schedules and access are unchanged.</p>{project.canUpdate?<Button size="sm" variant="ghost" disabled={!!actions.busy} onClick={()=>void actions.change(project.id,{archived:false})}>Restore project</Button>:<p>The project owner can restore it.</p>}</div>;
}
