// Content, not timestamps or an open counter, decides recovery-copy reuse.
import {createHash} from 'node:crypto';
import {lstatSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
export function identityBackupFingerprint(home:string,receipts:unknown):string{
 const hash=createHash('sha256');hash.update(JSON.stringify(receipts));
 const visit=(relative:string)=>{
  const path=join(home,relative),stat=lstatSync(path,{throwIfNoEntry:false});
  hash.update(JSON.stringify(relative));
  if(!stat){hash.update('absent');return;}
  if(stat.isSymbolicLink())throw new Error('A recovery-copy source cannot be a symbolic link.');
  if(stat.isDirectory()){for(const name of readdirSync(path).sort())visit(join(relative,name));return;}
  if(!stat.isFile()||stat.nlink!==1)throw new Error('A recovery-copy source must be an ordinary file.');
  const bytes=readFileSync(path);hash.update(String(bytes.length));hash.update(bytes);
 };
 // Work plus credential inputs to scrubbing; runtime state, logs and copies are excluded.
 for(const path of ['projects.json','threads','drafts','material','memory','skills','.agent-roles','connectors','credentials','settings.json'])visit(path);
 return hash.digest('hex');
}
