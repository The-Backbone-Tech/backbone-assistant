import { enableConnector } from '../src/testing/connectors.ts';
import { waitFor } from '../../../scripts/lib/test-hang.ts';
// Isolate a real Host startup deadlock so the parent can bound it and release OS-held locks.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {CoreLink} from '../src/composition/core.ts';
import {createHost,hostClosed} from '../src/composition/host.ts';
import {assertHomeWriteAdmission,withHomeLock} from '../src/composition/home-lock.ts';
import {writeJson} from '../src/stub/fsx.ts';
import {defaultToolEnv} from '../src/tools/places.ts';
const [mode,home,person]=process.argv.slice(2),server='claude-code:notes';
const file=join(home,'connectors','mcp.json'),read=()=>JSON.parse(readFileSync(file,'utf8'));
const config=join(person,'.claude.json');
writeFileSync(config,JSON.stringify({mcpServers:{notes:{command:process.execPath,args:[join(import.meta.dirname,'fake-mcp-server.ts')]}}}));
const options={home,harness:'stub' as const,connectors:{env:defaultToolEnv({HOME:person,PATH:process.env.PATH}),sources:['claude-code' as const]}};
const value=<T>(receipt:{ok:true;value:T}|{ok:false;detail:string}):T=>{assert.equal(receipt.ok,true,receipt.ok?'':receipt.detail);return (receipt as {value:T}).value;};
let host=createHost(options);
const sign=()=>{const shown=host.connectorToolView(server,'draft_note')!;return host.signConnectorTool(server,'draft_note',shown.seal,shown.stamp,false);};
try{
 value(await host.call('connectors.refresh',{serverId:server}));value(await enableConnector(host, server));
 value(await enableConnector(host, server, 'draft_note'));
 value(await host.openConnectorDoor(server,host.connectorDoorSeal(server)!));
 let signature:string;
 if(mode==='lost-give'){
  const call=CoreLink.prototype.call;
  CoreLink.prototype.call=async function<T>(...args:Parameters<typeof call>):Promise<T>{
   const result=await call.apply(this,args) as T;
   if(String(args[1]).includes('give_connector_signature'))throw Error('Synthetic committed give reply lost');
   return result;
  };
  try{await assert.rejects(sign(),/Core signature could not be confirmed/);}finally{CoreLink.prototype.call=call;}
  assert.equal(read().servers[server].tools.draft_note.standing,undefined);
  const link=await CoreLink.open({home});try{
   signature=(await link.read<{subject:string}>(link.person(),"SELECT subject FROM app.ledger WHERE entry_type='signature.given' ORDER BY seq DESC LIMIT 1")).rows[0].subject;
  }finally{await link.release();}
 }else{value(await sign());signature=read().servers[server].tools.draft_note.standing.id;}
 host.close();await hostClosed(home);
 if(mode==='pending-end')await withHomeLock(home,async()=>{
  const record=read();delete record.servers[server].tools.draft_note.standing;
  record.pendingEnds=[{id:signature,reason:'person_revoked'}];record.ver=(record.ver??0)+1;
  assertHomeWriteAdmission(home,join(home,'connectors'));writeJson(file,record);
 });
 if(mode==='gone')writeFileSync(config,JSON.stringify({mcpServers:{}}));
 // Start Core independently, but leave enough scheduling space for the startup reconciler
 // or immediate give to enter change(). No gate depends on the lock being acquired.
 const open=CoreLink.open;
 CoreLink.open=async function(...args:Parameters<typeof open>){await new Promise(r=>setTimeout(r,75));return open.apply(this,args);};
 try{
  host=createHost(options);
  if(mode==='lost-give')value(await sign());
  assert.equal((await host.call('core.signatureStatus',{})).state,'verified');
  if(mode==='pending-end'||mode==='gone'){
   await waitFor(()=>!read().pendingEnds?.length&&!read().servers[server].tools.draft_note.standing,'signature closure after Host restart',{diagnostic:()=>`pending ends=${read().pendingEnds?.length??0}`});
   assert.equal(read().pendingEnds,undefined);assert.equal(read().servers[server].tools.draft_note.standing,undefined);
  }
  const link=await CoreLink.open({home});try{
   const ended=(await link.read<{payload:unknown}>(link.person(),"SELECT payload FROM app.ledger WHERE entry_type='signature.ended' AND subject=$1",[signature])).rows;
   assert.deepEqual(ended,mode==='control'?[]:[{payload:{signature,reason:mode==='gone'?'connection_removed':mode==='lost-give'?'superseded':'person_revoked'}}]);
   if(mode==='lost-give')assert.notEqual(read().servers[server].tools.draft_note.standing.id,signature);
   assert.equal(await link.call(link.person(),'SELECT gov.verify_ledger()'),null);
  }finally{await link.release();}
 }finally{CoreLink.open=open;}
}finally{host.close();await hostClosed(home);}
console.log('Restart completed and ledger verified.');
