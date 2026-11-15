import * as React from 'react';
import type { IdentityView, PersonRole, Receipt } from '@backbone-next/platform';
import { SharedListener } from './SharedListener';
import type { SharingView } from '../../lib/api';
import { call, onEvent } from '../../lib/api';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Input, Select } from '../ui/input';
import { Automations } from './PeopleAutomations';

export function PeopleRoles() {
  const [company,setCompany]=React.useState(false);
  React.useEffect(()=>{void window.backbone?.identityConfiguration?.().then(value=>setCompany(value.company)).catch(()=>{});},[]);
  const [view,setView]=React.useState<IdentityView>(),[role,setRole]=React.useState<'admin'|'member'|'guest'>('member'),[token,setToken]=React.useState(''),[busy,setBusy]=React.useState(false),[error,setError]=React.useState<string>();
  const [sharing,setSharing]=React.useState<SharingView>(),[link,setLink]=React.useState('');
  const [removing,setRemoving]=React.useState<{id:string;name:string}>();
  React.useEffect(()=>{void window.backbone?.sharingView?.().then(setSharing).catch(()=>{});},[]);
  const generation=React.useRef(0);
  const inFlight=React.useRef(false);
  const load=React.useCallback(async()=>{const request=++generation.current;try{const result=await call('identity.get',{});if(request===generation.current){if(result.ok)setView(result.value);else setError(prior=>prior??'People could not be loaded.');}}catch{if(request===generation.current)setError(prior=>prior??'People could not be loaded.');}},[]);
  React.useEffect(()=>{void load();const off=onEvent(event=>{if(event.topic==='identity')void load();});return()=>{generation.current++;off();};},[load]);
  async function act<T>(work:()=>Promise<Receipt<T>>,confirmed?:(value:T)=>void){
    if(inFlight.current)return;inFlight.current=true;setBusy(true);setError(undefined);
    try{const result=await work();if(result.ok)confirmed?.(result.value);else setError(result.outcome==='REFUSED'?`The change was refused. ${result.detail}`:'The change was not confirmed. Inspect the current people and roles before trying again.');}
    catch{setError('The change was not confirmed. Inspect the current people and roles before trying again.');}
    finally{await load();inFlight.current=false;setBusy(false);}
  }
  const administer=view?.person.role==='owner'||view?.person.role==='admin';
  return <div className="space-y-5 py-4 text-sm">
    {view&&company&&<Button variant="outline" onClick={()=>{void window.backbone?.openRemoteWorkspace?.().catch(()=>setError('Open the workspace from your signed-in local window.'));}}>Join a workspace on another computer</Button>}
    {view&&<p>You are {view.person.name} · <strong>{view.person.role}</strong></p>}
    {administer&&<>
      {view?.person.role==='owner'&&<SharedListener onChange={value=>{setSharing(value);setLink('');}} />}
      <p>Owners and admins invite people and manage roles. Members work in projects shared with them. Guests only view shared projects.</p>
      <label className="block">Invitation role<Select value={role} disabled={busy} onChange={event=>setRole(event.target.value as typeof role)}><option value="member">Member</option><option value="guest">Guest</option><option value="admin">Admin</option></Select></label>
      <Button disabled={busy} onClick={()=>void act(async()=>{if(sharing?.enabled&&window.backbone?.createJoinLink){const result=await window.backbone.createJoinLink(role);return {ok:true,value:{link:result.link,token:''}};}const result=await call('identity.invite',{role});return result.ok?{ok:true,value:{link:'',token:result.value.token}}:result;},value=>{setLink(value.link);setToken(value.token);})}>Create invitation</Button>
      {link&&sharing?.enabled&&<label className="block">Join link<Input aria-label="Join link" readOnly value={link} /><Button variant="outline" onClick={()=>void navigator.clipboard.writeText(link)}>Copy join link</Button><span className="block text-xs text-muted">Give this private, one-use link to the person. It expires in 24 hours.</span></label>}
      {token&&<label className="block">Invitation code<Input aria-label="Invitation code" readOnly value={token} className="font-mono" /><span className="text-xs text-muted">Give this one-use code to the person. It expires in 24 hours.</span></label>}
      <ul className="space-y-3">{view.people.map(person=><li key={person.id} id={`person-${person.id}`} tabIndex={-1} className="flex flex-wrap items-center gap-2 border-t border-border pt-3 outline-none">
        <span className="min-w-0 flex-1 break-words">{person.name}{person.status==='removed'&&' · Removed'}</span>
        <Select aria-label={`Role for ${person.name}`} value={person.role} disabled={busy||person.status==='removed'||(person.role==='owner'&&view.person.role!=='owner')} onChange={event=>void act(()=>call('identity.role',{personId:person.id,role:event.target.value as PersonRole}))}>
          <option value="owner" disabled={view.person.role!=='owner'}>Owner</option><option value="admin">Admin</option><option value="member">Member</option><option value="guest">Guest</option>
        </Select>
        <Button variant="danger" aria-label={`Remove ${person.name}`} disabled={busy||person.status==='removed'||person.id===view.person.id} onClick={()=>setRemoving({id:person.id,name:person.name})}>Remove</Button>
      </li>)}</ul>
      {view.person.role==='owner'&&(view.recoveries??[]).map((entry,index)=><p key={index}>{view.people.find(person=>person.id===entry.person)?.name??'Device owner'} restored access on this Mac · {new Date(entry.at).toLocaleString()}</p>)}
      <Automations people={view.people.filter(person=>person.status==='active'&&person.role!=='guest')} />
    </>}
    {window.backbone?.openSignInWindow&&<Button variant="outline" onClick={()=>void window.backbone!.openSignInWindow!()}>Open sign-in window</Button>}
    {error&&<p role="alert" className="text-danger">{error}</p>}
    <ConfirmDialog open={!!removing} onOpenChange={open=>{if(!open)setRemoving(undefined);}} title={`Remove ${removing?.name??''}?`}
      consequence={`${removing?.name??'This person'} loses access to this workspace now, and their session on their computer ends. This cannot be undone from here.`} action={`Remove ${removing?.name??''}`}
      onConfirm={()=>act(()=>call('identity.remove',{personId:removing!.id}))} restoreFocus={()=>document.getElementById(`person-${removing?.id}`)} />
  </div>;
}
