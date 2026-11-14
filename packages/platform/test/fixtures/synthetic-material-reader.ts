// Offline consumer fixture, never evidence of native carrier/SQL authority. The real Store,
// immutable-byte preparation and file-read boundary run; only Core confirmation is synthetic.
import type {Gateway} from '../../src/stub/harness.ts';
import type {MaterialStore} from '../../src/stub/material.ts';
import {sha256} from '../../src/stub/fsx.ts';
import {readMaterialFile} from '../../src/composition/material-file-read.ts';
import {ThreadJournal} from '../../src/composition/thread-journal.ts';

/** Tests that request no files fail explicitly if a read is introduced accidentally. */
export const unexpectedMaterialRead:Gateway['read']=async()=>{throw new Error('This fixture does not admit material reads.');};
const uuid=(value:string)=>`${value.slice(0,8)}-${value.slice(8,12)}-4${value.slice(13,16)}-8${value.slice(17,20)}-${value.slice(20,32)}`;

/** File-consumer tests own a real disposable home. No caller text, author or fake material
 * entry can select preparation; onRead retains an existing test's mutation boundary. */
export function syntheticMaterialReader(home:string,material:MaterialStore,projectId:string,options:{onRead?:()=>Promise<void>;signal?:AbortSignal}={}):Gateway['read']{
  const journal=new ThreadJournal(home);
  return async request=>{
    await options.onRead?.();
    return readMaterialFile({home,material,projectId,threadId:'synthetic-test-thread',turnId:'synthetic-test-turn',
      handle:{run:'11111111-1111-4111-8111-111111111111',fence:1,secret:'synthetic-unused'},signal:options.signal,journal,
      link:{id:{workspace:'22222222-2222-4222-8222-222222222222'},async recordMaterialSourceRead(_handle,payload,retain,signal){
        signal.throwIfAborted();
        const receipt={workspace:'22222222-2222-4222-8222-222222222222',readKey:payload.readKey,
          episode:uuid(sha256(`synthetic-test-episode:${payload.readKey}`)),receipt:uuid(sha256(`synthetic-test-receipt:${payload.readKey}`))};
        retain(receipt);
        return receipt;
      }},
    },request);
  };
}
