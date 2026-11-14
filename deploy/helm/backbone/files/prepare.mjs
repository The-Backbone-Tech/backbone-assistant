import { mkdirSync, readFileSync, writeFileSync, chmodSync, chownSync, lstatSync, openSync, fchownSync, closeSync, constants, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ConfigMap keys are symlinks. Copy their bytes into a separate protected directory.
export function prepareFleetHome({data,source,target,admit,backup=join(data,'backups'),ownership={chownSync,fchownSync}}) {
  for (const dir of [join(data,'home'),backup].filter(Boolean)) {
    let stat,made=false;
    try { stat=lstatSync(dir); }
    catch(error) {
      if(error.code!=='ENOENT')throw error;
      admit(dir);mkdirSync(dir,{mode:0o700});made=true;stat=lstatSync(dir);
    }
    if(!stat.isDirectory())throw new Error('Fleet storage must contain real directories.');
    if(made) {
      const fd=openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try {admit(dir);ownership.fchownSync(fd,1000,1000);} finally {closeSync(fd);}
    }
  }
  // Existing homes are inspected only; root must not repair their ownership or lock files.
  chmodSync(target,0o755);ownership.chownSync(target,0,0);
  for(const file of ['managed-policy.json','managed-policy.json.sig','policy-trust.json']) {
    const bytes=readFileSync(join(source,file));if(!bytes.length)continue;
    const path=join(target,file);
    writeFileSync(path,bytes,{flag:'wx',mode:0o644});
    ownership.chownSync(path,0,0);chmodSync(path,0o644);
  }
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  const require=createRequire(resolve('packages/surfaces/cli/package.json'));
  const {assertHomeWriteAdmission}=await import(require.resolve('@backbone-next/platform/composition/home-lock'));
  prepareFleetHome({data:'/data',source:'/policy-source',target:'/etc/backbone',backup:process.env.BACKBONE_BACKUP_ROOT??null,admit:assertHomeWriteAdmission});
}
