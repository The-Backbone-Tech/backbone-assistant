// Main owns the opt-in listener. The saved choice never silently widens to another address.
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { Vault, type HomeKeys } from '@backbone-next/platform/keys';
import { withHomeLock } from '@backbone-next/platform/composition/home-lock';

export interface SharingChoice { enabled:boolean; address:string; port:number }
export interface SharingView extends SharingChoice { addresses:string[]; origin?:string; fingerprint?:string; notice?:string;
  /** True when the engine in use brings its own tools: colleagues can join and read, but their messages are refused. Read-only. */
  engineRefusesColleagues:boolean;engineNotice?:string }
interface Listener { origin:string; fingerprint:string; close():Promise<void> }
type Interfaces=Record<string,{address:string;family:string|number;internal:boolean}[]|undefined>;
// Offer the addresses another computer can reach first, then this computer's own. A link-local IPv6
// address only works with its interface name attached, which an invitation link cannot carry, so it is left out.
export function computerAddresses(interfaces:Interfaces=networkInterfaces()):string[] {
  const usable=Object.values(interfaces).flatMap(entries=>entries??[]).filter(entry=>!!isIP(entry.address)&&!['0.0.0.0','::'].includes(entry.address)&&!/^fe[89ab]/i.test(entry.address));
  const rank=(entry:{address:string;internal:boolean})=>(entry.internal?2:0)+(isIP(entry.address)===6?1:0);
  return [...new Set(usable.map((entry,index)=>({entry,index})).sort((a,b)=>rank(a.entry)-rank(b.entry)||a.index-b.index).map(({entry})=>entry.address))];
}
export async function appSharing(home:string,keys:HomeKeys,dependencies:{addresses():string[];start(address:string,port:number):Promise<Listener>;engineBringsOwnTools():boolean;sharedEngineNotice?():string|undefined}) {
  const vault=await Vault.open(home,keys),entry='app.sharing';
  let pending:Promise<SharingView>|undefined;
  let listener:Listener|undefined,notice:string|undefined,closed=false,busy=false;
  let choice:SharingChoice={enabled:false,address:dependencies.addresses().find(address=>!['127.0.0.1','::1'].includes(address))??'127.0.0.1',port:8443};
  function checked(value:unknown):SharingChoice {
    const given=value as SharingChoice;
    if(!given||typeof given.enabled!=='boolean'||typeof given.address!=='string'||!isIP(given.address)||['0.0.0.0','::'].includes(given.address)||!Number.isInteger(given.port)||given.port<1||given.port>65535)throw new Error('Choose one of this computer’s addresses and a port from 1 to 65535.');
    return {enabled:given.enabled,address:given.address,port:given.port};
  }
  async function start() {
    if(!dependencies.addresses().includes(choice.address))throw new Error('The saved address is no longer available. Choose a current address to turn sharing on.');
    listener=await dependencies.start(choice.address,choice.port);
  }
  const saved=vault.get(entry);
  if(saved)try{choice=checked(JSON.parse(saved.toString('utf8')));if(choice.enabled)await start();}
  catch(error){notice=error instanceof Error?error.message:'Sharing could not start. Choose an address and try again.';}
  return {
    view():SharingView {return {...choice,enabled:!!listener,addresses:dependencies.addresses(),engineRefusesColleagues:dependencies.engineBringsOwnTools(),engineNotice:dependencies.sharedEngineNotice?.(),...(listener?{origin:listener.origin,fingerprint:listener.fingerprint}:{}),...(notice?{notice}:{})};},
    configure(value:unknown):Promise<SharingView> {
      if(closed||busy)return Promise.reject(new Error('Sharing is already changing or the app is closing.'));
      let next:SharingChoice;
      try{next=checked(value);}catch(error){return Promise.reject(error);}
      if(next.enabled&&!dependencies.addresses().includes(next.address))return Promise.reject(new Error('This address is no longer available. Choose a current address.'));
      busy=true;
      return pending=(async()=>{
      try {
        await listener?.close();listener=undefined;choice=next;notice=undefined;
        // Persist the off choice before returning, and the enabled choice only after binding.
        if(next.enabled)await start();
        await withHomeLock(home,()=>vault.put(entry,Buffer.from(JSON.stringify(choice))));
        if(closed){await (listener as Listener|undefined)?.close();listener=undefined;}
        return this.view();
      } catch(error){await listener?.close();listener=undefined;notice='Sharing could not start or be saved. Check the address and port, then try again.';throw error;}
      finally{busy=false;}
      })();
    },
    async close(){closed=true;await pending?.catch(()=>{});await listener?.close();listener=undefined;},
  };
}

// Consume startup rejection immediately and retain one safe diagnosis for Settings.
// A failed setup owns no listener and therefore has nothing to close on quit.
export function observeSharing(setup:Promise<Awaited<ReturnType<typeof appSharing>>>):Promise<Awaited<ReturnType<typeof appSharing>>> {
  return setup.catch(()=>({
    view:()=>({enabled:false,address:'127.0.0.1',port:8443,addresses:computerAddresses(),engineRefusesColleagues:false,notice:'Sharing could not start. Restart the app to try again.'}),
    configure:async()=>{throw new Error('Sharing could not start. Restart the app to try again.');},
    close:async()=>{},
  }));
}

export async function closeSharedHost(sharing:Promise<{close():Promise<void>}>,host:{close():void}):Promise<void>{
  await (await sharing).close();
  host.close();
}
