import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { backupHomeVolume, pruneFleetArchives } from '../deploy/helm/backbone/files/backup.mjs';

test('cold archive holds the home lock while reading bytes, with no Core open under that lock', async t => {
  const dir=mkdtempSync(join(tmpdir(),'fleet-backup-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let locked=false,archives=0,exports=0;
  await backupHomeVolume({home:join(dir,'home'),to:join(dir,'backup'),
    lock:async (_home,fn)=>{locked=true;try {return await fn(new AbortController().signal);}finally{locked=false;}},
    admit:()=>assert.equal(locked,true),
    run:async (program,_args,signal)=>{
      if(program===process.execPath){assert.equal(locked,false,'never wait on Core under the home lock');exports++;}
      else{assert.equal(locked,true,'raw home bytes need exclusive ownership');assert.equal(signal.aborted,false);archives++;}
    },
  });
  assert.equal(exports,1);assert.ok(archives>=2);assert.equal(locked,false);
});

test('a competing owner refuses the cold archive and does not retry any command', async t => {
  const dir=mkdtempSync(join(tmpdir(),'fleet-backup-refused-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let calls=0;
  await assert.rejects(backupHomeVolume({home:join(dir,'home'),to:join(dir,'backup'),
    lock:async()=>{throw new Error('held by another owner');},admit:()=>{},
    run:async program=>{assert.equal(program,process.execPath);calls++;},
  }));
  assert.equal(calls,1);
});

test('a projected ConfigMap symlink executes the backup entry point and produces the archive', async t => {
  const fs=await import('node:fs');const {spawnSync}=await import('node:child_process');
  const dir=mkdtempSync(join(tmpdir(),'fleet-backup-entry-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const home=join(dir,'data/home'),to=join(dir,'data/backups/revision-2');
  fs.mkdirSync(home,{recursive:true});fs.writeFileSync(join(home,'human.txt'),'preserve this edit');
  const cli=join(dir,'packages/surfaces/cli');fs.mkdirSync(join(cli,'src'),{recursive:true});
  fs.writeFileSync(join(cli,'package.json'),'{}');
  fs.writeFileSync(join(cli,'src/main.ts'),`import fs from 'node:fs';fs.mkdirSync(process.argv[3],{recursive:true});fs.writeFileSync(process.argv[3]+'/proof','exported');`);
  const platform=join(cli,'node_modules/@backbone-next/platform');fs.mkdirSync(platform,{recursive:true});
  fs.writeFileSync(join(platform,'package.json'),JSON.stringify({type:'module',exports:{'./composition/home-lock':'./lock.mjs'}}));
  fs.writeFileSync(join(platform,'lock.mjs'),`export const withHomeLock=async(_home,fn)=>fn(new AbortController().signal);export const assertHomeWriteAdmission=()=>{};`);
  const entry=join(dir,'backup.mjs');fs.symlinkSync(new URL('../deploy/helm/backbone/files/backup.mjs',import.meta.url),entry);
  const result=spawnSync(process.execPath,[entry,to],{cwd:dir,env:{...process.env,BACKBONE_HOME:home},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(fs.readFileSync(join(to,'export/proof'),'utf8'),'exported');
  const archive=fs.statSync(join(to,'home.tar'));assert.ok(archive.size>0);
  assert.equal(archive.mode&0o077,0,'a full-home archive must be private even under a permissive parent umask');
});


test('retention removes only completed older archives after admission and preserves unknown outcomes', t => {
  const root=mkdtempSync(join(tmpdir(),'fleet-retention-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(let i=1;i<=4;i++){
    const dir=join(root,`revision-${i}`);mkdirSync(dir);
    if(i<4)writeFileSync(join(dir,'complete.json'),JSON.stringify({format:1,completedAt:i}));
  }
  symlinkSync(join(root,'revision-1'),join(root,'revision-5'));
  let admissions=0;
  const input={home:join(root,'home'),root,keep:2,current:join(root,'revision-3')};
  assert.throws(()=>pruneFleetArchives({...input,admit:()=>{throw new Error('refused');}}));
  assert.equal(existsSync(join(root,'revision-1')),true);
  pruneFleetArchives({...input,admit:()=>admissions++});
  assert.equal(admissions,1);
  assert.equal(existsSync(join(root,'revision-1')),false);
  for(const i of [2,3,4])assert.equal(existsSync(join(root,`revision-${i}`)),true);
});
