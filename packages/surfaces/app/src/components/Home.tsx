import {useProjectActions} from './project-actions';
// Home: one centred input and nothing below it (R-UX-HOME-01).
import { DataFolderLabel } from './DataFolderLabel';
import { ChevronDown } from 'lucide-react';
import * as React from 'react';
import { useApp } from '../lib/state';
import { FullAccessCard } from './FullAccessCard';
import { MacFileBanner } from './MacFileAccess';
import { Composer } from './Composer';
import { NewProjectDialog } from './NewProjectDialog';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';

export function Home() {
  const { remote, dataFolder, threads, projects, prefs, setPrefs, selectProject, selectThread } = useApp();
  const [newProject, setNewProject] = React.useState(false);
  const actions=useProjectActions();
  const noActive=projects.length>0&&!projects.some(p=>!p.archived);
  const project = projects.find((p) => p.id === prefs.selectedProjectId&&!p.archived);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4" data-testid="home">
      <div className="w-full max-w-2xl">
        {!remote&&threads.length===0&&<DataFolderLabel folder={dataFolder} />}
        {!remote&&<MacFileBanner />}
        {!remote&&<FullAccessCard projectId={project?.id} />}
        <h1 className="mb-5 text-center text-2xl font-medium tracking-tight sm:text-3xl">
          {project ? (
            <>
              What should we work on in{' '}
              {/* The question mark stays on the project name's line when the heading wraps. */}
              <span className="inline-flex max-w-full items-baseline">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="h-auto px-1.5 py-0.5 text-2xl font-medium text-accent sm:text-3xl">
                    {project.name}
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <ProjectMenu onNew={() => setNewProject(true)} />
              </DropdownMenu>
              ?
              </span>
            </>
          ) : (
            'What should we work on?'
          )}
        </h1>
        {noActive?<div className="space-y-2 text-center text-sm"><p>There is no active project. Restore one or create a new project before sending.</p>
          <div className="max-h-64 overflow-y-auto">{projects.filter(p=>p.archived).map(p=><div key={p.id}>{p.name} · Archived {p.canUpdate?<Button size="sm" variant="ghost" disabled={!!actions.busy} onClick={()=>void actions.change(p.id,{archived:false}).then(ok=>{if(ok)selectProject(p.id);})}>Restore {p.name}</Button>:<span>The project owner can restore it.</span>}</div>)}</div>
          {!remote&&<Button onClick={()=>setNewProject(true)}>New project</Button>}
        </div>:<Composer key={project?.id ?? 'none'} projectId={project?.id} autoFocus onNeedProject={() => setNewProject(true)} onSent={(id) => { setPrefs((p) => (p.fullAccessNotice ? p : { ...p, fullAccessNotice: 'decided' })); selectThread(id); }} />}
      </div>
      <NewProjectDialog open={newProject} onOpenChange={setNewProject} />
    </div>
  );

  function ProjectMenu({ onNew }: { onNew: () => void }) {
    return (
      <DropdownMenuContent align="center">
        <DropdownMenuRadioGroup value={project?.id ?? ''} onValueChange={(v) => selectProject(v)}>
          {projects.filter(p=>!p.archived).map((p) => (
            <DropdownMenuRadioItem key={p.id} value={p.id}>
              {p.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {projects.length > 0 && <DropdownMenuSeparator />}
        {!remote&&<DropdownMenuItem onSelect={onNew}>New project…</DropdownMenuItem>}
      </DropdownMenuContent>
    );
  }
}
