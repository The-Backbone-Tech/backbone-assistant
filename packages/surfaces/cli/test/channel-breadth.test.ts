import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Readable} from 'node:stream';
import {createHost,hostClosed,removeDataHome} from '@backbone-next/platform/composition';
import {freshDataHome} from '@backbone-next/platform/testing/data-home';
import {channelCredentials} from '@backbone-next/platform/credentials/channels';
import {plaintextKeys} from '@backbone-next/platform/keys';
import {Ledger,readChannelConfig} from '@backbone-next/channels';
import {parse} from '../src/commands.ts';
import {channelsCommand} from '../src/channels.ts';

for(const provider of ['discord','teams'] as const)test(`${provider} CLI seals credentials and keeps its registration through configuration`,async()=>{
 const home=freshDataHome(`cli-${provider}`),host=createHost({home});
 const previous=process.env.BACKBONE_KEYS;process.env.BACKBONE_KEYS='plaintext';
 try{
  const p=await host.call('projects.create',{name:'Breadth CLI',kind:'folder'});assert.ok(p.ok);host.close();await hostClosed(home);
  const token=`synthetic-${provider}-token`,registration=JSON.stringify(provider==='discord'?{applicationId:'app-id',publicKey:'a'.repeat(64)}:{appId:'app-id',tenantId:'tenant-id'});
  const parsed=parse(['channels','connect',provider,'--home',home,'--project',p.value.id,'--model','stub']);
  const output:string[]=[];
  assert.equal(await channelsCommand(parsed,{out:t=>output.push(t),err:t=>output.push(t)},Readable.from([`${token}\n${registration}\n`])),0);
  assert.ok(output.every(t=>!t.includes(token)&&!t.includes(registration)));
  assert.deepEqual(readChannelConfig(home)?.providers,[provider]);
  assert.deepEqual(await (await channelCredentials(home,plaintextKeys())).resolve(provider),{token,verification:registration});
  const ledger=new Ledger(home);try{assert.ok(!JSON.stringify(ledger.get('config')).includes(token));}finally{ledger.close();}
  await assert.rejects(channelsCommand(parsed,{out:()=>{},err:()=>{}},Readable.from([`${token}\ninvalid-registration\n`])),/second input line/);
 }finally{if(previous===undefined)delete process.env.BACKBONE_KEYS;else process.env.BACKBONE_KEYS=previous;host.close();await removeDataHome(home);}
});
