import { assertHomeWriteAdmission } from '@backbone-next/platform/composition/home-lock';
import { mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
/** Create the private parent before any advisory lock can create it with its default mode. */
export function secureChannelsHome(home:string):string{
 const dir=join(home,'channels');assertHomeWriteAdmission(home,dir);mkdirSync(dir,{recursive:true,mode:0o700});
 if(lstatSync(dir).isSymbolicLink())throw new Error('The channel folder must be a real directory.');
 chmodSync(dir,0o700);return dir;
}
