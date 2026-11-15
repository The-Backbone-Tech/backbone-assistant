import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Project, Receipt } from '../api.ts';
import { readJson, sha256, writeJson } from '../stub/fsx.ts';
import { assertHomeWriteAdmission, HomeWriteUnavailable, withHomeLock } from './home-lock.ts';
import { decideProjectIntent, type ProjectIntent } from './project-create-intent.ts';
import { prepareReservedProject } from './project-create-prepare.ts';

type StoredProject = Project & {dir:string};
type Cut = (point:'reserved'|'started'|'prepared'|'recorded') => void;
const slug = (s:string) => s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40) || 'project';
const unknown = (detail:string):Receipt<Project> => ({ok:false,reason:'NOT_AVAILABLE',outcome:'UNKNOWN',detail});
const invalid = (detail:string):Receipt<Project> => ({ok:false,reason:'INVALID',outcome:'REFUSED',detail});
const failed = (home:string, intent:ProjectIntent):Receipt<Project> => ({ok:false,reason:'PROJECT_CREATE_FAILED',outcome:'REFUSED',detail:intent.partial ? `The project was not created. Partial files were left at ${join(resolve(home),'projects',intent.project.dir)}; inspect them before removing or reusing them.` : 'The project was not created; its reserved folder could not be prepared. No existing folder was changed.'});

/** The serialized creator records an intent before any filesystem operation. */
export function createKeyedProject(deps:{home:string;list():StoredProject[];save(projects:StoredProject[]):void;emit(id:string):void;cut?:Cut}, name:string, kind:Project['kind'], clientKey:string):Promise<Receipt<Project>> {
  if (typeof clientKey !== 'string' || !clientKey || clientKey.length > 256 || (kind !== 'folder' && kind !== 'git')) return Promise.resolve(invalid('The project creation identity is invalid.'));
  let wrote = false;
  return withHomeLock<Receipt<Project>>(deps.home, async lost => {
    const intentDir=join(deps.home,'project-create-intents');
    assertHomeWriteAdmission(deps.home,intentDir);
    mkdirSync(intentDir,{recursive:true});wrote=true;
    const path=join(intentDir,`${sha256(clientKey)}.json`);
    let prior=readJson<ProjectIntent|null>(path,null);
    const cleanName=name.trim(),id=randomUUID();
    const proposed:ProjectIntent={key:clientKey,name:cleanName,kind,phase:'reserved',project:{id,name:cleanName,kind,createdAt:new Date().toISOString(),dir:`${slug(cleanName)}-${id}`}};
    if (prior && (prior.key!==clientKey || prior.name!==prior.project?.name || prior.kind!==prior.project?.kind || !['reserved','started','ready','failed'].includes(prior.phase) || (prior.phase==='failed' && typeof prior.partial!=='boolean') || typeof prior.project?.id!=='string' || !prior.project.id || typeof prior.project.dir!=='string' || !/^[a-z0-9-]+$/.test(prior.project.dir) || typeof prior.project.createdAt!=='string')) return unknown('The earlier project creation record needs inspection.');
    let decision=decideProjectIntent(prior,proposed,prior ? deps.list().find(project=>project.id===prior!.project.id) : undefined);
    if (decision.action==='conflict') return invalid('This project creation identity was already used with different details.');
    if (decision.action==='unknown') return unknown(`The earlier project creation could not be confirmed. Inspect any files at ${join(resolve(deps.home),'projects',prior!.project.dir)} before leaving this attempt.`);
    if (decision.action==='failed') return failed(deps.home,decision.intent);
    if (decision.action==='reserve') {
      if(lost.aborted) throw new Error('The data folder lock was lost.');
      assertHomeWriteAdmission(deps.home,intentDir);
      writeJson(path,decision.intent);deps.cut?.('reserved');prior=decision.intent;
      decision=decideProjectIntent(prior,proposed,undefined);
    }
    if (decision.action==='start') {
      if(lost.aborted) throw new Error('The data folder lock was lost.');
      assertHomeWriteAdmission(deps.home,intentDir);
      writeJson(path,decision.intent);deps.cut?.('started');
      let partial=false;
      try { prepareReservedProject(deps.home,decision.intent,()=>{partial=true;}); }
      catch (error) {
        if(error instanceof HomeWriteUnavailable) throw error;
        if(lost.aborted) throw new Error('The data folder lock was lost.');
        const stopped:ProjectIntent={...decision.intent,phase:'failed',partial};
        assertHomeWriteAdmission(deps.home,intentDir);
        writeJson(path,stopped);
        return failed(deps.home,stopped);
      }
      deps.cut?.('prepared');
      if(lost.aborted) throw new Error('The data folder lock was lost.');
      const projects=[...deps.list(),decision.intent.project];
      assertHomeWriteAdmission(deps.home);
      deps.save(projects);deps.cut?.('recorded');
      decision={action:'ready',intent:{...decision.intent,phase:'ready'}};
    }
    if(decision.action!=='ready') throw new Error('Project creation did not reach a confirmed state.');
    if(lost.aborted) throw new Error('The data folder lock was lost.');
    assertHomeWriteAdmission(deps.home,intentDir);
    writeJson(path,decision.intent);
    const {dir:_dir,...project}=decision.intent.project;deps.emit(project.id);
    return {ok:true,value:project};
  }).catch(error => {
    if (!(error instanceof HomeWriteUnavailable)) throw error;
    // Admission loss must not trigger another write, even to record the failure.
    return wrote ? unknown('Project creation lost write admission after it began. Inspect the project list and creation intent before another attempt.')
      : {ok:false,reason:'NOT_AVAILABLE',outcome:'REFUSED',detail:'Project creation has no write admission. This request created nothing; an earlier attempt with this key may have. Check the project list.'};
  });
}
