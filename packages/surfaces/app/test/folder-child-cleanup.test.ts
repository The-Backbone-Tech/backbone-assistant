import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { stopFixtureChildren } from '../e2e/folder-child-cleanup.ts';

test('fixture child cleanup bounds SIGTERM and SIGKILL waits',async()=>{
  const signals:string[]=[];
  const child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,kill(signal:string){signals.push(signal);if(signal==='SIGKILL')queueMicrotask(()=>child.emit('exit'));}});
  const state=globalThis as unknown as {restoredChildren:unknown[]};state.restoredChildren=[child];
  try{await stopFixtureChildren(undefined,2);assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(child.listenerCount('exit'),0);}
  finally{state.restoredChildren=[];}
});
test('fixture child cleanup reports an unconfirmed exit instead of waiting forever',async()=>{
  const child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,kill(){}});
  const state=globalThis as unknown as {restoredChildren:unknown[]};state.restoredChildren=[child];
  try{await assert.rejects(stopFixtureChildren(undefined,2),/did not confirm exit/);assert.equal(child.listenerCount('exit'),0);}
  finally{state.restoredChildren=[];}
});
