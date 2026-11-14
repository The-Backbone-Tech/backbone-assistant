import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelCredentials } from '@backbone-next/platform/credentials/channels';
import { Vault } from '@backbone-next/platform/keys';
import { memoryKeychain, findInHome } from '@backbone-next/platform/testing/keys';
import { Ledger } from '../src/index.ts';
test('channel credentials stay sealed across the entire home with a memory-held Keychain key',async()=>{
 const home=mkdtempSync(join(tmpdir(),'channels-sealed-')),keys=memoryKeychain(),prior=process.env.BACKBONE_KEYS;delete process.env.BACKBONE_KEYS;
 const token='synthetic-bot-token-secret-canary',secret='synthetic-webhook-secret-canary';
 try{
  const credentials=await channelCredentials(home,keys);await credentials.connect('slack',token,secret);await credentials.connect('telegram',token,secret);
  const db=new Ledger(home);db.invite();db.set('config',{version:1,providers:['slack','telegram']});db.close();
  const master=await (await Vault.open(home,keys)).masterKey();
  assert.deepEqual(findInHome(home,[Buffer.from(token),Buffer.from(secret),master]),[]);
  assert.deepEqual(await (await channelCredentials(home,keys)).resolve('slack'),{token,verification:secret});
  await assert.rejects(channelCredentials(home),/key|Keychain|app/i);
 }finally{if(prior===undefined)delete process.env.BACKBONE_KEYS;else process.env.BACKBONE_KEYS=prior;Vault.forget(home);rmSync(home,{recursive:true,force:true});}
});
