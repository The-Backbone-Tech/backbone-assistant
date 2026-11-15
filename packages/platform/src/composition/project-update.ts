import {validProjectName} from '../project-name.ts';
import type { Project, Receipt } from '../api.ts';
import { assertHomeWriteAdmission, HomeBusy, HomeWriteUnavailable, withHomeLock } from './home-lock.ts';

type StoredProject = Project & {dir:string};
export type ProjectPatch = Partial<Pick<Project,'name'|'archived'>>;

/** Project properties live beside conversation summaries, not in the Core sharing record. */
export function updateProject(deps:{home:string;unavailable?():boolean;list():StoredProject[];save(projects:StoredProject[]):void;emit(id:string):void}, id:string, patch:ProjectPatch):Promise<Receipt<Project>> {
  const refused=(detail:string,reason:'INVALID'|'NOT_FOUND'|'NOT_AVAILABLE'='INVALID'):Receipt<Project>=>({ok:false,reason,outcome:'REFUSED',detail});
  const invalid=()=>Promise.resolve(refused('Use a nonempty project name of at most 1,000 characters or an archive setting.'));
  if (!patch || typeof patch!=='object' || Array.isArray(patch))return invalid();
  // The caller cannot add a field or replace a validated value while the lock is awaited.
  const kept={...patch};
  if (!Object.keys(kept).length || Object.keys(kept).some(key=>!['name','archived'].includes(key)) ||
      ('name' in kept && (!validProjectName(kept.name))) ||
      ('archived' in kept && typeof kept.archived!=='boolean')) return invalid();
  let began=false;
  return withHomeLock<Receipt<Project>>(deps.home,async()=>{
    if(deps.unavailable?.())return {ok:false,reason:'NOT_AVAILABLE',outcome:'REFUSED',detail:'An earlier project write could not be confirmed. Check the project list before another change. Nothing was attempted.'};
    const current=deps.list(),project=current.find(project=>project.id===id);
    if(!project)return refused('No such project.','NOT_FOUND');
    const next={...project,...kept,...(kept.name===undefined?{}:{name:kept.name.trim()})};
    const projects=current.map(project=>project.id===id?next:project);
    assertHomeWriteAdmission(deps.home);
    began=true;deps.save(projects);
    const {dir:_dir,...value}=next;deps.emit(id);
    return {ok:true,value};
  }).catch(error=>{
    if(began)return {ok:false,reason:'NOT_AVAILABLE',outcome:'UNKNOWN',detail:'The project change could not be confirmed. Check the project list before another attempt.'};
    if(error instanceof HomeBusy)return refused('This data folder is busy. Nothing was changed.','NOT_AVAILABLE');
    if(error instanceof HomeWriteUnavailable)return refused('The project has no write admission. Nothing was changed.','NOT_AVAILABLE');
    throw error;
  });
}
