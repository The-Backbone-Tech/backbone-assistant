import * as React from 'react';
import type { Result, WorkspacePerson } from '@backbone-next/platform';
import { call,onEvent } from '../../lib/api';
import { useApp } from '../../lib/state';
import { Button } from '../ui/button';
import { Select } from '../ui/input';

type Sharing=Extract<Result<'identity.sharing'>,{ok:true}>['value'];
export function ProjectSharing() {
  const {projects}=useApp();
  const [project,setProject]=React.useState(''),[person,setPerson]=React.useState(''),[permission,setPermission]=React.useState<'viewer'|'editor'|'remove'>('viewer'),[snapshot,setSnapshot]=React.useState<{id:string;view:Sharing}>(),[busy,setBusy]=React.useState(false),[error,setError]=React.useState<string>(),[notice,setNotice]=React.useState('');
  const generation=React.useRef(0);
  const selected=project||projects[0]?.id||'';
  const load=React.useCallback(async()=>{const request=++generation.current;if(!selected){setSnapshot(undefined);return;}try{const result=await call('identity.sharing',{projectId:selected});if(request===generation.current){if(result.ok)setSnapshot({id:selected,view:result.value});else setError('Sharing could not be loaded.');}}catch{if(request===generation.current)setError('Sharing could not be loaded.');}},[selected]);
  React.useEffect(()=>{setSnapshot(undefined);setPerson('');setNotice('');setError(undefined);void load();const off=onEvent(event=>{if(event.topic==='identity')void load();});return()=>{generation.current++;off();};},[load]);
  const view=snapshot?.id===selected?snapshot.view:undefined;
  const people=(view?.people??[]).filter(person=>person.status==='active');
  function choosePerson(id:string){setPerson(id);setPermission(view?.grants.find(grant=>grant.person===id)?.access??'viewer');setNotice('');}
  async function save(){if(busy||!person||!view)return;setBusy(true);setError(undefined);const id=selected,request=generation.current;try{const result=await call('identity.share',{projectId:id,personId:person,access:permission==='remove'?null:permission});if(!result.ok)throw new Error();if(request===generation.current){setNotice('Project sharing saved.');await load();}}catch{if(request===generation.current)setError('Sharing was not confirmed. Inspect the project permissions before trying again.');}finally{setBusy(false);}}
  return <div className="space-y-4 py-4 text-sm">
    <label className="block">Shared project<Select aria-label="Shared project" value={selected} disabled={busy} onChange={event=>setProject(event.target.value)}><option value="">Choose a project</option>{projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</Select></label>
    {view&&<p>Your project access: <strong>{view.access}</strong></p>}
    {view?.access==='owner'&&<>
      <p>Viewer sharing gives access to this project only. Viewers cannot edit files, send work or change its sharing.</p>
      <label className="block">Share with<Select aria-label="Share with" value={person} disabled={busy} onChange={event=>choosePerson(event.target.value)}><option value="">Choose a person</option>{people.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</Select></label>
      <label className="block">Project permission<Select aria-label="Project permission" value={permission} disabled={busy} onChange={event=>setPermission(event.target.value as typeof permission)}><option value="viewer">Viewer</option><option value="editor" disabled={people.find(row=>row.id===person)?.role==='guest'}>Editor</option><option value="remove">Remove access</option></Select></label>
      <Button disabled={busy||!person} onClick={()=>void save()}>Save sharing</Button>
      <ul>{view.grants.map(grant=><li key={grant.person}>{people.find(person=>person.id===grant.person)?.name??'Former member'} · {grant.access}</li>)}</ul>
    </>}
    {notice&&<p role="status">{notice}</p>}{error&&<p role="alert" className="text-danger">{error}</p>}
  </div>;
}
