import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { withHomeLock, assertHomeWriteAdmission } from '../src/composition/home-lock.ts';
import { ModelRoutes } from '../src/models/route.ts';
import { CredentialStore } from '../src/credentials/store.ts';
import { freshHome } from './helpers.ts';

test('shared routes require an explicit choice and never borrow ambient or personal credentials', async () => {
  const home = freshHome(), key = randomBytes(32);
  const credentials = new CredentialStore(home, async () => key);
  const personal = new ModelRoutes(home, credentials, {BACKBONE_MODEL_ENDPOINT:'http://127.0.0.1:1234',BACKBONE_MODEL_ID:'personal'});
  const shared = new ModelRoutes(home, credentials, {}, false, false, undefined, undefined, true);
  assert.equal(shared.resolve(), null);
  await personal.change({route:'own',provider:'openai',key:'personal-secret',model:'personal'});
  assert.equal(shared.resolve(), null);
  await shared.change({route:'local',provider:'other',baseUrl:'http://127.0.0.1:4321/v1',model:'shared'});
  assert.equal(shared.resolve()?.model, 'shared');
  assert.equal(personal.resolve()?.model, 'personal');
  await shared.change({route:'own',provider:'openai',key:'shared-secret',model:'shared-paid'});
  assert.doesNotMatch(readFileSync(join(home,'shared-model-route.json'),'utf8'), /shared-secret/);
  assert.equal(await credentials.resolve(shared.resolve()!.credential!), 'shared-secret');
  await shared.change({route:'own',clear:true});
  assert.equal(shared.resolve(), null, 'clearing does not revive an older route');
});

test('a shared route refuses native engines and malformed saved engine choices', async () => {
  const home = freshHome();
  const shared = new ModelRoutes(home, new CredentialStore(home, async () => randomBytes(32)), {}, false, false, undefined, undefined, true);
  await assert.rejects(shared.change({route:'native',provider:'codex',model:'private'}), /Pi/);
  await withHomeLock(home,async()=>{assertHomeWriteAdmission(home);writeFileSync(join(home,'shared-model-route.json'), JSON.stringify({engine:'harness-codex',local:{provider:'other',baseUrl:'http://127.0.0.1:4321',model:'shared'}}));});
  assert.throws(() => shared.resolve(), /Pi/);
  await shared.change({route:'local',provider:'other',baseUrl:'http://127.0.0.1:4321',model:'repaired'});
  assert.equal(shared.resolve()?.model,'repaired');
});


test('shared local selection preserves its sealed provider key and clearing it restores that route', async () => {
  const home = freshHome(), credentials = new CredentialStore(home, async () => Buffer.alloc(32, 7));
  const shared = new ModelRoutes(home, credentials, {}, false, false, undefined, undefined, true);
  await shared.change({route:'own',provider:'openai',key:'shared-only-key',model:'paid-model'});
  const handle = shared.resolve()!.credential!;
  await shared.change({route:'local',provider:'ollama',baseUrl:'http://127.0.0.1:1',model:'local-model'});
  assert.equal(shared.settings().own?.keySet,true);
  assert.equal(await credentials.resolve(handle),'shared-only-key');
  assert.equal(shared.resolve()?.model,'local-model');
  await shared.change({route:'local',clear:true});
  assert.equal(shared.resolve()?.model,'paid-model');
});


test('a local choice repairs ambiguous shared providers without deleting either sealed key', async () => {
  const home=freshHome(),credentials=new CredentialStore(home,async()=>Buffer.alloc(32,6));
  const shared=new ModelRoutes(home,credentials,{},false,false,undefined,undefined,true);
  let own='',gateway='';
  await withHomeLock(home,async()=>{own=await credentials.put('own-key','Own');gateway=await credentials.put('gateway-key','Gateway');assertHomeWriteAdmission(home);writeFileSync(join(home,'shared-model-route.json'),JSON.stringify({own:{provider:'openai',model:'own',credential:own},gateway:{provider:'openrouter',model:'gateway',credential:gateway}}));});
  assert.throws(()=>shared.resolve(),/one shared provider/);
  await shared.change({route:'local',provider:'other',baseUrl:'http://127.0.0.1:1',model:'local'});
  assert.equal(shared.resolve()?.model,'local');assert.equal(credentials.has(own),true);assert.equal(credentials.has(gateway),true);
  await assert.rejects(shared.change({route:'local',clear:true}),/Choose.*provider/);
  assert.equal(shared.resolve()?.model,'local');
});
