// Read and write one bounded page at a time; paths never cross to the holder.
import {open} from 'node:fs/promises';
import {sep,resolve} from 'node:path';
import {auditOptions,type AuditOptions,type AuditSummary,type AuditPage} from '@backbone-next/platform/audit';
import {verifyAuditFile} from '@backbone-next/platform/audit-file';
import {exportAuditHome} from '@backbone-next/platform/composition/audit-home';
import {canonicalHome} from '@backbone-next/platform/composition';
import {attachApi} from '@backbone-next/platform/doors/api-line';
import {chooseKeys} from '@backbone-next/platform/system-keys';
import {EXIT,type Io,type Parsed} from './commands.ts';
import {refuseClosedApp} from './session.ts';
import {waitForAuditSlot} from './audit-slot.ts';
import {writeAuditOutput} from './audit-output.ts';
export async function auditCommand(parsed:Parsed,io:Io):Promise<number>{
  let writing=false;
  try{
    if(parsed.name==='audit verify'){
      const verified=await verifyAuditFile(resolve(parsed.target!),parsed.options.previous?resolve(parsed.options.previous):undefined);
      await writeAuditOutput(process.stdout,(parsed.json?JSON.stringify(verified):`Verified ${verified.count} events: internally whole${verified.joined?', source cursor joined to predecessor':''}. This does not authenticate the source database.`)+'\n');return EXIT.OK;
    }
    const options:AuditOptions=auditOptions({since:parsed.options.since!,until:parsed.options.until!,after:parsed.options.after,includeContent:parsed.options.includeContent,limit:parsed.options.limit});
    const home=canonicalHome(parsed.home),target=parsed.target&&parsed.target!=='-'?resolve(parsed.target):null;
    if(target){const destination=canonicalHome(target);if(destination===home||destination.startsWith(home+sep))throw new Error('An audit file must be outside the data folder.');}
    const line=await attachApi(home);
    let session:string|null=null;
    let file:Awaited<ReturnType<typeof open>>|undefined;
    try{
      // A file can be partial on any later failure; it is never reported as a complete export.
      if(target)file=await open(target,'wx',0o600);
      const write=async(bytes:string)=>{writing=true;if(file)await file.writeFile(bytes);else await writeAuditOutput(process.stdout,bytes);};
      let summary:AuditSummary;
      if(line){
        for(;;){const result: Awaited<ReturnType<typeof line.call<'audit.export'>>> = await waitForAuditSlot(()=>line.call('audit.export',{...options,...(session?{session}:{})}),()=>io.err('Another audit export is active; waiting up to 3 minutes for the holder slot.'));
          if(!result.ok)throw new Error(result.detail);
          const page:AuditPage=result.value;session=page.session;await write(page.jsonl);
          if(page.trailer){summary={header:page.header,trailer:page.trailer};break;}
          if(!session)throw new Error('The holder ended before the audit trailer.');
        }
      }else{
        refuseClosedApp(home);
        const result=await exportAuditHome(home,options,write,{scratchRoot:parsed.options.scratchRoot,keys:await chooseKeys(home,process.env,undefined,{create:false,readOnly:true}),postgresNative:process.env.BACKBONE_POSTGRES_NATIVE||undefined});
        if(!result.ok)throw new Error(result.detail);summary=result.value;
      }
      if(file){await file.close();file=undefined;}
      writing=false;
      if(target)await writeAuditOutput(process.stdout,(parsed.json?JSON.stringify({file:target,count:summary.trailer.count,cursor:summary.trailer.cursor}):`Exported ${summary.trailer.count} events to ${target}.`)+'\n');
      return EXIT.OK;
    }finally{
      if(session&&line)await line.call('audit.export',{...options,session,cancel:true}).catch(()=>{});
      line?.close();if(file)await file.close();
    }
  }catch(error){io.err(`REFUSED: audit ${parsed.name==='audit verify'?'verification':'export'} failed: ${(error as Error).message}${writing?' The audit export was not written whole; discard the partial output.':''}`);return EXIT.REFUSED;}
}
