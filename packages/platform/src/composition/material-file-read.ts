// Trusted file preparation. Callers select an exact source and rendering, never its text or author.
import type {MaterialEntry} from '../api.ts';
import {isWithdrawn,type MaterialStore} from '../stub/material.ts';
import {sha256} from '../stub/fsx.ts';
import type {CoreLink,MaterialReadTentative,MaterialSourceReadRequest,RunHandle} from './core.ts';
import {withHomeLock} from './home-lock.ts';
import {prepareMaterialText,type MaterialReaderProfile} from './material-source-preparation.ts';

export interface MaterialFileReadRequest {
  materialId:string;
  name:string;
  version:number;
  withdrawals:number;
  profile:MaterialReaderProfile;
  /** Only the trusted merge caller requests history explicitly, never by forging current metadata. */
  historical?:true;
}
export interface MaterialFileReadResult {
  materialId:string;projectId:string;name:string;version:number;withdrawals:number;text:string;
  /** Historical preparation only. No adapter/model receipt or continuing authority. */
  preparation:MaterialReadTentative;
}
/** A proven local source refusal, distinct from Core/transport/COMMIT uncertainty. */
export class MaterialSourceUnavailable extends Error {
  constructor(message:string){super(message);this.name='MaterialSourceUnavailable';}
}
export interface MaterialFileReadEvent {
  kind:'material.read.tentative'|'material.read.confirmed';threadId:string;turnId:string;run:string;
  materialId:string;version:number;generation:number;preparation:MaterialReadTentative;
}
export interface MaterialFileReadOptions {
  home:string;material:Pick<MaterialStore,'load'|'bytes'>;projectId:string;threadId:string;turnId:string;
  handle:RunHandle;signal?:AbortSignal;
  link:{id:Pick<CoreLink['id'],'workspace'>;recordMaterialSourceRead:CoreLink['recordMaterialSourceRead']};
  journal:{append(event:MaterialFileReadEvent):MaterialFileReadEvent&{at:string}};
}

/** A failed newer Save leaves committed versions intact; its warning grants no future bytes. */
function invalidInterruptedSave(entry:MaterialEntry):boolean{
  const warning=entry.interruptedSave;
  if(warning===undefined)return false;
  return (entry.class!=='working'&&entry.class!=='accepted')||!warning||typeof warning!=='object'||Array.isArray(warning)
    ||!Number.isSafeInteger(warning.version)||warning.version<=entry.current;
}

/** Own fresh Store inspection, exact bytes and registration through the same home lock. The
 * resulting text must still pass each consumer's later send-time/source checks after any wait. */
export async function readMaterialFile(options:MaterialFileReadOptions,input:MaterialFileReadRequest):Promise<MaterialFileReadResult>{
  const request=structuredClone(input),handle={...options.handle};
  if(!request||typeof request.materialId!=='string'||typeof request.name!=='string'
    ||!Number.isSafeInteger(request.version)||request.version<1||!Number.isSafeInteger(request.withdrawals)||request.withdrawals<0
    ||(request.historical!==undefined&&request.historical!==true)
    ||(request.historical&&request.profile!=='historical-utf8')||(!request.historical&&request.profile==='historical-utf8'))
    throw new Error('A file read requires an exact source and an explicit supported current or historical preparation.');
  const {home,material,projectId,threadId,turnId,link,journal}=options;
  const workspace=link.id.workspace;
  return withHomeLock(home,async lost=>{
    const signal=options.signal?AbortSignal.any([lost,options.signal]):lost;
    signal.throwIfAborted();
    const load=():MaterialEntry=>{
      const entry=material.load(request.materialId);
      if(!entry||entry.id!==request.materialId||entry.projectId!==projectId||entry.name!==request.name
        ||entry.hidden||entry.held||entry.unsure||entry.recovery||invalidInterruptedSave(entry)||entry.observation?.state==='pending'||isWithdrawn(entry)
        ||(entry.withdrawals?.length??0)!==request.withdrawals||request.version>entry.current||(!request.historical&&entry.current!==request.version))
        throw new MaterialSourceUnavailable('The requested material changed or is unavailable for agent input.');
      return entry;
    };
    const entry=load(),metadata=JSON.stringify(entry);
    const prepared=prepareMaterialText(entry,request.version,material.bytes(entry.id,request.version),request.profile);
    const author=entry.fromServer||entry.restored||(entry.class==='original'&&entry.projection==='managed')
      ?null:entry.versions.find(version=>version.n===request.version)!.by;
    const payload:MaterialSourceReadRequest={
      project:projectId,material:entry.id,version:request.version,generation:request.withdrawals,readKey:'',
      originalSha256:prepared.originalSha256,
      transformation:{...prepared.transformation,name:entry.name,mediaType:entry.mediaType},
      sourceKind:entry.fromServer?'mcp':'file',episodeContent:prepared.text,preparedText:prepared.text,authoredBy:author,
      ...(entry.fromServer?{connection:entry.fromServer.connection,tool:entry.fromServer.tool}:{})
    };
    // Same original run and exact payload reuse one registration, including after carrier reclaim.
    // Different turn/profile/bytes/provenance/generation cannot alias that historical identity.
    payload.readKey=sha256(JSON.stringify(['material-file-read-v1',workspace,handle.run,threadId,turnId,payload]));
    const retain=(kind:MaterialFileReadEvent['kind'],preparation:MaterialReadTentative):undefined=>{
      const event:MaterialFileReadEvent={kind,threadId,turnId,run:handle.run,materialId:entry.id,version:request.version,generation:request.withdrawals,preparation};
      const written=journal.append(event);
      if(!written||typeof written.at!=='string')throw new Error('Material read history requires a synchronous durable journal append.');
      return undefined;
    };
    const confirmation=await link.recordMaterialSourceRead(handle,payload,tentative=>retain('material.read.tentative',tentative),signal);
    // Keep an acknowledged historical outcome even when a stop prevents handover.
    retain('material.read.confirmed',confirmation);
    signal.throwIfAborted();
    const fresh=load();
    if(JSON.stringify(fresh)!==metadata||sha256(material.bytes(entry.id,request.version))!==prepared.originalSha256)
      throw new MaterialSourceUnavailable('The requested material changed before prepared text could be handed over.');
    return {materialId:entry.id,projectId,name:entry.name,version:request.version,withdrawals:request.withdrawals,text:prepared.text,preparation:confirmation};
  },60_000,options.signal);
}
