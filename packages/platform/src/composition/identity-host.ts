import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_PREFS, normaliseViewerPrefs, type Args, type Result, type Method, type Receipt, type Project, type ApiEvent, type ViewerPrefs, type ThreadSummary, type Turn } from '../api.ts';
import type { IdentityMethods, WorkspacePerson, ProjectAccess, AutomationIdentity } from '../api-identity.ts';
import { readJson, writeJson } from '../stub/fsx.ts';
import type { MaterialStore } from '../stub/material.ts';
import {CoreRefusal,type CoreLink} from './core.ts';
import type { StoredThread } from './thread-journal.ts';
import { assertHomeWriteAdmission, withHomeLock } from './home-lock.ts';
import { IdentityRefused, SharedEngineRequired, PersonalConversationRequired, AutomationSetupRefused, IdentityUnavailable, LegacyIdentityUnavailable, identityTokenHash } from './identity-core.ts';
import {withIdentityLocal} from './identity-local.ts';
import { withAdmissionTail } from './admission-tail.ts';
import { identityResource } from './identity-resources.ts';
import { READS } from './host-reads.ts';
import { searchThreads } from './thread-search.ts';
import { CompanySignIn, type CompanySignInOptions } from './identity-oidc.ts';
import { createScimHandler, ScimRefusal, type IdentityDirectory, type DirectoryPerson } from './identity-scim.ts';

type Dispatch = <M extends Method>(method: M, args: Args<M>) => Promise<Result<M>>;
const ok = <T>(value: T): Receipt<T> => ({ ok: true, value });
const admin = (person: WorkspacePerson) => person.role === 'owner' || person.role === 'admin';
const administrative = new Set<Method>(['identity.invite','identity.role','identity.remove','identity.share','identity.automation.create','identity.automation.revoke','identity.automation.run']);
const projectReads = new Set<Method>(['threads.get','material.list','material.read','files.list','files.resolveLink','changes.get','work.now']);
// Status reads and Stop never wait for the home lock: they admit on the reserved lane (admission-lanes.ts).
const statusLane = new Set<Method>(['threads.get','threads.list','projects.list','turns.stop']);
const projectWrites = new Set<Method>(['turns.send','turns.stop','material.save','material.lifecycle','threads.update','threads.delete']);

export interface IdentityHostDeps {
  home: string;
  readOnly: boolean;
  link(): Promise<CoreLink>;
  projects(): Project[];
  threads: Map<string, StoredThread>;
  summary(thread:StoredThread):Promise<ThreadSummary>;
  material: MaterialStore;
  piece(): string | null;
  nativeEngine(): boolean;
  sharedHint?(): string | null;
  sharedActive?(): boolean;
  checkSharedThread?(thread: StoredThread): void;
  sharedWork?<T>(work: () => Promise<T>, required?: boolean): Promise<T>;
  emit(event: ApiEvent): void;
  abort(person?: string, automation?: string): void;
  on(listener: (event: ApiEvent) => void): () => void;
  dispatch: Dispatch;
  configuration?: { company?: CompanySignInOptions; directory?: { bearer: string; issuer: string } };
}

export function createIdentityHost(deps: IdentityHostDeps) {
  const sharedWork = deps.sharedWork ?? (<T>(work: () => Promise<T>) => work());
  const deviceRequests = new AsyncLocalStorage<{device:boolean}>();
  let bootstrap: Promise<void> | undefined;
  const boot = () => bootstrap ??= (async () => {
    let link:CoreLink;
    try{link=await deps.link();link.identities.requireReady();}catch{throw new IdentityUnavailable();}
    if (deps.readOnly||!link.deviceAvailable) return;
    const device={workspace:link.id.workspace,principal:link.identities.devicePerson};
    // Register existing local projects without changing a binding already present in Core.
    for (const project of deps.projects()) await link.call(device, 'SELECT gov.identity_register_project($1)', [project.id]);
    for (const thread of deps.threads.values()) if (thread.task && (!thread.personId || thread.personId === link.identities.devicePerson)) {
      await link.call(device, 'SELECT gov.identity_bind_task($1,$2)', [thread.summary.projectId,thread.task]);
    }
  })();
  const access = async (link: CoreLink, project: string): Promise<ProjectAccess | null> => (await link.read<{access:ProjectAccess|null}>(link.person(), 'SELECT gov.identity_project_access($1) AS access', [project])).rows[0]?.access ?? null;
  async function registerCreatedProject(link:CoreLink,project:string):Promise<void>{
    // The project dispatch already committed. Even a definite metadata refusal
    // cannot prove that the person's mutation was refused or safe to repeat.
    try{await link.call(link.person(),'SELECT gov.identity_register_project($1)',[project]);}
    catch(error){throw new Error('The project was created, but its registration could not be confirmed. Inspect projects and receipts before retrying.',{cause:error});}
  }
  const people = async (link: CoreLink) => (await link.read<WorkspacePerson>(link.person(), 'SELECT * FROM gov.identity_people()')).rows;
  const me = async (link: CoreLink): Promise<WorkspacePerson> => {
    const row = (await link.read<WorkspacePerson>(link.person(), `SELECT id,name,role,status FROM app.principals WHERE id=$1 AND status='active' AND kind='person'`, [link.id.person])).rows[0];
    if (!row) throw new IdentityRefused();
    return row;
  };
  const viewerPath=(person:string)=>join(deps.home,'people',person,'viewer.json');
  async function localViewer(person:string,method:Method,fields:Record<string,unknown>){
    const path=viewerPath(person),device=(await deps.link()).identities.devicePerson;
    return withHomeLock<ViewerPrefs>(deps.home,async()=>{
      if(method==='viewer.get'){
        const prior=person===device?readJson<ViewerPrefs>(join(deps.home,'viewer.json'),DEFAULT_PREFS):DEFAULT_PREFS;
        return normaliseViewerPrefs(readJson<ViewerPrefs>(path,prior));
      }
      if(deps.readOnly)throw new IdentityRefused();
      assertHomeWriteAdmission(deps.home,dirname(path));mkdirSync(dirname(path),{recursive:true});
      const kept=normaliseViewerPrefs(fields.prefs as ViewerPrefs);assertHomeWriteAdmission(deps.home,dirname(path));writeJson(path,kept);return kept;
    });
  }
  const draftExists=(key:string)=>existsSync(join(deps.home,'drafts',identityTokenHash(key).slice(0,32)+'.json'));
  const changed = () => deps.emit({ topic: 'identity' });
  const handlers: { [M in keyof IdentityMethods]: (args: Args<M>) => Promise<Result<M>> } = {
    'identity.get': async () => { const link = await deps.link(), person = await me(link); return ok({ person, people: admin(person) ? await people(link) : [], deviceOwner: deviceRequests.getStore()?.device === true && person.id === link.identities.devicePerson, recoveries: person.role==='owner'?(await link.read<{person:string;at:string}>(link.person(),"SELECT actor_id::text AS person,at::text AS at FROM app.ledger WHERE entry_type='identity.device_access_restored' ORDER BY seq")).rows:[] }); },
    'identity.invite': async ({ role }) => {
      const link = await deps.link(), token = randomBytes(32).toString('base64url'), expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      await link.call(link.person(), 'SELECT gov.identity_invite($1,$2,$3)', [identityTokenHash(token),role,expiresAt]); changed(); return ok({ token, expiresAt });
    },
    'identity.role': async ({ personId,role }) => { const link = await deps.link(); await link.call(link.person(), 'SELECT gov.identity_change_role($1,$2)', [personId,role]); if (role === 'guest') deps.abort(personId); changed(); return ok({ changed: true }); },
    'identity.remove': async ({ personId }) => { const link = await deps.link(); await link.call(link.person(), 'SELECT gov.identity_remove($1)', [personId]); deps.abort(personId); changed(); return ok({ removed: true }); },
    'identity.share': async ({ projectId,personId,access: permission }) => { const link = await deps.link(); await link.call(link.person(), 'SELECT gov.identity_project_share($1,$2,$3)', [projectId,personId,permission]); if (permission !== 'editor') deps.abort(personId); changed(); return ok({ shared: true }); },
    'identity.sharing': async ({ projectId }) => {
      const link = await deps.link(), permission = await access(link,projectId);
      if (!permission) throw new IdentityRefused();
      const person = await me(link); return ok({ access: permission, nativeAccountTools: await link.nativeAccountToolsAllowed(projectId), people: permission === 'owner' && admin(person) ? await people(link) : [],
        grants:permission==='owner'?(await link.read<{person:string;access:'viewer'|'editor'}>(link.person(),'SELECT * FROM gov.identity_project_sharing($1)',[projectId])).rows:[] });
    },
    'identity.automations': async () => { const link = await deps.link(); return ok((await link.read<AutomationIdentity>(link.person(), 'SELECT * FROM gov.identity_automations()')).rows); },
    'identity.automation.create': async ({ personId,projectId,name }) => {
      try { return await sharedWork(async () => { const link = await deps.link(); const id = await link.call<string>(link.person(), 'SELECT gov.identity_automation_create($1,$2,$3,$4)', [personId,projectId,name,deps.piece()]); changed(); return ok({ id }); }); }
      catch (error) { if (!(error instanceof SharedEngineRequired)) throw error; throw new AutomationSetupRefused(deviceRequests.getStore()?.device === true ? deps.sharedHint?.() : undefined); }
    },
    'identity.automation.revoke': async ({ id }) => { const link = await deps.link(); await link.call(link.person(), 'SELECT gov.identity_automation_revoke($1)', [id]); deps.abort(undefined,id); changed(); return ok({ revoked: true }); },
    'identity.automation.run': async ({ id,text }) => {
      const link = await deps.link(), automation = (await link.read<AutomationIdentity>(link.person(), 'SELECT * FROM gov.identity_automations()')).rows.find(row=>row.id===id && !row.revoked);
      if (!automation || deps.nativeEngine()) throw new IdentityRefused();
      const invoker=link.id.person;
      return sharedWork(()=>link.identities.asAutomation(automation,async()=>{
        // One workspace identity lock covers both people. Switching the checked
        // actor needs no second lock behind a queued exclusive revoker.
        await link.identities.asPerson(invoker,async()=>{
          if(!admin(await me(link))||!['owner','editor'].includes(await access(link,automation.project)??''))throw new IdentityRefused();
        });
        if (!['owner','editor'].includes(await access(link,automation.project) ?? '')) throw new IdentityRefused();
        const models = await deps.dispatch('models.list',{});
        return deps.dispatch('turns.send', { projectId: automation.project, text, attachments:[],clientKey:randomUUID(),
          settings:{permission:'ask',model:models[0]?.id ?? 'stub',effort:3,runsOn:'this-computer',mode:'chat'} });
      }));
    },
  };

  async function dispatchCall<M extends Method>(token: string | undefined, method: M, args: Args<M>): Promise<Result<M>> {
    if (token === undefined && (method === 'host.status' || method === 'settings.policy.get')) return deps.dispatch(method,args);
    // The trusted local read-only surface inspects connector files offline. It
    // cannot enable, sign or dispatch a tool, and it is not a person transport.
    if(token===undefined&&deps.readOnly&&!deps.configuration?.company&&method==='connectors.list')return deps.dispatch(method,args);
    if(token===undefined&&!deps.configuration?.company){
      let link:CoreLink;
      // The existing dispatch owns vault, owner, schema and closing refusals.
      // A C1 bootstrap must not replace those errors with an identity pause.
      try{link=await deps.link();}catch{
        if(!method.startsWith('identity.'))return deps.dispatch(method,args);
        throw new IdentityUnavailable();
      }
      if(method==='identity.get'&&link.identityStatus.state!=='verified'&&await link.legacyDeviceOnly?.())throw new LegacyIdentityUnavailable();
      if(!method.startsWith('identity.')){
        const legacy=await link.legacyDeviceCall(async()=>{
          const fields=args as Record<string,unknown>,person=link.identities.devicePerson;
          if((method==='viewer.get'||method==='viewer.put')&&existsSync(viewerPath(person)))return await localViewer(person,method,fields) as Result<M>;
          if(method==='drafts.get'||method==='drafts.put'){
            const scoped=`identity:${person}:${String(fields.key)}`;
            if(draftExists(scoped))return deps.dispatch(method,{...fields,key:scoped} as Args<M>);
          }
          return deps.dispatch(method,args);
        },method==='backup.export'||method==='backup.inspect',statusLane.has(method)?'status':'request');
        if(legacy.legacy){
          if(method==='projects.create'&&link.identityStatus.state==='verified'){
            const made=legacy.value as Receipt<Project>;
            if(made.ok)try{await link.call({workspace:link.id.workspace,principal:link.identities.devicePerson},'SELECT gov.identity_register_project($1)',[made.value.id]);}
            catch{bootstrap=undefined;} // The local write committed; the next C1 bootstrap repairs only metadata.
          }
          return legacy.value;
        }
      }
    }
    await boot();
    const link = await deps.link();
    // Administrative crossings take their exclusive lock and re-check the actor themselves.
    // Holding a shared admission while invoking them would deadlock the same request.
    if (administrative.has(method)) {
      if (deps.readOnly) throw new IdentityRefused();
      const person = await link.identities.resolve(token);
      if (method !== 'identity.share' && !admin(person)) throw new IdentityRefused();
      const request = deviceRequests.getStore(); if (request) request.device = token === undefined && person.id === link.identities.devicePerson && person.role === 'owner';
      return link.identities.asPerson(person.id, () => deps.dispatch(method,args));
    }
    return link.identities.admit(token, async person => {
      const device = token === undefined && person.id === link.identities.devicePerson && person.role === 'owner';
      const request = deviceRequests.getStore(); if (request) request.device = device;
      const fields = args as Record<string, unknown>;
      if (method.startsWith('identity.')) return deps.dispatch(method,args);
      let addressed:ReturnType<typeof identityResource>;
      try{addressed=identityResource(method,fields,deps.threads,deps.material);}catch(error){
        if(device&&error instanceof IdentityRefused)return {ok:false,reason:'NOT_FOUND',detail:'No such resource.',outcome:'REFUSED'} as Result<M>;
        throw error;
      }
      const scoped=projectReads.has(method)||projectWrites.has(method)||!!addressed.project;
      if (device && !scoped && !['projects.list','threads.list','threads.search'].includes(method)) {
        const result = await deps.dispatch(method,args);
        if (method === 'projects.create') {
          const made = result as Receipt<Project>;
          if (made.ok) await registerCreatedProject(link,made.value.id);
        }
        return result;
      }
      if (method === 'host.status') return { owns: true } as Result<M>;
      if (method === 'models.list') return device ? deps.dispatch(method,args) : sharedWork(()=>deps.dispatch(method,args));
      if (method === 'projects.create') {
        if (deps.readOnly || person.role === 'guest') throw new IdentityRefused();
        const created=await deps.dispatch('projects.create',{...args as Args<'projects.create'>,clientKey:`identity:${person.id}:${identityTokenHash(String(fields.clientKey ?? randomUUID()))}`});
        if (created.ok) await registerCreatedProject(link,created.value.id);
        return created as Result<M>;
      }
      if(method==='viewer.get'||method==='viewer.put')return await localViewer(person.id,method,fields) as Result<M>;
      if(method==='drafts.get'||method==='drafts.put'){
        const raw=String(fields.key),scoped=`identity:${person.id}:${raw}`;
        // The original device's existing drafts stay theirs when C1 is enabled;
        // other people always use their own namespace.
        const key=person.id===link.identities.devicePerson&&draftExists(raw)&&!draftExists(scoped)?raw:scoped;
        return deps.dispatch(method,{...fields,key} as Args<M>);
      }
      const visible = new Set<string>();
      for (const project of deps.projects()) if (await access(link,project.id)) visible.add(project.id);
      if (method === 'projects.list') return await Promise.all((await deps.dispatch('projects.list',{})).filter(project=>visible.has(project.id)).map(async project=>{const permission=(await access(link,project.id))!;return device&&permission==='owner'?project:{...project,access:permission};})) as Result<M>;
      if (method === 'threads.list') return (await Promise.all([...deps.threads.values()].filter(thread=>visible.has(thread.summary.projectId)).map(async thread=>({...await deps.summary(thread),...(!device?{access:thread.personId===person.id&&['owner','editor'].includes(await access(link,thread.summary.projectId)??'')?'editor' as const:'viewer' as const}:{})})))).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)) as Result<M>;
      if (method === 'threads.search') return searchThreads([...deps.threads.values()].filter(thread=>visible.has(thread.summary.projectId)),String(fields.query ?? '')) as Result<M>;
      if (!device && !projectReads.has(method) && !projectWrites.has(method)) throw new IdentityRefused();
      const {project,thread}=addressed;
      if (!project || !visible.has(project)) throw new IdentityRefused();
      if (projectWrites.has(method)||(device&&!READS.has(method))) {
        if (deps.readOnly || !['owner','editor'].includes(await access(link,project) ?? '')) throw new IdentityRefused();
        if (!device && thread && thread.personId !== person.id) throw new IdentityRefused();
        if(method==='threads.update'&&(fields.patch as {projectId?:string})?.projectId){
          const target=(fields.patch as {projectId:string}).projectId;
          if(device&&!deps.projects().some(project=>project.id===target))return {ok:false,reason:'NOT_FOUND',detail:'No such project.',outcome:'REFUSED'} as Result<M>;
          if(!device||!['owner','editor'].includes(await access(link,target)??''))throw new IdentityRefused();
        }
        if (!device && method === 'turns.send' && deps.nativeEngine()) throw new SharedEngineRequired();
      }
      const check=()=>{const current=identityResource(method,fields,deps.threads,deps.material);if(current.project!==project||(thread&&current.thread!==thread))throw new IdentityRefused();};
      return withIdentityLocal(deps.home,check,async()=>{
        check();
        if(method==='work.now'&&!device){
          const result=await deps.dispatch('work.now',{projectId:project});check();
          return {...result,needsYou:result.needsYou.filter(item=>item.kind!=='connector'&&item.kind!=='connector-read')} as Result<M>;
        }
        const result=await(method==='turns.send'&&!device?sharedWork(()=>{if(thread&&person.id===link.identities.devicePerson)deps.checkSharedThread?.(thread);return link.identities.asPerson(person.id,()=>deps.dispatch(method,args),deps.piece());}):deps.dispatch(method,args));
        // Reads must not return substituted content. A committed write keeps its
        // receipt; its resource was checked before dispatch and under its locks.
        if(READS.has(method))check();
        if(!device&&method==='threads.get'){
          const read=result as Result<'threads.get'>;
          if(read.ok){
            // Internal route hashes can reveal a keyless loopback address by enumeration.
            const outward=(turn:Turn):Turn=>{const {carriers:_private,...work}=turn.work;return {...turn,work};};
            const rewind=(record:NonNullable<typeof read.value.rewinds>[number])=>({...record,turns:record.turns.map(outward),...(record.sideTurns?{sideTurns:record.sideTurns.map(outward)}:{})});
            return {...read,value:{...read.value,turns:read.value.turns.map((turn,index)=>({...outward(turn),...(thread?.personId===person.id?{clientKey:thread.clientKeys[index]}:{})})),sideTurns:(read.value.sideTurns??[]).map(outward),...(read.value.rewinds?{rewinds:read.value.rewinds.map(rewind)}:{}),...(read.value.rewindPending?{rewindPending:rewind(read.value.rewindPending)}:{}),summary:{...read.value.summary,access:thread?.personId===person.id&&['owner','editor'].includes(await access(link,project)??'')?'editor':'viewer'}}} as Result<M>;
          }
        }
        return result;
      });
    }, undefined, statusLane.has(method) ? 'status' : 'request');
  }

  function call<M extends Method>(token: string | undefined, method: M, args: Args<M>): Promise<Result<M>> {
    // A Stop's admitted part authorizes and aborts; its persistence finishes after admission (admission-tail.ts).
    return deviceRequests.run({device:token === undefined}, () => withAdmissionTail(method === 'turns.stop', () => dispatchCall(token, method, args)));
  }
  const ownsThread = (link: CoreLink, thread: StoredThread) => !link.id.automationId && link.id.person === link.identities.devicePerson
    && !thread.automationId && (!thread.personId || thread.personId === link.identities.devicePerson);
  async function canCheckThread(thread: StoredThread): Promise<boolean> {
    return deviceRequests.getStore()?.device === true && ownsThread(await deps.link(), thread);
  }
  /** Trusted device capability: hold live identity admission throughout the local audit write. */
  async function admitDeviceThread<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const link = await deps.link(), thread = deps.threads.get(threadId);
    if (deps.configuration?.company || !thread || !ownsThread(link, thread)) throw new IdentityRefused();
    const project = thread.summary.projectId;
    const check = () => {
      if (deps.threads.get(threadId) !== thread || thread.summary.projectId !== project || !ownsThread(link, thread)) throw new IdentityRefused();
    };
    const run = () => withIdentityLocal(deps.home, check, async () => { check(); return work(); });
    const legacy = await link.legacyDeviceCall(run);
    if (legacy.legacy) return legacy.value;
    await boot();
    return link.identities.admit(undefined, async person => {
      if (person.role !== 'owner' || !['owner', 'editor'].includes(await access(link, project) ?? '')) throw new IdentityRefused();
      return run();
    });
  }

  async function acceptInvitation(invitation: string, name: string) {
    if(deps.configuration?.company)throw new IdentityRefused();
    await boot(); if (deps.readOnly) throw new IdentityRefused();
    const link = await deps.link(), session = randomBytes(32).toString('base64url');
    const id = await link.call<string>({workspace:link.id.workspace},'SELECT gov.identity_accept($1,$2,$3,$4,$5)',[identityTokenHash(invitation),'urn:local-invitation',randomUUID(),name,identityTokenHash(session)]);
    const person = await link.identities.resolve(session); if (person.id !== id) throw new IdentityRefused();
    changed(); return ok({ session, person });
  }
  async function signOut(token:string) {
    await boot(); const link=await deps.link();
    await link.identities.admit(token,async()=>{
      if(deps.readOnly)throw new IdentityRefused();
      await link.call(link.person(),'SELECT gov.identity_sign_out($1)',[identityTokenHash(token)]);
    });
    changed(); return ok({ended:true as const});
  }
  // Each session owns one audience check and timer, however many windows subscribe.
  // Audience checks share two ordinary request slots; Stop/status keep their reserve.
  let audienceChecks=0;
  const waitingAudiences:(()=>void)[]=[];
  async function checkAudience(work:()=>Promise<void>){
    if(audienceChecks<2)audienceChecks++;
    else await new Promise<void>(resolve=>waitingAudiences.push(resolve));
    try{await work();}finally{const next=waitingAudiences.shift();if(next)next();else audienceChecks--;}
  }
  const audiences = new Map<string, {subscribe(listener:(event:ApiEvent)=>void):(()=>void)&{ready:Promise<void>}}>();
  function onAuthenticated(token: string, listener: (event: ApiEvent) => void) {
    const existing=audiences.get(token);if(existing)return existing.subscribe(listener);
    const listeners=new Set<(event:ApiEvent)=>void>();
    let admitted!:()=>void,refused!:(error:unknown)=>void;
    const ready=new Promise<void>((resolve,reject)=>{admitted=resolve;refused=reject;});
    // Local subscribers can retain the synchronous unsubscribe API. The HTTP
    // consumer awaits readiness before admitting a stream to the network.
    void ready.catch(()=>{});
    let ended=false,off=()=>{},visible:Set<string>|undefined,pending=false,checking=false,temporary=false;
    const events=new Map<string,ApiEvent>();
    const publish=(event:ApiEvent)=>{for(const notify of [...listeners])notify(event);};
    const stop=()=>{ended=true;refused(new Error('The event stream closed before admission.'));off();clearInterval(timer);events.clear();if(audiences.get(token)===audience)audiences.delete(token);};
    const inspect=async()=>{
      if(ended||checking)return;
      checking=true;
      do {
        pending=false;
        try {
          await checkAudience(async()=>{
            if(ended)return;
            await boot();const link=await deps.link();
            await link.identities.admit(token,async()=>{
              if(ended)return;
              const current=new Set<string>();
              for(const project of deps.projects())if(await access(link,project.id))current.add(project.id);
              if(visible&&[...visible].some(project=>!current.has(project)))throw new IdentityRefused();
              visible=current;temporary=false;
              const batch=[...events.values()];events.clear();
              for(const event of batch){
                if(event.topic==='identity'){publish(event);continue;}
                const project=event.topic==='threads'&&event.id?deps.threads.get(event.id)?.summary.projectId:(event.topic==='projects'||event.topic==='material')?event.id:undefined;
                if(project&&current.has(project))publish(event);
              }
            },undefined,'request');
            admitted();
          });
        } catch(error) {
          refused(error);
          events.clear();
          if(!ended&&error instanceof IdentityRefused){stop();publish({topic:'identity',urgent:'Access ended. Sign in again.'});}
          else if(!ended&&!temporary){temporary=true;publish({topic:'identity',urgent:'Temporary workspace connection problem. Access could not be checked; retry shortly.'});}
        }
      }while(pending&&!ended);
      checking=false;
    };
    const enqueue=(event?:ApiEvent)=>{
      if(ended)return;
      if(event)events.set(event.topic+':'+(event.id??''),event);
      pending=true;void inspect();
    };
    const timer=setInterval(()=>enqueue(),5_000);timer.unref();
    const audience={subscribe(notify:(event:ApiEvent)=>void){listeners.add(notify);return Object.assign(()=>{listeners.delete(notify);if(!listeners.size)stop();},{ready});}};
    audiences.set(token,audience);
    const unsubscribe=audience.subscribe(listener);
    off=deps.on(event=>enqueue(event));enqueue();
    return unsubscribe;
  }
  let company: Promise<CompanySignIn> | undefined;
  const companyClient = () => {
    if (!deps.configuration?.company || deps.readOnly) throw new IdentityRefused();
    return company ??= CompanySignIn.connect(deps.configuration.company);
  };
  async function beginCompanySignIn(browser: string) { await boot(); return (await companyClient()).begin(browser); }
  async function completeCompanySignIn(callback: URL, browser: string, invitation?: string) {
    await boot(); const proof = await (await companyClient()).complete(callback,browser), link = await deps.link();
    const session = randomBytes(32).toString('base64url');
    if (invitation) await link.call({workspace:link.id.workspace},'SELECT gov.identity_accept($1,$2,$3,$4,$5)',[identityTokenHash(invitation),proof.issuer,proof.subject,proof.displayName,identityTokenHash(session)]);
    else await link.call({workspace:link.id.workspace},'SELECT gov.identity_sign_in($1,$2,$3)',[proof.issuer,proof.subject,identityTokenHash(session)]);
    const person = await link.identities.resolve(session); changed(); return ok({ session,person });
  }
  let directory: ((request:Request)=>Promise<Response>) | undefined;
  async function directoryRequest(request: Request): Promise<Response> {
    if (!deps.configuration?.directory || deps.readOnly) return new Response(null,{status:404});
    await boot(); const configuration = deps.configuration.directory;
    const list = async (): Promise<(DirectoryPerson & {revision:string})[]> => {
      const link = await deps.link();
      return (await link.read<{id:string;username:string;external_id:string;display_name:string;active:boolean;revision:string}>(
        {workspace:link.id.workspace,principal:link.identities.devicePerson},'SELECT * FROM gov.identity_directory_list($1)',[configuration.issuer])).rows
        .map(row=>({id:row.id,userName:row.username,externalId:row.external_id,displayName:row.display_name ?? undefined,active:row.active,revision:row.revision}));
    };
    const storage: IdentityDirectory = {
      list,
      remove:async id=>{
        const current=(await list()).find(person=>person.id===id);if(!current)return false;
        const link=await deps.link();
        const removed=await link.call<string|null>({workspace:link.id.workspace,principal:link.identities.devicePerson},'SELECT gov.identity_directory_delete($1,$2,$3)',[configuration.issuer,id,current.revision]);
        if(!removed)return false;deps.abort(id);changed();return true;
      },
      get: async id => (await list()).find(person=>person.id===id) ?? null,
      create: async person => {
        if (!person.externalId) throw new IdentityRefused();
        const link = await deps.link(), actor={workspace:link.id.workspace,principal:link.identities.devicePerson};
        let id:string;
        try{id=await link.call<string>(actor,'SELECT gov.identity_directory_create($1,$2,$3,$4)',[configuration.issuer,person.externalId,person.userName,person.displayName ?? null]);}
        catch(error){if(error instanceof CoreRefusal&&error.reason==='conflict')throw new ScimRefusal(409);throw error;}
        let made=(await list()).find(row=>row.id===id)!;
        if (!person.active) { await link.call(actor,'SELECT gov.identity_directory_update($1,$2,$3,false,$4)',[configuration.issuer,id,made.displayName ?? null,made.revision]); made=(await list()).find(row=>row.id===id)!; deps.abort(id); }
        changed(); return made;
      },
      update: async (id, change) => {
        const current=(await list()).find(person=>person.id===id); if (!current) return null;
        const next=await change({...current}), link=await deps.link();
        await link.call({workspace:link.id.workspace,principal:link.identities.devicePerson},'SELECT gov.identity_directory_update($1,$2,$3,$4,$5)',[configuration.issuer,id,next.displayName ?? null,next.active,current.revision]);
        if (!next.active) deps.abort(id); changed(); return (await list()).find(person=>person.id===id) ?? null;
      },
    };
    directory ??= createScimHandler({bearer:configuration.bearer,directory:storage});
    return directory(request);
  }
  async function resumeAsActor(thread: StoredThread, work: () => Promise<void>, shared = false) {
    const link=await deps.link();
    const actor=thread.personId ?? link.identities.devicePerson;
    if(!shared&&actor===link.identities.devicePerson&&!thread.automationId&&deps.sharedActive?.())throw new PersonalConversationRequired();
    if((thread.automationId||actor!==link.identities.devicePerson)&&deps.nativeEngine())throw new IdentityRefused();
    if(!shared&&!deps.configuration?.company&&!thread.automationId&&(!thread.personId||thread.personId===link.identities.devicePerson)
      &&await link.legacyDeviceOnly?.())return work();
    await boot();
    const permitted=async()=>{
      if (!['owner','editor'].includes(await access(link,thread.summary.projectId) ?? '')) throw new IdentityRefused();
      return work();
    };
    const resume = async () => {
    if(actor===link.identities.devicePerson&&!thread.automationId)deps.checkSharedThread?.(thread);
    if (thread.automationId) {
      const rows=await link.read<AutomationIdentity>({workspace:link.id.workspace,principal:link.identities.devicePerson},'SELECT * FROM gov.identity_automations()');
      const automation=rows.rows.find(row=>row.id===thread.automationId&&!row.revoked&&row.person===actor&&row.project===thread.summary.projectId);
      if (!automation) throw new IdentityRefused();
      return link.identities.asAutomation(automation,permitted);
    }
    return link.identities.admitPerson(actor,()=>link.identities.asPerson(actor,permitted,deps.piece()));
    };
    return shared || thread.automationId || actor !== link.identities.devicePerson ? sharedWork(resume, shared) : resume();
  }
  return { handlers, call, canCheckThread, admitDeviceThread, acceptInvitation, signOut, onAuthenticated, boot, resumeAsActor, beginCompanySignIn, completeCompanySignIn, directoryRequest };
}
