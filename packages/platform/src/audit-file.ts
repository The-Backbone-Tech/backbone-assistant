// File verification retains one line and envelope metadata, regardless of period length.
import {createReadStream} from 'node:fs';
import {AuditInvalid,AuditVerifier,auditJoin,auditVerification,type AuditSummary} from './audit.ts';
async function inspect(file:string):Promise<AuditSummary>{
  const verifier=new AuditVerifier(),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});let pending='';
  for await(const chunk of createReadStream(file,{highWaterMark:65536})){
    pending+=decoder.decode(chunk as Buffer,{stream:true});let at:number;
    while((at=pending.indexOf('\n'))>=0){verifier.accept(pending.slice(0,at));pending=pending.slice(at+1);}
  }
  pending+=decoder.decode();if(pending)throw new AuditInvalid('Audit file needs a final LF.');
  return verifier.finish();
}
export async function verifyAuditFile(file:string,previous?:string){
  const current=await inspect(file);if(previous!==undefined)auditJoin(current,await inspect(previous));
  return auditVerification(current,previous!==undefined);
}
