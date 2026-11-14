// Operational guardrails. All effects accept owned paths or injected command runners.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fstatSync, globSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, writeFileSync, constants } from 'node:fs';
import { homedir, loadavg } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { takeLock, releaseLock, systemVSegments } from '../heavy-slots.mjs';

const protocol = 'backbone-merge-queue-lease-v1';
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const priorityFile = lock => lock.endsWith('.heavy.lock') ? join(dirname(lock), '.heavy.next') : `${lock}.next`;
const lockPath = options => resolve(options.lock || process.env.BACKBONE_HEAVY_LOCK || join(homedir(), 'backbone-next-worktrees/.heavy.lock'));
const hash = value => createHash('sha256').update(value).digest('hex');
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return true; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const atomicJson = (file,value) => { const temp=`${file}.${randomUUID()}`; writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temp,file); };
const freeSpace = root => { const stat=statfsSync(root);return stat.bavail*stat.bsize; };
const runningGates = () => {
  const result=spawnSync('ps',['-axo','pid=,command='],{encoding:'utf8'});
  if(result.status!==0)throw new Error('Cannot inspect running gate processes');
  return result.stdout.split('\n').filter(line=>/^\s*\d+\s+(?:\S*node\S*\s+(?:\S+\s+)*\S*scripts\/gate\.mjs\b|\S*pnpm\S*\s+gate\b)/.test(line)).map(line=>({pid:Number(line.trim().split(/\s+/)[0]),command:line.trim()}));
};

/** Samples disk and load before any attribution or admission decision. Never evicts a foreign owner. */
export async function preflight(root, options={}) {
  const lock=lockPath(options), maxLoad=options.maxLoad??2;
  const snapshot={at:new Date().toISOString(),root:resolve(root),freeBytes:(options.freeBytes||freeSpace)(root),load:(options.load||loadavg)(),lock,maxLoad};
  const refuse=message=>{const error=new Error(message);error.environment=snapshot;throw error;};
  if(!Number.isFinite(snapshot.freeBytes)||snapshot.freeBytes<20*1024**3)refuse('Merge queue requires at least 20 GiB free');
  const load=Array.isArray(snapshot.load)?snapshot.load[0]:snapshot.load;
  if(!Number.isFinite(maxLoad)||maxLoad<0||!Number.isFinite(load)||load>maxLoad)refuse(`Merge queue idle-load admission refused (${load}; limit ${maxLoad})`);
  // A queue parent can die while its detached gate child is still running.
  // Inspect children before reclaiming even a proven own/dead parent's controls.
  snapshot.gates=(options.gates||runningGates)();
  if(!Array.isArray(snapshot.gates)||snapshot.gates.length)refuse('A running gate already uses a worktree; refuse overlapping qualification');
  const receipt=typeof options.ownedReceipt==='string'?readJson(options.ownedReceipt):options.ownedReceipt;
  const pidAlive=options.pidAlive||alive;
  if(receipt?.protocol===protocol&&receipt.lock===lock&&!pidAlive(receipt.pid)) {
    for(const token of [receipt.token,receipt.unitToken].filter(Boolean)) {
      const own=[lock,`${lock}.b`].map(target=>readJson(join(target,'owner'))).find(owner=>owner?.token===token&&owner.pid===receipt.pid&&owner.protocol===protocol);
      if(own)await releaseLock(lock,token);
    }
    const marker=readJson(priorityFile(lock));
    if(marker?.token===receipt.token&&marker.pid===receipt.pid&&marker.protocol===protocol)rmSync(priorityFile(lock));
  }
  const marker=readJson(priorityFile(lock));
  if(existsSync(priorityFile(lock)))refuse(`Heavy priority marker is held; preserve ${priorityFile(lock)} (${marker?.pid??'unknown PID'})`);
  if(existsSync(lock))refuse(`Heavy lock is held; preserve ${lock}`);
  const unit=readJson(join(`${lock}.b`,'owner'));
  if(existsSync(`${lock}.b`)&&!(unit?.disabled===true&&unit.protocol==='backbone-slot-b-disabled-v1'))refuse(`Heavy unit slot is held; preserve ${lock}.b`);
  return snapshot;
}

/** Reserve B as well as A: the old B protocol deliberately ignores A's marker. */
export async function withQueueHeavyLease(callback,options={}) {
  const root=resolve(options.root||process.cwd()),lock=lockPath(options);
  const receipt=resolve(options.receipt||join(root,'.gate','merge-queue-lease.json'));
  await preflight(root,{...options,ownedReceipt:options.ownedReceipt||receipt});
  mkdirSync(dirname(receipt),{recursive:true});
  if(existsSync(receipt)) {
    const prior=readJson(receipt);
    if(prior?.protocol!==protocol||(!prior.end&&(options.pidAlive||alive)(prior.pid)))throw new Error(`Queue lease receipt needs reconciliation: ${receipt}`);
    renameSync(receipt,`${receipt}.previous-${randomUUID()}`);
  }
  const token=randomUUID(),owner={protocol,pid:process.pid,token,unitToken:`${token}-unit`,lock,cwd:root,start:new Date().toISOString()};
  atomicJson(receipt,owner);
  let heldA=false,heldB=false;
  const assertValid=()=>{
    const actual=readJson(join(lock,'owner')),other=readJson(join(`${lock}.b`,'owner')),marker=readJson(priorityFile(lock));
    if(actual?.token!==token||actual.pid!==process.pid||other?.token!==owner.unitToken||other.pid!==process.pid||marker?.token!==token)throw new Error('Queue heavy lease changed; stop qualification');
  };
  try {
    // A disabled B is already reserved. Its foreign disabled owner is left intact.
    const disabled=readJson(join(`${lock}.b`,'owner'));
    if(!(disabled?.disabled&&disabled.protocol==='backbone-slot-b-disabled-v1')) {
      await takeLock(lock,{...owner,token:owner.unitToken,role:'unit'},0,()=>false,{segments:options.segments||systemVSegments});heldB=true;
    }
    await takeLock(lock,{...owner,role:'gate'},0);heldA=true;
    const validate=()=>{
      const actual=readJson(join(lock,'owner')),marker=readJson(priorityFile(lock));
      if(actual?.token!==token||actual.pid!==process.pid||marker?.token!==token)throw new Error('Queue heavy lease changed; stop qualification');
      if(heldB)assertValid();
      else {const current=readJson(join(`${lock}.b`,'owner'));if(current?.token!==disabled.token||!current.disabled)throw new Error('Disabled unit-slot reservation changed; stop qualification');}
    };
    validate();
    const env={...process.env,...options.env,BACKBONE_HEAVY_LOCK:lock,BACKBONE_HEAVY_ROLE:'gate',BACKBONE_HEAVY_LEASE:JSON.stringify({lock,token,slot:'A',role:'gate'})};
    return await callback({env,owner,assertValid:validate});
  } finally {
    if(heldA)await releaseLock(lock,token);
    if(heldB)await releaseLock(lock,owner.unitToken);
    atomicJson(receipt,{...owner,end:new Date().toISOString()});
  }
}

export function archiveEvidence(out) {
  if(!existsSync(out))return null;
  const stat=lstatSync(out);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Evidence rotation requires an owned directory');
  const container=mkdtempSync(`${resolve(out)}.previous-`),destination=join(container,'evidence');
  renameSync(out,destination);return destination;
}

export function assertRecordTarget(root) {
  const file=join(resolve(root),'docs/execution.md');
  if(!existsSync(file))throw new Error('docs/execution.md is missing; the queue never creates the one-repo integration record');
  const stat=lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||!realpathSync(file).startsWith(realpathSync(root)+sep))throw new Error('Unsafe docs/execution.md record target');
  const text=readFileSync(file,'utf8'),headings=[...text.matchAll(/^## Integration record[ \t]*\r?$/gm)];
  if(headings.length!==1)throw new Error('docs/execution.md needs exactly one Integration record section; leave prose to its owner');
  const start=headings[0].index+headings[0][0].length,next=/^## /m.exec(text.slice(start));
  return{file,text,insertAt:next?start+next.index:text.length,stat};
}

export function appendIntegrationRecord(root,line) {
  const target=assertRecordTarget(root),value=line.replace(/\r?\n$/,'');
  if(!value||/[\r\n]/.test(value))throw new Error('Integration record must be one line');
  const newline=target.text.includes('\r\n')?'\r\n':'\n',before=target.text.slice(0,target.insertAt);
  const stat=lstatSync(target.file);
  if(stat.dev!==target.stat.dev||stat.ino!==target.stat.ino||readFileSync(target.file,'utf8')!==target.text)throw new Error('Integration record changed before append');
  writeFileSync(target.file,before+(before.endsWith('\n')?'':newline)+value+newline+target.text.slice(target.insertAt));
  return target.file;
}

export function driverSnapshot(root,files) {
  root=realpathSync(root);
  const paths=files||['scripts/merge-queue.mjs',...(existsSync(join(root,'scripts/merge-queue-isolated.mjs'))?['scripts/merge-queue-isolated.mjs']:[]),...globSync('scripts/lib/merge-queue*.mjs',{cwd:root})];
  const entries=[...new Set(paths)].sort().map(file=>{
    if(isAbsolute(file)||!realpathSync(join(root,file)).startsWith(root+sep))throw new Error('Driver snapshot path escapes its worktree');
    return{file,hash:hash(readFileSync(join(root,file)))};
  });
  return{root,files:entries,hash:hash(JSON.stringify(entries))};
}
export function assertDriverUnchanged(snapshot) {
  try {if(snapshot.files.some(entry=>hash(readFileSync(join(snapshot.root,entry.file)))!==entry.hash))throw new Error('changed');}
  catch {throw new Error('Merge queue driver changed while running; qualification discarded');}
}

export function expectedOracleOnly(output,exitCode) {
  const summaries=[...output.matchAll(/oracle \(successor\):\s*(\d+) passed,\s*(\d+) failed,\s*(\d+) not implemented/g)];
  const pending=[...output.matchAll(/^\s*(\S+): not implemented\s*$/gm)].map(match=>match[1]).sort();
  return exitCode===1&&summaries.length===1&&+summaries[0][1]>0&&+summaries[0][2]===0&&+summaries[0][3]===2&&pending.join(',')==='lifecycle,scenes'&&!/^\s*\S+: fail(?:\s|$)/m.test(output);
}

export function validatePostGate(options={}) {
  for(const name of ['nativeCollector','restoredNative'])if(!Array.isArray(options[name])||!options[name].length||options[name].some(arg=>typeof arg!=='string'||!arg||/[\0\r\n]/.test(arg)))throw new Error(`Missing reviewed ${name} argv; configure native proof before building or gating`);
  if(options.colimaProfile&&(!/^[a-z0-9][a-z0-9-]{0,55}$/.test(options.colimaProfile)||options.colimaProfile==='default'))throw new Error('Colima profile must be a queue-owned non-default name');
}

/** Every command is injected, and receives the verified heavy environment as its fourth argument. */
export async function runPostGate(root,command,options={}) {
  validatePostGate(options);
  const profile=options.colimaProfile||`merge-queue-${randomUUID().slice(0,12)}`;
  // Admission, VM lifecycle and Docker must resolve to the same owned home.
  const colimaRoot=resolve(root,options.colimaRoot||options.env?.COLIMA_HOME||process.env.COLIMA_HOME||join(homedir(),'.colima')),profileDir=join(colimaRoot,profile);
  if(existsSync(profileDir))throw new Error('Queue Colima profile already exists; never stop or delete another run\'s VM');
  const phases=[],env={...process.env,...options.env},colimaEnv={...env,COLIMA_HOME:colimaRoot},dockerEnv={...colimaEnv,DOCKER_HOST:`unix://${join(profileDir,'docker.sock')}`};
  // A pre-existing context would override DOCKER_HOST and target another VM.
  delete dockerEnv.DOCKER_CONTEXT;
  delete dockerEnv.DOCKER_TLS_VERIFY;
  delete dockerEnv.DOCKER_CERT_PATH;
  let ownedColima=false,error;
  const run=async(phase,argv,commandEnv=env)=>{
    const entry={phase,command:argv,started:new Date().toISOString()},start=Date.now();phases.push(entry);options.onPhase?.(entry);
    try {
      const result=await command(root,argv[0],argv.slice(1),{env:commandEnv,phase});entry.exitCode=result.code;entry.output=result.output;
      if(result.code!==0)throw new Error(`${phase} failed (${result.code})`);
    } catch(caught){entry.error=caught.message;throw caught;}
    finally{entry.durationSeconds=(Date.now()-start)/1000;entry.ended=new Date().toISOString();options.onPhase?.(entry);}
  };
  try {
    await run('native collector',options.nativeCollector);
    await run('restored native',options.restoredNative);
    ownedColima=true;
    let dockerError;
    try {
      await run('Colima start',['colima','start','--profile',profile,'--activate=false'],colimaEnv);
      await run('Docker smoke',['bash','scripts/docker-smoke.sh'],dockerEnv);
    } catch(caught) { dockerError=caught;
    } finally {
      if(ownedColima){
        for(const [phase,argv] of [['Colima stop',['colima','stop','--profile',profile]],['Colima delete',['colima','delete','--force','--profile',profile]]]) {
          try{await run(phase,argv,colimaEnv);}catch(caught){if(dockerError)(dockerError.cleanupErrors??=[]).push(caught.message);else dockerError=caught;}
        }
      }
    }
    if(dockerError)throw dockerError;
    await run('CLI install',['pnpm','test:install']);
  } catch(caught){error=caught;}
  finally {
    try{await run('restore oracle results',['git','checkout','--','oracle/results']);}
    catch(caught){if(!error)error=caught;else(error.cleanupErrors??=[]).push(caught.message);}
  }
  if(error){error.phases=phases;throw error;}
  return phases;
}

const git=(root,args,options={})=>{
  const result=spawnSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:64*1024**2,...options});
  if(result.status!==0)throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
};
const ownLock=(file)=>{const fd=openSync(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW||0),0o600);return{file,fd,stat:fstatSync(fd),closed:false};};
const closeOwned=lock=>{if(!lock.closed){closeSync(lock.fd);lock.closed=true;}};
const removeOwned=lock=>{closeOwned(lock);if(existsSync(lock.file)){const stat=lstatSync(lock.file);if(stat.dev===lock.stat.dev&&stat.ino===lock.stat.ino)rmSync(lock.file);}};

/** Protect both checkout locks while replacing the index/tree and CAS-updating the named ref. */
export function fastForwardIntegration({repository,integrationWorktree,base,head,stackBranch,onLocked=()=>{}}) {
  if(!integrationWorktree)throw new Error('An explicit integrationWorktree is required for local synchronization');
  const root=realpathSync(integrationWorktree),integration='refs/heads/claude/integration';
  if(!repository||realpathSync(repository)===root)throw new Error('Integration synchronization needs a distinct driver repository worktree');
  const common=at=>realpathSync(resolve(at,git(at,['rev-parse','--git-common-dir'])));
  if(common(repository)!==common(root))throw new Error('Integration worktree belongs to another repository');
  if(typeof stackBranch!=='string'||stackBranch==='claude/integration'||spawnSync('git',['check-ref-format','--branch',stackBranch],{stdio:'ignore'}).status!==0)throw new Error('A distinct valid stack branch is required');
  const gitDir=git(root,['rev-parse','--absolute-git-dir']),index=join(gitDir,'index'),temporary=join(gitDir,`merge-queue-index-${randomUUID()}`);
  const locks=[];let changedTree=false,committed=false;
  try {
    locks.push(ownLock(join(gitDir,'index.lock')));locks.push(ownLock(join(gitDir,'HEAD.lock')));
    if(readFileSync(join(gitDir,'HEAD'),'utf8').trim()!==`ref: ${integration}`)throw new Error('Integration worktree is on another branch; never repair an arbitrary checkout');
    if(git(root,['rev-parse','HEAD'])!==base)throw new Error('Integration worktree base changed');
    if(git(root,['status','--porcelain','--untracked-files=normal']))throw new Error('Integration worktree is dirty; preserve human edits');
    git(root,['merge-base','--is-ancestor',base,head]);
    // Git checkout/read-tree deliberately overwrites ignored untracked files.
    // An integration sync instead preserves them, including ignored parent links.
    const additions=git(root,['diff','--no-renames','--name-only','--diff-filter=A','-z',base,head]).split('\0').filter(Boolean);
    for(const file of additions) {
      let path=root;
      const parts=file.split('/');
      for(let i=0;i<parts.length;i++) {
        path=join(path,parts[i]);let stat;
        try{stat=lstatSync(path);}catch(caught){if(caught.code==='ENOENT')break;throw caught;}
        if(stat.isSymbolicLink()||i===parts.length-1||!stat.isDirectory())throw new Error(`Untracked human path would be overwritten: ${file}`);
      }
    }
    const blocks=git(root,['worktree','list','--porcelain']).split('\n\n');
    if(blocks.filter(block=>block.includes(`branch ${integration}`)).length!==1||blocks.some(block=>block.includes(`branch refs/heads/${stackBranch}\n`)||block.endsWith(`branch refs/heads/${stackBranch}`)))throw new Error('Integration or stack branch has another checkout owner');
    let oldStack;
    try{oldStack=git(root,['rev-parse','--verify',`refs/heads/${stackBranch}`]);git(root,['merge-base','--is-ancestor',oldStack,head]);}catch(caught){if(oldStack)throw caught;}
    copyFileSync(index,temporary);onLocked();
    const env={...process.env,GIT_INDEX_FILE:temporary};
    git(root,['read-tree','-m','-u',base,head],{env});changedTree=true;
    // Update from the distinct driver checkout. Updating from this integration
    // checkout would implicitly acquire HEAD.lock, which this operation owns.
    git(repository,['update-ref','--stdin'],{input:`start\nupdate ${integration} ${head} ${base}\nupdate refs/heads/${stackBranch} ${head} ${oldStack||'0'.repeat(head.length)}\nprepare\ncommit\n`});committed=true;
    writeFileSync(locks[0].fd,readFileSync(temporary));closeOwned(locks[0]);renameSync(locks[0].file,index);
    return{head,branch:'claude/integration',stackBranch,worktree:root};
  } catch(error) {
    if(changedTree&&!committed)try{git(root,['read-tree','-m','-u',head,base],{env:{...process.env,GIT_INDEX_FILE:temporary}});}catch(rollback){error.rollbackError=rollback.message;}
    throw error;
  } finally {
    for(const lock of locks.reverse())removeOwned(lock);
    rmSync(temporary,{force:true});
  }
}
