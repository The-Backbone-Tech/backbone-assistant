import * as React from 'react';
import type { IdentityConfiguration } from '../../lib/api';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export function IdentityEntry() {
  const [name,setName]=React.useState(''),[invitation,setInvitation]=React.useState(''),[busy,setBusy]=React.useState(false),[error,setError]=React.useState<string>();
  const [configuration,setConfiguration]=React.useState<IdentityConfiguration>();
  const [remote,setRemote]=React.useState(false);
  React.useEffect(()=>{let active=true;void window.backbone?.identityConfiguration?.().then(value=>{if(active){setConfiguration(value);if(value.company&&value.workspaceWindow)setRemote(true);}}).catch(()=>{});return()=>{active=false;};},[]);
  async function join(company:boolean) {
    if(busy)return;setBusy(true);setError(undefined);
    try {
      const bridge=window.backbone;
      const result=remote?await bridge?.joinRemoteWorkspace?.(invitation.trim(),name.trim()):company?await bridge?.companySignIn?.(invitation.trim()||undefined):await bridge?.acceptInvitation?.(invitation.trim(),name.trim());
      if(!result?.ok)setError('Sign-in was not confirmed. Inspect membership before trying again.');
    }catch(error){setError(remote?`Joining was not confirmed. ${String(error)}`:'Sign-in was not confirmed. Your current edits are kept. Inspect membership before trying again.');}
    finally{setBusy(false);}
  }
  return <section className="space-y-3 text-sm" aria-label="Workspace sign-in">
    <h1 className="text-lg font-semibold">Workspace sign-in</h1>
    {configuration?.remote?.connection==='ended'&&<p role="status">Your workspace access ended. Sign in again.</p>}
    {!configuration?.company&&window.backbone?.joinRemoteWorkspace&&<Button variant="outline" onClick={()=>{setRemote(value=>!value);setInvitation('');setError(undefined);}}>{remote?'Use a local invitation code':'Join a workspace…'}</Button>}
    {remote?<p>Paste the private join link from the owner. This workspace runs on their computer; your local work stays in its own window.</p>:<p>An invitation code is a bearer secret: anyone holding it can use it once. Keep it private. Your account receives only the role and project permissions assigned by the workspace.</p>}
    {(remote||!configuration?.company)&&<><label className="block">Your name<Input value={name} onChange={event=>setName(event.target.value)} disabled={busy} autoComplete="name" /></label></>}
    <label className="block">{remote?'Join link':'Invitation code'}<Input value={invitation} onChange={event=>setInvitation(event.target.value)} disabled={busy} autoComplete="off" /></label>
    {configuration&&(remote||!configuration.company)&&<Button disabled={busy||!name.trim()||!invitation.trim()} onClick={()=>void join(false)}>Join workspace</Button>}
    {configuration?.company&&!remote&&<Button variant="outline" disabled={busy} onClick={()=>void join(true)}>Company sign-in</Button>}
    {error&&<p role="alert" className="text-danger">{error}</p>}
  </section>;
}
