// Remote work uses the same command presentation and turn follower as local work.
// This module opens only the colleague's vault; it never starts a local Host/Core.
import { readJoinDetails } from './remote-input.ts';
import { readFileSync } from 'node:fs';
import { attachApi } from '@backbone-next/platform/doors/api-line';
import { chooseKeys } from '@backbone-next/platform/system-keys';
import { remoteWorkspace } from '@backbone-next/platform/remote/workspace';
import { makeJoinLink, RemoteError, ACCESS_ENDED } from '@backbone-next/platform/remote/client';
import type { Receipt } from '@backbone-next/platform';
import { daemonFile } from './daemon.ts';
import { alive } from './session.ts';
import { EXIT, runCommand, type Parsed, type Io } from './commands.ts';

const value=<T>(receipt:Receipt<T>):T=>{if(!receipt.ok)throw new Error(receipt.detail);return receipt.value;};
export async function remoteCommand(parsed:Parsed,io:Io):Promise<number>{
  try {
    const keys=await chooseKeys(parsed.home), workspace=await remoteWorkspace(parsed.home,keys);
    if(parsed.name==='join'){
      const {link,name}=await readJoinDetails(parsed.target,parsed.options.name);
      const person=await workspace.join(link,name);
      io.out(parsed.json?JSON.stringify(person):`Joined as ${person.name}. Run backbone remote projects to see shared work.`);return EXIT.OK;
    }
    if(parsed.name==='remote leave'){await workspace.leave();io.out('Signed out of the workspace. Join again with a new invitation.');return EXIT.OK;}
    const client=await workspace.client();
    if(parsed.name==='remote events'){
      const abort=new AbortController();io.onInterrupt(()=>abort.abort());
      try{for await(const event of client.events(abort.signal))io.out(parsed.json?JSON.stringify(event):event.urgent?.startsWith('Access ended')?ACCESS_ENDED:event.urgent??`Workspace ${event.topic} changed.`);}
      catch(error){if(!abort.signal.aborted)throw error;}return EXIT.OK;
    }
    if(parsed.name==='remote threads'){
      const threads=(await client.call('threads.list',{})).filter(t=>!parsed.options.project||t.projectId===parsed.options.project);
      io.out(parsed.json?JSON.stringify(threads):threads.map(t=>`${t.id}  ${t.title}`).join('\n')||'No shared conversations.');return EXIT.OK;
    }
    const names:Record<string,string>={'remote projects':'projects list','remote read':'threads show','remote send':'send'};
    return await runCommand({...parsed,name:names[parsed.name]},client,{...io,live:true});
  } catch(error){
    io.err(error instanceof Error?error.message:'The workspace request failed.');
    return error instanceof RemoteError&&error.outcome==='UNKNOWN'?EXIT.UNKNOWN:EXIT.REFUSED;
  }
}
export async function sharedDaemonState(home:string):Promise<{pid:number;shared?:{origin:string;fingerprint:string}}|undefined>{
  try{
    const state=JSON.parse(readFileSync(daemonFile(home),'utf8'));
    if(!Number.isSafeInteger(state.pid)||state.pid<=0||!alive(state.pid))return undefined;
    const line=await attachApi(home);
    if(!line)return undefined;
    try{return line.serverPid===state.pid?state:undefined;}finally{line.close();}
  }catch{return undefined;}
}
export async function teamCommand(parsed:Parsed,io:Io):Promise<number>{
  const state=await sharedDaemonState(parsed.home);
  if(!state?.shared)throw new Error('Start the shared service first with backbone daemon run --share <ip>:<port>.');
  const api=await attachApi(parsed.home);
  if(!api)throw new Error('The shared daemon could not be reached on this computer. Check backbone daemon status.');
  try{
    if(parsed.name==='team invite'){
      const invitation=value(await api.call('identity.invite',{role:parsed.options.role??'member'}));
      const link=makeJoinLink({...state.shared,invitation:invitation.token});
      io.out(parsed.json?JSON.stringify({link,expiresAt:invitation.expiresAt}):`Join link (one use, expires ${invitation.expiresAt}):\n${link}\nAfter they join, use backbone team people and backbone team share to share a project.`);
    }else if(parsed.name==='team people'){
      const identity=value(await api.call('identity.get',{}));
      io.out(parsed.json?JSON.stringify(identity.people):identity.people.map(p=>`${p.id}  ${p.name} (${p.role}, ${p.status})`).join('\n'));
    }else if(parsed.name==='team share'){
      value(await api.call('identity.share',{projectId:parsed.target!,personId:parsed.options.person!,access:parsed.options.access==='none'?null:parsed.options.access!}));
      io.out('Project access updated.');
    }else if(parsed.name==='team remove'){
      value(await api.call('identity.remove',{personId:parsed.target!}));io.out('The colleague was removed. Their sessions and running work have ended.');
    }
    return EXIT.OK;
  }finally{api.close();}
}
