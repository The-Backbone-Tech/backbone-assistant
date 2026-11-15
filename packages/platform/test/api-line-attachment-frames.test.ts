import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {createConnection,type Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {ApiLineAttachmentBudget,serveApiLine} from '../src/composition/api-line.ts';
import {apiSocket,attachApi,MAX_ATTACHMENT_LINE} from '../src/doors/api-line.ts';
import {MAX_LINE} from '../src/doors/protocol.ts';

async function raw(home:string, greet = true):Promise<Socket> {
  const socket = createConnection(apiSocket(home));
  socket.on('error',()=>{});
  await new Promise<void>(resolve=>socket.once('connect',resolve));
  if(greet) {
    const ready = new Promise<void>(resolve=>socket.once('data',()=>resolve()));
    socket.write('{"api":1}\n');await ready;
  }
  return socket;
}
async function closed(socket:Socket) {
  if(socket.destroyed)return;
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('oversized partial frame was retained')),1000);
    socket.once('close',()=>{clearTimeout(timer);resolve();});
  });
}
const header = '{"id":1,"method":"material.attach","args":{"base64":"';

for(const scenario of ['hello','other','company','off','unicode'] as const) {
  test(`partial frame keeps the 1 MiB byte ceiling: ${scenario}`, async () => {
    const home=mkdtempSync(join(tmpdir(),'attach-frame-'));
    const server=await serveApiLine({home,attachment:scenario==='company'?'signed-in-app':scenario!=='off',attachmentBudget:new ApiLineAttachmentBudget(),call:async()=>assert.fail('no dispatch')});
    const socket=await raw(home,scenario!=='hello');
    try {
      const prefix=(scenario==='other'||scenario==='unicode')?'{"id":1,"method":"projects.list","args":{"padding":"':header;
      socket.write(prefix+(scenario==='unicode'?'界'.repeat(Math.ceil(MAX_LINE/3)):'x'.repeat(MAX_LINE)));
      await closed(socket);
    } finally {socket.destroy();await server.close();rmSync(home,{recursive:true,force:true});}
  });
}

test('only one connection holds a large partial attachment; close and completion release its slot', async () => {
  const home=mkdtempSync(join(tmpdir(),'attach-frame-slot-'));let calls=0;
  const server=await serveApiLine({home,attachment:true,attachmentBudget:new ApiLineAttachmentBudget(),call:async()=>{calls++;return {ok:true} as never;}});
  const sockets:Socket[]=[];
  const partial=header+'A'.repeat(MAX_LINE);
  try {
    const first=await raw(home);sockets.push(first);first.write(partial);
    const second=await raw(home);sockets.push(second);second.write(partial);
    await closed(second);assert.equal(first.destroyed,false);
    first.destroy();await new Promise<void>(resolve=>first.once('close',resolve));
    // A complete, valid large attachment must work after the partial owner's disconnect.
    const client=await attachApi(home);assert.ok(client);
    try {
      const args={projectId:'p',name:'file.bin',mediaType:'application/octet-stream',base64:'AAAA'.repeat(MAX_LINE/4)};
      assert.ok((await client.call('material.attach',args)).ok);
      const next=await attachApi(home);assert.ok(next);
      try {assert.ok((await next.call('material.attach',args)).ok,'completion releases the slot for another connection');}
      finally {next.close();}
      assert.equal(calls,2);
    } finally {client.close();}
  } finally {for(const socket of sockets)socket.destroy();await server.close();rmSync(home,{recursive:true,force:true});}
});


test('a large partial attachment retains its encoded byte ceiling for multibyte input', async () => {
  const home=mkdtempSync(join(tmpdir(),'attach-frame-bytes-'));
  const server=await serveApiLine({home,attachment:true,attachmentBudget:new ApiLineAttachmentBudget(),call:async()=>assert.fail('no dispatch')});
  const socket=await raw(home);
  try {
    socket.write(header+'界'.repeat(Math.ceil(MAX_ATTACHMENT_LINE/3)));
    await closed(socket);
  } finally {socket.destroy();await server.close();rmSync(home,{recursive:true,force:true});}
});

test('a stalled large partial attachment gives its slot back after the wait', async () => {
  const home=mkdtempSync(join(tmpdir(),'attach-frame-stall-'));let calls=0;
  const server=await serveApiLine({home,attachment:true,attachmentBudget:new ApiLineAttachmentBudget(),attachmentFrameWaitMs:{idle:150,total:5_000},call:async()=>{calls++;return {ok:true} as never;}});
  const stalled=await raw(home);
  try {
    stalled.write(header+'A'.repeat(MAX_LINE));
    await closed(stalled);
    const client=await attachApi(home);assert.ok(client);
    try {assert.ok((await client.call('material.attach',{projectId:'p',name:'file.bin',mediaType:'application/octet-stream',base64:'AAAA'.repeat(MAX_LINE/4)})).ok);assert.equal(calls,1);}
    finally {client.close();}
  } finally {stalled.destroy();await server.close();rmSync(home,{recursive:true,force:true});}
});

test('a slow large partial attachment cannot hold its slot past the total wait', async () => {
  const home=mkdtempSync(join(tmpdir(),'attach-frame-slow-'));
  const server=await serveApiLine({home,attachment:true,attachmentBudget:new ApiLineAttachmentBudget(),attachmentFrameWaitMs:{idle:5_000,total:300},call:async()=>assert.fail('no dispatch')});
  const slow=await raw(home);
  const drip=setInterval(()=>{if(!slow.destroyed)slow.write('A');},40);
  try {
    slow.write(header+'A'.repeat(MAX_LINE));
    await closed(slow);
  } finally {clearInterval(drip);slow.destroy();await server.close();rmSync(home,{recursive:true,force:true});}
});
