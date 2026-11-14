// Layout is view state. Once access ends, retain its pending snapshot locally;
// never resend it through an ended identity or bypass the draft/content drain.
import { createWriteBehind } from './write-behind.ts';
export function createViewerLayoutWriter<T>(options:{write(prefs:T):Promise<void>;retain(prefs:T):void;delay?:number}) {
  let retired=false;
  const writer=createWriteBehind<T>({delay:options.delay??150,async write(batch){
    for(const prefs of batch.values()){
      if(retired){options.retain(prefs);continue;}
      try{await options.write(prefs);}
      catch(error){if(!retired)throw error;options.retain(prefs);}
    }
  }});
  return {...writer,retired:()=>retired,endAccess(){retired=true;return writer.flush();}};
}

// Retention is window-local recovery state, but its resource IDs still belong
// to the person who selected them. An old unbound snapshot cannot be reassigned.
export function retainedViewerLayout<T>(storage:{getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void}) {
 const key=(person:string)=>`viewer-left:${person}`;
 return {
  read(person:string):T|undefined{try{storage.removeItem('viewer-left');const value=storage.getItem(key(person));return value?JSON.parse(value) as T:undefined;}catch{return undefined;}},
  retain(person:string,prefs:T){storage.setItem(key(person),JSON.stringify(prefs));},
  clear(person:string){storage.removeItem(key(person));},
 };
}
