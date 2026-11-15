import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plaintextKeys } from '@backbone-next/platform/keys';
import { appSharing, computerAddresses } from '../electron/shared-listener.ts';

// No Host or database is needed to prove preference/lifetime ownership.
test('sharing defaults off, persists the chosen address, restores and closes the owned listener', async () => {
  const home=await mkdtemp(join(tmpdir(),'app-sharing-'));let opens=0,closes=0;
  const dependencies={engineBringsOwnTools:()=>false,addresses:()=>['127.0.0.1'],start:async(address:string,port:number)=>{opens++;assert.equal(address,'127.0.0.1');assert.equal(port,8443);return{origin:'https://127.0.0.1:8443',fingerprint:'a'.repeat(64),close:async()=>{closes++;}};}};
  try {
    const first=await appSharing(home,plaintextKeys(),dependencies);
    assert.equal(first.view().enabled,false);assert.equal(opens,0);
    await first.configure({enabled:true,address:'127.0.0.1',port:8443});
    assert.equal(first.view().enabled,true);assert.equal(first.view().fingerprint,'a'.repeat(64));
    await first.close();assert.equal(closes,1);
    const second=await appSharing(home,plaintextKeys(),dependencies);
    assert.equal(second.view().enabled,true);assert.equal(opens,2);
    await second.configure({enabled:false,address:'127.0.0.1',port:8443});assert.equal(closes,2);
    const third=await appSharing(home,plaintextKeys(),dependencies);assert.equal(third.view().enabled,false);
    await third.close();await second.close();
  } finally {await rm(home,{recursive:true,force:true});}
});

test('an unavailable saved address stays off with a reason; wildcard binding and invalid ports are refused',async()=>{
  const home=await mkdtemp(join(tmpdir(),'app-sharing-address-'));let addresses=['127.0.0.1'];let opens=0;
  const dependencies={engineBringsOwnTools:()=>false,addresses:()=>addresses,start:async()=>{opens++;return{origin:'https://127.0.0.1:8443',fingerprint:'b'.repeat(64),close:async()=>{}};}};
  try {
    const first=await appSharing(home,plaintextKeys(),dependencies);
    for(const address of ['0.0.0.0','::','192.0.2.1'])await assert.rejects(first.configure({enabled:true,address,port:8443}));
    await assert.rejects(first.configure({enabled:true,address:'127.0.0.1',port:65536}));
    await first.configure({enabled:true,address:'127.0.0.1',port:8443});await first.close();addresses=[];
    const second=await appSharing(home,plaintextKeys(),dependencies);assert.equal(second.view().enabled,false);assert.match(second.view().notice!,/address is no longer available/);assert.equal(opens,1);await second.close();
  } finally {await rm(home,{recursive:true,force:true});}
});

test('closing waits for an in-flight start and leaves no listener behind',async()=>{
  const home=await mkdtemp(join(tmpdir(),'app-sharing-close-'));let release!:()=>void,closed=0;
  try {
    const controller=await appSharing(home,plaintextKeys(),{engineBringsOwnTools:()=>false,addresses:()=>['127.0.0.1'],start:async()=>{await new Promise<void>(resolve=>{release=resolve;});return{origin:'https://127.0.0.1:8443',fingerprint:'a'.repeat(64),close:async()=>{closed++;}};}});
    const configuring=controller.configure({enabled:true,address:'127.0.0.1',port:8443});await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(controller.configure({enabled:false,address:'127.0.0.1',port:8443}));
    let settled=false;const stopping=controller.close().then(()=>{settled=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
    release();await configuring;await stopping;assert.equal(closed,1);assert.equal(controller.view().enabled,false);
  }finally{await rm(home,{recursive:true,force:true});}
});

test('turning sharing off closes the existing TLS listener and its open event stream',async()=>{
  const {serveIdentityApi}=await import('@backbone-next/platform/composition/identity-http');
  const {sharedCertificate}=await import('@backbone-next/platform/composition/shared-certificate');
  const {RemoteClient}=await import('@backbone-next/platform/remote/client');
  const home=await mkdtemp(join(tmpdir(),'app-sharing-stream-'));const abort=new AbortController();
  let controller:Awaited<ReturnType<typeof appSharing>>|undefined;
  try {
    controller=await appSharing(home,plaintextKeys(),{engineBringsOwnTools:()=>false,addresses:()=>['127.0.0.1'],start:async address=>{
      const tls=await sharedCertificate(home,plaintextKeys());
      const host={callAuthenticated:async()=>({ok:true,value:{}}),// The listener sends events only once the stream is open (after `ready`), so keep notifying until it unsubscribes.
      onAuthenticated:(_token:string,notify:(event:{topic:'identity'})=>void)=>{const timer=setInterval(()=>notify({topic:'identity'}),20);return Object.assign(()=>clearInterval(timer),{ready:Promise.resolve()});}};
      const listener=await serveIdentityApi({host:host as unknown as import('@backbone-next/platform/composition').Host,address,port:0,tls});return{...listener,fingerprint:tls.fingerprint};
    }});
    await controller.configure({enabled:true,address:'127.0.0.1',port:8443});const view=controller.view();
    const client=new RemoteClient({origin:view.origin!,fingerprint:view.fingerprint!},'s'.repeat(40));const stream=client.events(abort.signal);
    assert.equal((await stream.next()).value?.topic,'identity');
    await controller.configure({enabled:false,address:'127.0.0.1',port:8443});await assert.rejects(stream.next(),/Temporary/);
    await assert.rejects(client.call('projects.list',{}));assert.equal(controller.view().enabled,false);
  }finally{abort.abort();await controller?.close();await rm(home,{recursive:true,force:true});}
});

test('failed sharing setup is observed once, remains visible and cannot poison quit',async()=>{
  const {observeSharing}=await import('../electron/shared-listener.ts');let attempts=0;
  const sharing=observeSharing((async()=>{attempts++;throw new Error('private setup detail');})());
  await new Promise(resolve=>setImmediate(resolve));
  assert.match((await sharing).view().notice!,/Sharing could not start/);
  await (await sharing).close();await (await sharing).close();assert.equal(attempts,1);
});

test('withdrawing an engine update closes sharing before closing the Host',async()=>{
  const {closeSharedHost}=await import('../electron/shared-listener.ts');const order:string[]=[];let release!:()=>void;
  const closing=closeSharedHost(Promise.resolve({close:async()=>{order.push('listener closing');await new Promise<void>(resolve=>{release=resolve;});order.push('listener closed');}}),{close:()=>{order.push('host closed');}});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(order,['listener closing']);release();await closing;
  assert.deepEqual(order,['listener closing','listener closed','host closed']);
});

test('the address offered first is one another computer can reach', () => {
  const interfaces = {
    lo0: [
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: '::1', family: 'IPv6', internal: true },
      { address: 'fe80::1', family: 'IPv6', internal: true },
    ],
    en1: [
      { address: 'fe80::1c2d:3e4f:5a6b:7c8d', family: 'IPv6', internal: false },
      { address: 'fd12:3456:789a::10', family: 'IPv6', internal: false },
      { address: '192.168.1.152', family: 'IPv4', internal: false },
    ],
    utun0: undefined,
  };
  // This computer's network address comes first; link-local addresses, which a link cannot carry, are left out.
  assert.deepEqual(computerAddresses(interfaces), ['192.168.1.152', 'fd12:3456:789a::10', '127.0.0.1', '::1']);
  assert.deepEqual(computerAddresses({ lo0: interfaces.lo0 }), ['127.0.0.1', '::1']);
});

test('the sharing view says whether the engine in use cannot answer colleagues, using the fact the platform supplies', async () => {
  for (const brings of [true, false]) {
    const home=await mkdtemp(join(tmpdir(),'app-sharing-engine-'));
    try {
      const controller=await appSharing(home,plaintextKeys(),{engineBringsOwnTools:()=>brings,addresses:()=>['127.0.0.1'],start:async()=>({origin:'https://127.0.0.1:8443',fingerprint:'a'.repeat(64),close:async()=>{}})});
      assert.equal(controller.view().engineRefusesColleagues,brings,'off');
      await controller.configure({enabled:true,address:'127.0.0.1',port:8443});
      assert.equal(controller.view().engineRefusesColleagues,brings,'on');
      await controller.close();
    } finally { await rm(home,{recursive:true,force:true}); }
  }
});
