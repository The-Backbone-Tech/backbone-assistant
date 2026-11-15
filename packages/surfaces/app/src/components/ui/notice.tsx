import * as React from 'react';
import {X} from 'lucide-react';
import {Button} from './button';

/** A reversible change stays keyboard reachable; its timer pauses while the person uses it. */
export function Notice({children,onDismiss,duration=12000}:{children:React.ReactNode;onDismiss():void;duration?:number}) {
  const returnFocus=React.useRef<HTMLElement|null>(null);
  const [hovered,setHovered]=React.useState(false),[focused,setFocused]=React.useState(false);
  React.useEffect(()=>{if(hovered||focused)return;const timer=setTimeout(onDismiss,duration);return()=>clearTimeout(timer);},[hovered,focused,onDismiss,duration]);
  return <div role="status" aria-live="polite" aria-atomic="true" className="flex items-center gap-2 rounded-md border border-border bg-surface p-3 text-sm shadow-sm"
    onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)} onFocusCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget)&&event.relatedTarget instanceof HTMLElement)returnFocus.current=event.relatedTarget;setFocused(true);}} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget))setFocused(false);}}>
    <div className="max-h-[50vh] min-w-0 flex-1 overflow-y-auto break-words">{children}</div>
    <Button variant="ghost" size="icon-sm" aria-label="Dismiss notice" tip onClick={()=>{onDismiss();const target=returnFocus.current;setTimeout(()=>{if(document.activeElement===document.body&&target?.isConnected)target.focus();});}}><X /></Button>
  </div>;
}
