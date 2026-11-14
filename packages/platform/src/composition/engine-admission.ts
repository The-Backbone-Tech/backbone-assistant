// Every engine with native account tools uses the same live project audience check.
import {hostToolsOnly} from './harnesses.ts';
export const SHARED_ENGINE_REFUSAL='This engine uses your own accounts and cannot run in a shared project. Choose another engine for this project.';
export class SharedEngineRefusal extends Error {constructor(){super(SHARED_ENGINE_REFUSAL);this.name='SharedEngineRefusal';}}
export async function nativeToolsForProject(id:string,manifest:{capabilities?:{nativeTools?:string}}|undefined,link:{nativeAccountToolsAllowed(project:string):Promise<boolean>},project:string,restricted=false):Promise<boolean>{
 if(hostToolsOnly(id,manifest))return false;
 const allowed=!restricted&&await link.nativeAccountToolsAllowed(project);
 if(!allowed&&id!=='harness-codex')throw new SharedEngineRefusal();
 return allowed;
}

/** Take the native-turn lease before observing the audience, closing share/start races. */
export async function nativeTurnForProject(id:string,manifest:{capabilities?:{nativeTools?:string}}|undefined,link:{nativeAccountToolsAllowed(project:string):Promise<boolean>;nativeAccountTurn(project:string):Promise<()=>Promise<void>>},project:string,restricted=false){
 const release=hostToolsOnly(id,manifest)?async()=>{}:await link.nativeAccountTurn(project);
 try{
  const nativeAccountTools=await nativeToolsForProject(id,manifest,link,project,restricted);
  if(!nativeAccountTools)await release();
  return {nativeAccountTools,release:nativeAccountTools?release:async()=>{}};
 }catch(error){await release();throw error;}
}
