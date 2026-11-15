import type { Project, ThreadSummary } from '@backbone-next/platform';
import { Archive, ChevronDown, ChevronRight, Folder, FolderGit2, MoreHorizontal } from 'lucide-react';
import * as React from 'react';
import { useApp } from '../lib/state';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ItemContextMenu, ItemMenuButton, type MenuEntry } from './ui/item-menu';

export function ProjectRow({project,threads,children,change,busy}: {
  project:Project;threads:ThreadSummary[];children:React.ReactNode;
  change(id:string,patch:Partial<Pick<Project,'name'|'archived'>>):Promise<boolean>;busy:boolean;
}) {
  const {prefs,selectProject,setSidebarOpen}=useApp();
  const [open,setOpen]=React.useState(false),[renaming,setRenaming]=React.useState(false),[name,setName]=React.useState(project.name);
  const [validation,setValidation]=React.useState<string>();
  const row=React.useRef<HTMLButtonElement>(null),input=React.useRef<HTMLInputElement>(null),saving=React.useRef(false),cancelled=React.useRef(false);
  const finish=()=>{setValidation(undefined);setRenaming(false);setTimeout(()=>row.current?.focus());};
  const save=async()=>{
    if(saving.current||cancelled.current)return;
    if(!name.trim()){setValidation('A project needs a name.');return;}
    setValidation(undefined);
    if(name.trim()===project.name){finish();return;}
    saving.current=true;
    try{if(await change(project.id,{name}))finish();}finally{saving.current=false;}
  };
  const startRename=()=>{cancelled.current=false;setName(project.name);setRenaming(true);setTimeout(()=>input.current?.focus());};
  const allowed=project.canUpdate===true;
  const entries:MenuEntry[]=allowed?[
    {kind:'item',id:'rename',label:'Rename',disabled:busy,onSelect:startRename},
    {kind:'item',id:'archive',label:'Archive',icon:<Archive />,disabled:busy,onSelect:()=>void change(project.id,{archived:true})},
  ]:[];
  const Icon=project.kind==='git'?FolderGit2:Folder;
  const selected=prefs.selectedProjectId===project.id&&!prefs.selectedThreadId;
  return <li>
    <ItemContextMenu entries={entries} disabled={!allowed} focusTarget="[data-row-main],[data-menu-focus]">
      <div className={cn('group flex items-center rounded-md hover:bg-hover',selected&&'bg-accent-soft')} aria-busy={busy}>
        <button type="button" aria-label={open?'Hide its chats':'Show its chats'} aria-expanded={open} className="flex size-7 shrink-0 items-center justify-center text-muted" onClick={()=>setOpen(!open)}>
          {open?<ChevronDown className="size-3.5" />:<ChevronRight className="size-3.5" />}
        </button>
        {renaming?<Input ref={input} data-menu-focus aria-label="Project name" aria-invalid={!!validation} maxLength={1000} value={name} size="sm" className="m-0.5 min-w-0 flex-1" disabled={busy}
          onFocus={event=>event.target.select()} onChange={event=>setName(event.target.value)} onContextMenu={event=>event.stopPropagation()}
          onBlur={()=>{if(!busy)void save();}} onKeyDown={event=>{
            if(event.key==='Enter'){event.preventDefault();void save();}
            if(event.key==='Escape'){event.preventDefault();cancelled.current=true;finish();}
          }} />:
          <button ref={row} data-row-main data-project-id={project.id} aria-label={project.name} aria-description={`${threads.length} chats`} type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left text-sm" onKeyDown={event=>{if(event.key==='Enter'&&allowed&&!busy){event.preventDefault();startRename();}}} aria-current={selected?'page':undefined} onClick={()=>{selectProject(project.id);setSidebarOpen(false);}}>
            <Icon className="size-4 shrink-0 text-muted" aria-hidden /><span className="truncate">{project.name}</span>
            {threads.length>0&&<span className="ml-auto text-xs text-muted">{threads.length}</span>}
          </button>}
        {allowed&&<ItemMenuButton entries={entries} focusTarget={()=>input.current} trigger={<Button variant="ghost" size="icon-sm" className="reveal text-muted" aria-label={`Project actions for ${project.name}`} tip><MoreHorizontal /></Button>} />}
      </div>
    </ItemContextMenu>
    {validation&&<p role="alert" className="px-2 py-1 text-xs text-danger">{validation}</p>}
    {open&&<ul className="ml-5 border-l border-border pl-1">{threads.length?children:<li className="px-2 py-1 text-xs text-muted">No chats in this project.</li>}</ul>}
  </li>;
}
