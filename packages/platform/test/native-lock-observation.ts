import { hangDetector } from '../../../scripts/lib/test-hang.ts';
// Observe the real primitive or invalidate its named inode; never manufacture an abort signal.
import assert from 'node:assert/strict';
import {fstatSync,lstatSync,renameSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import type {TestContext} from 'node:test';
import {withHomeLock} from '../src/composition/home-lock.ts';

export function observeNativeHomeLocks(t:TestContext,home:string,onAttempt:()=>void):void {
 const require=createRequire(import.meta.resolve('@backbone-next/kernel/home-lock'));
 const entry=require.resolve('fs-native-extensions');
 const native=require(join(dirname(entry),'prebuilds',`${process.platform}-${process.arch}`,'fs-native-extensions.node')) as {tryLock(fd:number,offset:number,length:number,exclusive:boolean):void};
 const original=native.tryLock;
 t.mock.method(native,'tryLock',(...args:Parameters<typeof original>)=>{
  try{return original(...args);}finally{
   const actual=fstatSync(args[0],{bigint:true}),named=lstatSync(join(home,'.lock'),{bigint:true});
   if(actual.dev===named.dev&&actual.ino===named.ino)onAttempt();
  }
 });
}

export async function replaceHeldHomeLock(home:string):Promise<AbortSignal> {
 return withHomeLock(home,async signal=>{
  assert.equal(signal.aborted,false,'the actual holder has not yet reported a loss');
  const path=join(home,'.lock');
  renameSync(path,join(home,'.lock-retained-for-loss-control'));
  writeFileSync(path,'',{mode:0o600});
  let notify!:()=>void;
  try{
   await hangDetector(new Promise<void>((resolve)=>{
    notify=resolve;signal.addEventListener('abort',notify,{once:true});
    if(signal.aborted)resolve();
   }), 'home inode replacement notification', {diagnostic:()=>`aborted=${signal.aborted}`});
  }finally{signal.removeEventListener('abort',notify);}
  assert.equal(signal.aborted,true,'the real home holder reported the integrity loss');
  return signal;
 });
}
