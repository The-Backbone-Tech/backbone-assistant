// Durable file primitives, the one pair every writer of a data home's keys and cluster files uses:
// a file takes its name only once its bytes are on disk, created owner-only from its first byte;
// a name taken or removed holds after a crash once its folder is synced.
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

function syncFolder(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Complete a byte write, including legal partial writes. No progress is a failure, never a
 * successful durability barrier. An explicit position advances with bytes, not string units. */
export function writeAll(fd:number,bytes:Uint8Array,position?:number):void {
  if(position!==undefined&&(!Number.isSafeInteger(position)||position<0))throw new Error('Invalid file write position.');
  let offset=0;
  while(offset<bytes.byteLength){
    const remaining=bytes.byteLength-offset;
    const written=writeSync(fd,bytes,offset,remaining,position===undefined?null:position+offset);
    if(!Number.isSafeInteger(written)||written<=0||written>remaining)throw new Error('File write made no progress or returned an invalid byte count.');
    offset+=written;
  }
}

/** Create an empty file without replacing an existing name. Its parent must already exist.
 * EEXIST also syncs the folder: a concurrent creator may have just introduced that name. */
export function createDurableFile(path:string,mode=0o600):void {
  let fd:number;
  try{fd=openSync(path,'wx',mode);}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    syncFolder(dirname(path));return;
  }
  try{fsyncSync(fd);}finally{closeSync(fd);}
  syncFolder(dirname(path));
}

/** Write `data` at `path`: a new file made with `mode`, synced, renamed into place, its folder synced. */
export function writeDurable(path: string, data: string | Uint8Array, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', mode);
  try {
    writeAll(fd, typeof data === 'string' ? Buffer.from(data) : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  syncFolder(dirname(path));
}

/** Remove `path` if it is there, and sync its folder so the removal holds after a crash. */
export function removeDurable(path: string): void {
  if (!existsSync(path)) return;
  rmSync(path, { force: true });
  syncFolder(dirname(path));
}
