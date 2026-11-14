import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { startChannels } from './service.ts';
import type { Provider } from './ledger.ts';

/** Loopback transport; the adapters authenticate each provider before intake. */
export async function serveChannels(service: Awaited<ReturnType<typeof startChannels>>, port: number) {
  const sockets=new Set<Socket>();
  const server=createServer(async(req,res)=>{
    const provider=req.url?.split('/')[2] as Provider;
    if(req.method!=='POST'||req.url!==`/channels/${provider}`||!['slack','telegram','discord','teams'].includes(provider)){res.writeHead(404);res.end();return;}
    try {
      let bytes=0;const chunks:Buffer[]=[];
      for await(const chunk of req){bytes+=chunk.length;if(bytes>1024*1024){res.writeHead(413);res.end();return;}chunks.push(Buffer.from(chunk));}
      const headers=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);
      const response=await service.webhook(provider,new Request(`http://localhost${req.url}`,{method:'POST',headers,body:Buffer.concat(chunks)}));
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
    } catch {res.writeHead(503);res.end('Channel intake is unavailable.');}
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  const address=server.address() as {port:number};
  return {port:address.port,async close(){for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server.close(()=>r()));}};
}
