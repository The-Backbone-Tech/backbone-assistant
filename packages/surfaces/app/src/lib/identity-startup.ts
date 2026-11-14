import type {Result} from '@backbone-next/platform';

/** Resolve the layout's person before reading retained state. */
export async function layoutPerson(read:()=>Promise<Result<'identity.get'>>):Promise<string>{
 let identity:Result<'identity.get'>;
 try{identity=await read();}catch(error){
  // Native IPC preserves the backend class in a fixed prefix; HTTP preserves
  // its known name. A missing or arbitrary identity response is never legacy.
  const message=error instanceof Error?error.message:String(error);
  if((error instanceof Error&&error.name==='LegacyIdentityUnavailable')||/^Error invoking remote method 'api': LegacyIdentityUnavailable:/.test(message))return 'legacy-device';
  throw error;
 }
 if(!identity?.ok||typeof identity.value?.person?.id!=='string'||!identity.value.person.id)throw new Error('The layout owner is not available.');
 return identity.value.person.id;
}
