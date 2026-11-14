import { hangDetector } from '../../../scripts/lib/test-hang.ts';
// Offline Core admission and gateway retry contracts. Native locks/close state are real;
// only retry-budget controls replace Core.open. Vault is always a no-database tripwire.
import assert from 'node:assert/strict';
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test,type TestContext} from 'node:test';
import {parse} from '@babel/parser';
import {CoreCloseWaitRefusal,CoreLink} from '../src/composition/core.ts';
import {grantDoor,revokeDoor} from '../src/composition/gateway.ts';
import {inActiveHomeLockScope,outsideHomeLocks,withHomeLock} from '../src/composition/home-lock.ts';
import {PIECES} from '../src/composition/pieces.ts';
import {Vault} from '../src/keys/vault.ts';
import {pieceDigest,pieceFiles,readManifest} from '../src/pieces/digest.ts';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};

function fixture(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'backbone-admission-')),home=join(root,'data');mkdirSync(home);
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const boundary=new Error('Synthetic Vault boundary: no database opened');let vault=0;
 t.mock.method(Vault,'open',async()=>{vault++;throw boundary;});
 return {root,home,boundary,vault:()=>vault};
}
function closeOnly(close:()=>Promise<void>):CoreLink{return {close} as unknown as CoreLink;}
function noOpenEffects(home:string,vault:number){
 assert.equal(vault,0,'the rejected admission never reaches Vault');
 for(const name of ['kernel.json','core.json','keys','pg','doors'])assert.equal(existsSync(join(home,name)),false,`no ${name} mutation`);
}
function declaredDoor(root:string){
 const piece=join(root,'door');
 for(const file of pieceFiles(PIECES.mcp.dir)){mkdirSync(dirname(join(piece,file)),{recursive:true});cpSync(join(PIECES.mcp.dir,file),join(piece,file));}
 writeFileSync(join(piece,'backbone.module.json'),`${JSON.stringify({...readManifest(piece),digest:pieceDigest(piece)})}\n`);
 return piece;
}

for(const spelling of ['relative','dot'] as const)test(`a close registered on the real absolute home refuses ${spelling} alias admission before every Core effect`,{timeout:240_000},async t=>{
 const f=fixture(t),alias=spelling==='relative'?relative(process.cwd(),f.home):`${f.home}/.`;
 const release=deferred();let closes=0;
 CoreLink.closeWhenOpen(realpathSync(f.home),release.promise.then(()=>closeOnly(async()=>{closes++;})));
 const pending=CoreLink.whenClosed(f.home);
 try{
  assert.equal(CoreLink.pendingClose(alias),pending,'aliases find the same still-pending attempt');
  await withHomeLock(f.home,async outer=>{
   assert.equal(inActiveHomeLockScope(alias),true);
   await assert.rejects(hangDetector(CoreLink.open({home:alias}),"CoreLink.open({home:alias})"),error=>{
    assert.ok(error instanceof CoreCloseWaitRefusal);assert.equal(error.closed,pending);return true;
   });
   noOpenEffects(f.home,f.vault());assert.equal(existsSync(join(f.home,'.lock')),true);
   assert.equal(inActiveHomeLockScope(alias),true,'a refusal does not end the caller scope');
   await withHomeLock(alias,async nested=>{assert.equal(nested,outer,'native reentry retains the exact holder');assert.equal(nested.aborted,false);});
   assert.equal(closes,0,'the test has not manufactured completion to escape the refusal');
  });
 }finally{release.resolve();await pending;}
 assert.equal(CoreLink.pendingClose(alias),undefined);assert.equal(closes,1);
 // A resolved historical entry must not keep the same nested home busy forever.
 await withHomeLock(alias,async()=>{await assert.rejects(CoreLink.open({home:alias}),error=>error===f.boundary);});
 assert.equal(f.vault(),1);assert.equal(inActiveHomeLockScope(f.home),false);
});

test('scope query matches native ALS reentry and an escaped inactive marker cannot bypass another holder',{timeout:240_000},async t=>{
 const f=fixture(t),alias=`${f.home}/.`,resume=deferred(),attempt=deferred(),laterEntered=deferred(),releaseLater=deferred();
 let descendant:Promise<void>|undefined,original:AbortSignal|undefined,laterSignal:AbortSignal|undefined,entered=false,observed=false;
 assert.equal(inActiveHomeLockScope(alias),false);
 await withHomeLock(f.home,async held=>{
  original=held;assert.equal(inActiveHomeLockScope(alias),true);
  assert.equal(inActiveHomeLockScope(join(f.home,'different')),false,'scope identity is the same key used by the lock');
  outsideHomeLocks(()=>assert.equal(inActiveHomeLockScope(alias),false,'independent work cannot borrow this scope'));
  await withHomeLock(alias,async nested=>{assert.equal(nested,held);assert.equal(inActiveHomeLockScope(alias),true);});
  descendant=(async()=>{
   await resume.promise;observed=inActiveHomeLockScope(alias);attempt.resolve();
   await withHomeLock(alias,async acquired=>{entered=true;assert.equal(inActiveHomeLockScope(alias),true);assert.notEqual(acquired,original);assert.notEqual(acquired,laterSignal);});
  })();
 });
 const later=withHomeLock(f.home,async held=>{laterSignal=held;laterEntered.resolve();await releaseLater.promise;});
 try{
  await laterEntered.promise;resume.resolve();await attempt.promise;await new Promise(r=>setImmediate(r));
  assert.equal(observed,false,'an inherited marker is inactive after its callback ends');
  assert.equal(entered,false,'the escaped descendant must queue behind the actual current holder');
  assert.equal(laterSignal?.aborted,false,'scope inspection/caller admission cannot cancel a different holder');
 }finally{resume.resolve();releaseLater.resolve();await Promise.allSettled([later,descendant]);}
 await later;await descendant;
 assert.equal(entered,true);assert.equal(inActiveHomeLockScope(alias),false);
});

for(const operation of ['grant','revoke'] as const){
 function invoke(home:string,piece:string){return operation==='grant'
  ?grantDoor({home,piece,name:'synthetic-admission',operations:['outbox.write'],ceiling:3})
  :revokeDoor({home,name:'synthetic-admission',intent:'original-absent-file-intent'});}

 test(`standalone ${operation} unwinds the lock, waits once and exhausts exactly one typed retry`,{timeout:240_000},async t=>{
  const f=fixture(t),piece=declaredDoor(f.root),firstEntered=deferred(),release=deferred();let attempts=0,closes=0;
  const second=new CoreCloseWaitRefusal(new Promise<void>(()=>{}));
  t.mock.method(CoreLink,'open',async()=>{
   attempts++;assert.equal(inActiveHomeLockScope(f.home),true,'each attempt owns its own native lock');
   if(attempts===1){
    CoreLink.closeWhenOpen(f.home,release.promise.then(()=>closeOnly(async()=>{closes++;})));
    const pending=CoreLink.pendingClose(f.home);assert.ok(pending);firstEntered.resolve();throw new CoreCloseWaitRefusal(pending);
   }
   throw second;
  });
  const result=invoke(f.home,piece).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
  try{
   await firstEntered.promise;
   await hangDetector(withHomeLock(f.home,async()=>{assert.equal(attempts,1,'retry waits outside the lock');assert.equal(closes,0);}),"withHomeLock(f.home,async()=>{assert.equal(attempts,1,'retry waits outside the lock');assert.equal(closes,0);})");
   release.resolve();const answer=await hangDetector(result,"result");
   assert.equal(answer.error,second,'a second typed refusal is returned without waiting again');
   assert.equal(answer.value,undefined,'in particular, a refusal is not zero successful revocations');
   assert.equal(attempts,2);assert.equal(closes,1);noOpenEffects(f.home,f.vault());
  }finally{release.resolve();await Promise.allSettled([result,CoreLink.whenClosed(f.home)]);}
 });

 test(`standalone ${operation} never retries an ordinary Error copying the typed name and message`,async t=>{
  const f=fixture(t),piece=declaredDoor(f.root),typed=new CoreCloseWaitRefusal(Promise.resolve());let attempts=0;
  const ordinary=new Error(typed.message);ordinary.name=typed.name;
  t.mock.method(CoreLink,'open',async()=>{attempts++;throw ordinary;});
  await assert.rejects(invoke(f.home,piece),error=>error===ordinary);
  assert.equal(attempts,1);noOpenEffects(f.home,f.vault());
 });

 test(`standalone ${operation} propagates its failed captured close instead of making another attempt`,{timeout:240_000},async t=>{
  const f=fixture(t),piece=declaredDoor(f.root),firstEntered=deferred(),release=deferred(),failure=new Error('Synthetic final close failure');let attempts=0;
  t.mock.method(CoreLink,'open',async()=>{
   attempts++;CoreLink.closeWhenOpen(f.home,Promise.resolve(closeOnly(async()=>{await release.promise;throw failure;})));
   const pending=CoreLink.pendingClose(f.home);assert.ok(pending);firstEntered.resolve();throw new CoreCloseWaitRefusal(pending);
  });
  const result=invoke(f.home,piece).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
  try{
   await firstEntered.promise;await hangDetector(withHomeLock(f.home,async()=>{assert.equal(attempts,1);}),"withHomeLock(f.home,async()=>{assert.equal(attempts,1);})");
   release.resolve();const answer=await hangDetector(result,"result");
   assert.equal(answer.error,failure);assert.equal(answer.value,undefined);assert.equal(attempts,1);noOpenEffects(f.home,f.vault());
   assert.equal(CoreLink.pendingClose(f.home),undefined);
  }finally{release.resolve();await Promise.allSettled([result,CoreLink.whenClosed(f.home)]);}
 });
}

test('standalone pending-close preflight waits outside the lock and a failed historical close does not poison native admission',{timeout:240_000},async t=>{
 const f=fixture(t),piece=declaredDoor(f.root),release=deferred(),failure=new Error('Synthetic preflight close failure');
 CoreLink.closeWhenOpen(f.home,Promise.resolve(closeOnly(async()=>{await release.promise;throw failure;})));
 const opening=grantDoor({home:f.home,piece,name:'synthetic-preflight',operations:['outbox.write'],ceiling:3}).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
 try{
  await hangDetector(withHomeLock(f.home,async()=>{assert.ok(CoreLink.pendingClose(f.home));noOpenEffects(f.home,f.vault());}),"withHomeLock(f.home,async()=>{assert.ok(CoreLink.pendingClose(f.home));noOpenEffects(f.home,f.vault());})");
  release.resolve();const answer=await hangDetector(opening,"opening");assert.equal(answer.error,failure);assert.equal(answer.value,undefined);
  noOpenEffects(f.home,f.vault());assert.equal(CoreLink.pendingClose(f.home),undefined);
  await assert.rejects(CoreLink.open({home:f.home}),error=>error===f.boundary,'native reopen rechecks instead of inheriting historical rejection');
  assert.equal(f.vault(),1);
  let laterCloses=0;
  CoreLink.closeWhenOpen(f.home,Promise.resolve(closeOnly(async()=>{laterCloses++;})));
  await hangDetector(CoreLink.whenClosed(f.home),"CoreLink.whenClosed(f.home)");
  assert.equal(laterCloses,1,'a later close settles independently of the failed predecessor');
  assert.equal(CoreLink.pendingClose(f.home),undefined);
 }finally{release.resolve();await Promise.allSettled([opening,CoreLink.whenClosed(f.home)]);}
});

// Static scope: direct constructors and named effect calls. Behavioural admission tests cover
// refusal semantics; aliases, stored errors and qualified constructors are outside this scan.
test('the dedicated retryable refusal has exactly one direct throw new CoreCloseWaitRefusal site in src, thrown by a top-level synchronous guard in static Core.open before any await and before every claimCoreHome, Vault.open and openPersonalDatabase call',()=>{
 const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
 function* syntax(value:unknown):Generator<Record<string,unknown>>{
  if(Array.isArray(value)){for(const item of value)yield* syntax(item);return;}
  const node=object(value);if(!node)return;
  if(typeof node.type==='string')yield node;
  for(const child of Object.values(node))yield* syntax(child);
 }
 const parsed=(text:string)=>[...syntax(parse(text,{sourceType:'module',plugins:['typescript']}))];
 const refusal=(node:Record<string,unknown>)=>{
  const argument=object(node.argument),callee=object(argument?.callee);
  return node.type==='ThrowStatement'&&argument?.type==='NewExpression'&&callee?.type==='Identifier'&&callee.name==='CoreCloseWaitRefusal';
 };
 const admission=(text:string)=>{
  const open=parsed(text).find(node=>node.type==='ClassMethod'&&node.static===true&&node.async===true&&object(node.key)?.name==='open');
  assert.ok(open,'inspect the actual static Core.open method');
  const statements=object(open.body)?.body;
  const statement=Array.isArray(statements)?statements.map(object).find(node=>node?.type==='IfStatement'&&refusal(object(node.consequent)??{})):undefined;
  const body=[...syntax(open.body)],guard=object(statement?.consequent);
  const beforeGuard=(node:Record<string,unknown>)=>guard!==undefined&&Number(node.start)<Number(guard.start);
  const suspends=(node:Record<string,unknown>)=>node.type==='AwaitExpression'||(node.type==='ForOfStatement'&&node.await===true)||(node.type==='VariableDeclaration'&&String(node.kind).startsWith('await'));
  return {body,guard,statement,beforeGuard,synchronous:!!guard&&!body.some(node=>suspends(node)&&beforeGuard(node))};
 };
 const root=fileURLToPath(new URL('../src/',import.meta.url)),sites:{file:string;count:number}[]=[];
 function walk(dir:string){for(const entry of readdirSync(dir,{withFileTypes:true})){
  const path=join(dir,entry.name);if(entry.isDirectory())walk(path);
  else if(entry.isFile()&&entry.name.endsWith('.ts')){const count=parsed(readFileSync(path,'utf8')).filter(refusal).length;if(count)sites.push({file:relative(root,path),count});}
 }}walk(root);
 assert.deepEqual(sites,[{file:'composition/core.ts',count:1}]);
 const source=readFileSync(join(root,'composition/core.ts'),'utf8'),facts=admission(source);
 assert.ok(facts.guard&&facts.statement,'the refusal is thrown by a direct top-level IfStatement, never a nested function or deferred callback');
 for(const effect of ['claimCoreHome','Vault.open','openPersonalDatabase']){
  const calls=facts.body.filter(node=>{
   const callee=object(node.callee);
   const name=callee?.type==='Identifier'?callee.name:callee?.type==='MemberExpression'?`${object(callee.object)?.name}.${object(callee.property)?.name}`:undefined;
   return node.type==='CallExpression'&&name===effect;
  });
  assert.ok(calls.length>0&&calls.every(call=>!facts.beforeGuard(call)),`${effect} stays after the direct CoreCloseWaitRefusal guard`);
 }
 assert.ok(facts.synchronous,'the guard is decided synchronously before any actual await');
 const marker='    const current = closing.get(canonicalHome(options.home));';assert.ok(source.includes(marker));
 assert.ok(admission(source.replace(marker,`    // await and throw new CoreCloseWaitRefusal() are prose, not code.\n${marker}`)).synchronous);
 for(const suspension of ['await Promise.resolve();','for await (const _ of []) {}','{ await using resource = null; }'])
  assert.equal(admission(source.replace(marker,`    ${suspension}\n${marker}`)).synchronous,false,`${suspension} before the guard still fails the grader`);
 const directGuard=source.slice(Number(facts.statement.start),Number(facts.statement.end));
 for(const deferred of [`const delayed = () => { ${directGuard} };`,`queueMicrotask(() => { ${directGuard} });`,`if (false) { ${directGuard} }`])
  assert.equal(admission(source.replace(directGuard,deferred)).synchronous,false,'a deferred or nested refusal cannot stand in for the direct synchronous guard');
});
