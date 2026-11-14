import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sharedCertificate } from '../src/composition/shared-certificate.ts';
import { plaintextKeys } from '../src/keys/vault.ts';
import { RemoteClient, RemoteError } from '../src/remote/client.ts';

for(const status of [429,500,503])test(`event opening ${status} reports a temporary problem without claiming access ended`,async()=>{
  const home=mkdtempSync(join(tmpdir(),'remote-event-error-'));
  const tls=await sharedCertificate(home,plaintextKeys());
  const server=createServer(tls,(_req,res)=>res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify({error:'Temporarily busy.',outcome:'UNKNOWN'})));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const client=new RemoteClient({origin:`https://127.0.0.1:${(server.address() as {port:number}).port}`,fingerprint:tls.fingerprint},'s'.repeat(40));
    await assert.rejects(client.events().next(),(error:unknown)=>error instanceof RemoteError&&error.outcome==='UNKNOWN'&&/temporary/i.test(error.message)&&!/invitation|Access ended/.test(error.message));
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(home,{recursive:true,force:true});}
});

test('a socket error after the certificate check and before HTTP listener attachment is a clean unknown outcome',async()=>{
  // Inject at the exact boundary using a real TLS socket. A child makes an unhandled
  // error observable as a process crash instead of affecting the test runner.
  const script=`
    import tls from 'node:tls';
    import { syncBuiltinESMExports } from 'node:module';
    import { createHash } from 'node:crypto';
    import { mkdtempSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { createServer } from 'node:https';
    import { sharedCertificate } from ${JSON.stringify(new URL('../src/composition/shared-certificate.ts',import.meta.url).href)};
    import { plaintextKeys } from ${JSON.stringify(new URL('../src/keys/vault.ts',import.meta.url).href)};
    const home=mkdtempSync(join(tmpdir(),'remote-pin-race-')), cert=await sharedCertificate(home,plaintextKeys());
    const server=createServer(cert,(_req,res)=>res.end('{}'));
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const original=tls.connect;
    tls.connect=(...args)=>{
      const socket=original(...args), emit=socket.emit;
      socket.emit=function(event,...args){
        const result=emit.call(this,event,...args);
        if(event==='secureConnect'){emit.call(this,'error',new Error('injected after pin'));this.destroy();}
        return result;
      };
      return socket;
    };
    syncBuiltinESMExports();
    const { RemoteClient,RemoteError }=await import(${JSON.stringify(new URL('../src/remote/client.ts',import.meta.url).href)});
    try{
      await new RemoteClient({origin:'https://127.0.0.1:'+server.address().port,fingerprint:cert.fingerprint}).request('/identity/sign-out',{});
      throw new Error('unexpected success');
    }catch(error){
      if(!(error instanceof RemoteError)||error.outcome!=='UNKNOWN')throw error;
    }finally{await new Promise(r=>server.close(r));rmSync(home,{recursive:true,force:true});}
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:20_000});
  assert.equal(result.status,0,result.stderr||String(result.error));
});
test('an event stream that closes without an access refusal reports a temporary problem',async()=>{
  const home=mkdtempSync(join(tmpdir(),'remote-event-close-'));
  const tls=await sharedCertificate(home,plaintextKeys());
  const server=createServer(tls,(_req,res)=>res.writeHead(200,{'content-type':'text/event-stream'}).end(': open\n\n'));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const client=new RemoteClient({origin:`https://127.0.0.1:${(server.address() as {port:number}).port}`,fingerprint:tls.fingerprint},'s'.repeat(40));
    await assert.rejects(client.events().next(),(error:unknown)=>error instanceof RemoteError&&error.outcome==='UNKNOWN'&&/temporary/i.test(error.message));
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(home,{recursive:true,force:true});}
});
