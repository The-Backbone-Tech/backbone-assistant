import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createSharedEngine } from '../src/composition/shared-engine.ts';
import { PIECE_DIRS } from '../src/composition/pieces.ts';
import { pieceDigest, pieceFiles } from '../src/pieces/digest.ts';
import { CredentialStore } from '../src/credentials/store.ts';
import type { CoreLink } from '../src/composition/core.ts';
import { freshDir, freshHome } from './helpers.ts';

function fixture(marker: string) {
  const dir=freshDir('shared-load-');
  for(const file of pieceFiles(PIECE_DIRS['harness-pi'])){const target=join(dir,file);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(PIECE_DIRS['harness-pi'],file),target);}
  writeFileSync(join(dir,'src/index.ts'),`import {writeFileSync} from 'node:fs'; export function createPiHarness(){return {specificationVersion:'v1',id:'fixture',label:'Shared fixture',async close(){writeFileSync(${JSON.stringify(marker)},'closed');}}}`);
  const path=join(dir,'backbone.module.json'),manifest=JSON.parse(readFileSync(path,'utf8'));
  const digest=pieceDigest(dir);writeFileSync(path,JSON.stringify({...manifest,digest}));return {dir,digest};
}

test('close joins a pending shared load, closes its result and refuses subsequent loads', async () => {
  const home=freshHome(),marker=join(freshDir('shared-close-'),'closed'),{dir,digest}=fixture(marker);
  const engine=createSharedEngine({home,pieceDirs:{'harness-pi':dir}},new CredentialStore(home,async()=>Buffer.alloc(32,4)),()=>true);
  await engine.routes.change({route:'local',provider:'other',baseUrl:'http://127.0.0.1:1',model:'fixture'});
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
  const link={deviceAvailable:true,person:()=>({}),read:async()=>{entered();await held;return {rows:[{id:'piece',digest,standing:true}]};},pieceMandate:async()=>true} as unknown as CoreLink;
  const loading=engine.prepare(link);await started;
  let closed=false;const closing=engine.close().then(()=>{closed=true;});
  await new Promise(r=>setImmediate(r));
  const prematurelyClosed=closed;
  release();await loading;await closing;
  assert.equal(prematurelyClosed,false,'close waits for the admitted load');
  assert.equal(existsSync(marker),true,'the late engine was closed');
  await assert.rejects(engine.prepare(link),/clos/i);
  await assert.rejects(engine.run(async()=>assert.fail('closed engine ran')),/clos/i);
});

test('shared settings retain the last load error, redact credentials and clear it after a successful load', async () => {
  const home=freshHome(),marker=join(freshDir('shared-retry-'),'closed'),{dir,digest}=fixture(marker);
  const credentials=new CredentialStore(home,async()=>Buffer.alloc(32,5));
  const engine=createSharedEngine({home,pieceDirs:{'harness-pi':dir}},credentials,()=>true);
  await engine.routes.change({route:'own',provider:'openai',key:'sealed-canary',model:'fixture'});
  let failing=true;
  const link={deviceAvailable:true,person:()=>({}),read:async()=>{if(failing)throw new Error('fixture load failure sealed-canary');return {rows:[{id:'piece',digest,standing:true}]};},pieceMandate:async()=>true} as unknown as CoreLink;
  await assert.rejects(engine.prepare(link),/fixture load failure/);
  assert.match(engine.settings().hint??'',/fixture load failure/);
  assert.doesNotMatch(engine.settings().hint??'',/sealed-canary/);
  assert.equal(engine.available(),false);
  await engine.routes.change({route:'own',clear:true});
  await engine.prepare(link);assert.doesNotMatch(engine.settings().hint??'',/fixture load failure/);
  await engine.routes.change({route:'own',provider:'openai',key:'sealed-canary',model:'fixture'});
  failing=false;await engine.prepare(link);
  assert.equal(engine.settings().hint,null);
  assert.equal(engine.available(),true);
  await engine.close();
});
