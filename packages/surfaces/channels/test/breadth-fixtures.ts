import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';

// A signed local relay exercises the SDK's documented Teams verifier boundary.
export const relaySecret = 'synthetic-local-relay-secret';
export function verifyRelay(request: Request, body: string) {
  const expected = createHmac('sha256', relaySecret).update(body).digest();
  const supplied = Buffer.from(request.headers.get('x-test-signature') ?? '', 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
export async function breadthEndpoint() {
  const requests: {path:string; body:Record<string,unknown>}[] = [], sockets = new Set<Socket>();
  let entered!:()=>void;
  const posted=new Promise<void>(resolve=>{entered=resolve;});
  let silent=false;
  const server = createServer(async (req,res) => {
    let body='';for await(const chunk of req)body+=chunk;
    requests.push({path:req.url!,body:body?JSON.parse(body):{}});
    if(req.url?.endsWith('/messages')||req.url?.endsWith('/activities'))entered();
    if(silent)return;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({type:1,id:String(requests.length),channel_id:'D1',author:{id:'BOT',username:'assistant',bot:true},content:body?JSON.parse(body).content??'':'',timestamp:new Date().toISOString(),attachments:[]}));
  });
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address();if(!address||typeof address==='string')throw new Error('No local address');
  return {url:`http://127.0.0.1:${address.port}`,requests,posted,silence(){silent=true;},posts:()=>requests.filter(r=>r.path.endsWith('/messages')||r.path.endsWith('/activities')),
    async close(){for(const s of sockets)s.destroy();await new Promise<void>(r=>server.close(()=>r()));}};
}
export function discordMessage(id:number,text:string,extra={}) {
  return {type:'GATEWAY_MESSAGE_CREATE',timestamp:Date.now(),data:{id:String(id),channel_id:'D1',author:{id:'U1',username:'person',bot:false},content:text,timestamp:new Date().toISOString(),mentions:[],attachments:[],...extra}};
}
export function teamsMessage(id:number,text:string,url:string,extra={}) {
  return {type:'message',id:String(id),timestamp:new Date().toISOString(),serviceUrl:url,channelId:'msteams',from:{id:'U1',name:'Person'},recipient:{id:'28:app-id',name:'assistant'},conversation:{id:'a:personal',conversationType:'personal',tenantId:'tenant-one'},channelData:{tenant:{id:'tenant-one'}},text,...extra};
}
export function breadthRequest(provider:'discord'|'teams',payload:unknown,valid=true) {
  const body=JSON.stringify(payload);
  return new Request('http://localhost/events',{method:'POST',body,headers:{'content-type':'application/json',...(provider==='discord'?{'x-discord-gateway-token':valid?'fake-discord-token':'wrong'}:{'x-test-signature':createHmac('sha256',valid?relaySecret:'wrong').update(body).digest('hex')})}});
}
