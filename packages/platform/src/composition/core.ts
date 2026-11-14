// The platform's link to the core (L0): personal mode's database in the data home, the person's
// workspace and worker, and the crossings the host calls. Everything here goes through named
// crossings as the service role; nothing writes a core store directly.
import { claimCoreHome, refuseStampedHome } from './home-kernel.ts';
import { requireCompleteHome } from './home-complete.ts';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { LOG_POLICY_QUERY, safeLogPolicy } from '../authority/log-policy.ts';
import { type Actor, buildBaseline, openPersonalDatabase, type PersonalDatabase, type MaterialGuardStatus, type MaterialLinkStatus, type MaterialEnforcementStatus, reasonOf, serviceClient, readOnlyConnectionConfig, ReadOnlyClient, IDENTITY_PAUSED, IdentityUpgradeRequired, deviceOnly,deviceOnlyAvailable, deviceRecoveryAvailable, restoreDeviceAccess } from '@backbone/core/db';
import type {MaterialWithdrawalEvent} from '../stub/material.ts';
import { type HomeKeys, Vault } from '../keys/vault.ts';
import { assertHomeWriteAdmission, inActiveHomeLockScope, withHomeLock } from './home-lock.ts';
import { canonicalHome } from '../doors/protocol.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import {backupExistingIdentityHome,recordIdentityUpgrade,identityUpgradeNotice} from './identity-upgrade-backup.ts';
import { IdentityCore } from './identity-core.ts';
import { ADMISSION_CONNECTIONS, admissionLanes, type AdmissionLane } from './admission-lanes.ts';

export interface CoreOptions {
  /** The data home; the cluster lives in `<home>/pg`. */
  home: string;
  /** A prebuilt baseline (a packaged app ships one); otherwise built from packages/core/schema. */
  baselineSql?: string;
  /** Where the PostgreSQL binaries' `native` folder is (a packaged app ships one). */
  postgresNative?: string;
  /**
   * What wraps the home's vault (keys/vault.ts): the Keychain's key in the app. Without it, only a
   * home whose vault is already plaintext (a test home) opens.
   */
  keys?: HomeKeys;
  /** Existing identity and exact current schema only; never claim, initialize or renew. */
  readOnly?: boolean;
  keychainRoutes?:boolean;
  /** Only native app main may start an existing data folder’s Team update. */
  allowIdentityUpgrade?:boolean;
}

/**
 * Who this data home is in its workspace: the person, their worker, its mandate for work no piece
 * carries, and the mandates the person granted for each registered piece (by registration id).
 */
interface Identity {
  workspace: string;
  person: string;
  system: string;
  agent: string;
  mandate: string;
  pieceMandates?: Record<string, string>;
  automationId?: string;
}

export interface RunHandle {
  run: string;
  fence: number;
  secret: string;
}
export interface MaterialWithdrawalConfirmation {workspace:string;event:string;receipt:string}
export interface MaterialSourceReadRequest {
  project:string;material:string;version:number;generation:number;readKey:string;
  originalSha256:string;transformation:Record<string,unknown>;
  sourceKind:'file'|'mcp';episodeContent:string;preparedText:string;
  authoredBy:'person'|'agent'|null;connection?:string;tool?:string;
}
/** Tentative until COMMIT or a matching ledger witness, never current source authority. */
export interface MaterialReadTentative {readonly workspace:string;readonly readKey:string;readonly episode:string;readonly receipt:string}
/** Registration may have committed. Retained IDs require a historical witness or exact
 * registration-only recovery; this never permits another provider call or fresh use. */
export class MaterialCommitUnknown extends Error {
  readonly tentative:MaterialReadTentative;
  constructor(tentative:MaterialReadTentative,cause:unknown){
    super('Core material registration is unresolved; retained identities need confirmation before use.',{cause});
    this.name='MaterialCommitUnknown';this.tentative=Object.freeze({...tentative});
  }
}

export interface EffectState {
  id: string;
  status: string;
  routeReason: string | null;
  repeatOf: string | null;
}

/** A refusal from a crossing, with its reason in the core's words. */
export class CoreRefusal extends Error {
  readonly reason: string;
  constructor(reason: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }
}

/** Proven pre-write refusal. Only a standalone caller may await this close after releasing its
 * lock and retry admission; a nested caller must first leave the outer scope. */
export class CoreCloseWaitRefusal extends Error {
  readonly closed: Promise<void>;
  constructor(closed: Promise<void>) {
    super('This data home is closing; nothing was granted or revoked by this attempt. Try again after it closes.');
    this.name = 'CoreCloseWaitRefusal';
    this.closed = closed;
  }
}

const YEAR = 365 * 86_400_000;
/** A run's lease, renewed while its turn works (kept in step with the host's heartbeat). */
const LEASE_MS = 6_000;
/** Data homes this process is closing, so a host opened again waits for its server to stop. */
interface Closing { done: Promise<void>; pending: boolean; lastFailure?: unknown }
const closing = new Map<string, Closing>();

/** The session settings the core derives identity from, as one parameterized statement. */
function identityStatement(actor: Actor): pg.QueryConfig {
  return {
    text: `SELECT set_config('backbone.workspace', $1, false), set_config('backbone.principal', $2, false),
          set_config('backbone.run', $3, false), set_config('backbone.secret', $4, false)`,
    values: [actor.workspace ?? '', actor.principal ?? '', actor.run?.id ?? '', actor.run?.secret ?? ''],
  };
}

/** Driver errors with Node errno/numeric DOM codes are not SQL refusals. Fatal/connection
 * failures and the server's explicit completion-unknown state also supply no negative proof. */
export function definiteServerRefusal(error:unknown):error is pg.DatabaseError {
  return error instanceof pg.DatabaseError&&error.severity==='ERROR'&&typeof error.code==='string'
    &&!error.code.startsWith('08')&&error.code!=='40003';
}

export class CoreLink {
  private readonly db: PersonalDatabase;
  private readonly pool: pg.Pool;
  private readonly operator: pg.Pool;
  private admissionPool?: pg.Pool;
  private readonly admissionClient=admissionLanes(()=>this.identityPool.connect());
  private get identityPool():pg.Pool {
    if(!this.admissionPool){
      // Material recording owns a dedicated connection and never needs this
      // pool. Construct admission credentials only when identity work uses it.
      this.admissionPool=new pg.Pool({...this.pool.options,password:this.pool.options.password,max:ADMISSION_CONNECTIONS});
      this.admissionPool.on('error',()=>{});
    }
    return this.admissionPool;
  }
  private readonly readOnly: boolean;
  private readonly deviceIdentity: Identity;
  private mountedDevice=false;
  get deviceAvailable(){return this.mountedDevice;}
  private readonly personScope = new AsyncLocalStorage<Identity>();
  readonly identities: IdentityCore;
  get id(): Identity { return this.personScope.getStore() ?? this.deviceIdentity; }
  /** The home's vault: the cluster's passwords and the master key, unsealed only in this process. */
  readonly vault: Vault;
  /** Verified installed guard or a paused capability, never inferred from migration history alone. */
  get identityUpgrade(){return this.db.identityUpgrade;}
  get identityStatus(){return {...(this.db.identityStatus??IDENTITY_PAUSED)};}
  /** Current sole-device facts admit personal work while unrelated Team checks pause.
   * Pre-Team folders retain their stricter historical admission. */
  async legacyDeviceOnly():Promise<boolean>{
    if(this.id.person!==this.deviceIdentity.person)return false;
    const client=await this.operator.connect();
    try{if(await deviceOnlyAvailable(client))return await deviceOnly(client,this.deviceIdentity.workspace,this.deviceIdentity.person);}
    finally{client.release();}
    const {rows}=await this.read<{solo:boolean}>(this.worker(),`SELECT
      EXISTS(SELECT FROM app.principals WHERE id=$1 AND kind='person' AND status='active' AND role='owner')
      AND NOT EXISTS(SELECT FROM app.principals WHERE kind='person' AND id<>$1)
      -- An extra restrictive policy must not hide a second person and manufacture
      -- a legacy exception while the complete C1 catalogue is paused.
      AND EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='app' AND c.relname='principals' AND c.relrowsecurity AND c.relforcerowsecurity)
      AND (SELECT count(*) FROM pg_policies WHERE schemaname='app' AND tablename='principals')=3
      AND EXISTS(SELECT FROM pg_policies WHERE schemaname='app' AND tablename='principals'
        AND policyname='readers' AND cmd='SELECT' AND permissive='PERMISSIVE'
        AND roles=ARRAY['backbone_app']::name[] AND qual='true')
      AND EXISTS(SELECT FROM pg_policies WHERE schemaname='app' AND tablename='principals'
        AND policyname='crossings' AND cmd='ALL' AND permissive='PERMISSIVE'
        AND roles=ARRAY['backbone_gov']::name[] AND qual='true' AND with_check='true')
      AND EXISTS(SELECT FROM pg_policies WHERE schemaname='app' AND tablename='principals'
        AND policyname='tenant_wall' AND cmd='ALL' AND permissive='RESTRICTIVE' AND roles=ARRAY['public']::name[]
        AND qual='(workspace_id = ( SELECT sec.current_workspace() AS current_workspace))'
        AND with_check=qual) AS solo`,[this.deviceIdentity.person]);
    return rows[0]?.solo===true;
  }
  /** A session lease survives individual Core calls and ends with this engine turn.
   * Sharing takes its exclusive counterpart without waiting or aborting work. */
  async nativeAccountTurn(project:string):Promise<()=>Promise<void>>{
    // A running turn must not occupy the operator pool used by recovery and reads.
    const client=new pg.Client(this.operator.options);await client.connect();
    try{await client.query("SET lock_timeout='5s'");await client.query("SELECT pg_advisory_lock_shared(hashtextextended('native-account-turn:'||$1||':'||$2,17))",[this.deviceIdentity.workspace,project]);}
    catch(error){await client.end();throw error;}
    let released=false;
    return async()=>{
      if(released)return;released=true;await client.end();
    };
  }
  /** Native account tools belong only in a project whose live audience is the device owner. */
  async nativeAccountToolsAllowed(project: string): Promise<boolean> {
    if (this.id.person !== this.deviceIdentity.person) return false;
    if (this.identityStatus.state !== 'verified') return this.legacyDeviceOnly();
    const admission=await this.admissionClient('request');let broken=false;
    try{
      await admission.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await admission.query("SET LOCAL lock_timeout='5s'");
      await admission.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('identity:'||$1,17))",[this.deviceIdentity.workspace]);
      // Sharing and person changes use the exclusive side of this mutex. All
      // audience reads therefore describe one state, even with concurrent grants.
      const actor = {workspace: this.id.workspace, principal: this.deviceIdentity.person};
      if (await this.call<string | null>(actor,'SELECT gov.identity_project_access($1)',[project]) !== 'owner') return false;
      const {rows} = await this.read<{id:string;status:string}>(actor,'SELECT * FROM gov.identity_people()');
      for (const person of rows) if (person.status === 'active' && person.id !== actor.principal) {
        if (await this.call<string | null>({...actor,principal:person.id},'SELECT gov.identity_project_access($1)',[project])) return false;
      }
      return true;
    }finally{
      try{await admission.query('ROLLBACK');}catch{broken=true;}
      admission.release(broken);
    }
  }
  /** Keep the sole-device observation stable until its ordinary request settles.
   * This connection holds only an admission lock, so rolling it back cannot
   * discard work committed through the normal local/Core dispatch. */
  async legacyDeviceCall<T>(work:()=>Promise<T>,backup=false,lane:AdmissionLane='request'):Promise<{legacy:false}|{legacy:true;value:T}>{
    const client=await this.admissionClient(lane);let broken=false;
    try{
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('identity:'||$1,17))",[this.deviceIdentity.workspace]);
      const solo=await this.legacyDeviceOnly();
      if(!solo){
        if(!backup||this.identityStatus.state==='verified'||this.id.person!==this.deviceIdentity.person)return {legacy:false};
        const me=(await this.read<{role:string;status:string}>(this.person(),'SELECT role,status FROM app.principals WHERE id=$1',[this.deviceIdentity.person])).rows[0];
        if(me?.role!=='owner'||me.status!=='active')return {legacy:false};
      }
      return {legacy:true,value:await work()};
    }finally{
      try{await client.query('ROLLBACK');}catch{broken=true;}
      client.release(broken);
    }
  }
  /** Trusted process only: no caller can supply a person, workspace or session. */
  async deviceRecoveryStatus():Promise<{available:boolean;notice?:string}>{
    const client=await this.operator.connect();
    try{
      const owner=(await this.read<{status:string;role:string}>(this.worker(),"SELECT status,role FROM app.principals WHERE id=$1",[this.deviceIdentity.person])).rows[0];
      const failed=owner?.status!=='active'||owner?.role!=='owner';
      return {available:!this.readOnly&&failed&&await deviceRecoveryAvailable(client),notice:this.db.identityUpgrade?.state!=='installed'?identityUpgradeNotice(this.db.identityUpgrade):undefined};}
    finally{client.release();}
  }
  async restoreDeviceAccess(signal?:AbortSignal):Promise<void>{
    signal?.throwIfAborted();
    this.requireWritable();
    if(this.id!==this.deviceIdentity)throw new CoreRefusal('denied','Device owner recovery only.');
    if(!(await this.deviceRecoveryStatus()).available)throw new Error('Device recovery is not available outside an access failure.');
    const client=await this.operator.connect();
    try{await restoreDeviceAccess(client,this.deviceIdentity.workspace,this.deviceIdentity.person,signal);}
    finally{client.release();}
    // Replace a removed direct worker without reviving its old permissions.
    // Revoked piece permissions remain revoked.
    const agent=(await this.read<{status:string}>(this.worker(),'SELECT status FROM app.principals WHERE id=$1',[this.deviceIdentity.agent])).rows[0];
    if(agent?.status!=='active'){
      this.deviceIdentity.agent=await this.call<string>({workspace:this.deviceIdentity.workspace,principal:this.deviceIdentity.person},'SELECT gov.create_agent($1,$2)',['Agent','worker']);
      this.deviceIdentity.mandate='';this.deviceIdentity.pieceMandates={};this.save();
    }
  }
  get materialGuard(): Readonly<MaterialGuardStatus> { return { ...this.db.materialGuard }; }
  get materialLink():Readonly<MaterialLinkStatus>{return {...this.db.materialLink};}
  get materialEnforcement():Readonly<MaterialEnforcementStatus>{
    return {...(this.db.materialEnforcement??{state:'paused',reason:'Native material source enforcement is not verified.'})};
  }

  get knowledgeNotice(): string {
    return this.db.materialGuard.state === 'verified'
      ? 'Only message and web evidence is eligible for agent recall and promotion while material withdrawal checks are being completed. Older knowledge with other or uncertain sources is withheld from agents. Your records remain available.'
      : 'Knowledge promotion and recall are paused because source checks could not be verified. Other work remains available; your sources and decisions are kept.';
  }

  requireMaterialGuard(): void {
    if (this.db.materialGuard.state !== 'verified') throw new CoreRefusal('paused', `Knowledge source checks are paused. ${this.db.materialGuard.reason}`);
  }
  private readonly path: string;

  private constructor(db: PersonalDatabase, pool: pg.Pool, operator: pg.Pool, id: Identity, path: string, vault: Vault, readOnly = false) {
    this.db = db;
    this.pool = pool;
    this.operator = operator;
    this.deviceIdentity = id;
    // Long request admissions use a separate lazy pool from nested crossings.
    this.identities = new IdentityCore(lane => this.admissionClient(lane), id, () => this.id, (person, work) => this.personScope.run(person, work),()=>pool.connect(),db.identityStatus);
    this.path = path;
    this.vault = vault;
    this.readOnly = readOnly;
  }

  static async open(options: CoreOptions): Promise<CoreLink> {
    const readOnly = !!options.readOnly;
    // A host of the same data home that this process is still closing goes first: the one closing when
    // this open began, never a close registered later, which waits for this very open.
    // Never await a pending Core close or independently started Core open under the same home lock:
    // mandatory completion or that opener may need it. An open invoked in this scope can re-enter.
    // Snapshot pending state before any claim/Vault/DB effect; a later close is not our predecessor.
    const current = closing.get(canonicalHome(options.home));
    const before = current?.pending ? current.done : undefined;
    if (before && inActiveHomeLockScope(options.home)) throw new CoreCloseWaitRefusal(before);
    let readIdentity: Identity | undefined;
    if (readOnly) {
      requireCompleteHome(options.home); refuseStampedHome(options.home);
      try { readIdentity = JSON.parse(readFileSync(join(options.home,'core.json'),'utf8')) as Identity; }
      catch { throw new CoreRefusal('incomplete','This home is missing a valid Core identity; restore its original identity before opening.'); }
      if (!readIdentity || ![readIdentity.workspace,readIdentity.person,readIdentity.system,readIdentity.agent].every(value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value))) throw new CoreRefusal('incomplete','This home is missing a valid Core identity; restore its original identity before opening.');
    }
    else { assertHomeWriteAdmission(options.home,join(options.home,'keys'),join(options.home,'pg')); await claimCoreHome(options.home); }
    await before;
    const vault = await Vault.open(options.home, options.keys, {readOnly:readOnly});
    const db = await openPersonalDatabase({
      dir: join(options.home, 'pg'),
      baselineSql: options.baselineSql ?? buildBaseline().sql,
      native: options.postgresNative,
      passwords: vault.passwords(),
      readOnly: readOnly,
      allowIdentityUpgrade:options.allowIdentityUpgrade,
      beforeIdentityUpgrade:appUrl=>{
        if(!existsSync(join(options.home,'core.json')))throw new IdentityUpgradeRequired('This data folder has no device identity core record. The Team update was refused.');
        return backupExistingIdentityHome(options.home,appUrl,vault,options.keychainRoutes);
      },
    });
    if(db.identityUpgrade&&!readOnly){
      try{recordIdentityUpgrade(options.home,db.identityUpgrade);}catch{/* A full disk must not close the unchanged data folder. */}
      if(db.identityUpgrade.state!=='installed')process.stderr.write(`[identity update] ${JSON.stringify(db.identityUpgrade)}\n`);
    }
    const session = (connectionString:string) => readOnly ? {...readOnlyConnectionConfig(connectionString),Client:ReadOnlyClient} : {connectionString};
    const pool = new pg.Pool({ ...session(db.appUrl), max: 8, allowExitOnIdle: true });
    // Every device request makes its sole-device check on this pool (legacyDeviceOnly). One
    // connection serialized those checks across a burst of renderer reads.
    const operator = new pg.Pool({ ...session(db.operatorUrl), max: 4, allowExitOnIdle: true });
    // An idle connection the server ends (it is stopping) is no call's failure: a call in flight
    // still rejects on its own. Without a listener the pool would throw it at the process.
    for (const p of [pool, operator]) p.on('error', () => {});
    try {
      for (const p of [pool, operator]) {
        const { rows } = await p.query(LOG_POLICY_QUERY);
        if (!safeLogPolicy(rows[0])) throw new Error('PostgreSQL may log secret parameters; configure the database logging policy before opening this home.');
      }
    const path = join(options.home, 'core.json');
    const known = () => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Identity) : null);
    if (readOnly) {
      return new CoreLink(db,pool,operator,readIdentity!,path,vault,readOnly);
    }
    // Made once, under a lock of its own (pg/.lock: a holder of the home's lock may be waiting for
    // this link), so two processes opening a fresh home (the app and a door's host or grant) never
    // make two workspaces, each believing it is the person's.
    const id =
      known() ??
      (await withHomeLock(join(options.home, 'pg'), async () => {
        const now = known();
        if (now) return now;
        const { rows } = await operator.query<{ workspace_id: string; owner_id: string; system_id: string }>(
          'SELECT * FROM operator.create_workspace($1, $2, $3, $4)',
          ['Personal', 'personal', 'You', 'you@this.computer'],
        );
        const made = rows[0];
        const link = new CoreLink(db, pool, operator, { workspace: made.workspace_id, person: made.owner_id, system: made.system_id, agent: '', mandate: '' }, path, vault);
        const agent = await link.call<string>(link.person(), 'SELECT gov.create_agent($1, $2)', ['Agent', 'worker']);
        const identity: Identity = { ...link.id, agent, mandate: '' };
        writeFileSync(`${path}.tmp`, JSON.stringify(identity));
        renameSync(`${path}.tmp`, path);
        return identity;
      }));
    const link = new CoreLink(db, pool, operator, id, path, vault);
    // Mounting authenticated service does not renew a removed local person's
    // authority. Another live owner can still sign in using their own account.
    const device=(await link.read<{role:string;status:string}>(link.worker(),'SELECT role,status FROM app.principals WHERE id=$1',[id.person])).rows[0];
    link.mountedDevice=device?.status==='active'&&device.role==='owner';
    if(link.mountedDevice)await link.ensureMandate();
    return link;
    } catch (error) {
      await Promise.allSettled([pool.end(), operator.end()]);
      await db.stopIfStarted();
      throw error;
    }
  }

  private save() {
    if (this.id !== this.deviceIdentity) throw new CoreRefusal('denied', 'A member cannot replace the device identity.');
    assertHomeWriteAdmission(dirname(this.path));
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.deviceIdentity));
    renameSync(`${this.path}.tmp`, this.path);
  }

  private async stands(mandate: string | undefined): Promise<boolean> {
    if (!mandate) return false;
    const { rows } = await this.read<{ ok: boolean }>(
      this.person(),
      `SELECT revoked_at IS NULL AND expires_at > now() + interval '7 days' AS ok FROM app.mandates WHERE id = $1`,
      [mandate],
    );
    return !!rows[0]?.ok;
  }

  /**
   * The person grants their worker a mandate bound to a registered piece: its runs inherit the
   * registration, and the core caps them by its declaration. Called by the person's own act
   * (grantPieceIn), or by the host on a piece's first use in this home.
   */
  async grantPiece(registration: string): Promise<string> {
    const mandate = await this.call<string>(
      this.person(),
      `SELECT gov.issue_mandate($1, NULL, '"*"', '"*"', '"*"', '"*"', 4::smallint, NULL, NULL, NULL, NULL, $2, 'piece', '{}'::jsonb, $3)`,
      [this.id.agent, new Date(Date.now() + YEAR), registration],
    );
    this.id.pieceMandates = { ...this.id.pieceMandates, [registration]: mandate };
    this.save();
    return mandate;
  }

  /**
   * The standing mandate the person granted for a registration, renewed for that same registration
   * near its end; null when they never granted one. A new registration never reuses another's.
   */
  async pieceMandate(registration: string): Promise<string | null> {
    const granted = this.id.pieceMandates?.[registration];
    if (!granted) return null;
    if (await this.stands(granted)) return granted;
    const { rows } = await this.read<{ revoked: boolean }>(this.person(), 'SELECT revoked_at IS NOT NULL AS revoked FROM app.mandates WHERE id = $1', [granted]);
    // A grant the person revoked stays revoked; one that only ran out is renewed.
    return rows[0]?.revoked ? null : this.grantPiece(registration);
  }

  /** The person's root mandate for direct work: the platform's own stub, which the installation trusts as itself. Renewed when it is revoked or near its end. */
  private async ensureMandate() {
    if (await this.stands(this.id.mandate)) return;
    this.id.mandate = await this.call<string>(
      this.person(),
      `SELECT gov.issue_mandate($1, NULL, '"*"', '"*"', '"*"', '"*"', 4::smallint, NULL, NULL, NULL, NULL, $2, 'direct')`,
      [this.id.agent, new Date(Date.now() + YEAR)],
    );
    this.save();
  }

  person = (): Actor => ({ workspace: this.id.workspace, principal: this.id.person });
  system = (): Actor => ({ workspace: this.id.workspace, principal: this.id.system });
  worker = (): Actor => ({ workspace: this.id.workspace });
  runOf = (h: RunHandle): Actor => ({ workspace: this.id.workspace, run: { id: h.run, secret: h.secret } });

  private requireWritable(): void {
    if (this.readOnly) throw new CoreRefusal('read_only','This Core link was opened read-only; use a writable open to make changes.');
  }

  /** One write-capable crossing in its own transaction, as `actor`; the first column of the first row. */
  async call<T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> {
    this.requireWritable();
    const { rows } = await this.read<Record<string, unknown>>(actor, sql, params);
    return (rows[0] ? Object.values(rows[0])[0] : null) as T;
  }

  /** One statement in its own transaction, as `actor`. */
  async read<T extends pg.QueryResultRow>(actor: Actor, sql: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
    if(/\bgov\.identity_[a-z_]+\s*\(/i.test(sql))this.identities.requireReady();
    const client = await this.pool.connect();
    let failed = false;
    try {
      const logging = await client.query(LOG_POLICY_QUERY);
      if (!safeLogPolicy(logging.rows[0])) throw new Error('PostgreSQL may log secret parameters; configure the database logging policy before sending credentials.');
      // Every call names all four settings, at session level on this pooled connection, then runs
      // the crossing as its own transaction. Check the logging posture before sending credentials.
      await client.query(identityStatement(actor));
      return await client.query<T>(sql, params);
    } catch (error) {
      failed = true;
      const e = error as { code?: string; message?: string };
      throw e.code ? new CoreRefusal(reasonOf(e), e.message ?? '', {cause:error}) : error;
    } finally {
      client.release(failed);
    }
  }

  createTask(title: string, project?: string): Promise<string> {
    return this.createProjectTask(title,project);
  }
  private async createProjectTask(title:string,project?:string):Promise<string>{
    if(project&&this.identityStatus.state==='verified'){
      if(await this.legacyDeviceOnly())await this.call(this.person(),'SELECT gov.identity_register_project($1)',[project]);
      return this.call(this.person(),'SELECT gov.identity_create_task($1,$2)',[project,title]);
    }
    if(project&&!(await this.legacyDeviceOnly()))this.identities.requireReady();
    return this.call(this.person(),'SELECT gov.create_task($1,$1,$2,NULL,NULL)',[this.id.person,title]);
  }
  async bindProjectTask(project:string,task:string):Promise<void>{
    if(this.identityStatus.state!=='verified'){
      if(!(await this.legacyDeviceOnly()))this.identities.requireReady();
      return;
    }
    if(await this.legacyDeviceOnly())await this.call(this.person(),'SELECT gov.identity_register_project($1)',[project]);
    await this.call(this.person(),'SELECT gov.identity_bind_task($1,$2)',[project,task]);
  }

  /**
   * Queue a run of the person's worker on a task and claim it as this process's worker. A run a
   * registered piece carries is queued under the person's mandate for exactly that registration, and
   * bound to it; with no such grant it is refused, never run under a wider mandate.
   */
  async startRun(task: string, piece: string | null = null): Promise<RunHandle> {
    const mandate = piece ? await this.pieceMandate(piece) : this.id.mandate;
    if (!mandate) throw new CoreRefusal('denied', 'the person has not granted this piece; nothing runs on it');
    const run = await this.call<string>(this.person(), 'SELECT gov.queue_run($1, $2, $3, NULL, $4)', [task, this.id.agent, mandate, piece]);
    return this.claim(run, piece);
  }

  /**
   * Queue and claim a run of `agent` under exactly `mandate` (a job's own grant), bound to the piece
   * that mandate was granted to. The core refuses a mandate that no longer stands.
   */
  async startRunUnder(task: string, agent: string, mandate: string, piece: string | null): Promise<RunHandle> {
    const run = await this.call<string>(this.person(), 'SELECT gov.queue_run($1, $2, $3, NULL, $4)', [task, agent, mandate, piece]);
    return this.claim(run, piece);
  }

  /** Claim a run as this process's worker for the piece it runs (null: none), under a short lease the turn renews. */
  private async claim(run: string, piece: string | null): Promise<RunHandle> {
    const { rows } = await this.read<{ fence: string; secret: string }>(this.worker(), 'SELECT fence, secret FROM gov.claim_run($1, $2, $3, $4, $5)', [
      run,
      `host-${process.pid}`,
      LEASE_MS,
      piece ? 'piece' : 'direct',
      piece,
    ]);
    if (!rows[0]) throw new CoreRefusal('not_claimable', 'the run could not be claimed: its mandate no longer stands');
    return { run, fence: Number(rows[0].fence), secret: rows[0].secret };
  }

  /** The task's run a dead holder left unfinished, if any. */
  async openRun(task: string): Promise<string | null> {
    const { rows } = await this.read<{ id: string }>(
      this.system(),
      `SELECT id FROM app.runs WHERE task_id = $1 AND status IN ('queued', 'running', 'waiting') ORDER BY created_at DESC LIMIT 1`,
      [task],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Claim again a run whose last holder died, once its lease has lapsed, for exactly the piece it is
   * bound to: a run begun on another harness, or another version of it, is never resumed (the core
   * refuses the claim too).
   */
  async reclaimRun(run: string, piece: string | null = null): Promise<RunHandle> {
    for(let observation=0;observation<3;observation++){
      const { rows } = await this.read<{ ms: number; piece_id: string | null;status:string;lease_expired:boolean|null }>(
        this.system(),
        'SELECT greatest(0, extract(epoch FROM lease_expires_at - clock_timestamp()) * 1000)::int AS ms, piece_id, status, lease_expires_at <= clock_timestamp() AS lease_expired FROM app.runs WHERE id = $1',
        [run],
      );
      if ((rows[0]?.piece_id ?? null) !== piece) {
        throw new CoreRefusal('other_piece', 'This turn began on another harness, or another version of it, so it is not resumed under its run. Ask again.');
      }
      // A lease can change after observation, and a local timer is no native
      // expiry proof. Re-observe after waiting; the crossing still owns the
      // final atomic decision. Never retry a claim with an unknown outcome.
      const row=rows[0];
      if(!row||row.status!=='running'||row.lease_expired===true)return this.claim(run,piece);
      if(observation<2)await new Promise(resolve=>setTimeout(resolve,Math.min(row.ms,LEASE_MS)+50));
    }
    throw new CoreRefusal('not_claimable','The original run still has a live lease. Its recovery data is retained; no replacement was started.');
  }

  renewRun(h: RunHandle): Promise<string> {
    return this.call(this.runOf(h), 'SELECT gov.renew_run_lease($1, $2, $3)', [h.run, h.fence, LEASE_MS]);
  }

  finishRun(h: RunHandle, outcome: 'succeeded' | 'failed'): Promise<string> {
    return this.call(this.runOf(h), 'SELECT gov.finish_run($1, $2, $3)', [h.run, h.fence, outcome]);
  }

  say(task: string, text: string): Promise<string> {
    return this.call(this.person(), 'SELECT gov.post_message($1, $2, $3)', [task, this.id.person, text]);
  }

  answer(h: RunHandle, task: string, text: string): Promise<string> {
    return this.call(this.runOf(h), 'SELECT gov.answer_in_conversation($1, $2, $3)', [task, this.id.agent, text]);
  }

  /** What the run read: recorded by the system principal, its trust decided by the core. `null`: no author in the workspace, so untrusted. */
  recordRead(h: RunHandle, ref: string, content: string, byPerson: boolean | null): Promise<string> {
    return this.call(this.system(), "SELECT gov.record_source('file', $1, $2, $3, $4, NULL)", [
      ref,
      content,
      byPerson === null ? null : byPerson ? this.id.person : this.id.agent,
      h.run,
    ]);
  }

  /** What a connected server answered the run: untrusted always, and private for a person's own connection (gov.record_server_answer). */
  recordServerAnswer(h: RunHandle, connection: string, tool: string, content: string): Promise<string> {
    return this.call(this.system(), 'SELECT gov.record_server_answer($1, $2, $3, $4)', [h.run, connection, tool, content]);
  }

  /** The caller owns the fresh Store inspection through commit. Authenticate the real carrier
   * before changing to the trusted recorder, in the same native transaction. The local callback
   * must synchronously fsync the tentative IDs; it never calls Core, providers or another lock.
   * The signal must be the held lock's lost signal, or composed with it and the turn's signal.
   * This permits positive historical recovery after a lost COMMIT reply without a new SQL grant. */
  async recordMaterialSourceRead(h:RunHandle,request:MaterialSourceReadRequest,
    beforeCommit:(tentative:MaterialReadTentative)=>undefined,signal:AbortSignal):Promise<MaterialReadTentative>{
    this.requireWritable();
    if(!inActiveHomeLockScope(dirname(this.path)))throw new CoreRefusal('paused','Material registration requires the source owner to hold the home lock.');
    if(this.materialGuard.state!=='verified'||this.materialLink.state!=='verified'||this.materialEnforcement.state!=='verified')
      throw new CoreRefusal('paused','Native material source enforcement is not verified.');
    signal.throwIfAborted();
    // Snapshot before the first await. Mutation of a caller object cannot change either the
    // registered payload or the key retained by the local durable callback.
    const p=structuredClone(request),handle={...h};
    const workspace=this.id.workspace,runActor=this.runOf(handle),systemActor=this.system();
    if(!['file','mcp'].includes(p.sourceKind)||![null,'person','agent'].includes(p.authoredBy))
      throw new CoreRefusal('invalid','Material registration requires an explicit source kind and known or absent author.');
    if([p.project,p.material,p.episodeContent,p.preparedText,p.tool??''].some(value=>typeof value!=='string'||value.includes('\0')))
      throw new CoreRefusal('invalid','Material registration requires supported text without NUL. Original bytes are kept.');
    const parameters=[p.project,p.material,p.version,p.generation,p.readKey,p.originalSha256,JSON.stringify(p.transformation),
      p.sourceKind,p.episodeContent,p.preparedText,p.authoredBy===null?null:p.authoredBy==='person'?this.id.person:this.id.agent,
      handle.run,null,p.connection??null,p.tool??null];
    let tentative:MaterialReadTentative|undefined,retained=false,acknowledged=false,rolledBack=false;
    const held=()=>{
      signal.throwIfAborted();
      if(!inActiveHomeLockScope(dirname(this.path)))throw new CoreRefusal('paused','The material source home lock is no longer held.');
    };
    try{return await this.materialTransport(signal,async client=>{
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(identityStatement(runActor));
      await this.verifyMaterialRecipient(client,handle,p.connection);
      signal.throwIfAborted();
      await client.query(identityStatement(systemActor));
      const result=await client.query<{episode_id:string;receipt_id:string}>(
        'SELECT episode_id, receipt_id FROM gov.record_material_source_read($1::text,$2::text,$3::integer,$4::integer,$5::text,$6::text,$7::jsonb,$8::text,$9::text,$10::text,$11::uuid,$12::uuid,$13::uuid,$14::uuid,$15::text)',parameters);
      const row=result.rows[0],uuid=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
      if(result.rows.length!==1||!row||!uuid.test(row.episode_id)||!uuid.test(row.receipt_id))throw new Error('Core returned no valid material preparation identities.');
      tentative=Object.freeze({workspace,readKey:p.readKey,episode:row.episode_id,receipt:row.receipt_id});
      held();
      const returned:unknown=beforeCommit(tentative);
      if(returned!==undefined)throw new Error('Tentative material identities must be retained synchronously before Core commits.');
      retained=true;held();
      const committed=await client.query('COMMIT');
      if(committed.command==='ROLLBACK'){rolledBack=true;throw new CoreRefusal('paused','Core rolled back material registration; this attempt did not commit.');}
      if(committed.command!=='COMMIT')throw new Error('Core did not confirm a material registration COMMIT.');
      acknowledged=true;
      return tentative;
    },()=>acknowledged);}
    catch(error){
      if(definiteServerRefusal(error))throw new CoreRefusal(reasonOf(error),error.message);
      if(retained&&tentative&&!acknowledged&&!rolledBack)throw new MaterialCommitUnknown(tentative,error);
      throw error;
    }
  }

  /** Fresh native admission before a connector read leaves the Host. This records no source
   * and grants no future dispatch: the caller still checks its exact live offer, held lock and
   * cancellation immediately before its one dispatch. A lost admission reply permits no call. */
  async admitMaterialConnectorRead(h:RunHandle,connection:string,signal:AbortSignal):Promise<void>{
    this.requireWritable();
    const held=()=>{
      signal.throwIfAborted();
      if(!inActiveHomeLockScope(dirname(this.path)))throw new CoreRefusal('paused','Connector admission requires the home lock.');
    };
    held();
    if(this.materialGuard.state!=='verified'||this.materialLink.state!=='verified'||this.materialEnforcement.state!=='verified')
      throw new CoreRefusal('paused','Native material source enforcement is not verified.');
    if(typeof connection!=='string'||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(connection))
      throw new CoreRefusal('invalid','Connector admission requires its native connection identity.');
    const handle={...h},actor=this.runOf(handle);
    try{await this.materialTransport(signal,async client=>{
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(identityStatement(actor));
      await this.verifyMaterialRecipient(client,handle,connection);
      held();
      const committed=await client.query('COMMIT');
      if(committed.command!=='COMMIT')throw new CoreRefusal('paused','Connector admission did not commit. Nothing was called.');
      held();
    });}catch(error){if(definiteServerRefusal(error))throw new CoreRefusal(reasonOf(error),error.message);throw error;}
  }

  /** Explicit person recovery only. Claim this original run once, under its exact carrier;
   * never queue a substitute, wait out a live holder or register a source as a side effect.
   * A lost COMMIT may have claimed it: no handle is returned and the next attempt must let
   * that native lease settle. Its returned secret is never put in a journal or an error. */
  async claimMaterialRecovery(run:string,piece:string|null,signal:AbortSignal):Promise<RunHandle>{
    this.requireWritable();
    const held=()=>{
      signal.throwIfAborted();
      if(!inActiveHomeLockScope(dirname(this.path)))throw new CoreRefusal('paused','Material recovery claim requires the home lock.');
    };
    held();
    if(this.materialGuard.state!=='verified'||this.materialLink.state!=='verified'||this.materialEnforcement.state!=='verified')
      throw new CoreRefusal('paused','Native material source enforcement is not verified.');
    const uuid=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
    if(!uuid.test(run)||(piece!==null&&!uuid.test(piece)))throw new CoreRefusal('invalid','Material recovery requires the exact native run and carrier.');
    const actor=this.worker(),systemActor=this.system(),workspace=this.id.workspace;let committing=false;
    try{return await this.materialTransport(signal,async client=>{
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      // One READ COMMITTED statement observes the original lifecycle and workspace sequence
      // together. The empty worker cannot see private runs; this trusted pre-read uses system.
      await client.query(identityStatement(systemActor));
      const snapshot=await client.query<{fence:string;ledger_seq:string}>(
        `SELECT r.fence::text AS fence, coalesce((SELECT max(l.seq) FROM app.ledger l
           WHERE l.workspace_id = r.workspace_id), 0)::text AS ledger_seq
         FROM app.runs r WHERE r.workspace_id = $1::uuid AND r.id = $2::uuid
           AND r.status = 'running' AND r.lease_expires_at <= clock_timestamp()`,[workspace,run]);
      const before=snapshot.rows[0],originalFence=Number(before?.fence);
      if(snapshot.rows.length!==1||!before||!Number.isSafeInteger(originalFence)||originalFence<0||!/^(0|[1-9][0-9]*)$/.test(before.ledger_seq))
        throw new CoreRefusal('not_claimable','Material recovery only reclaims an original running run whose native lease expired. Parked, woken and queued work stays untouched.');
      await client.query(identityStatement(actor));held();
      const result=await client.query<{fence:string;secret:string}>(
        'SELECT fence, secret FROM gov.claim_run($1::uuid,$2::text,$3::integer,$4::text,$5::uuid)',[run,`host-${process.pid}`,LEASE_MS,piece?'piece':'direct',piece]);
      const row=result.rows[0],fence=Number(row?.fence);
      // The pinned native claim uses two UUIDs separated by a dot, not a material read key.
      const secretParts=typeof row?.secret==='string'?row.secret.split('.'):[];
      if(result.rows.length!==1||!row||!Number.isSafeInteger(fence)||fence<1||secretParts.length!==2||!secretParts.every(part=>uuid.test(part)))
        throw new CoreRefusal('not_claimable','The original run has no available verified recovery claim. No substitute was started.');
      if(fence!==originalFence+1)throw new CoreRefusal('not_claimable','The original holder changed after recovery inspection. No recovery claim was committed.');
      const handle={run,fence,secret:row.secret};
      await client.query(identityStatement({workspace,run:{id:handle.run,secret:handle.secret}}));
      // claim_run has now taken the same workspace head lock as park/finish/stop. The
      // sequence remains text/bigint throughout; do not round it through a JS number.
      // _wake_run writes no ledger event: from a running snapshot, a legitimate wake
      // requires an intervening park, and its run.parked event is included here.
      const lifecycle=await client.query<{material_recovery_lifecycle_clear:boolean}>(
        `SELECT NOT EXISTS (SELECT FROM app.ledger l WHERE l.workspace_id = $1::uuid
          AND l.subject = $2::text AND l.seq > $3::bigint
          AND l.entry_type = ANY($4::text[])) AS material_recovery_lifecycle_clear`,
        [workspace,run,before.ledger_seq,['run.parked','run.finished','run.stopped']]);
      if(lifecycle.rows.length!==1||lifecycle.rows[0]?.material_recovery_lifecycle_clear!==true)
        throw new CoreRefusal('not_claimable','The original run parked or stopped after recovery inspection. No recovery claim was committed.');
      await this.verifyMaterialRecipient(client,handle);
      held();committing=true;
      const committed=await client.query('COMMIT');
      if(committed.command!=='COMMIT')throw new CoreRefusal('paused','The original recovery claim did not receive a COMMIT acknowledgement.');
      held();return handle;
    });}catch(error){
      if(definiteServerRefusal(error))throw new CoreRefusal(reasonOf(error),error.message);
      if(committing)throw new CoreRefusal('paused','The original recovery claim is unresolved. Let its native lease settle before another explicit attempt.');
      throw error;
    }
  }

  /** The same trusted SQL/actor boundary as read(), with finite transport and cancellation
   * for explicit material recovery. No statement or authority is inferred from a receipt.
   * A stopped/lost reply to an effectful crossing remains uncertain to its caller. */
  async readBounded<T extends pg.QueryResultRow>(actor:Actor,sql:string,params:unknown[],signal:AbortSignal):Promise<pg.QueryResult<T>>{
    const captured=structuredClone(actor),parameters=structuredClone(params);
    try{return await this.materialTransport(signal,async client=>{
      await client.query(identityStatement(captured));
      signal.throwIfAborted();
      return client.query<T>(sql,parameters);
    });}catch(error){if(definiteServerRefusal(error))throw new CoreRefusal(reasonOf(error),error.message);throw error;}
  }

  /** RunActor RLS checks the receiving task and, when present, the actual connection. The
   * native holder takes workspace then run; run_standing also checks ancestor revocations
   * and budgets. Neither a UUID nor system-principal visibility substitutes for that actor. */
  private async verifyMaterialRecipient(client:pg.Client,handle:RunHandle,connection?:string):Promise<void>{
    await client.query('SELECT gov.renew_run_lease($1::uuid, $2::bigint, $3::integer)',[handle.run,handle.fence,LEASE_MS]);
    const standing=await client.query<{standing:string}>('SELECT gov.run_standing($1::uuid) AS standing',[handle.run]);
    if(standing.rows.length!==1||standing.rows[0]?.standing!=='ok')throw new CoreRefusal('stale','The receiving run no longer has standing.');
    const visible=await client.query<{material_recipient_visible:boolean}>(
      `SELECT EXISTS (SELECT FROM app.runs r JOIN app.tasks t ON t.workspace_id = r.workspace_id AND t.id = r.task_id
       WHERE r.id = $1::uuid AND r.status = 'running')
       AND ($2::uuid IS NULL OR EXISTS (SELECT FROM app.connections c WHERE c.id = $2::uuid)) AS material_recipient_visible`,[handle.run,connection??null]);
    if(visible.rows.length!==1||visible.rows[0]?.material_recipient_visible!==true)
      throw new CoreRefusal('denied','The run cannot see the receiving task or connection.');
  }

  /** Only a positive, tenant-scoped historical witness for IDs previously retained by the
   * transport. No read-key association or current source/run authority is inferred here.
   * Absence stays UNKNOWN; it never permits provider replay or clears an unresolved outcome. */
  async materialReadCommitWitness(tentative:Pick<MaterialReadTentative,'workspace'|'episode'|'receipt'>,signal?:AbortSignal):Promise<'confirmed'|'unknown'>{
    const p={...tentative},uuid=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
    if(p.workspace!==this.id.workspace)throw new CoreRefusal('invalid','The historical material witness belongs to another workspace.');
    if(!uuid.test(p.episode)||!uuid.test(p.receipt))throw new CoreRefusal('invalid','The historical material witness has invalid identities.');
    if(this.materialGuard.state!=='verified'||this.materialLink.state!=='verified')throw new CoreRefusal('paused','Core material journaling is not verified.');
    const systemActor=this.system();
    try{return await this.materialTransport(signal,async client=>{
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
      await client.query(identityStatement(systemActor));
      const result=await client.query<{receipt:string}>(
        `SELECT subject AS receipt FROM app.ledger WHERE workspace_id = $1::uuid AND entry_type = 'material.read_registered'
         AND subject = $2::text AND payload->>'episode' = $3::text AND actor_id = $4::uuid`,[p.workspace,p.receipt,p.episode,systemActor.principal]);
      await client.query('COMMIT');
      return result.rows.length===1?'confirmed':'unknown';
    });}
    catch(error){if(definiteServerRefusal(error))throw new CoreRefusal(reasonOf(error),error.message);throw error;}
  }

  /** Dedicated bounded transport for the new source producer, never a provider retry. Existing
   * withdrawal delivery is unchanged. Ending the client aborts uncommitted/unknown work; do not
   * queue rollback behind a stalled statement. The timeout starts after the bounded connection. */
  private async materialTransport<T>(signal:AbortSignal|undefined,perform:(client:pg.Client)=>Promise<T>,acknowledged:()=>boolean=()=>false):Promise<T>{
    signal?.throwIfAborted();
    const client=await serviceClient(this.db.appUrl,{connectionTimeoutMillis:2000,query_timeout:6000,statement_timeout:5000,lock_timeout:2000,readOnly:this.readOnly});
    client.on('error',()=>{});
    let expired=false;
    const stop=()=>{void client.end().catch(()=>{});};
    const deadline=setTimeout(()=>{expired=true;stop();},8000);deadline.unref();
    signal?.addEventListener('abort',stop,{once:true});
    try{
      signal?.throwIfAborted();
      const logging=await client.query(LOG_POLICY_QUERY);
      if(!safeLogPolicy(logging.rows[0]))throw new Error('PostgreSQL may log secret parameters; configure the database logging policy before recording material.');
      signal?.throwIfAborted();
      const result=await perform(client);
      if(acknowledged())return result; // Historical COMMIT acknowledgement survives a late stop/deadline.
      if(expired)throw new Error('Core material recording exceeded its deadline; its outcome is not confirmed.');
      signal?.throwIfAborted();return result;
    }finally{
      signal?.removeEventListener('abort',stop);clearTimeout(deadline);await client.end().catch(()=>{});
    }
  }

  /** Confirm this immutable event only after Core acknowledges commit. A lost reply may have
   * committed: retry this exact event, never invent a receipt or repeat a provider operation. */
  async confirmMaterialWithdrawal(event:MaterialWithdrawalEvent):Promise<MaterialWithdrawalConfirmation>{
    this.requireWritable();
    if(this.db.materialLink.state!=='verified')throw new CoreRefusal('paused','Core material journaling is not verified.');
    const client=await serviceClient(this.db.appUrl,{connectionTimeoutMillis:2000,query_timeout:6000,statement_timeout:5000,lock_timeout:2000,readOnly:this.readOnly});
    client.on('error',()=>{});
    let expired=false;
    const deadline=setTimeout(()=>{expired=true;void client.end().catch(()=>{});},8000);deadline.unref();
    try{
      const logging=await client.query(LOG_POLICY_QUERY);
      if(!safeLogPolicy(logging.rows[0]))throw new Error('PostgreSQL may log secret parameters; configure the database logging policy before sending credentials.');
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(identityStatement(this.system()));
      const result=await client.query<{receipt:string}>('SELECT gov.withdraw_material_source($1,$2,$3,$4,$5,$6) AS receipt',
        [event.projectId,event.materialId,event.id,event.sequence,event.version,event.at]);
      const receipt=result.rows[0]?.receipt;
      if(typeof receipt!=='string'||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt))throw new Error('Core returned no valid withdrawal confirmation.');
      await client.query('COMMIT');
      if(expired)throw new Error('Core withdrawal confirmation exceeded its deadline.');
      return {workspace:this.id.workspace,event:event.id,receipt};
    }catch(error){
      const e=error as {code?:string;message?:string};
      throw e.code?new CoreRefusal(reasonOf(e),e.message??''):error;
    }finally{
      // Do not queue a rollback behind an unresponsive query. Ending this dedicated client
      // aborts any uncommitted work; already committed/unknown work stays idempotently retryable.
      clearTimeout(deadline);await client.end().catch(()=>{});
    }
  }

  /**
   * Propose a connector's effect under the run, at class 5, which always waits for a person
   * (sec.route_effect): it is never let through by a mandate's ceiling.
   */
  async proposeConnectorEffect(h: RunHandle, operation: string, args: Record<string, unknown>, description: string, key: string) {
    const effect = await this.call<string>(
      this.runOf(h),
      `SELECT gov.propose_effect($1, $2, NULL, 'mcp', $3, NULL, NULL, 5::smallint, true, $4::jsonb, $5, NULL, $6)`,
      [h.run, h.fence, operation, JSON.stringify(args), description, key],
    );
    const { rows } = await this.read<{ status: string; args_hash: string; route_reason: string | null }>(this.system(), 'SELECT status, args_hash, route_reason FROM app.effects WHERE id = $1', [effect]);
    return { effect, status: rows[0]?.status ?? 'unknown', argsHash: rows[0]?.args_hash ?? '', reason: rows[0]?.route_reason ?? null };
  }

  /** Propose a working-copy write through the gateway; returns the effect as the core routed it. */
  async proposeWrite(h: RunHandle, args: Record<string, unknown>, description: string, key: string): Promise<EffectState> {
    const id = await this.call<string>(
      this.runOf(h),
      `SELECT gov.propose_effect($1, $2, 1, 'write', 'workspace.write_document', NULL, NULL, NULL, NULL, $3::jsonb, $4, NULL, $5)`,
      [h.run, h.fence, JSON.stringify(args), description, key],
    );
    return this.effect(id);
  }

  async effect(id: string): Promise<EffectState> {
    const { rows } = await this.read<EffectState>(
      this.system(),
      'SELECT id, status, route_reason AS "routeReason", repeat_of AS "repeatOf" FROM app.effects WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  /** The claims this workspace's dispatcher holds on effects still claimed or dispatching. */
  async heldClaims(): Promise<{ effect: string; status: string; claim: string; document: string; sha256: string }[]> {
    const { rows } = await this.read<{ effect_id: string; status: string; claim_token: string; args: Record<string, string> }>(
      this.system(),
      'SELECT * FROM gov.held_claims()',
    );
    return rows.map((r) => ({ effect: r.effect_id, status: r.status, claim: r.claim_token, document: r.args.document_id, sha256: r.args.content_sha256 }));
  }

  claimEffect(effect: string): Promise<string> {
    return this.call(this.system(), 'SELECT gov.claim_effect($1, $2)', [effect, 600_000]);
  }

  beginDispatch(effect: string, claim: string, connectorStanding?: boolean): Promise<boolean> {
    if (connectorStanding !== undefined) return this.beginConnectorDispatch(effect, claim, connectorStanding).then(result => result === 'begun');
    return this.call(this.system(), 'SELECT gov.begin_dispatch($1, $2)', [effect, claim]);
  }

  /** Bind a person's displayed statement to the immutable proposal, not an editable file. */
  async connectorStatementMatches(effect: string, argsHash: string, args: Record<string, unknown>, statement: string): Promise<boolean> {
    return (await this.call<boolean>(this.system(), 'SELECT args_hash = $2 AND args = $3::jsonb AND description = $4 FROM app.effects WHERE id = $1', [effect, argsHash, JSON.stringify(args), statement]).catch(() => false)) === true;
  }

  /** Exact operation includes the whole tool name, including dots. */
  async connectorEffectPause(effect: string): Promise<'unknown' | 'dispatching' | null> {
    return this.call(this.system(), `SELECT CASE WHEN bool_or(prior.status = 'unknown') THEN 'unknown'
      WHEN bool_or(prior.status = 'dispatching') THEN 'dispatching' END
      FROM app.effects prior JOIN app.effects requested
        ON requested.workspace_id = prior.workspace_id AND requested.connection_id = prior.connection_id
          AND requested.operation = prior.operation
      WHERE requested.id = $1 AND prior.id <> requested.id AND prior.status IN ('unknown', 'dispatching')`, [effect]);
  }

  async connectorEffectsPaused(effect: string): Promise<boolean> { return (await this.connectorEffectPause(effect)) !== null; }

  /** Serialize connector admission across processes. A dispatch in progress is conservatively
   * unresolved too. The lock is database-owned, never the home lock, and the check gets a fresh
   * READ COMMITTED snapshot after waiting. Person-basis proposals are outside the standing pause. */
  async beginConnectorDispatch(effect: string, claim: string, standing: boolean): Promise<'begun' | 'paused' | 'busy' | 'closed'> {
    this.requireWritable();
    const client = await this.pool.connect();
    let failed = false;
    try {
      const logging = await client.query(LOG_POLICY_QUERY);
      if (!safeLogPolicy(logging.rows[0])) throw new Error('The Core logging policy is unavailable.');
      await client.query(identityStatement(this.system()));
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 13))", [`connector-dispatch:${this.id.workspace}`]);
      // A hand-written local hint cannot relabel a Core standing answer. A person
      // override uses a separate proposal with its own checked person basis.
      const basis = await client.query<{ standing: boolean }>(`SELECT EXISTS (
        SELECT FROM app.effects e JOIN app.ledger l ON l.workspace_id = e.workspace_id AND l.subject = e.decision_id::text
        WHERE e.id = $1 AND l.entry_type = 'decision.answered' AND l.payload->'basis'->>'method' = 'standing_signature') AS standing`, [effect]);
      if (standing || basis.rows[0].standing) {
        const check = await client.query<{ pause: 'unknown' | 'dispatching' | null }>(`SELECT CASE
          WHEN bool_or(prior.status = 'unknown') THEN 'unknown' WHEN bool_or(prior.status = 'dispatching') THEN 'dispatching' END AS pause
          FROM app.effects prior JOIN app.effects requested
            ON requested.workspace_id = prior.workspace_id AND requested.connection_id = prior.connection_id
              AND requested.operation = prior.operation
          WHERE requested.id = $1 AND prior.id <> requested.id AND prior.status IN ('unknown', 'dispatching')`, [effect]);
        if (check.rows[0].pause) { await client.query('ROLLBACK'); return check.rows[0].pause === 'unknown' ? 'paused' : 'busy'; }
      }
      const result = await client.query<{ begun: boolean }>('SELECT gov.begin_dispatch($1, $2) AS begun', [effect, claim]);
      await client.query('COMMIT');
      return result.rows[0].begun ? 'begun' : 'closed';
    } catch {
      failed = true;
      await client.query('ROLLBACK').catch(() => {});
      throw new Error('Connector dispatch could not be confirmed. Inspect its receipt; nothing is retried.');
    } finally { client.release(failed); }
  }

  observe(effect: string, claim: string, outcome: 'succeeded' | 'failed' | 'unknown', evidence: string, note: string | null): Promise<string> {
    return this.call(this.system(), 'SELECT gov.observe_effect($1, $2, $3, NULL, $4, $5)', [effect, claim, outcome, evidence, note]);
  }

  /** Whether a task is the run's own and private to the run's person alone (as gov._route_for_run and gov.write_document_by_effect judge it). */
  async privateOwnTask(run: string, task: string): Promise<boolean> {
    const { rows } = await this.read<{ ok: boolean }>(this.system(), `SELECT EXISTS (
      SELECT FROM app.runs r JOIN app.mandates m ON m.workspace_id = r.workspace_id AND m.id = r.mandate_id
      JOIN app.tasks t ON t.workspace_id = r.workspace_id AND t.id = r.task_id
      WHERE r.id = $1 AND t.id = $2 AND t.visibility = 'private' AND t.requested_by = m.on_behalf_of_id AND t.on_behalf_of = m.on_behalf_of_id
        AND NOT EXISTS (SELECT FROM app.task_people tp WHERE tp.workspace_id = t.workspace_id AND tp.task_id = t.id AND tp.person_id <> m.on_behalf_of_id)
        AND NOT EXISTS (SELECT FROM app.channel_threads ct WHERE ct.workspace_id = t.workspace_id AND ct.task_id = t.id AND ct.kind = 'group')) AS ok`, [run, task]);
    return rows[0]?.ok === true;
  }

  /**
   * Whether gov.write_document_by_effect would accept this effect's audience now: always, unless it is a
   * document write by a run marked both ways that was allowed without a checker, whose task must still be
   * requested by and for the run's person and read by nobody else.
   */
  async documentAudienceHolds(effect: string): Promise<boolean> {
    const { rows } = await this.read<{ ok: boolean }>(this.system(), `SELECT NOT EXISTS (
      SELECT FROM app.effects e
      JOIN app.runs r ON r.workspace_id = e.workspace_id AND r.id = e.run_id
      JOIN app.mandates m ON m.workspace_id = r.workspace_id AND m.id = r.mandate_id
      LEFT JOIN app.documents d ON d.workspace_id = e.workspace_id AND d.id::text = e.args ->> 'document_id'
      LEFT JOIN app.tasks t ON t.workspace_id = e.workspace_id
        AND t.id = coalesce(d.task_id, CASE WHEN d.id IS NULL THEN nullif(e.args ->> 'task_id', '')::uuid END)
      WHERE e.id = $1 AND e.operation = 'workspace.write_document' AND r.tainted_untrusted AND r.tainted_sensitive
        AND e.route IS DISTINCT FROM 'needs_checker'
        AND NOT coalesce(t.visibility = 'private' AND t.requested_by = m.on_behalf_of_id AND t.on_behalf_of = m.on_behalf_of_id
          AND NOT EXISTS (SELECT FROM app.task_people tp WHERE tp.workspace_id = t.workspace_id AND tp.task_id = t.id AND tp.person_id <> m.on_behalf_of_id)
          AND NOT EXISTS (SELECT FROM app.channel_threads ct WHERE ct.workspace_id = t.workspace_id AND ct.task_id = t.id AND ct.kind = 'group'), false)) AS ok`, [effect]);
    return rows[0]?.ok === true;
  }

  /** The dispatcher writes the document an effect names, as part of dispatching it: a new one in the task its arguments name, if any. */
  writeDocument(effect: string, document: string, title: string, content: string): Promise<string> {
    return this.call(this.system(), "SELECT gov.write_document_by_effect($1, $2, $3, $4, true, (SELECT nullif(e.args ->> 'task_id', '')::uuid FROM app.effects e WHERE e.id = $1::uuid))", [effect, document, title, content]);
  }

  /** The person's Save, as a new version of the core document. */
  async reviseDocument(document: string, content: string, project?: string, base?: number): Promise<number> {
    if(project&&this.identityStatus.state!=='verified'&&!await this.legacyDeviceOnly())this.identities.requireReady();
    if (project && base !== undefined && this.identityStatus.state==='verified') {
      const bound = await this.call<number | null>(this.person(),'SELECT gov.identity_document_version($1,$2)',[project,document]);
      if (bound !== null) return this.call(this.person(), 'SELECT gov.identity_revise_document($1,$2,$3,$4)', [project,document,content,base]);
      if (this.id.person !== this.identities.devicePerson) throw new CoreRefusal('denied','No document in this project.');
    }
    return this.call(this.person(), 'SELECT gov.revise_document($1, NULL, $2)', [document, content]);
  }

  async documentVersion(document: string, project?: string): Promise<number | null> {
    if(project&&this.identityStatus.state!=='verified'&&!await this.legacyDeviceOnly())this.identities.requireReady();
    if (project && this.identityStatus.state==='verified') {
      const bound = await this.call<number | null>(this.person(),'SELECT gov.identity_document_version($1,$2)',[project,document]);
      if (bound !== null || this.id.person !== this.identities.devicePerson) return bound;
    }
    const { rows } = await this.read<{ version: number }>(this.person(), 'SELECT version FROM app.documents WHERE id = $1', [document]);
    return rows[0]?.version ?? null;
  }

  async close(): Promise<void> {
    await this.release();
    await this.db.stop();
  }

  /** Let go of the database without stopping it: another process (the app) may share this data home's server. */
  async release(): Promise<void> {
    await this.admissionPool?.end().catch(() => {});
    await this.pool.end().catch(() => {});
    await this.operator.end().catch(() => {});
  }

  /** Observe this process's latest close attempt, including its failure. Never await a pending Core
   * close or independently started Core open under the home lock: either may need it. A later open
   * rechecks the home itself; an open invoked within a held scope can re-enter that scope. */
  static whenClosed(home: string): Promise<void> {
    return closing.get(canonicalHome(home))?.done ?? Promise.resolve();
  }

  /** Capture only a currently pending close for an admission outside the home-lock scope. A
   * settled failed attempt is retained diagnostically but cannot poison a later opener. */
  static pendingClose(home: string): Promise<void> | undefined {
    const current = closing.get(canonicalHome(home));
    return current?.pending ? current.done : undefined;
  }

  /** Close the link a host opened, and make any later open of the same home wait for it. */
  static closeWhenOpen(home: string, link: Promise<CoreLink>): void {
    const key = canonicalHome(home), previous = closing.get(key);
    const current: Closing = { done: Promise.resolve(), pending: true, lastFailure: previous?.lastFailure };
    current.done = Promise.allSettled([previous?.done, link.then((l) => l.close(), () => {})]).then(([, own]) => {
      if (own.status === 'rejected') {
        current.lastFailure = own.reason;
        // No original error text, path or credentials in the process log. Keep the actual failure
        // on this attempt and report it to openers that captured it while it was pending.
        process.emitWarning('A Core close attempt failed; a later open will inspect the home again.', { code: 'CORE_CLOSE_FAILED' });
        throw own.reason;
      }
    }).finally(() => { current.pending = false; });
    // Recording a failed attempt must not itself create an unhandled rejection. Observers still
    // receive the original rejected promise; later closes settle predecessors independently.
    void current.done.catch(() => {});
    closing.set(key, current);
  }
}
