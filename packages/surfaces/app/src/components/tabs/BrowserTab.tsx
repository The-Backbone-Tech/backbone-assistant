import * as React from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, Square } from 'lucide-react';
import type { BrowserRequest, BrowserState } from '../../lib/browser-types';
import { Button } from '../ui/button';
import { isMac } from '../../lib/api';
import { Tip } from '../ui/tooltip';
import { Input } from '../ui/input';

// Renderer-session draft only: closing a tab does not discard an unfinished address.
let retainedAddress = '';
let navigatedUrl = '';
const EMPTY: BrowserState = { url: '', title: 'Browser', phase: 'empty', back: false, forward: false };
export function BrowserTab({ active, onTitle }: { active: boolean; onTitle(title: string): void }) {
  const [state, setState] = React.useState(EMPTY);
  const [address, setAddress] = React.useState(retainedAddress);
  const [unconfirmed, setUnconfirmed] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  const area = React.useRef<HTMLDivElement>(null);
  const previousUrl = React.useRef(navigatedUrl);
  const receive = React.useCallback((next: BrowserState) => {
    setState(next); onTitle(next.title);
    if (next.url !== previousUrl.current) { setAddress(next.url); retainedAddress = next.url; navigatedUrl = next.url; previousUrl.current = next.url; }
  }, [onTitle]);
  const request = React.useCallback(async (command: BrowserRequest) => {
    try {
      if (!window.backbone?.browserRequest) { setState({ ...EMPTY, phase: 'blocked', detail: 'Open the desktop app to browse beside your work.' }); return; }
      receive(await window.backbone.browserRequest(command)); setUnconfirmed(false);
    } catch { setUnconfirmed(true); }
  }, [receive]);
  React.useEffect(() => {
    const off = window.backbone?.onBrowserState?.(receive);
    const focus = window.backbone?.onBrowserFocusAddress?.(() => { input.current?.focus(); input.current?.select(); });
    void request({ action: 'state' });
    return () => { off?.(); focus?.(); };
  }, [receive, request]);
  React.useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [active]);
  React.useEffect(() => {
    let previous = '';
    const update = () => {
      const r = area.current?.getBoundingClientRect();
      if (!r) return;
      // Native child views sit above DOM portals: hide while app menus or dialogs own the surface.
      const overlay = !!document.querySelector('[role=dialog], [role=alertdialog], [role=menu], [role=alert].fixed, [role=listbox][data-state=open]');
      const bounds = { x: r.x, y: r.y, width: r.width, height: r.height };
      const visible = active && !overlay && !document.hidden;
      const key = JSON.stringify({bounds,visible});
      if (key === previous) return;
      previous = key;
      void window.backbone?.browserRequest?.({action:'layout',bounds,visible}).catch(() => setUnconfirmed(true));
    };
    const resize = new ResizeObserver(update); if (area.current) resize.observe(area.current);
    const mutations = new MutationObserver(update); mutations.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-state','hidden','class','style']});
    window.addEventListener('resize',update); document.addEventListener('visibilitychange',update); update();
    return () => { resize.disconnect(); mutations.disconnect(); window.removeEventListener('resize',update); document.removeEventListener('visibilitychange',update); void window.backbone?.browserRequest?.({action:'layout',visible:false,bounds:{x:0,y:0,width:0,height:0}}).catch(() => {}); };
  }, [active]);
  const loading = state.phase === 'loading';
  return <section aria-label="Browser" className="flex h-full min-w-0 flex-col" data-testid="browser-tab">
    <form onSubmit={event => { event.preventDefault(); if (!address.trim()) return; void request({action:'navigate',url:address,typed:true}); }} className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Back" tip disabled={!state.back} onClick={() => void request({action:'back'})}><ArrowLeft /></Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Forward" tip disabled={!state.forward} onClick={() => void request({action:'forward'})}><ArrowRight /></Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={loading ? 'Stop loading' : 'Reload'} tip shortcut={loading ? undefined : isMac() ? '⌘R' : 'Ctrl+R'} disabled={!state.url} onClick={() => void request({action:loading?'stop':'reload'})}>{loading ? <Square /> : <RotateCw />}</Button>
      <Tip label="Page address" shortcut={isMac() ? '⌘L · Escape' : 'Ctrl+L · Escape'}><Input ref={input} maxLength={8192} type="text" inputMode="url" aria-label="Page address" placeholder="https://…" value={address} onChange={event => {setAddress(event.target.value); retainedAddress = event.target.value;}} className="h-7 min-w-0 flex-1 text-xs" /></Tip>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Open in my browser" tip disabled={!state.url} onClick={() => void request({action:'external'})}><ExternalLink /></Button>
    </form>
    {loading && <p role="status" className="border-b border-border px-3 py-1 text-xs text-muted">Loading page…</p>}
    {unconfirmed && <p role="alert" className="px-3 py-2 text-sm text-danger">Browser state is not known. Check the page before trying the action again. <button className="underline" onClick={() => void request({action:'state'})}>Check state</button></p>}
    {state.detail && ['ready','loading'].includes(state.phase) && <p role="status" className="px-3 py-2 text-xs text-muted">{state.detail}</p>}
    <div ref={area} className="min-h-0 flex-1" tabIndex={state.phase === 'ready' ? 0 : -1} aria-label="Page content; press Escape to return to the address" onFocus={() => void request({action:'focus'})}>
      {!['ready','loading'].includes(state.phase) && <div className="space-y-3 p-4 text-sm">
        <p className="font-medium">{state.phase === 'empty' ? 'Open a page beside your work' : state.phase === 'blocked' ? 'Page blocked' : state.phase === 'stopped' ? 'Loading stopped' : 'Page could not load'}</p>
        <p role={state.phase === 'empty' ? undefined : 'alert'} className="text-muted">{state.detail ?? 'Enter an HTTP or HTTPS address above.'}</p>
        {state.phase === 'failed' && state.technical && <details className="text-xs text-muted"><summary className="cursor-pointer">Details</summary><p className="mt-1 font-mono" data-testid="browser-failure-code">{state.technical}</p></details>}
        {state.phase === 'failed' && <Button size="sm" variant="outline" onClick={() => void request({action:'navigate',url:address,typed:true})}>Retry</Button>}
        {state.phase === 'stopped' && <Button size="sm" variant="outline" onClick={() => void request({action:'reload'})}>Reload</Button>}
        <p className="text-xs text-muted">Pages you open here are yours; the assistant does not see them</p>
      </div>}
    </div>
  </section>;
}
