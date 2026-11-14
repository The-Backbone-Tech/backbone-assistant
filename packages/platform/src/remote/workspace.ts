// One remote workspace per client data folder for stage 1. The entire connection
// record, including its bearer secret, lives in the existing encrypted vault.
import { createHash } from 'node:crypto';
import type { Args, Method, Result, Receipt } from '../api.ts';
import type { WorkspacePerson } from '../api-identity.ts';
import { Vault, type HomeKeys } from '../keys/vault.ts';
import { withHomeLock } from '../composition/home-lock.ts';
import { RemoteClient, RemoteError, parseJoinLink, type RemoteAddress } from './client.ts';
interface Saved extends RemoteAddress { session:string; owner?:string }
export async function remoteWorkspace(home:string,keys:HomeKeys){
  const vault=await Vault.open(home,keys), entry='remote.workspace';
  const saved=():Saved=>{
    const bytes=vault.get(entry);
    if(!bytes?.length)throw new Error('Join a workspace first with backbone join <link>.');
    const value=JSON.parse(bytes.toString('utf8')) as Saved;
    if(!/^[A-Za-z0-9_-]{30,256}$/.test(value.session))throw new Error('The saved workspace session is invalid. Join again with a new invitation.');
    return value;
  };
  const pendingEntry='remote.pending-app-sends';
  interface Pending { key:string; session:string; at:number }
  const scope=(value:Saved)=>createHash('sha256').update(JSON.stringify([value.origin,value.fingerprint,value.session])).digest('hex');
  const sendKey=(value:Saved,key:string)=>createHash('sha256').update(JSON.stringify([value.origin,value.fingerprint,value.session,key])).digest('hex');
  const pending=(value:Saved):Pending[]=>{
    const entries=JSON.parse(vault.get(pendingEntry)?.toString('utf8')??'[]') as (Pending|string)[];
    return entries.filter((item):item is Pending=>typeof item!=='string'&&item.session===scope(value)&&item.at>Date.now()-12*60*60*1000).slice(-4096);
  };
  function owned(owner:string):Saved {
    const value=saved();
    // Legacy unowned records remain usable by the CLI, but cannot acquire app authority.
    if(value.owner!==owner)throw new Error('Sign in as the local person who joined this workspace.');
    return value;
  }
  const release=(value:Saved,key:string)=>withHomeLock(home,()=>vault.put(pendingEntry,Buffer.from(JSON.stringify(pending(value).filter(item=>item.key!==key)))));
  // Reserve before sending. A crash or lost acknowledgement keeps the reservation;
  // no app retry can turn an unknown outcome into another network mutation.
  async function appCall<M extends Method>(value:Saved,method:M,args:Args<M>):Promise<Result<M>> {
    const client=new RemoteClient(value,value.session);
    if(method!=='turns.send')return client.call(method,args);
    const key=sendKey(value,(args as Args<'turns.send'>).clientKey);
    await withHomeLock(home,async()=>{
      const keys=pending(value);
      if(keys.some(item=>item.key===key))throw new RemoteError('Unknown outcome. Read the conversation and check its messages before starting new work. Nothing was resent.','UNKNOWN');
      await vault.put(pendingEntry,Buffer.from(JSON.stringify([...keys.slice(-4095),{key,session:scope(value),at:Date.now()}])));
    });
    try {
      const result=await client.call('turns.send',args as Args<'turns.send'>);
      if(result.ok||result.outcome!=='UNKNOWN')await release(value,key);
      return result as Result<M>;
    }catch(error){if(error instanceof RemoteError&&error.outcome==='REFUSED')await release(value,key);throw error;}
  }
  return {
    connection():{origin:string}|undefined {
      if(!vault.get(entry)?.length)return undefined;
      const value=saved(),client=new RemoteClient(value,value.session);
      return {origin:client.target.origin};
    },
    owner():string|undefined {return vault.get(entry)?.length?saved().owner:undefined;},
    async releaseAppSend(owner:string,key:string):Promise<void>{const value=owned(owner);await release(value,sendKey(value,key));},
    async appClient(owner='device owner'):Promise<RemoteClient>{
      const value=owned(owner),client=new RemoteClient(value,value.session);
      await withHomeLock(home,async()=>{
        const entries=JSON.parse(vault.get(pendingEntry)?.toString('utf8')??'[]') as (Pending|string)[];
        // Stamp old hash-only reservations once, so reopening cannot renew their age.
        if(entries.some(item=>typeof item==='string'))await vault.put(pendingEntry,Buffer.from(JSON.stringify(entries.map(item=>typeof item==='string'?{key:item,session:scope(value),at:Date.now()}:item).slice(-4096))));
      });
      client.call=<M extends Method>(method:M,args:Args<M>)=>appCall(value,method,args);
      return client;
    },
    async join(link:string,name:string,owner='device owner'):Promise<WorkspacePerson>{
      const target=parseJoinLink(link);
      if(!name.trim()||name.length>200)throw new Error('Give your name, up to 200 characters.');
      const receipt=await new RemoteClient(target).request('/identity/accept',{invitation:target.invitation,name}) as Receipt<{session:string;person:WorkspacePerson}>;
      if(!receipt.ok)throw new Error('The invitation was refused. Ask the owner for a new invitation.');
      const {session,person}=receipt.value;
      if(!/^[A-Za-z0-9_-]{30,256}$/.test(session))throw new Error('The workspace returned an invalid session. Ask for a new invitation.');
      await withHomeLock(home,async()=>vault.put(entry,Buffer.from(JSON.stringify({origin:target.origin,fingerprint:target.fingerprint,session,owner}))));
      return person;
    },
    async client():Promise<RemoteClient>{const value=saved();return new RemoteClient(value,value.session);},
    async leave(owner?:string):Promise<void>{
      const value=owner===undefined?saved():owned(owner);
      try{
        const reply=await new RemoteClient(value,value.session).request('/identity/sign-out',{}) as Receipt<{ended:boolean}>;
        if(!reply?.ok||reply.value?.ended!==true)throw new Error('Unconfirmed sign-out reply.');
      }catch(error){
        if(!(error instanceof RemoteError)||!(error.status===401||error.accessEnded))
          throw new RemoteError('Sign-out could not be confirmed. Your local session was kept. Check the connection before trying again.','UNKNOWN');
      }
      await withHomeLock(home,async()=>{
        // A concurrent join may have replaced the session while the request was away.
        const current=saved();
        if(current.session===value.session&&current.origin===value.origin&&current.fingerprint===value.fingerprint)
          {await vault.put(entry,Buffer.alloc(0));await vault.put(pendingEntry,Buffer.from('[]'));}
      });
    },
  };
}
