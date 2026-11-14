import { spawn } from 'node:child_process';
import { realpathSync,readdirSync,lstatSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The CLI finishes and closes Core before the raw archive acquires the native home lock.
export async function backupHomeVolume({home,to,run,lock,admit,retention}) {
  await run(process.execPath, [resolve('packages/surfaces/cli/src/main.ts'), 'export', `${to}/export`, '--json']);
  await lock(home, async lost => {
    admit(home, to);
    await run('tar', ['-C', dirname(home), '-cf', `${to}/home.tar`, basename(home)], lost);
    await run('tar', ['-tf', `${to}/home.tar`], lost);
    if(retention!==undefined){admit(home,to);writeFileSync(`${to}/complete.json`,JSON.stringify({format:1,completedAt:Date.now()}),{flag:'wx',mode:0o600});pruneFleetArchives({home,root:dirname(to),keep:retention,current:to,admit});}
  }, 0);
}

export function pruneFleetArchives({home,root,keep,current,admit}) {
  if(!Number.isInteger(keep)||keep<1||keep>50)throw new Error('Invalid archive retention.');
  const completed=[];
  for(const name of readdirSync(root)){
    if(!/^revision-[0-9]+$/.test(name))continue;
    const path=resolve(root,name);if(!lstatSync(path).isDirectory())continue;
    try{const marker=resolve(path,'complete.json');if(!lstatSync(marker).isFile()||lstatSync(marker).isSymbolicLink())continue;const entry=JSON.parse(readFileSync(marker,'utf8'));if(entry.format===1&&Number.isFinite(entry.completedAt))completed.push({path,at:entry.completedAt});}catch{}
  }
  completed.sort((a,b)=>b.at-a.at);
  const retained=new Set([current,...completed.filter(v=>v.path!==current).slice(0,keep-1).map(v=>v.path)]);
  for(const entry of completed)if(!retained.has(entry.path)){admit(home,root);rmSync(entry.path,{recursive:true});}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077); // The cold archive includes the home's plaintext keys.
  const require = createRequire(resolve('packages/surfaces/cli/package.json'));
  const {withHomeLock,assertHomeWriteAdmission} = await import(require.resolve('@backbone-next/platform/composition/home-lock'));
  const run = (program,args,signal) => new Promise((resolve,reject) => {
    const child=spawn(program,args,{stdio:['ignore','ignore','inherit'],...(signal?{signal}:{})});
    // An abort/error still waits for the child to drain before releasing the home lock.
    let error;child.on('error',value=>{error=value;});
    child.on('close',code=>error?reject(error):code===0?resolve():reject(new Error(`Backup command failed (${code}).`)));
  });
  await backupHomeVolume({home:process.env.BACKBONE_HOME,to:process.argv[2],run,lock:withHomeLock,admit:assertHomeWriteAdmission,retention:Number(process.env.BACKBONE_BACKUP_RETENTION??3)});
}
