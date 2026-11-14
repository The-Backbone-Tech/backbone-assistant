// A renderer owns only its main-process session. An empty/ended session never falls
// back to the device owner, and joining drains the previous person's drafts first.
import { RemoteClient, RemoteError } from '@backbone-next/platform/remote/client';
import type { Host } from '@backbone-next/platform/composition';
import type { ApiEvent, Args, Method, Result, Receipt, WorkspacePerson } from '@backbone-next/platform';

export interface IdentityWindow {
  id: number;
  prepare(): Promise<boolean>;
  reload(): Promise<void>;
  failed(): void;
  event(event: ApiEvent): void;
}
export interface RemoteWorkspace {
  join(link:string,name:string,owner?:string):Promise<WorkspacePerson>;
  client():Promise<RemoteClient>;
  leave(owner?:string):Promise<void>;
  appClient?(owner?:string):Promise<RemoteClient>;
  owner?():string|undefined;
  releaseAppSend?(owner:string,key:string):Promise<void>;
}
export interface RemoteView { origin:string; connection:'connecting'|'online'|'temporary'|'ended' }
interface RemoteSession { workspace:RemoteWorkspace; client:RemoteClient; view:RemoteView; owner:string; localToken:string|null|undefined; unknown:Set<string> }
interface Session { workspaceWindow:boolean; remote?:RemoteSession; window: IdentityWindow; token: string | null | undefined; off: () => void; changing: boolean; accessFailed:boolean; controls:AbortController }
export class RendererIdentitySessions {
  private closing = false;
  private remoteChanging = false;
  private readonly repairs = new Map<number, AbortController>();
  private readonly host: Host;
  private readonly windows = new Map<number, Session>();
  private readonly remoteWorkspace?:()=>Promise<RemoteWorkspace>;
  private readonly company:boolean;
  constructor(host: Host, remoteWorkspace?:()=>Promise<RemoteWorkspace>, company=false) { this.host = host; this.remoteWorkspace=remoteWorkspace;this.company=company; }
  bind(window: IdentityWindow, deviceOwner: boolean, workspaceWindow=false): void {
    this.forget(window.id);
    const session: Session = { workspaceWindow, window, token: deviceOwner ? undefined : null, off: () => {}, changing: false, accessFailed:false, controls:new AbortController() };
    this.windows.set(window.id,session); this.listen(session);
  }
  // Main alone opens dedicated workspace windows and carries the local binding.
  bindWorkspace(window:IdentityWindow,sourceId:number):void {
    const source=this.windows.get(sourceId);
    if(!source||source.remote||source.changing||this.closing)throw new Error('Open the workspace from your local window.');
    if(this.company&&typeof source.token!=='string')throw new Error('Sign in locally before joining a workspace.');
    if(!this.company&&!this.deviceOwner(sourceId))throw new Error('Only the device owner can join a workspace on this Mac.');
    this.bind(window,false,true);
    const session=this.windows.get(window.id)!;
    session.token=this.company?source.token:null;this.listen(session);
  }
  private requireWorkspace(session:Session):void {
    if(!this.company&&typeof session.token==='string')throw new Error('Only the device owner can join a workspace on this Mac.');
    if(!session.workspaceWindow)throw new Error('Open a dedicated workspace window from Join a workspace… first.');
  }
  close(): void { this.closing = true; for (const pending of this.repairs.values()) pending.abort(); for (const session of this.windows.values()) { session.controls.abort(); session.off(); } }
  reopen(): void { this.closing = false; for (const session of this.windows.values()) { session.controls = new AbortController(); this.listen(session); } }
  forget(id: number) { this.windows.get(id)?.controls.abort(); this.repairs.get(id)?.abort(); this.windows.get(id)?.off(); this.windows.delete(id); }
  deviceOwner(id: number): boolean { return !this.closing && this.windows.has(id) && !this.windows.get(id)?.remote && this.windows.get(id)?.token === undefined; }
  deviceSignal(id:number):AbortSignal {
    if (!this.deviceOwner(id)) throw new Error('Device owner controls only.');
    return this.windows.get(id)!.controls.signal;
  }
  signedIn(id:number):boolean { const session=this.windows.get(id);return !!session&&(session.remote?session.remote.view.connection!=='ended':session.token!==null); }
  workspaceWindow(id:number):boolean {return this.windows.get(id)?.workspaceWindow??false;}
  remoteView(id:number):RemoteView|undefined {const view=this.windows.get(id)?.remote?.view;return view?{...view}:undefined;}
  private endRemote(session:Session,expected=session.remote){
    if(!expected||session.remote!==expected||!session.remote||session.remote.view.connection==='ended')return;
    session.remote.view.connection='ended';session.off();session.off=()=>{};
    session.window.event({topic:'identity',urgent:'Access ended. Sign in again.'});
  }
  private listen(session: Session) {
    session.off();
    if(session.remote){
      if(session.remote.view.connection==='ended')return;
      const remote=session.remote,controller=new AbortController();
      const localToken=session.token;
      const offLocal=this.company&&typeof localToken==='string'?this.host.onAuthenticated(localToken,event=>{
        if(session.remote!==remote||session.token!==localToken)return;
        if(event.topic==='identity'&&event.urgent?.startsWith('Access ended')){session.token=null;this.endRemote(session,remote);}
      }):()=>{};
      session.off=()=>{controller.abort();offLocal();};
      void (async()=>{
        while(!controller.signal.aborted){
          try {
            for await(const event of remote.client.events(controller.signal)){
              if(controller.signal.aborted)return;
              if(event.topic==='identity'&&event.urgent?.startsWith('Access ended')){this.endRemote(session,remote);return;}
              remote.view.connection=event.topic==='identity'&&event.urgent?'temporary':'online';
              session.window.event(event);
            }
          } catch(error){if(controller.signal.aborted||session.remote!==remote)return;if(error instanceof RemoteError&&error.accessEnded){this.endRemote(session,remote);return;}}
          if(controller.signal.aborted)return;
          remote.view.connection='temporary';session.window.event({topic:'identity',urgent:'Temporary connection problem. Reconnecting automatically.'});
          await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,5_000);controller.signal.addEventListener('abort',done,{once:true});});
        }
      })();
      return;
    }
    session.off = session.token === undefined ? this.host.on(event=>session.window.event(event))
      : session.token === null ? () => {} : this.host.onAuthenticated(session.token,event=>{
        if(event.topic==='identity'&&event.urgent?.startsWith('Access ended')){session.token=null;session.off();session.off=()=>{};}
        session.window.event(event);
      });
  }
  async call<M extends Method>(id: number, method: M, args: Args<M>): Promise<Result<M>> {
    const session = this.windows.get(id);
    if (!session) throw new Error('This window has no identity.');
    if(session.remote){
      const remote=session.remote;
      if(this.company&&await this.localOwner(session)!==remote.owner)throw new Error('Sign in as the local person who joined this workspace.');
      if(session.remote!==remote||session.changing)throw new Error('The workspace identity is changing.');
      if(remote.view.connection==='ended'){
        if(method==='host.status')return {owns:true} as Result<M>;
        throw new Error('Sign in to this workspace.');
      }
      const key=method==='turns.send'?(args as Args<'turns.send'>).clientKey:undefined;
      if(key&&remote.unknown.has(key))throw new Error('Unknown outcome. Read the conversation and check its messages before starting new work. Nothing was resent.');
      if(key){remote.unknown.add(key);if(remote.unknown.size>4096)remote.unknown.delete(remote.unknown.values().next().value!);}
      try {
        const value=await (remote.client.call(method,args));
        if(key&&(!value||typeof value!=='object'||!('ok' in value)||value.ok!==false||!('outcome' in value)||value.outcome!=='UNKNOWN'))remote.unknown.delete(key);
        if(this.signedIn(id))remote.view.connection='online';
        return value;
      }catch(error){
        if(error instanceof RemoteError){
          if(key&&error.outcome==='REFUSED')remote.unknown.delete(key);
          if(error.accessEnded)this.endRemote(session,remote);
          else if(error.status===undefined||error.status>=500)remote.view.connection='temporary';
        }
        throw error;
      }
    }
    if (session.token === null || session.workspaceWindow) {
      if (method === 'host.status') return { owns:true } as Result<M>;
      throw new Error('Sign in to this workspace.');
    }
    try{return session.token === undefined ? await this.host.call(method,args) : await this.host.callAuthenticated(session.token,method,args);}
    catch(error){
      if(session.token===undefined&&error instanceof Error&&['IdentityRefused','IdentityUnavailable'].includes(error.name))session.accessFailed=true;
      throw error;
    }
  }
  async restoreDeviceAccess(id:number):Promise<void>{
    const session = this.windows.get(id);
    if (this.repairs.has(id)) throw new Error('Device recovery is already pending.');
    if(!this.deviceOwner(id))throw new Error('Device owner recovery only.');
    if(!this.windows.get(id)?.accessFailed)throw new Error('Device recovery is not available outside an access failure.');
    const pending = new AbortController(); this.repairs.set(id, pending);
    try {
    if(!(await this.host.deviceRecoveryStatus()).available)throw new Error('Device recovery is not available outside an access failure.');
    if (this.closing || this.windows.get(id) !== session || !this.deviceOwner(id) || session?.changing) throw new Error('Device recovery was withdrawn.');
    pending.signal.throwIfAborted();
    await this.host.restoreDeviceAccess(pending.signal);
    this.windows.get(id)!.accessFailed=false;
    } finally { if (this.repairs.get(id) === pending) this.repairs.delete(id); }
  }
  private async localOwner(session:Session):Promise<string>{
    if(!this.company){
      if(typeof session.token==='string')throw new Error('Only the device owner can join a workspace on this Mac.');
      return 'device owner';
    }
    if(session.remote&&session.token===session.remote.localToken&&typeof session.token==='string')return session.remote.owner;
    if(typeof session.token!=='string')throw new Error('Sign in locally before joining a workspace.');
    const token=session.token;
    const identity=await this.host.callAuthenticated(token,'identity.get',{});
    if(this.closing||session.token!==token||this.windows.get(session.window.id)!==session)throw new Error('The local sign-in has ended.');
    if(!identity.ok)throw new Error('Sign in locally before joining a workspace.');
    return identity.value.person.id;
  }
  async releaseRemoteSend(id:number,key:string):Promise<void>{
    const session=this.windows.get(id),remote=session?.remote;
    if(!session||!remote||remote.view.connection==='ended'||session.changing||this.closing)throw new Error('Sign in to this workspace.');
    const owner=await this.localOwner(session);
    if(owner!==remote.owner)throw new Error('Sign in as the local person who joined this workspace.');
    await remote.workspace.releaseAppSend?.(owner,key);
    remote.unknown.delete(key);
  }
  async restoreRemote(id:number):Promise<void>{return this.attachRemote(id);}
  private async attachRemote(id:number):Promise<void>{
    const session=this.windows.get(id);
    if(!session||session.remote||session.changing||!this.remoteWorkspace||this.closing)throw new Error('Open a workspace sign-in window first.');
    this.requireWorkspace(session);
    if(this.remoteChanging)throw new Error('A workspace sign-in is already in progress.');
    this.remoteChanging=true;
    try {
      const token=session.token,owner=await this.localOwner(session),workspace=await this.remoteWorkspace();
      if(workspace.owner&&workspace.owner()!==owner)throw new Error('Sign in as the local person who joined this workspace.');
      const client=await (workspace.appClient?.(owner)??workspace.client());
      if(this.closing||this.windows.get(id)!==session||session.token!==token)throw new Error('This workspace window has closed or its local sign-in has ended.');
      session.remote={workspace,client,owner,localToken:token,view:{origin:client.target.origin,connection:'connecting'},unknown:new Set()};
      this.listen(session);
    }finally{this.remoteChanging=false;}
  }
  async joinRemote(id:number,link:string,name:string):Promise<Receipt<WorkspacePerson>>{
    const session=this.windows.get(id);
    if(!session||session.changing||this.remoteChanging||this.closing||!this.remoteWorkspace)throw new Error('Open a workspace sign-in window first.');
    this.requireWorkspace(session);
    if([...this.windows.values()].some(other=>other!==session&&other.remote&&other.remote.view.connection!=='ended'))throw new Error('Leave the joined workspace before joining another.');
    session.changing=true;this.remoteChanging=true;session.controls.abort();
    try {
      const token=session.token,owner=await this.localOwner(session);
      if(!await session.window.prepare())throw new Error('Keep the current edits before changing accounts.');
      const workspace=await this.remoteWorkspace();
      if(workspace.owner?.()&&workspace.owner()!==owner)throw new Error('Sign in as the local person who joined this workspace.');
      if(this.closing||this.windows.get(id)!==session||session.token!==token)throw new Error('The local sign-in has ended.');
      const person=await workspace.join(link,name,owner),client=await (workspace.appClient?.(owner)??workspace.client());
      if(this.closing||this.windows.get(id)!==session||session.token!==token)throw new Error('The workspace window closed. Reopen the app to restore the saved session.');
      session.off();
      session.remote={workspace,client,owner,localToken:token,view:{origin:client.target.origin,connection:'connecting'},unknown:new Set()};
      this.listen(session);await session.window.reload();return{ok:true,value:person};
    } catch(error){session.window.failed();throw error;}
    finally{session.changing=false;this.remoteChanging=false;}
  }
  async leaveRemote(id:number):Promise<void>{
    const session=this.windows.get(id);
    if(!session?.remote||session.changing||this.closing)throw new Error('No joined workspace is open.');
    session.changing=true;
    try {
      if(!await session.window.prepare())throw new Error('Keep the current edits before leaving.');
      const owner=await this.localOwner(session);
      if(owner!==session.remote.owner)throw new Error('Sign in as the local person who joined this workspace.');
      await session.remote.workspace.leave(owner);
      session.token=null;
      this.endRemote(session);await session.window.reload();
    }catch(error){session.window.failed();throw error;}
    finally{session.changing=false;}
  }
  async join(id: number, invitation: string, name: string): Promise<Receipt<WorkspacePerson>> {
    return this.activate(id,() => this.host.acceptInvitation(invitation,name));
  }
  async activate(id: number, signIn: () => ReturnType<Host['acceptInvitation']>): Promise<Receipt<WorkspacePerson>> {
    const session=this.windows.get(id);
    if (!session || session.changing) throw new Error('A sign-in is already in progress.');
    if (this.closing) throw new Error('The app is closing.');
    this.repairs.get(id)?.abort(); session.controls.abort();
    session.changing=true;
    try {
      if (!await session.window.prepare()) throw new Error('Keep the current edits before changing accounts.');
      const result=await signIn();
      if (!result.ok) { session.window.failed(); return result; }
      session.remote=undefined;session.workspaceWindow=false;session.token=result.value.session;session.accessFailed=false; this.listen(session);
      await session.window.reload();
      return {ok:true,value:result.value.person};
    } catch {
      session.window.failed();
      throw new Error('Sign-in could not be confirmed. Inspect membership before trying again.');
    } finally { session.changing=false; if (!this.closing) session.controls = new AbortController(); }
  }
}
