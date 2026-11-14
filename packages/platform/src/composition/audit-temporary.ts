// Private snapshot lifetime. The allocating PID is recorded atomically in the folder name; a
// supervisor writes the fuller record and owns the server. Sweep never removes a live owner's copy.
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {auditScratchParent} from '../audit-scratch.ts';
import { AuditInvalid } from '../audit.ts';
export function auditTemporaryRoot(root = auditScratchParent()):string{
  try{mkdirSync(root,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const st=lstatSync(root);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o777)!==0o700)throw new AuditInvalid('The audit scratch root must be a real directory owned by this user with mode 0700; links are refused.');
  const canonical=realpathSync(root),socket=join(canonical,`backbone-audit-v1-${process.pid}-XXXXXX`,'socket','.s.PGSQL.5432');
  if(Buffer.byteLength(socket)>100)throw new AuditInvalid('The audit scratch root exceeds the 100-byte Unix socket path limit; choose a shorter --scratch-root.');
  return canonical;
}
export function auditProcessAlive(pid: number, kill: typeof process.kill = process.kill): boolean {
  try { kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
const PREFIX = /^backbone-audit-v1-([1-9][0-9]*)-/;
function ownedServer(pid:number,folder:string):boolean{
  try{
    if(Number(readFileSync(join(folder,'data','postmaster.pid'),'utf8').split('\n')[0])!==pid)return false;
    const command=execFileSync('ps',['-p',String(pid),'-o','uid=,args='],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
    return Number(command.split(/\s+/)[0])===process.getuid?.()&&command.includes(`-D ${join(folder,'data')}`);
  }catch{return false;}
}
export async function sweepAuditTemporary(root = auditTemporaryRoot()): Promise<void> {
  root=auditTemporaryRoot(root);
  for (const name of readdirSync(root)) {
    const match = PREFIX.exec(name); if (!match) continue;
    const folder = join(root, name);let st;try{st=lstatSync(folder);}catch{continue;}
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || auditProcessAlive(Number(match[1]))) continue;
    const record = join(folder, 'owner.json');
    if (existsSync(record)) {
      const r = lstatSync(record); if (!r.isFile() || r.isSymbolicLink() || r.uid !== st.uid) continue;
      let owner: { format?: string; owner?: number; server?: number };
      try { owner = JSON.parse(readFileSync(record, 'utf8')); } catch { continue; }
      if (owner.format !== 'backbone.audit.temp.v1' || owner.owner !== Number(match[1])) continue;
      if(owner.server&&auditProcessAlive(owner.server)){
        // Stop only a server proven to use this dead owner's private copy. A reused PID stays alone.
        if(!ownedServer(owner.server,folder))continue;
        try{process.kill(owner.server,'SIGINT');}catch{}
        for(let i=0;i<100&&auditProcessAlive(owner.server);i++)await new Promise(r=>setTimeout(r,20));
        if(auditProcessAlive(owner.server)){
          if(!ownedServer(owner.server,folder))continue;
          try{process.kill(owner.server,'SIGKILL');}catch{}
          for(let i=0;i<100&&auditProcessAlive(owner.server);i++)await new Promise(r=>setTimeout(r,20));
        }
        if(auditProcessAlive(owner.server))continue;
      }
    }
    if(auditProcessAlive(Number(match[1])))continue;
    try{const current=lstatSync(folder);if(current.dev===st.dev&&current.ino===st.ino)rmSync(folder,{recursive:true,force:true});}catch{}
  }
}
function answer(child: ChildProcess, type: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { child.off('message', message); child.off('exit', ended); signal?.removeEventListener('abort', aborted); };
    const message = (m: unknown) => { const kind = (m as {type?: string})?.type; if (kind === type) { cleanup(); resolve(); } else if (kind === 'failed') { cleanup(); reject(new AuditInvalid('The temporary audit database could not start.')); } };
    const ended = () => { cleanup(); reject(new AuditInvalid('The audit snapshot supervisor ended.')); };
    const aborted = () => { cleanup(); reject(signal!.reason); };
    child.on('message', message); child.once('exit', ended); signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}
export function allocateAuditTemporary(root: string, signal: AbortSignal, failed: (error:Error)=>void) {
  const folder = mkdtempSync(join(root, `backbone-audit-v1-${process.pid}-`));
  // No await or copy between allocation and starting the guard. Signals are already handled.
  let guard: ChildProcess;
  try { guard = fork(fileURLToPath(new URL('./audit-temp-guard.mjs', import.meta.url)), [folder, String(process.pid)], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [], env:{PATH:process.env.PATH??'',LANG:'C',LC_ALL:'C'} }); }
  catch (error) { rmSync(folder, {recursive:true,force:true}); throw error; }
  let closing=false,server=0;
  guard.on('message',message=>{const m=message as {type?:string;pid?:number};if(m.type==='started'&&Number.isSafeInteger(m.pid))server=m.pid!;});
  guard.once('exit',()=>{if(!closing)failed(new AuditInvalid('The audit snapshot supervisor ended; stopping its server and removing the copy.'));});
  const ready = answer(guard, 'ready', signal);
  return { folder, ready,
    async start(command: string, args: string[]) { const started = answer(guard, 'started', signal); guard.send({ type: 'start', command, args }); await started; },
    async close() {
      closing=true;
      if (guard.exitCode === null && guard.signalCode === null) {
        const done = new Promise<void>(resolve => guard.once('exit', () => resolve()));
        if (guard.connected) guard.send({ type: 'close' });
        await done;
      }
      // The supervisor may die alone. Stop the server it told this owner about before removal.
      if(server&&auditProcessAlive(server)&&ownedServer(server,folder)){
        try{process.kill(server,'SIGINT');}catch{}
        for(let i=0;i<150&&auditProcessAlive(server);i++)await new Promise(r=>setTimeout(r,20));
        if(auditProcessAlive(server)&&ownedServer(server,folder)){
          try{process.kill(server,'SIGKILL');}catch{}
          for(let i=0;i<100&&auditProcessAlive(server);i++)await new Promise(r=>setTimeout(r,20));
        }
        if(auditProcessAlive(server))throw new AuditInvalid('The temporary audit server has not stopped; its folder is preserved for the next startup sweep.');
      }
      // Also covers a supervisor that failed before its first record/start.
      if (existsSync(folder)) rmSync(folder, { recursive: true, force: true });
    },
  };
}
