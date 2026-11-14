// Expected security qualification results, not a sandbox implementation.
import { readlink, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { filesystemOverride, type NativeEnvironment } from './native.ts';
import type { SandboxCommand } from './readonly-proof.ts';
export const linuxExpected = (environment: NativeEnvironment, freshProc = true) => ({
  single_file_initial: 'denied', single_file_renamed: environment === 'full' ? 'allowed' : 'denied',
  created_path: environment === 'full' ? 'allowed' : 'denied', data_home: 'denied', arrangement: 'denied',
  udp: 'denied', dns: 'denied', unix_stream: 'denied', abstract_stream: 'denied',
  abstract_datagram_sendmsg: 'denied',
  unix_datagram_sendmsg: environment === 'full' ? 'allowed' : 'denied',
  host_datagram_visible: environment === 'full', run_visible: environment === 'full',
  proc_cmdline: environment === 'full' && !freshProc ? 'allowed' : 'denied', proc_environ: 'denied',
});
export function assessLinuxAudit(environment: NativeEnvironment, value: unknown, coverage: 'syscall' | 'node' = 'syscall') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid Linux security probe result.');
  const result = value as Record<string, unknown>;
  if (result.network_namespace_distinct !== true || typeof result.fresh_proc !== 'boolean' || ![true, false, null].includes(result.pid_namespace_distinct as boolean | null) || (result.fresh_proc && result.pid_namespace_distinct !== true)) throw Error('Invalid Linux proc evidence.');
  const expected: Record<string, unknown> = linuxExpected(environment, result.fresh_proc);
  if (coverage === 'node') for (const key of ['unix_datagram_sendmsg', 'abstract_datagram_sendmsg', 'host_datagram_visible']) delete expected[key];
  const keys = [...Object.keys(expected), 'fresh_proc', 'pid_namespace_distinct', 'network_namespace_distinct', 'host_hits'].sort();
  if (Object.keys(result).sort().join(',') !== keys.join(',')) throw Error('Missing or unexpected Linux security evidence.');
  for (const [key, wanted] of Object.entries(expected)) if (result[key] !== wanted) throw Error(`Linux security probe mismatch (${key}).`);
  const hits = result.host_hits;
  if (!Array.isArray(hits) || hits.some(hit => typeof hit !== 'string') ||
    JSON.stringify(hits.slice().sort()) !== JSON.stringify(coverage === 'syscall' && environment === 'full' ? ['sendmsg'] : [])) throw Error('Unexpected Host network delivery.');
  return { expected: true, networkAcceptable: coverage === 'syscall' ? result.unix_datagram_sendmsg === 'denied' && result.host_datagram_visible === false : null,
    limits: environment === 'full' ? ['rename-over-file-deny', 'created-after-start', 'visible-host-datagram', ...(!result.fresh_proc ? ['host-cmdline'] : [])] : [] };
}
/** Cache belongs to one harness (Host lifetime). Failures are never cached. */
export function createLinuxInventoryCache() {
  const cache = new Map<string, string>();
  return { get size() { return cache.size; }, get: (key: string) => cache.get(key), set(key: string, value: string) {
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, value);
  } };
}
const unescapeMount = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
export function inventoryPaths(mounts: string, stage: string, socketParents: string[]) {
  const paths = new Set(['/run', '/var/run', '/tmp', '/var/tmp', '/dev', stage, ...socketParents]);
  for (const line of mounts.trim().split('\n')) {
    const fields = line.split(' '), split = fields.indexOf('-');
    if (split < 6 || !fields[4]?.startsWith('/') || !fields[5]) throw Error('Invalid Linux mount table evidence.');
    const path = unescapeMount(fields[4]);
    // Fresh virtual trees are not Host service endpoints; runtime roots are read-only.
    if (fields[5].split(',').includes('rw') && path !== '/' && !/^\/(proc|sys)(\/|$)/.test(path)) paths.add(path);
  }
  for (const path of paths) if (['/usr','/etc','/lib','/lib64','/'].includes(path)) throw Error('A Host socket-bearing runtime root cannot be inventoried within the selected Linux scope. Use contained.');
  return [...paths].sort();
}
/** Actual native entries, byte-exact names and aliases. No traversal into unselected runtime roots. */
export const LINUX_SOCKET_INVENTORY_PROGRAM = String.raw`
// backbone-linux-datagram-visibility-v1
const fs = require('node:fs');
const spec=JSON.parse(process.argv[1]);
const seen = new Set(); let count=0, visible=false, complete=true;
const started=Date.now(), limit=250000, time_limit_ms=10000;
let excludedRoot=false;
const runtimeBindings=spec.paths.flatMap(root=>{try{const real=fs.realpathSync.native(root,{encoding:'buffer'});if(/^\/(usr|etc|lib|lib64)$/.test(real.toString()))excludedRoot=true;return /^\/(usr|etc|lib|lib64)\//.test(real.toString())?[real]:[];}catch{return [];}});
function walk(path) {
  if (++count>limit || Date.now()-started>time_limit_ms) throw Error('inventory bound');
  let real;
  try { real=fs.realpathSync.native(path,{encoding:'buffer'}); }
  catch(error) { if(['ENOENT','ENOTDIR','EACCES','EPERM','ELOOP'].includes(error.code)) return; throw error; }
  const key=real.toString('base64'); if(seen.has(key))return; seen.add(key);
  // Symlinks into runtime roots do not make those read-only trees inventory roots.
  if(spec.exclude_runtime && /^\/(usr|etc|lib|lib64)(\/|$)/.test(real.toString()) && !runtimeBindings.some(root=>real.equals(root) || (real.length>root.length && real[root.length]===47 && real.subarray(0,root.length).equals(root))))return;
  const stat=fs.statSync(real);
  if(stat.isSocket()){visible=true;return;}
  if(!stat.isDirectory())return;
  let names;
  try { names=fs.readdirSync(real,{encoding:'buffer'}); }
  catch(error) {
    if(['EACCES','EPERM'].includes(error.code)) {
      try { fs.accessSync(real,fs.constants.X_OK); } catch(accessError) { if(['EACCES','EPERM','ENOENT','ENOTDIR'].includes(accessError.code))return; throw accessError; }
    }
    throw error;
  }
  for(const name of names){walk(Buffer.concat([real,Buffer.from('/'),name]));if(visible)return;}
}
try{if(spec.exclude_runtime&&excludedRoot)throw Error('excluded runtime root');for(const path of spec.paths){walk(Buffer.from(path));if(visible)break;}}catch{complete=false;}
let network_namespace=null;try{network_namespace=fs.readlinkSync('/proc/self/ns/net');}catch{}
const data=Buffer.from(JSON.stringify({visible,complete,network_namespace,count,limit,time_limit_ms,elapsed_ms:Date.now()-started})+'\n');let offset=0;
while(offset<data.length){const n=fs.writeSync(1,data,offset,data.length-offset);if(n<=0)throw Error('output');offset+=n;}
`;
const MOUNT_PROGRAM = String.raw`
// backbone-linux-mount-table-v1
const fs=require('node:fs'); const data=Buffer.from(JSON.stringify({mounts:fs.readFileSync('/proc/self/mountinfo','utf8'),network_namespace:fs.readlinkSync('/proc/self/ns/net')}));
let offset=0;while(offset<data.length)offset+=fs.writeSync(1,data,offset,data.length-offset);
`;
export async function refuseVisibleHostDatagrams(command: SandboxCommand, stage: string, environment: NativeEnvironment, node: string, extraDenies: readonly string[], hostNamespace?: string, cache = createLinuxInventoryCache(), hostEvidence?: { mounts: string; sockets: string }) {
  let host: string;
  try { host = hostNamespace ?? await readlink('/proc/self/ns/net'); } catch { throw Error('Host Linux network namespace could not be read; a usable proc filesystem is required.'); }
  if (typeof host !== 'string' || !/^net:\[\d+\]$/.test(host)) throw Error('Invalid Host network namespace evidence.');
  const args = ['sandbox', '-C', stage, '-P', 'backbone-native-staged', '-c', filesystemOverride(environment, extraDenies), '-c', 'permissions.backbone-native-staged.network.enabled=false', '--', node, '--openssl-config=/dev/null', '-e'];
  let mountProof;
  try { mountProof=JSON.parse(await command([...args,MOUNT_PROGRAM])); } catch { throw Error('Invalid Linux mount table evidence.'); }
  if (!mountProof || Object.keys(mountProof).sort().join(',') !== 'mounts,network_namespace' || typeof mountProof.mounts !== 'string' || !/^net:\[\d+\]$/.test(mountProof.network_namespace) || mountProof.network_namespace === host) throw Error('Native Linux network namespace isolation was not established.');
  const evidence = hostEvidence ?? {mounts: await readFile('/proc/self/mountinfo','utf8'), sockets: await readFile('/proc/net/unix','utf8')};
  const socketParents = evidence.sockets.split('\n').slice(1).flatMap(line => {
    const match=line.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/);
    return match ? [dirname(match[1]!)] : [];
  });
  const paths=inventoryPaths(mountProof.mounts,stage,socketParents);
  // A new staged bind is scanned every turn; stable native mounts are cached across turns.
  const bound = paths.filter(path=>path === stage || path.startsWith(stage+'/'));
  const stable = paths.filter(path=>!bound.includes(path));
  const normalized=mountProof.mounts.trim().split('\n').map((line: string)=>line.split(' ').slice(3).join(' ').split(stage).join(':workspace')).sort().join('\n');
  const key=createHash('sha256').update(JSON.stringify([environment,extraDenies,node,evidence.mounts,evidence.sockets,normalized,stable])).digest('hex');
  async function scan(selected: string[]) {
    let result;
    try { result=JSON.parse(await command([...args,LINUX_SOCKET_INVENTORY_PROGRAM,JSON.stringify({paths:selected,exclude_runtime:true})])); } catch { throw Error('Invalid Host socket visibility evidence.'); }
    if (!result || Object.keys(result).sort().join(',') !== 'complete,count,elapsed_ms,limit,network_namespace,time_limit_ms,visible' || typeof result.visible !== 'boolean' || typeof result.complete !== 'boolean' || ![result.count,result.elapsed_ms,result.limit,result.time_limit_ms].every(value=>Number.isSafeInteger(value)&&value>=0) || result.limit!==250000 || result.time_limit_ms!==10000) throw Error('Invalid Host socket visibility evidence.');
    if (typeof result.network_namespace !== 'string' || !/^net:\[\d+\]$/.test(result.network_namespace) || result.network_namespace === host) throw Error('Native Linux network namespace isolation was not established.');
    const budget=`${result.count}/${result.limit} entries, ${result.elapsed_ms}/${result.time_limit_ms} ms`;
    if (!result.complete || result.count>result.limit || result.elapsed_ms>result.time_limit_ms) throw Error(`Native Linux Host socket inventory was incomplete (${budget}); command networking was not qualified.`);
    if (result.visible) throw Error(`Native Linux command networking cannot be qualified while a Host datagram socket is visible or a visible Unix socket entry cannot be ruled out (${budget}). Full on a Linux desktop is expected to refuse with visible /run sockets: a datagram could reach them. Use contained.`);
  }
  if (!cache.get(key)) { await scan(stable); cache.set(key,'qualified'); }
  await scan(bound);
}
