import type { Method } from '../api.ts';
import type { StoredThread } from './thread-journal.ts';
import type { MaterialStore } from '../stub/material.ts';
import { IdentityRefused } from './identity-core.ts';

/** Resource ownership is authoritative. A project hint can confirm it, never replace it. */
export function identityResource(method:Method,fields:Record<string,unknown>,threads:Map<string,StoredThread>,material:MaterialStore) {
  const hint=typeof fields.projectId==='string'?fields.projectId:undefined;
  let project=hint,thread:StoredThread|undefined;
  const confirm=(actual:string|undefined)=>{
    if(!actual)throw new IdentityRefused('NOT_FOUND');
    if(project!==undefined&&project!==actual)throw new IdentityRefused();
    project=actual;
  };
  if(method==='projects.update')confirm(typeof fields.id==='string'?fields.id:undefined);
  if(method.startsWith('threads.')&&['threads.get','threads.update','threads.delete','threads.fork'].includes(method)){
    thread=typeof fields.id==='string'?threads.get(fields.id):undefined;confirm(thread?.summary.projectId);
  }
  for(const key of ['threadId','parentThreadId'] as const)if(fields[key]!==undefined){
    const found=typeof fields[key]==='string'?threads.get(fields[key]):undefined;confirm(found?.summary.projectId);thread??=found;
  }
  if(method==='turns.stop'&&fields.threadId===undefined)throw new IdentityRefused('NOT_FOUND');
  if(['material.read','material.save','material.lifecycle'].includes(method))confirm(typeof fields.id==='string'?material.load(fields.id)?.projectId:undefined);
  if(method==='changes.get'&&fields.version!==undefined){
    const version=fields.version as {materialId?:unknown};confirm(typeof version?.materialId==='string'?material.load(version.materialId)?.projectId:undefined);
  }
  return {project,thread};
}
