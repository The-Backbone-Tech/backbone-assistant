import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {Host} from '@backbone-next/platform/composition';
import {hangDetector} from '../../../../scripts/lib/test-hang.ts';
export async function fakeRead(mode:'unknown'|'complete'='unknown') {
 let calls=0;
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>release=r),called=new Promise<void>(r=>entered=r);
 const server=createServer(async(req,res)=>{
  // This stateless fixture proves read outcomes, not idle HTTP connection reuse.
  // End each response's socket explicitly: a loaded Host must not race the server's idle clock.
  res.setHeader('connection','close');
  if(req.method!=='POST'){res.writeHead(405).end();return;}
  let body='';for await(const chunk of req)body+=chunk;
  const message=JSON.parse(body);
  if(message.id===undefined){res.writeHead(202).end();return;}
  res.setHeader('content-type','application/json');
  const result=message.method==='initialize'
   ?{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'local-unknown-read',version:'1.0.0'}}
   :{tools:[{name:'lookup',description:'Look up a local note.',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]};
  if(message.method==='tools/call'){
   calls++;entered();
   if(mode==='complete'){
    await gate;res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:'A verified local note.'}]}}));return;
   }
   // A protocol error is not an observed tool result. It must remain UNKNOWN.
   res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'Synthetic lost result'}}));
  }else res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 return {url:`http://127.0.0.1:${address.port}/mcp`,calls:()=>calls,called,release,
  async close(){release();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}
/** Subscribe before inspecting: a Host event during an async read must not be lost. */
export function hostState(host:Pick<Host,'on'>,diagnostic:()=>string){
 return async(check:()=>Promise<boolean>|boolean)=>{
  let active=true,revision=0,checks=0,lastEvent:unknown,wake:(()=>void)|undefined;
  const off=host.on(event=>{revision++;lastEvent=event;wake?.();});
  try{
   await hangDetector((async()=>{
    while(active){
     const before=revision;
     checks++;
     if(await check())return;
     if(!active)return;
     if(revision!==before)continue;
     await new Promise<void>(resolve=>{wake=resolve;});
    }
   })(),'channel Host state settles',{diagnostic:()=>JSON.stringify({checks,lastEvent,fixture:diagnostic()})});
  }finally{active=false;off();wake?.();}
 };
}
