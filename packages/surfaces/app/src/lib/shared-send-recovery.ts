// Settling submission custody never retries a mutation or claims its work succeeded.
export async function settleSharedSend(key:string,checked:boolean,ports:{find(key:string):Promise<string|undefined>;release(key:string):Promise<void>;clear():Promise<void>}):Promise<string|null|undefined>{
  const found=checked?null:await ports.find(key);
  if(found===undefined)return undefined;
  await ports.release(key);
  await ports.clear();
  return found;
}
