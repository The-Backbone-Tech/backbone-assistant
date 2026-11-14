// Shared windows expose the authenticated conversation API only. Draft custody and
// shutdown use the same ordered writer as the local composer.
import * as React from 'react';
import type { Thread, TurnSettings } from '@backbone-next/platform';
import { call, clientKey } from '../lib/api';
import { useApp, useLive } from '../lib/state';
import { acceptDraftRead, persistDraft, persistDraftNow, readDraft, trackDraftOperation } from '../lib/drafts';
import { Answer } from './Answer';
import { settleSharedSend } from '../lib/shared-send-recovery';
import { Button } from './ui/button';

export function SharedComposer({projectId,threadId,running,onSent,readOnly=false}:{projectId?:string;threadId?:string;running?:boolean;onSent?:(id:string)=>void;readOnly?:boolean}) {
  const {projects,models,selectThread}=useApp();
  const selected=projectId??projects[0]?.id;
  const viewer=readOnly||projects.find(project=>project.id===selected)?.access==='viewer';
  const key=`composer:${threadId??`home:${selected??'none'}`}`;
  const [text,setText]=React.useState(''),[loaded,setLoaded]=React.useState(false),[busy,setBusy]=React.useState(false),[problem,setProblem]=React.useState(''),[unknown,setUnknown]=React.useState(false);
  const attempt=React.useRef<string|undefined>(undefined),inflight=React.useRef(false);
  const current=React.useRef(key);current.current=key;
  React.useEffect(()=>{let live=true;setLoaded(false);setProblem('');setUnknown(false);attempt.current=undefined;void readDraft(key).then(draft=>{
    if(!live)return;acceptDraftRead(key,draft?.revision??0);setText(draft?.text??'');
    if(draft?.meta?.sendKey){attempt.current=String(draft.meta.sendKey);setUnknown(true);setProblem('Unknown outcome. Read the conversation and check its messages before starting new work. Nothing was resent.');}
    setLoaded(true);
  }).catch(()=>{if(live)setProblem('The draft could not be loaded. Check the connection; your saved draft is kept.');});return()=>{live=false;};},[key]);
  const settling=React.useRef(false),checkedPending=React.useRef(false);
  async function settle(checked:boolean){
    const sendKey=attempt.current,ownKey=key;
    if(!sendKey||inflight.current||!unknown)return;
    if(settling.current){if(checked)checkedPending.current=true;return;}
    settling.current=true;
    try {
      const found=await trackDraftOperation(()=>settleSharedSend(sendKey,checked,{
        find:async()=>{
          const threads=threadId?[{id:threadId}]:await call('threads.list',{}).then(items=>items.filter(item=>item.projectId===selected));
          for(const item of threads){const result=await call('threads.get',{id:item.id});if(result.ok&&result.value.turns.some(turn=>turn.clientKey===sendKey))return item.id;}
          return undefined;
        },
        release:async()=>{if(!window.backbone?.remoteSendChecked)throw new Error('Submission inspection is unavailable.');await window.backbone.remoteSendChecked(sendKey);},
        clear:async()=>{await persistDraftNow(ownKey,'');},
      }));
      if(found!==undefined&&current.current===ownKey&&attempt.current===sendKey){
        attempt.current=undefined;setText('');setUnknown(false);setProblem('');
      }
    }catch{if(current.current===ownKey)setProblem('The submission could not be cleared. Check the connection; nothing was resent.');}
    finally{settling.current=false;if(checkedPending.current){checkedPending.current=false;void settle(true);}}
  }
  React.useEffect(()=>{
    if(!unknown||busy)return;
    void settle(false);
    const timer=setInterval(()=>void settle(false),5_000);
    return()=>clearInterval(timer);
  },[unknown,busy,key,threadId,selected]);
  function send(){
    if(inflight.current||!loaded||viewer||unknown||running||!selected||!text.trim())return;
    inflight.current=true;setBusy(true);setProblem('');
    const ownKey=key,words=text,sendKey=clientKey();attempt.current=sendKey;
    void trackDraftOperation(async()=>{
      // An interrupted submission remains inspectable and cannot be sent a second time.
      await persistDraftNow(ownKey,words,{sendKey,sendHow:'send'});
      const model=models[0];
      const settings:TurnSettings={permission:model?.permissions?.[0]??'ask',model:model?.id??'stub',effort:model?.efforts?.[0]??3,runsOn:'this-computer',mode:'chat',memory:'off'};
      let receipt;
      try {receipt=await call('turns.send',{projectId:selected,threadId,text:words,attachments:[],settings,clientKey:sendKey});}
      catch(error){if(current.current===ownKey){setUnknown(true);setProblem(String(error));}return;}
      if(!receipt.ok){
        if(current.current!==ownKey)return;
        setUnknown(receipt.outcome==='UNKNOWN');setProblem(receipt.detail);
        if(receipt.outcome!=='UNKNOWN'){attempt.current=undefined;await persistDraftNow(ownKey,words);}
        return;
      }
      await persistDraftNow(ownKey,'');
      if(current.current===ownKey){setText('');setUnknown(false);attempt.current=undefined;onSent?.(receipt.value.threadId);selectThread(receipt.value.threadId);}
    }).catch(()=>{if(current.current===ownKey){setUnknown(true);setProblem('The message or its draft has an unknown outcome. Inspect the conversation before starting new work. Nothing will be resent.');}}).finally(()=>{inflight.current=false;setBusy(false);});
  }
  return <div className="space-y-2" data-testid="composer">
    {viewer&&<p role="status" className="text-xs text-muted">Viewer access: this project is read only.</p>}
    {!selected&&<p role="status" className="text-sm text-muted">Ask the owner to share a project with you.</p>}
    <label className="sr-only" htmlFor={`shared-${key}`}>Message</label>
    <textarea id={`shared-${key}`} value={text} disabled={!loaded||viewer||busy||unknown||!selected} className="min-h-24 w-full rounded-xl border border-border bg-surface p-3" placeholder="Message this workspace" onChange={event=>{
      const value=event.target.value;setText(value);void persistDraft(key,value).catch(()=>setProblem('The draft could not be saved. Keep this window open and check the connection.'));
    }} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();send();}}} />
    <div className="flex items-center justify-end gap-2"><span className="text-xs text-muted">Runs on the owner’s computer</span>{running?<span role="status">Working…</span>:<Button disabled={!loaded||viewer||busy||unknown||!selected||!text.trim()} onClick={send}>Send</Button>}</div>
    {problem&&<p role="alert" className="text-sm text-danger">{problem}</p>}
    {unknown&&<div className="space-y-2"><p className="text-sm">Unknown outcome. Inspect Chats for this message and its answer. The app kept the submission and will not resend it.</p><Button variant="outline" disabled={busy} onClick={()=>void settle(true)}>I checked the conversation</Button></div>}
  </div>;
}

export function SharedConversation({id}:{id:string}) {
  const thread=useLive(async()=>{const result=await call('threads.get',{id});return result.ok?result.value:null;},[id],null as Thread|null);
  const bottom=React.useRef<HTMLDivElement>(null);
  React.useEffect(()=>{bottom.current?.scrollIntoView({block:'end'});},[thread?.turns.at(-1)?.answer?.text,thread?.turns.length]);
  if(!thread)return <p role="status" className="p-4 text-sm text-muted">Loading conversation…</p>;
  return <div className="flex min-h-0 flex-1 flex-col">
    <h1 className="sr-only">{thread.summary.title}</h1>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3"><div className="mx-auto max-w-3xl space-y-5">{thread.turns.map(turn=><article key={turn.id} className="space-y-3" data-testid="turn">
      <p className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-xl bg-sunken p-3">{turn.user.text}</p>
      {turn.work.steps.length>0&&<details open={turn.status==='running'}><summary className="cursor-pointer text-sm text-muted">{turn.status==='running'?'Working…':'Work details'}</summary><ul className="text-xs text-muted">{turn.work.steps.map((step,index)=><li key={index}>{step.label}</li>)}</ul></details>}
      {turn.answer&&<div data-testid="answer" className="reading"><Answer text={turn.answer.text} streaming={turn.status==='running'} projectId={thread.summary.projectId} /></div>}
      {turn.unknownOutcome&&<p role="status">Unknown outcome. Inspect this conversation and its work before starting new work. Nothing was resent.</p>}
    </article>)}<div ref={bottom} /></div></div>
    <div className="mx-auto w-full max-w-3xl p-4"><SharedComposer key={id} projectId={thread.summary.projectId} threadId={id} running={thread.summary.running} readOnly={thread.summary.access!=='editor'} /></div>
  </div>;
}
