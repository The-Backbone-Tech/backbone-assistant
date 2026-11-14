import * as React from 'react';
import type { WorkspacePerson, AutomationIdentity } from '@backbone-next/platform';
import { call,onEvent } from '../../lib/api';
import { useApp } from '../../lib/state';
import { Button } from '../ui/button';
import { Input,Select } from '../ui/input';

export function Automations({people}:{people:WorkspacePerson[]}) {
  const {projects,selectThread}=useApp();
  const [items,setItems]=React.useState<AutomationIdentity[]>([]),[person,setPerson]=React.useState(''),[project,setProject]=React.useState(''),[name,setName]=React.useState(''),[brief,setBrief]=React.useState(''),[busy,setBusy]=React.useState(false),[error,setError]=React.useState<string>();
  const generation=React.useRef(0);
  const load=React.useCallback(async()=>{const request=++generation.current;try{const result=await call('identity.automations',{});if(result.ok&&request===generation.current)setItems(result.value);}catch{if(request===generation.current)setError('Automations could not be loaded.');}},[]);
  React.useEffect(()=>{void load();const off=onEvent(event=>{if(event.topic==='identity')void load();});return()=>{generation.current++;off();};},[load]);
  async function act(work:()=>Promise<unknown>){if(busy)return;setBusy(true);setError(undefined);try{await work();await load();}catch{setError('The automation change was not confirmed. Inspect its record before trying again.');}finally{setBusy(false);}}
  return <section className="space-y-3 border-t border-border pt-4" aria-label="Automation identities">
    <h3 className="font-semibold">Automation identities</h3><p>A helper acts for the named person in one project. Revoking it stops its running work and does not create a replacement permission.</p>
    <label className="block">Automation name<Input value={name} disabled={busy} onChange={event=>setName(event.target.value)} /></label>
    <label className="block">Acts for<Select value={person} disabled={busy} onChange={event=>setPerson(event.target.value)}><option value="">Choose a person</option>{people.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</Select></label>
    <label className="block">Automation project<Select value={project} disabled={busy} onChange={event=>setProject(event.target.value)}><option value="">Choose a project</option>{projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</Select></label>
    <Button disabled={busy||!name.trim()||!person||!project} onClick={()=>void act(()=>call('identity.automation.create',{personId:person,projectId:project,name:name.trim()}))}>Create automation</Button>
    <label className="block">Automation task<Input value={brief} disabled={busy} onChange={event=>setBrief(event.target.value)} /></label>
    <ul className="space-y-2">{items.map(item=><li key={item.id} className="flex flex-wrap items-center gap-2"><span className="flex-1">{item.name} · {people.find(person=>person.id===item.person)?.name??'Former member'}{item.revoked&&' · Revoked'}</span>
      <Button variant="outline" disabled={busy||item.revoked||!brief.trim()} onClick={()=>void act(async()=>{const result=await call('identity.automation.run',{id:item.id,text:brief});if(!result.ok)throw new Error();selectThread(result.value.threadId);})}>Run {item.name}</Button>
      <Button variant="outline" disabled={busy||item.revoked} onClick={()=>void act(()=>call('identity.automation.revoke',{id:item.id}))}>Revoke {item.name}</Button>
    </li>)}</ul>{error&&<p role="alert" className="text-danger">{error}</p>}
  </section>;
}
