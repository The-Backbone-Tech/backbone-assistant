// A stopped embedded database is read from a temporary copy. Its supervisor exists before any
// copy begins. Local trust on a private Unix socket requires neither a vault nor home passwords.
import { governedPolicy, auditDecision } from '../policy/index.ts';
import { constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statfsSync, writeFileSync } from 'node:fs';
import { copyFile, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { binaries } from '@backbone-next/kernel/cluster';
import { serviceClient } from '@backbone/core/db';
import { AUDIT_UUID, AUDIT_WRITE_TIMEOUT_MS, AuditInvalid, auditOptions, type AuditSummary, type AuditOptions } from '../audit.ts';
import { LOG_POLICY_QUERY, safeLogPolicy } from '../authority/log-policy.ts';
import type { Receipt } from '../api.ts';
import {Vault, type HomeKeys } from '../keys/vault.ts';
import { canonicalHome } from '../doors/protocol.ts';
import { exportAudit, type AuditSource } from './audit-export.ts';
import { allocateAuditTemporary, auditProcessAlive, auditTemporaryRoot, sweepAuditTemporary } from './audit-temporary.ts';
import {auditDigester} from './audit-digest.ts';
import { ownerSocket, ownerAnswers } from './home-owner.ts';
import { refuseStampedHome } from './home-kernel.ts';
export type AuditCopyPoint = 'allocated' | 'copying' | 'server-ready';
export interface AuditHomeOptions {
  keys?: HomeKeys; postgresNative?: string;
  /** scratchRoot is operator-selected; temporaryRoot/atPoint are trusted fixture observations. */
  temporaryRoot?: string; scratchRoot?: string; progressTimeoutMs?: number; atPoint?: (point: AuditCopyPoint, folder: string) => void | Promise<void>;
}
const inside = (file: string, home: string) => file === home || file.startsWith(home + sep);
async function hasOwner(home: string): Promise<boolean> {
  if (await ownerAnswers(ownerSocket(home,true))) return true;
  return ownerAnswers(ownerSocket(home));
}
function stopped(data: string) {
  const file = join(data, 'postmaster.pid');
  if (!existsSync(file)) return;
  const pid=Number(readFileSync(file,'utf8').split('\n')[0]);
  if(!Number.isSafeInteger(pid)||pid<1)throw new AuditInvalid('The source PID file is invalid; confirm that PostgreSQL is stopped before retrying. Audit export never removes the source PID file.');
  if (auditProcessAlive(pid)) throw new AuditInvalid('The source PID file names a live process but no API line is available. Confirm the owner or resolve a stale PID before retrying; audit export never removes the source PID file.');
}
async function copyCluster(from: string, to: string, signal: AbortSignal, copied: () => Promise<void>): Promise<void> {
  signal.throwIfAborted(); mkdirSync(to, { mode: 0o700 });
  for (const name of await readdir(from)) {
    signal.throwIfAborted();
    if (['postmaster.pid', 'postmaster.opts', 'postgresql.auto.conf'].includes(name)) continue;
    const src = join(from, name), dest = join(to, name), st = lstatSync(src);
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()) || (st.isFile() && st.nlink !== 1)) throw new AuditInvalid('Standalone audit snapshots require an embedded database without links or tablespaces. Use the live API line.');
    if (st.isDirectory()) await copyCluster(src, dest, signal, copied);
    else {
      const space = statfsSync(to);
      if (space.bavail * space.bsize < st.size + 8 * 1024 ** 3) throw new AuditInvalid('The temporary audit snapshot would leave less than 8 GiB free. Use the live API line.');
      await copyFile(src, dest, constants.COPYFILE_FICLONE);
      await copied(); signal.throwIfAborted();
      const after = lstatSync(src);
      if (st.ino !== after.ino || st.size !== after.size || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs) throw new AuditInvalid('The source database changed during its audit snapshot. Retry through the live API line.');
    }
  }
}
async function observe(point: AuditCopyPoint, folder: string, options: AuditHomeOptions, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!options.atPoint) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => options.atPoint!(point, folder)).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  signal.throwIfAborted();
}

/** A standalone read: never initializes, renews, migrates or recovers the source home. */
export async function exportAuditHome(homePath: string, supplied: AuditOptions, write: (bytes: string) => Promise<void>, options: AuditHomeOptions = {}): Promise<Receipt<AuditSummary>> {
  const period = auditOptions(supplied), home = canonicalHome(homePath), root = auditTemporaryRoot(options.scratchRoot ?? options.temporaryRoot);
  auditDecision(governedPolicy(home), period.includeContent === true);
  await sweepAuditTemporary(root);
  if (!existsSync(home)) throw new AuditInvalid('No audit data folder exists at the named path.');
  refuseStampedHome(home);
  if (await hasOwner(home)) throw new AuditInvalid('This data folder has a live owner whose API line is not available; retry when the line is ready.');
  const identity = JSON.parse(readFileSync(join(home, 'core.json'), 'utf8')) as { workspace: string; person: string };
  if (!AUDIT_UUID.test(identity.workspace) || !AUDIT_UUID.test(identity.person)) throw new AuditInvalid('This data folder has no valid Core identity.');
  if (JSON.parse(readFileSync(join(home, 'keys', 'vault.json'), 'utf8')).holder !== 'plaintext') throw new AuditInvalid('Standalone audit export requires a data folder with plaintext keys. Use the running app for content-free export.');
  if(existsSync(join(home,'keys','master.key')))throw new AuditInvalid('A legacy master key must be migrated by the app before a standalone audit read.');
  const vault=await Vault.open(home,options.keys,{readOnly:true});
  const abort = new AbortController(), signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const handlers = signals.map(signal => () => abort.abort(new AuditInvalid(`Audit export interrupted by ${signal}; the temporary snapshot is being removed.`)));
  signals.forEach((signal, i) => process.on(signal, handlers[i]));
  let temporary: ReturnType<typeof allocateAuditTemporary> | undefined;
  let client: Awaited<ReturnType<typeof serviceClient>> | undefined;
  try {
    const external = join(home, 'pg', 'external.json');
    let appUrl: string;
    if (existsSync(external)) appUrl = (JSON.parse(readFileSync(external, 'utf8')) as { appUrl: string }).appUrl;
    else {
      const data = join(home, 'pg', 'data'); stopped(data);
      const controlPath = join(data, 'global', 'pg_control'), control = readFileSync(controlPath);
      if (inside(root, home)) throw new AuditInvalid('The temporary folder is inside the data folder.');
      temporary = allocateAuditTemporary(root, abort.signal,error=>abort.abort(error)); await temporary.ready;
      const folder = temporary.folder; await observe('allocated', folder, options, abort.signal);
      let observedCopy = false;
      const copied = join(folder, 'data');
      await copyCluster(data, copied, abort.signal, async () => { if (!observedCopy) { observedCopy = true; await observe('copying', folder, options, abort.signal); } });
      stopped(data);
      if (!control.equals(readFileSync(controlPath)) || await hasOwner(home)) throw new AuditInvalid('The source database started or changed during its audit snapshot. Retry through the live API line.');
      const socket = join(folder, 'socket'); mkdirSync(socket, {mode:0o700});
      if (Buffer.byteLength(join(socket, '.s.PGSQL.5432')) > 100) throw new AuditInvalid('The audit scratch root exceeds the 100-byte Unix socket path limit; choose a shorter --scratch-root.');
      const config = join(folder, 'postgresql.conf'), hba = join(folder, 'pg_hba.conf');
      writeFileSync(config, '', {mode:0o600}); writeFileSync(hba, 'local all all trust\n', {mode:0o600});
      await temporary.start(binaries(options.postgresNative).postgres, ['-D',copied,'-c',`config_file=${config}`,'-c',`hba_file=${hba}`,
        '-c','listen_addresses=','-c',`unix_socket_directories=${socket}`,'-c','max_connections=16',
        '-c','log_parameter_max_length=0','-c','log_parameter_max_length_on_error=0','-c','auto_explain.log_parameter_max_length=0']);
      appUrl = `postgresql://backbone_app@localhost/backbone?host=${encodeURIComponent(socket)}&port=5432`;
      for (let attempt=0;;attempt++) {
        abort.signal.throwIfAborted();
        try { client = await serviceClient(appUrl,{connectionTimeoutMillis:500,statement_timeout:30000}); break; }
        catch(error) { if(attempt>=150) throw error; await new Promise(r=>setTimeout(r,50)); }
      }
      await observe('server-ready',folder,options,abort.signal);
    }
    abort.signal.throwIfAborted();
    client ??= await serviceClient(appUrl, {connectionTimeoutMillis:5000,statement_timeout:30000});
    if (!safeLogPolicy((await client.query(LOG_POLICY_QUERY)).rows[0])) throw new AuditInvalid('Database logging policy is unsafe for an audit connection.');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SELECT set_config('backbone.workspace', $1, true), set_config('backbone.principal', $2, true),
      set_config('backbone.run', '', true), set_config('backbone.secret', '', true)`, [identity.workspace,identity.person]);
    const source: AuditSource = {homeId:identity.workspace,personId:identity.person,digester:()=>auditDigester(home,identity.workspace,vault),snapshot:async(sql,values)=>{auditDecision(governedPolicy(home),values[3]===true);return(await client!.query(sql,values)).rows[0]}};
    const value=await exportAudit(source,period,async bytes=>{
      abort.signal.throwIfAborted();
      let timer:NodeJS.Timeout|undefined;
      try{
        await new Promise<void>((resolve,reject)=>{
          const stop=()=>reject(abort.signal.reason);
          timer=setTimeout(()=>abort.abort(new AuditInvalid('No audit output progress within 30 seconds; the export was not written whole; discard the partial output.')),options.progressTimeoutMs??AUDIT_WRITE_TIMEOUT_MS);
          abort.signal.addEventListener('abort',stop,{once:true});
          write(bytes).then(resolve,reject).finally(()=>abort.signal.removeEventListener('abort',stop));
        });
      }finally{if(timer)clearTimeout(timer);}
    });
    abort.signal.throwIfAborted();await client.query('COMMIT');
    return {ok:true,value};
  } finally {
    await client?.end().catch(()=>{});await temporary?.close();
    signals.forEach((signal,i)=>process.off(signal,handlers[i]));
  }
}
