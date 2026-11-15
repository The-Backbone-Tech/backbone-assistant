import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHmac,hkdfSync,randomBytes} from 'node:crypto';
import {lstatSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {auditJoin,readAudit} from '../src/audit.ts';
import {exportAuditHome} from '../src/composition/audit-home.ts';
import {CoreLink} from '../src/composition/core.ts';
import {serveApiLine} from '../src/composition/api-line.ts';
import {auditReceipt} from '../src/composition/audit-export.ts';
import {attachApi} from '../src/doors/api-line.ts';
import {Vault} from '../src/keys/vault.ts';
import {collectAuditHome} from './fixtures/audit-collect.ts';
import {freshHome,value} from './helpers.ts';
import {AUDIT_PERIOD} from './fixtures/audit-activity.ts';
const secretsAbsent=(file:string|Buffer,secrets:Buffer[])=>{const output=typeof file==='string'?Buffer.from(file):file;for(const secret of secrets)for(const bytes of [secret,Buffer.from(secret.toString('hex')),Buffer.from(secret.toString('base64'))])assert.equal(output.includes(bytes),false,'key material must not cross the export');};
test('line and direct files use the same derived audit key, other homes differ and master rotation has its own join refusal',async()=>{
  const home=freshHome(),link=await CoreLink.open({home});let closed=false;
  const master=await link.vault.masterKey(),derived=Buffer.from(hkdfSync('sha256',master,Buffer.from(link.id.workspace),Buffer.from('backbone.audit.v1/digest-key'),32));
  const server=await serveApiLine({home,call:((_method:string,args:never)=>auditReceipt(link,args)) as never});
  try{
    await link.createTask('After the first three receipts');
    const line=await attachApi(home);assert.ok(line);let first;
    try{first=value(await line.call('audit.export',{...AUDIT_PERIOD,limit:3}));}finally{line.close();}
    assert.ok(first.trailer);const before=readAudit(first.jsonl);
    assert.deepEqual(before.header.digestKey,{id:createHmac('sha256',derived).update(`backbone.audit.v1/key-id\0${link.id.workspace}`).digest('hex').slice(0,32),derivation:'hkdf-master-sha256'});
    await server.close();await link.close();closed=true;
    const direct=value(await collectAuditHome(home,{...AUDIT_PERIOD,after:first.trailer.cursor!.id}));
    assert.deepEqual(direct.header.digestKey,first.header.digestKey);readAudit(direct.jsonl,first.jsonl);
    assert.throws(()=>auditJoin({...direct,header:{...direct.header,after:{...direct.header.after!,receiptHash:'f'.repeat(64)}}},before),/do not join/,'same-key forked anchors keep the history refusal');
    secretsAbsent(first.jsonl,[master,derived]);secretsAbsent(direct.jsonl,[master,derived]);
    const otherHome=freshHome(),other=await CoreLink.open({home:otherHome});await other.close();
    const otherFile=value(await collectAuditHome(otherHome,AUDIT_PERIOD));assert.notEqual(otherFile.header.digestKey.id,first.header.digestKey.id);
    const vault=await Vault.open(home),replacement=randomBytes(32);await vault.put('credentials.master',replacement);
    const changed=value(await collectAuditHome(home,{...AUDIT_PERIOD,after:first.trailer.cursor!.id}));readAudit(changed.jsonl);
    assert.notEqual(changed.header.digestKey.id,first.header.digestKey.id);
    assert.throws(()=>readAudit(changed.jsonl,first.jsonl),/these files were digested under different keys \(the data folder's keys changed between them\); each verifies alone/);
    const opted=value(await collectAuditHome(home,{...AUDIT_PERIOD,includeContent:true}));secretsAbsent(opted.jsonl,[master,derived,replacement,Buffer.from(hkdfSync('sha256',replacement,Buffer.from(link.id.workspace),Buffer.from('backbone.audit.v1/digest-key'),32))]);
    // A different home remains an unrelated history, not a rotation claim.
    assert.throws(()=>readAudit(otherFile.jsonl,first.jsonl),/do not join/);
  }finally{await server.close();if(!closed)await link.close();}
});
test('a legacy idle home with no credential master uses the labelled read-only fallback without making one',async()=>{
  const home=freshHome(),link=await CoreLink.open({home});await link.close();
  const path=join(home,'keys','vault.json'),file=JSON.parse(readFileSync(path,'utf8'));delete file.entries['credentials.master'];writeFileSync(path,JSON.stringify(file));
  const before=readFileSync(path),made=value(await collectAuditHome(home,AUDIT_PERIOD));
  assert.equal(made.header.digestKey.derivation,'legacy-service-secret');assert.deepEqual(readFileSync(path),before);readAudit(made.jsonl);
});

test('after key derivation a real standalone export keeps master and audit bytes out of its copy, argv and environment',{timeout: TEST_HANG_MS * 2},async()=>{
  const home=freshHome(),root=mkdtempSync('/tmp/ak-');rmSync(join(home,'pg','external.json'),{force:true});
  const link=await CoreLink.open({home});const master=await link.vault.masterKey(),derived=Buffer.from(hkdfSync('sha256',master,Buffer.from(link.id.workspace),Buffer.from('backbone.audit.v1/digest-key'),32));await link.close();
  let folder='',writes=0;
  try{
    const made=value(await exportAuditHome(home,AUDIT_PERIOD,async bytes=>{
      writes++;secretsAbsent(bytes,[master,derived]);
      const visit=(dir:string)=>{for(const name of readdirSync(dir)){assert.notEqual(name,'vault.json');const path=join(dir,name),st=lstatSync(path);if(st.isDirectory())visit(path);else if(st.isFile())secretsAbsent(readFileSync(path),[master,derived]);}};visit(folder);
      const record=JSON.parse(readFileSync(join(folder,'owner.json'),'utf8'));secretsAbsent(execFileSync('ps',['eww','-p',[process.pid,record.supervisor,record.server].join(','),'-o','command=']),[master,derived]);
    },{temporaryRoot:root,atPoint:(_point,path)=>{folder=path;}}));
    assert.equal(made.header.digestKey.derivation,'hkdf-master-sha256');assert.ok(writes);assert.deepEqual(readdirSync(root),[]);
  }finally{rmSync(root,{recursive:true,force:true});}
});
