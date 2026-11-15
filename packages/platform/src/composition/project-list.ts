import {readFileSync} from 'node:fs';
import type {Project} from '../api.ts';
import {writeJson} from '../stub/fsx.ts';

type StoredProject=Project&{dir:string};
/** Atomic replacement leaves old or new bytes. Only a readable list can release a failed write. */
export function projectList(path:string,initial:StoredProject[],write:(next:StoredProject[])=>void=next=>writeJson(path,next)) {
  let current=initial,uncertain=false;
  const read=()=>{
    if(uncertain){
      const next:unknown=JSON.parse(readFileSync(path,'utf8'));
      if(!Array.isArray(next)||!next.every(p=>p&&typeof p.id==='string'&&typeof p.name==='string'&&typeof p.dir==='string'&&['folder','git'].includes(p.kind)&&typeof p.createdAt==='string'&&(p.archived===undefined||typeof p.archived==='boolean')))throw new Error('The project list could not be read. No project change was attempted.');
      current=next;uncertain=false;
    }
    return current;
  };
  const unavailable=()=>{try{read();return false;}catch{return true;}};
  return {read,unavailable,save(next:StoredProject[]){
    if(unavailable())throw new Error('An earlier project write could not be confirmed. Check the project list before another change.');
    try{write(next);current=next;}catch(error){uncertain=true;throw error;}
  }};
}
