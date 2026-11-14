// Only small test readers materialize a file. Production exports await a sink page by page.
import {exportAudit as streamAudit,coreAuditSource,type AuditSource} from '../../src/composition/audit-export.ts';
import {exportAuditHome as streamHome,type AuditHomeOptions} from '../../src/composition/audit-home.ts';
import type {AuditExport,AuditOptions} from '../../src/audit.ts';
export {coreAuditSource};export type {AuditSource};
export async function exportAudit(source:AuditSource,options:AuditOptions):Promise<AuditExport>{
  const chunks:string[]=[];const summary=await streamAudit(source,options,async bytes=>{chunks.push(bytes);});
  return{...summary,jsonl:chunks.join('')};
}
export async function collectAuditHome(home:string,options:AuditOptions,setup:AuditHomeOptions={}){
  const chunks:string[]=[];const result=await streamHome(home,options,async bytes=>{chunks.push(bytes);},setup);
  return result.ok?{ok:true as const,value:{...result.value,jsonl:chunks.join('')}}:result;
}
