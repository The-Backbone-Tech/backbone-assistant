import {upgradeIdentityHardening} from './identity-hardening.ts';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import pg from 'pg';
import { buildBaseline } from './baseline.ts';
import {upgradeMaterialGuard} from './material-guard.ts';
import {upgradeMaterialLink} from './material-link.ts';
import {upgradeSignatureLedger} from './signature-ledger.ts';
import {upgradeMaterialClosure} from './material-closure.ts';
import {upgradeMaterialClosureHardening} from './material-closure-hardening.ts';
import {upgradeIdentity} from './identity.ts';
import {upgradeIdentityWork} from './identity-work.ts';
import {upgradeIdentityRoleRevocation} from './identity-role-revocation.ts';
import {upgradeIdentityResource} from './identity-resource.ts';
import {upgradeIdentityPlatform} from './identity-platform.ts';
import {upgradeIdentityGuarantees} from './identity-guarantees.ts';
import {upgradeIdentityAdmission} from './identity-admission.ts';
import {upgradeMaterialEnforcement} from './material-enforcement.ts';
import { guardCluster } from '@backbone-next/kernel/cluster';
import { binaries, CLUSTER_FILE, type ClusterPasswords, EXTERNAL_DATABASE_FILE, freePort, PERSONAL_DATABASE, ready, rolePasswordSql } from './personal.ts';

export interface TestPostgres {
  /** The installer (a superuser), for setup and for the oracle's adversary only. */
  readonly adminUrl: (database: string) => string;
  /** The service role, backbone_app. */
  readonly appUrl: (database: string) => string;
  /** The installation's operator, backbone_operator. */
  readonly operatorUrl: (database: string) => string;
  /** Create `database` from the template that holds the baseline. */
  clone(database: string): Promise<void>;
  drop(database: string): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Where a run's shared cluster is told to every process of the run: a JSON `{ port, admin, app,
 * operator }` (the passwords were made up for this run). Set by `startSharedTestCluster`.
 */
export const TEST_CLUSTER_ENV = 'BACKBONE_TEST_PG';
const TEMPLATE = 'backbone_template';

interface ClusterRef {
  port: number;
  admin: string;
  app: string;
  operator: string;
}

const urlsOf = (ref: ClusterRef) => {
  const url = (user: string, password: string) => (database: string) => `postgres://${user}:${password}@127.0.0.1:${ref.port}/${database}`;
  return { adminUrl: url('postgres', ref.admin), appUrl: url('backbone_app', ref.app), operatorUrl: url('backbone_operator', ref.operator) };
};

/**
 * FILE_COPY copies the template's files (cloned where the filesystem can) instead of writing every
 * block through the log: about twice as fast here (docs/how-to/run-the-checks.md has the numbers).
 */
const cloneSql = (database: string) => `CREATE DATABASE ${database} TEMPLATE ${TEMPLATE} STRATEGY = FILE_COPY`;

async function runSql(url: string, sql: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  try {
    await c.connect();
  } catch (error) {
    await c.end().catch(() => {});
    if (process.env[TEST_CLUSTER_ENV]) throw new Error(`the test cluster named by ${TEST_CLUSTER_ENV} does not answer (${(error as Error).message}); unset it, or run through scripts/with-test-cluster.mjs.`);
    throw error;
  }
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

/** Whether files under `dir` can be cloned (copy-on-write): PostgreSQL's `file_copy_method = clone` fails where they cannot. */
function canClone(dir: string): boolean {
  const from = join(dir, 'clone-probe');
  writeFileSync(from, 'x');
  const cloned = spawnSync('cp', process.platform === 'darwin' ? ['-c', from, `${from}.copy`] : ['--reflink=always', from, `${from}.copy`]).status === 0;
  rmSync(from, { force: true });
  rmSync(`${from}.copy`, { force: true });
  return cloned;
}

/**
 * A fresh PostgreSQL 18 in a temporary directory with the baseline installed once into a template
 * database. A guard process beside it stops it and removes the directory if this process dies
 * without calling `stop`: a killed run must not leave a server holding a shared-memory segment
 * (macOS allows 32 per machine).
 */
async function launchCluster(qualifySignature = true, qualifyClosure = true, qualifyHardening = true, qualifyIdentity = true, qualifyIdentityWork = true, qualifyIdentityRoleRevocation = true, qualifyIdentityResource = true, qualifyIdentityAdmission = true,qualifyIdentityGuarantees=true,qualifyIdentityPlatform=true,qualifyIdentityHardening=true): Promise<{ ref: ClusterRef; stop(): Promise<void> }> {
  const { initdb, postgres } = binaries();
  const dir = mkdtempSync(join(tmpdir(), 'backbone-pg-'));
  let child: ChildProcess | undefined;
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGINT');
        await new Promise((resolve) => child?.once('exit', resolve));
      }
      rmSync(dir, { recursive: true, force: true });
    })());
  try {
    const data = join(dir, 'data');
    const ref: ClusterRef = { port: await freePort(), admin: randomBytes(18).toString('hex'), app: randomBytes(18).toString('hex'), operator: randomBytes(18).toString('hex') };
    writeFileSync(join(dir, 'pw'), ref.admin);
    const init = spawnSync(initdb, ['-D', data, '-U', 'postgres', '--auth=scram-sha-256', `--pwfile=${join(dir, 'pw')}`, '-E', 'UTF8', '--locale=C'], {
      encoding: 'utf8',
    });
    if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`);
    rmSync(join(dir, 'pw'));
    child = spawn(
      postgres,
      ['-D', data, '-p', String(ref.port), '-c', 'unix_socket_directories=', '-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off', '-c', 'synchronous_commit=off',
       '-c', 'full_page_writes=off', '-c', 'max_connections=300', '-c', 'shared_buffers=128MB', '-c', 'log_checkpoints=off',
       '-c', 'log_parameter_max_length=0', '-c', 'log_parameter_max_length_on_error=0', '-c', 'auto_explain.log_parameter_max_length=0',
       ...(canClone(dir) ? ['-c', 'file_copy_method=clone'] : [])],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let log = '';
    // Drained always: a server whose log pipe is full blocks in the middle of a checkpoint.
    child.stderr?.on('data', (chunk) => {
      log = (log + String(chunk)).slice(-4000);
    });
    guardCluster(child, dir);
    const { adminUrl } = urlsOf(ref);
    await ready(adminUrl('postgres'), child, () => log);
    await runSql(adminUrl('postgres'), `CREATE DATABASE ${TEMPLATE}`);
    await runSql(adminUrl(TEMPLATE), buildBaseline().sql);
    // A clone is an external home, so opening it inspects rather than installs. Use the real
    // owned installers on the disposable template first: never invent migration receipts or
    // infer a capability from a baseline digest without its exact catalogue verification.
    const installer=new pg.Client({connectionString:adminUrl(TEMPLATE)});
    try{
      await installer.connect();
      const baseline=buildBaseline().sql;
      for(const install of [upgradeMaterialGuard,upgradeMaterialLink,upgradeMaterialEnforcement,...(qualifySignature?[upgradeSignatureLedger,...(qualifyClosure?[upgradeMaterialClosure,...(qualifyHardening?[upgradeMaterialClosureHardening,...(qualifyIdentity?[((client:pg.ClientBase)=>upgradeIdentity(client)),...(qualifyIdentityWork?[((client:pg.ClientBase)=>upgradeIdentityWork(client)),...(qualifyIdentityRoleRevocation?[((client:pg.ClientBase)=>upgradeIdentityRoleRevocation(client)),...(qualifyIdentityResource?[((client:pg.ClientBase)=>upgradeIdentityResource(client)),...(qualifyIdentityAdmission?[((client:pg.ClientBase)=>upgradeIdentityAdmission(client)),...(qualifyIdentityGuarantees?[((client:pg.ClientBase)=>upgradeIdentityGuarantees(client)),...(qualifyIdentityPlatform?[((client:pg.ClientBase)=>upgradeIdentityPlatform(client)),...(qualifyIdentityHardening?[((client:pg.ClientBase)=>upgradeIdentityHardening(client))]:[])]:[])]:[])]:[])]:[])]:[])]:[])]:[])]:[])]:[])]:[])]){
        const status=await install(installer,baseline);
        if(status.state!=='verified')throw new Error(`The test template capability could not be verified: ${status.reason}`);
      }
    }finally{await installer.end();}
    await runSql(adminUrl('postgres'), `${rolePasswordSql('backbone_app', ref.app)}; ${rolePasswordSql('backbone_operator', ref.operator)}`);
    return { ref, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** The run's shared cluster, when a runner started one (`startSharedTestCluster`). */
function sharedCluster(): ClusterRef | undefined {
  const told = process.env[TEST_CLUSTER_ENV];
  return told ? (JSON.parse(told) as ClusterRef) : undefined;
}

/** A test file's view of the run's shared cluster: its own databases, under names no other file can take. */
function attach(ref: ClusterRef): TestPostgres {
  const urls = urlsOf(ref);
  const prefix = `t${randomBytes(4).toString('hex')}_`;
  const made = new Map<string, string>();
  const real = (database: string) => made.get(database) ?? database;
  const drop = (database: string) => runSql(urls.adminUrl('postgres'), `DROP DATABASE IF EXISTS ${real(database)} WITH (FORCE)`).then(() => void made.delete(database));
  return {
    adminUrl: (database) => urls.adminUrl(real(database)),
    appUrl: (database) => urls.appUrl(real(database)),
    operatorUrl: (database) => urls.operatorUrl(real(database)),
    async clone(database) {
      await runSql(urls.adminUrl('postgres'), cloneSql(prefix + database));
      made.set(database, prefix + database);
    },
    drop,
    // The cluster belongs to the run; what this file cloned goes with the file.
    async stop() {
      for (const database of [...made.keys()]) await drop(database).catch(() => {});
    },
  };
}

/**
 * A PostgreSQL 18 for tests. Inside a run that started a shared cluster (`startSharedTestCluster`,
 * which the runners do: docs/how-to/run-the-checks.md) it is that cluster, so a file's databases
 * are clones of its template and `stop` removes only them. Alone, it is a throwaway cluster of its
 * own, stopped by `stop`.
 */
export async function startTestPostgres(options: { unqualifiedIdentityHardeningBaseline?:boolean; unqualifiedIdentityPlatformBaseline?:boolean; unqualifiedIdentityGuaranteesBaseline?:boolean; unqualifiedIdentityAdmissionBaseline?:boolean; unqualifiedIdentityResourceBaseline?:boolean; unqualifiedIdentityRoleRevocationBaseline?: boolean; unqualifiedIdentityWorkBaseline?: boolean; unqualifiedIdentityBaseline?: boolean; unqualifiedSignatureBaseline?: boolean; unqualifiedClosureBaseline?: boolean; unqualifiedHardeningBaseline?: boolean } = {}): Promise<TestPostgres> {
  const shared = sharedCluster();
  // The source/catalogue generator needs a fresh candidate before pins can be regenerated.
  // Never let that explicit qualification fixture borrow or weaken a shared test template.
  if (shared && (options.unqualifiedIdentityHardeningBaseline||options.unqualifiedIdentityPlatformBaseline||options.unqualifiedIdentityGuaranteesBaseline||options.unqualifiedIdentityAdmissionBaseline||options.unqualifiedIdentityResourceBaseline||options.unqualifiedIdentityRoleRevocationBaseline||options.unqualifiedIdentityWorkBaseline||options.unqualifiedIdentityBaseline||options.unqualifiedSignatureBaseline||options.unqualifiedClosureBaseline||options.unqualifiedHardeningBaseline)) throw new Error('Source qualification requires its own disposable baseline.');
  if (shared) return attach(shared);
  const { ref, stop } = await launchCluster(!options.unqualifiedSignatureBaseline,!options.unqualifiedClosureBaseline,!options.unqualifiedHardeningBaseline,!options.unqualifiedIdentityBaseline,!options.unqualifiedIdentityWorkBaseline,!options.unqualifiedIdentityRoleRevocationBaseline,!options.unqualifiedIdentityResourceBaseline,!options.unqualifiedIdentityAdmissionBaseline,!options.unqualifiedIdentityGuaranteesBaseline,!options.unqualifiedIdentityPlatformBaseline,!options.unqualifiedIdentityHardeningBaseline);
  const urls = urlsOf(ref);
  return {
    ...urls,
    clone: (database) => runSql(urls.adminUrl('postgres'), cloneSql(database)),
    drop: (database) => runSql(urls.adminUrl('postgres'), `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`),
    stop,
  };
}

/**
 * One cluster for a whole test run, told to every process the run starts through the environment.
 * Call once from the runner (a vitest `globalSetup`, or scripts/with-test-cluster.mjs) and call
 * `stop` when the run ends. Inside a run that already has one, this is a no-op.
 */
export async function startSharedTestCluster(): Promise<{ stop(): Promise<void> }> {
  if (sharedCluster()) return { stop: async () => {} };
  const { ref, stop } = await launchCluster();
  process.env[TEST_CLUSTER_ENV] = JSON.stringify(ref);
  return {
    async stop() {
      delete process.env[TEST_CLUSTER_ENV];
      await stop();
    },
  };
}

let worker: Worker | undefined;
/** Run `sql` on the server at `url` and wait for it, for helpers that must return a value rather than a promise. */
function runSqlSync(url: string, sql: string): void {
  if (!worker) {
    worker = new Worker(new URL('./sql-worker.mjs', import.meta.url));
    worker.unref();
    worker.once('error', () => void (worker = undefined));
  }
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  worker.postMessage({ flag, port: port2, url, sql }, [port2]);
  if (Atomics.wait(flag, 0, 0, 60_000) === 'timed-out') throw new Error('the database did not answer within 60 s');
  const reply = receiveMessageOnPort(port1)?.message as { ok: boolean; error?: string } | undefined;
  port1.close();
  if (!reply?.ok) throw new Error(reply?.error ?? 'the database gave no reply');
}

/**
 * Give a fresh data home its own database in the run's shared cluster, cloned from the template, by
 * writing the `external.json` that `openPersonalDatabase` follows: the home (and any process given
 * its path: a host, the app, the MCP door) then needs no cluster of its own. Returns false and
 * leaves the home alone when the run has no shared cluster, so the home boots its own as in
 * production. The database goes with the cluster when the run ends.
 */
export function prepareDataHome(home: string): boolean {
  const ref = sharedCluster();
  if (!ref) return false;
  const dir = join(home, 'pg');
  if (existsSync(join(dir, 'data'))) throw new Error(`${home} already has a cluster of its own.`);
  const database = `home_${randomBytes(6).toString('hex')}`;
  const urls = urlsOf(ref);
  runSqlSync(urls.adminUrl('postgres'), cloneSql(database));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, EXTERNAL_DATABASE_FILE), JSON.stringify({ appUrl: urls.appUrl(database), operatorUrl: urls.operatorUrl(database) }), { mode: 0o600 });
  return true;
}

/**
 * The installer's URL for the database a data home keeps, for a test that must act as the cluster's
 * administrator (move time, read a store the service cannot): the run's shared cluster for a
 * prepared home, the home's own cluster otherwise, whose passwords only their keeper holds, so the
 * test passes them (the platform's testing helpers read them from the home's vault).
 */
export function dataHomeAdminUrl(home: string, passwords?: ClusterPasswords): string {
  const dir = join(home, 'pg');
  const external = join(dir, EXTERNAL_DATABASE_FILE);
  if (existsSync(external)) {
    const ref = sharedCluster();
    if (!ref) throw new Error(`${home} keeps its database in the run's shared cluster, and ${TEST_CLUSTER_ENV} is not set.`);
    const { appUrl } = JSON.parse(readFileSync(external, 'utf8')) as { appUrl: string };
    return urlsOf(ref).adminUrl(new URL(appUrl).pathname.slice(1));
  }
  if (!passwords) throw new Error(`${home} has a cluster of its own: pass its passwords, which only its keeper holds.`);
  const { port } = JSON.parse(readFileSync(join(dir, CLUSTER_FILE), 'utf8')) as { port: number };
  return `postgres://postgres:${passwords.admin}@127.0.0.1:${port}/${PERSONAL_DATABASE}`;
}

/** The passwords of the cluster a data home uses, for a test that checks none of them leaks: the shared cluster's, or those given for a cluster of its own. */
export function dataHomePasswords(home: string, passwords?: ClusterPasswords): string[] {
  const dir = join(home, 'pg');
  if (existsSync(join(dir, EXTERNAL_DATABASE_FILE))) {
    const ref = sharedCluster();
    return ref ? [ref.admin, ref.app, ref.operator] : [];
  }
  if (!passwords) throw new Error(`${home} has a cluster of its own: pass its passwords, which only its keeper holds.`);
  return [passwords.admin, passwords.app, passwords.operator];
}
