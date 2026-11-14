import { childHangTimer } from '../../../scripts/lib/test-child.ts';
import assert from 'node:assert/strict';
import {createHmac,hkdfSync} from 'node:crypto';
import {fork,execFileSync} from 'node:child_process';
import {existsSync,lstatSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after,before,test} from 'node:test';
import {CoreLink} from '../src/composition/core.ts';
import {auditProcessAlive,sweepAuditTemporary} from '../src/composition/audit-temporary.ts';
import {freshHome} from './helpers.ts';
let home:string,root:string,key:Buffer,encoded:Buffer,secrets:Buffer[];
before(async()=>{
  root=mkdtempSync('/tmp/ba-');home=freshHome();rmSync(join(home,'pg','external.json'),{force:true});
  const link=await CoreLink.open({home});await link.createTask('Cleanup controls');
  const master=await link.vault.masterKey(),derived=Buffer.from(hkdfSync('sha256',master,Buffer.from(link.id.workspace),Buffer.from('backbone.audit.v1/digest-key'),32));
  secrets=[master,derived].flatMap(bytes=>[bytes,Buffer.from(bytes.toString('hex')),Buffer.from(bytes.toString('base64'))]);await link.close();
  const vault=JSON.parse(readFileSync(join(home,'keys','vault.json'),'utf8'));key=Buffer.from(vault.key,'base64');encoded=Buffer.from(vault.key);
});
after(()=>rmSync(root,{recursive:true,force:true}));
function inspect(folder:string){
  const visit=(dir:string)=>{for(const name of readdirSync(dir)){
    assert.notEqual(name,'vault.json');const path=join(dir,name),st=lstatSync(path);
    if(st.isDirectory())visit(path);else if(st.isFile()){
      const bytes=readFileSync(path);assert.equal(bytes.includes(key),false,'home data key never copied');assert.equal(bytes.includes(encoded),false,'encoded home key never copied');for(const secret of secrets)assert.equal(bytes.includes(secret),false,'master and derived audit keys never enter the copy');
    }
  }};visit(folder);
}
for(const point of ['allocated','copying','server-ready'])for(const signal of ['SIGINT','SIGTERM','SIGHUP'] as const){
  test(`${signal} at ${point}: no vault or home data key, no surviving snapshot or server`,{timeout: 600_000},async()=>{
    const child=fork(join(import.meta.dirname,'fixtures/audit-copy-process.mjs'),[home,root,point],{stdio:['ignore','ignore','pipe','ipc'],execArgv:[]});
    let err='';child.stderr!.on('data',chunk=>err+=chunk);
    const done=new Promise<number|null>(resolve=>child.once('exit',code=>resolve(code)));
    const timer=childHangTimer(child, 'audit-cleanup.test: child completion/shutdown');
    let folder:string|undefined,server=0;
    try{
      const reached=await new Promise<{folder:string}>((resolve,reject)=>{child.once('message',m=>resolve(m as {folder:string}));child.once('exit',()=>reject(new Error(err||'export ended before observation')));});
      folder=reached.folder;inspect(folder);
      const record=JSON.parse(readFileSync(join(folder,'owner.json'),'utf8')),pids=[child.pid,record.supervisor,record.server].filter(Boolean);
      const processes=execFileSync('ps',['eww','-p',pids.join(','),'-o','command=']);for(const secret of secrets)assert.equal(processes.includes(secret),false,'keys never enter owner, supervisor or server arguments/environment');
      const pidfile=join(folder,'data','postmaster.pid');if(existsSync(pidfile))server=Number(readFileSync(pidfile,'utf8').split('\n')[0]);
      child.kill(signal);assert.notEqual(await done,0);assert.match(err,new RegExp(signal));for(const secret of secrets)assert.equal(Buffer.from(err).includes(secret),false,'keys never enter diagnostics');
      assert.equal(existsSync(folder),false);if(server)assert.equal(auditProcessAlive(server),false);
      assert.deepEqual(readdirSync(root),[]);
    }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await done;}}
  });
}
test('startup sweep removes a recorded dead owner and preserves a live owner; EPERM is alive',async()=>{
  const dead=2147483647;assert.equal(auditProcessAlive(dead),false);
  const stale=mkdtempSync(join(root,`backbone-audit-v1-${dead}-`)),live=mkdtempSync(join(root,`backbone-audit-v1-${process.pid}-`));
  for(const [folder,owner]of [[stale,dead],[live,process.pid]] as const)writeFileSync(join(folder,'owner.json'),JSON.stringify({format:'backbone.audit.temp.v1',owner,uid:process.getuid?.(),server:null}),{mode:0o600});
  await sweepAuditTemporary(root);assert.equal(existsSync(stale),false);assert.equal(existsSync(live),true);
  assert.equal(auditProcessAlive(1,(()=>{const e:NodeJS.ErrnoException=new Error('permission');e.code='EPERM';throw e;}) as typeof process.kill),true);
  rmSync(live,{recursive:true});
});
