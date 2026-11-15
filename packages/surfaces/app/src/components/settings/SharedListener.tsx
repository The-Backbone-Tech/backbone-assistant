import * as React from 'react';
import type { SharingView } from '../../lib/api';
import { Input, Select } from '../ui/input';
import { Button } from '../ui/button';

// When sharing could not start because the saved address is gone, offer a current address instead of the stale one.
export function withCurrentAddress(value:SharingView):SharingView {
  return !value.enabled&&value.notice&&!value.addresses.includes(value.address)&&value.addresses[0]?{...value,address:value.addresses[0]}:value;
}

export function SharedListener({onChange}:{onChange(view:SharingView):void}) {
  const [requested,setRequested]=React.useState<boolean>();
  const [view,setView]=React.useState<SharingView>(),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
  function show(value:SharingView){setView(withCurrentAddress(value));onChange(value);}
  React.useEffect(()=>{void window.backbone?.sharingView?.().then(show).catch(()=>{});},[]);
  async function change(enabled:boolean){if(!view||busy)return;setBusy(true);setRequested(enabled);setError('');try{show(await window.backbone!.configureSharing!({enabled,address:view.address,port:view.port}));}catch{setError('Sharing could not change. Check the address and port, then try again.');void window.backbone?.sharingView?.().then(show);}finally{setBusy(false);setRequested(undefined);}}
  if(!view)return null;
  return <SharingPanel view={view} requested={requested} busy={busy} error={error} onToggle={value=>void change(value)} onAddress={address=>setView({...view,address})} onPort={port=>setView({...view,port})} />;
}

export function SharingPanel({view,requested,busy,error,onToggle,onAddress,onPort}:{view:SharingView;requested?:boolean;busy:boolean;error:string;onToggle(enabled:boolean):void;onAddress(address:string):void;onPort(port:number):void}) {
  return <section className="space-y-3 border-b border-border pb-4" aria-label="Other computers">
    <label className="flex items-center gap-2"><input type="checkbox" checked={requested??view.enabled} disabled={busy} onChange={event=>onToggle(event.target.checked)} />Let people on other computers connect</label>
    {!view.enabled&&view.notice&&<p role="status">{view.notice}</p>}
    <p>People on that network who have an invitation can connect while the app is running.</p>
    {(view.engineRefusesColleagues||view.engineNotice)&&<p role="note" data-testid="engine-notice">{view.engineNotice && <>{view.engineNotice} </>}Colleagues can join and read what is shared with them, but their messages are refused until you configure a model for shared work. In Settings › AI and models › Shared work, choose a key, a gateway or a local model; or close the app, run <code>backbone model shared local --endpoint &lt;loopback-url&gt; --model &lt;id&gt;</code> in a terminal, then open it again. Your own engine and model stay selected on this computer.</p>}
    <label className="block">Computer address<Select aria-label="Computer address" value={view.address} disabled={busy||view.enabled} onChange={event=>onAddress(event.target.value)}>{[...new Set([view.address,...view.addresses])].map(address=><option key={address}>{address}</option>)}</Select></label>
    <label className="block">Port<Input type="number" min={1} max={65535} value={view.port} disabled={busy||view.enabled} onChange={event=>onPort(Number(event.target.value))} /></label>
    {view.enabled&&<><p role="status">Sharing is on at <span className="break-all">{view.origin}</span>.</p><p>Certificate SHA-256: <span className="break-all font-mono">{view.fingerprint}</span></p></>}
    {view.enabled&&view.notice&&<p role="status">{view.notice}</p>}{error&&<p role="alert">{error}</p>}
    {!view.enabled&&error&&<Button variant="outline" disabled={busy} onClick={()=>onToggle(true)}>Try sharing again</Button>}
  </section>;
}
