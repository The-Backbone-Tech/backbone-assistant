import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTurnCarrier } from '../src/composition/turn-carrier.ts';
import type { Turn } from '../src/api.ts';
import type { StoredThread } from '../src/composition/thread-journal.ts';
import type { CoreLink, RunHandle } from '../src/composition/core.ts';

// Exercise the carrying boundary without any identity-host caller check or model transport.
for(const resumed of [false,true]) test(`the carrier refuses a restricted identity on a tool-bringing engine (${resumed?'resume':'new turn'})`, async () => {
  let started=0;
  const turn={id:'turn',status:'running',user:{text:'Work'},work:{steps:[]},effects:[],...(resumed?{completed:true,answer:{text:'Original answer',files:[]}}:{})} as unknown as Turn;
  const thread={summary:{id:'thread',projectId:'project',running:true},personId:'colleague',turns:[turn]} as StoredThread;
  const noop=()=>{};
  const deps={home:'unused',restricted:true,harnessId:'harness-codex',harnessPiece:{manifest:{capabilities:{nativeTools:'account'}}},engine:{start(){started++;throw new Error('unsafe native start');}},
    inflight:new Set(),carriers:new Map(),running:new Map(),parallel:{drain:async()=>{},closed:noop,ended:noop},
    checkpointsFor:()=>({load:()=>null}),admission:{check:noop},memory:{learn:async()=>{}},goalRuns:{judged:noop,ended:noop},proactivity:{ended:noop},triggers:{ended:noop},board:{ended:noop},saveThread:async()=>{},emit:noop,classify:async()=>{}} as unknown as Parameters<typeof createTurnCarrier>[0];
  const link={id:{person:'colleague'},identities:{devicePerson:'owner'}} as CoreLink;
  await createTurnCarrier(deps)(link,thread,turn,[],new AbortController(),Promise.resolve(undefined as unknown as RunHandle),resumed);
  assert.equal(started,0);
  assert.equal(turn.status,resumed?'done':'refused',JSON.stringify(turn));
  if(resumed){assert.equal(turn.answer?.text,'Original answer');assert.match(turn.work.steps.at(-1)?.label??'',/Recovery did not start/);}
  else assert.match(turn.refusal?.detail??'',/was not sent.*shared model/);
});

// The owner on their own computer under a tool-bringing engine, sending into an automation's conversation.
for(const person of ['owner','colleague']) test(`the refusal for an automation conversation is worded for ${person}`, async () => {
  const turn={id:'turn',status:'running',user:{text:'Work'},work:{steps:[]},effects:[]} as unknown as Turn;
  const thread={summary:{id:'thread',projectId:'project',running:true},personId:person,automationId:'automation',turns:[turn]} as StoredThread;
  const noop=()=>{};
  const deps={home:'unused',restricted:false,harnessId:'harness-codex',harnessPiece:{manifest:{capabilities:{nativeTools:'account'}}},engine:{start(){throw new Error('unsafe native start');}},
    inflight:new Set(),carriers:new Map(),running:new Map(),parallel:{drain:async()=>{},closed:noop,ended:noop},
    checkpointsFor:()=>({load:()=>null}),admission:{check:noop},memory:{learn:async()=>{}},goalRuns:{judged:noop,ended:noop},proactivity:{ended:noop},triggers:{ended:noop},board:{ended:noop},saveThread:async()=>{},emit:noop,classify:async()=>{}} as unknown as Parameters<typeof createTurnCarrier>[0];
  const link={id:{person},identities:{devicePerson:'owner'}} as CoreLink;
  await createTurnCarrier(deps)(link,thread,turn,[],new AbortController(),Promise.resolve(undefined as unknown as RunHandle),false);
  assert.equal(turn.status,'refused');
  const text=turn.refusal?.detail??'';
  if(person==='owner'){assert.match(text,/belongs to an automation.*shared-work model.*Settings › AI and models › Shared work.*start a new conversation/);assert.doesNotMatch(text,/workspace owner must/);}
  else{assert.match(text,/workspace owner must configure a shared model/);assert.doesNotMatch(text,/belongs to an automation/);}
});
