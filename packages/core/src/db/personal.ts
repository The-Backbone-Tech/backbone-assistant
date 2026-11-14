import {upgradeIdentityCohort} from './identity-cohort.ts';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { binaries, freePort, ready } from '@backbone-next/kernel/cluster';
import { removeDurable, writeDurable } from '@backbone-next/kernel/files';
import {assertHomeWriteAdmission} from '@backbone-next/kernel/home-lock';
import { CORE_SCHEMA_LOCK, upgradeMaterialGuard, type MaterialGuardStatus } from './material-guard.ts';
import {upgradeMaterialLink,type MaterialLinkStatus} from './material-link.ts';
import {upgradeMaterialEnforcement,type MaterialEnforcementStatus} from './material-enforcement.ts';
import {upgradeSignatureLedger} from './signature-ledger.ts';
import {upgradeMaterialClosure} from './material-closure.ts';
import {upgradeMaterialClosureHardening} from './material-closure-hardening.ts';
import {verifyIdentityRuntime,IDENTITY_PAUSED,type IdentityRuntimeStatus} from './identity-runtime.ts';
import {hasMaterialClosure} from './material-closure-status.ts';
import {verifyMaterialStatuses} from './material-status.ts';
import {readSchemaHistory,CORE_SCHEMA_UPGRADES} from './schema-migrations.ts';
import {readExistingPasswords,verifyReadOnlyDatabase,matchingPersonalServer,refuseLivePersonalPid,PersonalReadRefusal} from './personal-readonly.ts';
import {readOnlyConnectionConfig,ReadOnlyClient} from './session.ts';

export { binaries, freePort, ready };
export class IdentityUpgradeRequired extends Error {
 constructor(message='Open the app once to update this data folder.'){super(message);this.name='IdentityUpgradeRequired';}
}

/**
 * Stop the personal cluster kept in `dir`, if a server (this process's or one a killed process
 * left behind) is running there, and wait until it has exited.
 */
export async function stopPersonalDatabaseAt(dir: string): Promise<void> {
  const pidFile = join(dir, 'data', 'postmaster.pid');
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').split('\n')[0]) : 0;
  if (!(pid > 0)) return;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (alive()) process.kill(pid, 'SIGINT');
  for (let i = 0; i < 200 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
  if (alive()) process.kill(pid, 'SIGKILL');
}

/** The file that makes a data home's database someone else's cluster: see `openPersonalDatabase`. */
export const EXTERNAL_DATABASE_FILE = 'external.json';

export interface IdentityUpgradeResult {state:'installed'|'unchanged'|'backup-failed'|'unconfirmed';backup?:string;reason:string}

export interface PersonalDatabase {
  readonly identityUpgrade?:IdentityUpgradeResult;
  /** The service role, backbone_app. */
  readonly appUrl: string;
  /** The installation's operator, backbone_operator. */
  readonly operatorUrl: string;
  /** This capability can pause without preventing the home or other capabilities from opening. */
  readonly materialGuard: MaterialGuardStatus;
  /** Multi-person access requires the complete current identity runtime, never a predecessor phase. */
  readonly identityStatus:IdentityRuntimeStatus;
  /** Preparation/withdrawal journaling is separate from knowledge eligibility or source access. */
  readonly materialLink: MaterialLinkStatus;
  /** Absent on an older adapter means unverified, never permission to record material. */
  readonly materialEnforcement?: MaterialEnforcementStatus;
  /** Stop only a server started by this open, never one already in use. */
  stopIfStarted(): Promise<void>;
  stop(): Promise<void>;
}

/** The cluster's three passwords: its superuser's, the service role's and the operator's. */
export interface ClusterPasswords {
  admin: string;
  app: string;
  operator: string;
}

/**
 * Where a personal cluster's passwords are kept: the caller's choice, never a file of the core's.
 * The platform seals them in the data home's vault, whose key the Keychain holds.
 */
export interface PasswordKeeper {
  /** The passwords, or null when none were kept yet. */
  read(): Promise<ClusterPasswords | null>;
  /** Keep them durably; called before the cluster that uses them is made. */
  write(passwords: ClusterPasswords): Promise<void>;
}

/** The cluster's port, the one thing kept beside it in the clear: it is not a secret. */
export const CLUSTER_FILE = 'cluster.json';
/** Where passwords were kept in the clear before keepers: moved to the keeper once, then removed. */
export const LEGACY_PASSWORDS_FILE = 'secrets.json';

const b64 = (b: Buffer) => b.toString('base64');
const hmac = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest();

/**
 * A SCRAM-SHA-256 verifier for `password` (RFC 5802 and 7677), in the form PostgreSQL stores: given
 * a verifier, the server keeps it as it is, so the password itself never reaches the server, its
 * log or its files. The passwords made here are hex, which SASLprep leaves unchanged.
 */
export function scramVerifier(password: string, iterations = 4096): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const stored = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(stored)}:${b64(hmac(salted, 'Server Key'))}`;
}

/** `statement` (its `%I` the quoted role) setting the role's password as a verifier: the one way a password is set here. */
export function rolePasswordSql(role: string, password: string, statement = 'ALTER ROLE %I'): string {
  return `${statement.replace('%I', `"${role.replace(/"/g, '""')}"`)} PASSWORD '${scramVerifier(password)}'`;
}

const makePasswords = (): ClusterPasswords => ({ admin: randomBytes(18).toString('hex'), app: randomBytes(18).toString('hex'), operator: randomBytes(18).toString('hex') });

/** initdb's password file. Earlier versions wrote the superuser's password there in the clear, so one a crash left is removed at every open. */
const PASSWORD_FILE = 'pw';

/**
 * The cluster's passwords from its keeper. A cluster made before keepers kept them, and its port,
 * in `secrets.json`: they move to the keeper and the port to `cluster.json` (on disk before the old
 * file goes) once, then that file is removed. A crash between the steps leaves them in both, and the
 * next open finishes the move. A stray `pw` is removed every time.
 */
export async function keptPasswords(dir: string, keeper: PasswordKeeper): Promise<{ passwords: ClusterPasswords; port: number }> {
  const legacy = join(dir, LEGACY_PASSWORDS_FILE);
  const cluster = join(dir, CLUSTER_FILE);
  removeDurable(join(dir, PASSWORD_FILE));
  if (existsSync(legacy)) {
    const old = JSON.parse(readFileSync(legacy, 'utf8')) as ClusterPasswords & { port: number };
    if (!(await keeper.read())) await keeper.write({ admin: old.admin, app: old.app, operator: old.operator });
    if (!existsSync(cluster)) writeDurable(cluster, JSON.stringify({ port: old.port }));
    removeDurable(legacy);
  }
  const passwords = await keeper.read();
  if (!passwords) throw new Error(`The passwords of the cluster in ${dir} are not in its keeper, so it cannot be opened.`);
  if (!existsSync(cluster)) throw new Error(`${join(dir, CLUSTER_FILE)} is missing, so the cluster's port is not known.`);
  return { passwords, port: (JSON.parse(readFileSync(cluster, 'utf8')) as { port: number }).port };
}

/** The database personal mode keeps in its own cluster. */
export const PERSONAL_DATABASE = 'backbone';
const DATABASE = PERSONAL_DATABASE;

/**
 * Personal mode: one PostgreSQL 18 cluster kept in `dir` (a data home's `pg`), created on first use
 * with the baseline installed, and started again on every later one. A server left running by a
 * killed process is reused rather than fought. Its passwords are made up on creation and kept by
 * `passwords`, the caller's keeper; without one no cluster is made or opened. PostgreSQL is given
 * only their SCRAM verifiers. Beside the cluster stays only its port (`cluster.json`).
 *
 * A data home whose `dir` holds `external.json` (`{ appUrl, operatorUrl }`) keeps its database in a
 * cluster someone else runs, already holding the baseline: nothing is started, created or stopped
 * here, and that cluster's owner decides when it goes. Tests use it to run one cluster per run
 * rather than one per data home (`prepareDataHome` in testing.ts writes it); its passwords are in
 * the clear, so it is for tests only.
 */
export async function openPersonalDatabase(options: { dir: string; baselineSql: string; native?: string; passwords?: PasswordKeeper; readOnly?: boolean; allowIdentityUpgrade?:boolean; beforeIdentityUpgrade?: (appUrl:string) => Promise<string> }): Promise<PersonalDatabase> {
  const readOnly = !!options.readOnly;
  const baselineSql = options.baselineSql.replace(/\r\n/g, '\n');
  const external = join(options.dir, EXTERNAL_DATABASE_FILE);
  if (existsSync(external)) {
    const { appUrl, operatorUrl } = JSON.parse(readFileSync(external, 'utf8')) as Partial<Pick<PersonalDatabase, 'appUrl' | 'operatorUrl'>>;
    if (typeof appUrl !== 'string' || typeof operatorUrl !== 'string') throw new Error(`${external} must hold appUrl and operatorUrl.`);
    const connection=readOnly?readOnlyConnectionConfig(appUrl):{connectionString:appUrl};
    if(readOnly)readOnlyConnectionConfig(operatorUrl);
    const client = readOnly?new ReadOnlyClient(connection):new pg.Client(connection);
    let identityStatus:IdentityRuntimeStatus={...IDENTITY_PAUSED};
    let materialGuard: MaterialGuardStatus = { state: 'paused', reason: 'Core source withdrawal guard could not be inspected.' };
    let materialLink: MaterialLinkStatus = {state:'paused',reason:'Core material link could not be inspected.'};
    let materialEnforcement:MaterialEnforcementStatus={state:'paused',reason:'Material insertion enforcement could not be inspected.'};
    try { await client.connect(); ({materialGuard,materialLink,materialEnforcement}=readOnly?await verifyReadOnlyDatabase(client):await verifyMaterialStatuses(client));identityStatus=await verifyIdentityRuntime(client); }
    catch (error) { if(readOnly)throw error; /* Writable external capabilities retain their existing optional-paused behavior. */ }
    finally { await client.end().catch(() => {}); }
    return { appUrl, operatorUrl, materialGuard, materialLink, materialEnforcement,identityStatus, async stopIfStarted() {}, async stop() {} };
  }
  assertHomeWriteAdmission(options.dir);
  const keeper = options.passwords;
  const existing = readOnly ? await readExistingPasswords(options.dir, keeper) : undefined;
  if (!keeper) throw new Error('Personal mode needs a keeper for its cluster\'s passwords (`passwords`); none was given, so nothing was made and nothing is written in the clear.');
  const { initdb, postgres } = binaries(options.native);
  const data = join(options.dir, 'data');
  if (!readOnly) mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  const fresh = !existsSync(join(data, 'PG_VERSION'));
  if (readOnly && fresh) throw new PersonalReadRefusal('missing-cluster', 'This home has no existing PostgreSQL cluster; complete its first run with a writable open.');
  let passwords: ClusterPasswords;
  let port: number;
  if (fresh) {
    rmSync(data, { recursive: true, force: true });
    removeDurable(join(options.dir, LEGACY_PASSWORDS_FILE));
    passwords = makePasswords();
    port = await freePort();
    // Kept before the cluster exists: a crash after initdb never leaves a cluster nobody can open.
    await keeper.write(passwords);
    writeDurable(join(options.dir, CLUSTER_FILE), JSON.stringify({ port }));
    // initdb reads the superuser's password from a file: given its verifier, it stores that as it is.
    const pw = join(options.dir, PASSWORD_FILE);
    writeFileSync(pw, scramVerifier(passwords.admin), { mode: 0o600 });
    const init = spawnSync(initdb, ['-D', data, '-U', 'postgres', '--auth=scram-sha-256', `--pwfile=${pw}`, '-E', 'UTF8', '--locale=C'], { encoding: 'utf8' });
    removeDurable(pw);
    if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`);
  } else ({ passwords, port } = existing ?? await keptPasswords(options.dir, keeper));
  const url = (user: string, password: string, database = DATABASE) => `postgres://${user}:${password}@127.0.0.1:${port}/${database}`;
  const adminUrl = (database: string) => url('postgres', passwords.admin, database);
  if(readOnly){readOnlyConnectionConfig(adminUrl('postgres'));readOnlyConnectionConfig(url('backbone_app',passwords.app));readOnlyConnectionConfig(url('backbone_operator',passwords.operator));}
  const matchingServer=()=>matchingPersonalServer(adminUrl('postgres'),data,readOnly?new ReadOnlyClient({...readOnlyConnectionConfig(adminUrl('postgres')),connectionTimeoutMillis:1000}):undefined);

  let child: ChildProcess | undefined;
  let log = '';
  const stopStarted = async () => {
    const started = child;
    if (!started || started.exitCode !== null || started.signalCode !== null) return;
    started.ref();
    started.kill('SIGINT');
    await new Promise<void>((resolve) =>
      started.exitCode !== null || started.signalCode !== null ? resolve() : started.once('exit', () => resolve()));
  };
  const running = !fresh && (await matchingServer());
  if (!running) {
    // Leave stale-PID adjudication to PostgreSQL. A live PID may be an unrelated process;
    // never remove its file or signal it merely because authentication did not succeed.
    if (!fresh) refuseLivePersonalPid(data);
    child = spawn(
      postgres,
      ['-D', data, '-p', String(port), '-c', 'listen_addresses=127.0.0.1', '-c', "unix_socket_directories=", '-c', 'max_connections=64',
       '-c', 'log_parameter_max_length=0', '-c', 'log_parameter_max_length_on_error=0', '-c', 'auto_explain.log_parameter_max_length=0'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    child.stderr?.on('data', (chunk) => {
      log = (log + String(chunk)).slice(-4000);
    });
    try { await ready(adminUrl('postgres'), child, () => log); await matchingServer(); }
    catch (error) { await stopStarted(); throw error; }
    // The server never keeps its parent alive, and a parent that exits takes it down with it; a
    // parent killed outright leaves it running, and the next start reuses it.
    child.unref();
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    const started = child;
    process.once('exit', () => {
      if (started.exitCode === null) started.kill('SIGINT');
    });
  }
  if (readOnly) {
    const reader = new ReadOnlyClient(readOnlyConnectionConfig(adminUrl(DATABASE)));
    try {
      await reader.connect();
      const statuses = await verifyReadOnlyDatabase(reader,true);
      return {appUrl:url('backbone_app',passwords.app),operatorUrl:url('backbone_operator',passwords.operator),...statuses,identityStatus:await verifyIdentityRuntime(reader),stopIfStarted:stopStarted,stop:stopStarted};
    } catch (error) { await reader.end().catch(()=>{}); await stopStarted(); throw error; }
    finally { await reader.end().catch(()=>{}); }
  }
  const admin = async (database: string, sql: string) => {
    const c = new pg.Client({ connectionString: adminUrl(database) });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  };
  if (fresh) {
    await admin('postgres', `CREATE DATABASE ${DATABASE}`);
    await admin(DATABASE, `BEGIN; ${CORE_SCHEMA_LOCK};\n${baselineSql}\nCOMMIT`);
    await admin(DATABASE, `${rolePasswordSql('backbone_app', passwords.app)}; ${rolePasswordSql('backbone_operator', passwords.operator)}`);
  }
  // Existing local homes predate the baseline settings. These idempotent role settings apply to
  // new sessions; the consumer checks each connection before sending any credentials.
  try {
    // Role settings are cluster-wide, so serialize concurrent opens across processes. This
    // reconciliation also repairs settings reset by a restore; it is not a schema migration.
    await admin('postgres', `BEGIN; SELECT pg_advisory_xact_lock(1111573323, 1);
      ALTER ROLE backbone_app SET log_parameter_max_length = 0;
      ALTER ROLE backbone_app SET log_parameter_max_length_on_error = 0;
      ALTER ROLE backbone_operator SET log_parameter_max_length = 0;
      ALTER ROLE backbone_operator SET log_parameter_max_length_on_error = 0; COMMIT`);
  } catch (error) {
    await stopStarted();
    throw error;
  }
  const installer = new pg.Client({ connectionString: adminUrl(DATABASE) });
  let identityStatus:IdentityRuntimeStatus={...IDENTITY_PAUSED};
  let identityUpgrade:IdentityUpgradeResult|undefined;
  let copy:string|undefined;
  let beforeIdentity:Awaited<ReturnType<typeof readSchemaHistory>>|undefined;
  let backupFailed=false;
  let cohortAttempted=false;
  let cohortVerified=false;
  let materialGuard: MaterialGuardStatus = { state: 'paused', reason: 'The Core guard installer could not be reached.' };
  let materialLink: MaterialLinkStatus = {state:'paused',reason:'The Core material link installer could not be reached.'};
  let materialEnforcement:MaterialEnforcementStatus={state:'paused',reason:'The material insertion enforcement installer could not be reached.'};
  try {
    await installer.connect();
    // A current closure profile replaces old material definitions; never run their installers
    // first on an already upgraded home. External homes remain inspection-only above.
    try {
      const openingHistory=await readSchemaHistory(installer,'installer');
      const needsIdentityUpgrade=openingHistory.length<CORE_SCHEMA_UPGRADES.length+1;
      if(!fresh&&needsIdentityUpgrade&&(!options.allowIdentityUpgrade||!options.beforeIdentityUpgrade))throw new IdentityUpgradeRequired();
      if(!fresh&&needsIdentityUpgrade&&options.beforeIdentityUpgrade){
        try{copy=await options.beforeIdentityUpgrade(url('backbone_app',passwords.app));if(!copy)throw new IdentityUpgradeRequired('The Team update requires a verified recovery copy.');}
        catch(error){
          if(error instanceof IdentityUpgradeRequired)throw error;
          backupFailed=true;
          const code=(error as {code?:string}).code;
          const reason=code==='ENOSPC'?'There is not enough disk space.':code==='EACCES'?'The backup folder cannot be written.':'The data export refused the recovery copy.';
          identityUpgrade={state:'backup-failed',reason:`The Team update did not start. Nothing was changed. ${reason}`};
        }
      }
      if(!backupFailed){
        if(hasMaterialClosure(await readSchemaHistory(installer,'installer'))){
          await upgradeMaterialClosureHardening(installer);
        }else{
          materialGuard=await upgradeMaterialGuard(installer,baselineSql);
          if(materialGuard.state==='verified')materialLink=await upgradeMaterialLink(installer,baselineSql);
          if(materialLink.state==='verified')materialEnforcement=await upgradeMaterialEnforcement(installer,baselineSql);
          if(materialEnforcement.state==='verified'&&(await upgradeSignatureLedger(installer,baselineSql)).state==='verified'){
            if((await upgradeMaterialClosure(installer)).state==='verified')await upgradeMaterialClosureHardening(installer);
          }
        }
        beforeIdentity=await readSchemaHistory(installer,'installer');
        cohortAttempted=true;cohortVerified=(await upgradeIdentityCohort(installer)).state==='verified';
      }
    } finally {
      // Optional installation failure is not a verdict on unchanged message/web capabilities.
      // Conversely, a lost COMMIT reply can leave a new receipt: inspect actual history and
      // catalogue rather than retain stale pre-install admissions or copy the step's refusal.
      materialGuard={state:'paused',reason:'The current Core source guard could not be inspected.'};
      materialLink={state:'paused',reason:'The current Core material link could not be inspected.'};
      materialEnforcement={state:'paused',reason:'The current material insertion enforcement could not be inspected.'};
      // An unavailable inspector leaves the statuses paused; it must never replace a refusal
      // to update (IdentityUpgradeRequired) and so let a headless open continue unchanged.
      try{
        ({materialGuard,materialLink,materialEnforcement}=await verifyMaterialStatuses(installer));
        identityStatus=await verifyIdentityRuntime(installer);
      }catch{/* Statuses stay paused. */}
    }
  }
  catch(error) {
    if(error instanceof IdentityUpgradeRequired){await installer.end().catch(()=>{});await stopStarted();throw error;}
    // A refused optional guard leaves unchanged message/web work available.
  }
  finally { await installer.end().catch(() => {}); }
  if(cohortAttempted&&beforeIdentity){
    const observer=new pg.Client({connectionString:adminUrl(DATABASE)});
    try{
      await observer.connect();
      const actual=await readSchemaHistory(observer,'installer');
      identityStatus=await verifyIdentityRuntime(observer);
      const unchanged=JSON.stringify(actual)===JSON.stringify(beforeIdentity);
      if(identityStatus.state==='verified')identityUpgrade={state:'installed',backup:copy,reason:'The Team update is installed and verified.'};
      else if(unchanged&&!cohortVerified)identityUpgrade={state:'unchanged',backup:copy,reason:copy?`Nothing was changed. A copy of your data from before the update is at ${copy}.`:'Nothing was changed. The Team update could not be installed.'};
      else identityUpgrade={state:'unconfirmed',backup:copy,reason:'The update outcome could not be confirmed. Keep this data folder and inspect it before retrying.'};
    }catch{identityUpgrade={state:'unconfirmed',backup:copy,reason:'The update outcome could not be confirmed. Keep this data folder and inspect it before retrying.'};}
    finally{await observer.end().catch(()=>{});}
  }
  return {
    identityUpgrade,
    appUrl: url('backbone_app', passwords.app),
    operatorUrl: url('backbone_operator', passwords.operator),
    materialGuard,
    materialLink,
    materialEnforcement,
    identityStatus,
    stopIfStarted: stopStarted,
    async stop() {
      if (child && child.exitCode === null && child.signalCode === null) {
        await stopStarted();
        return;
      }
      await stopPersonalDatabaseAt(options.dir);
    },
  };
}
