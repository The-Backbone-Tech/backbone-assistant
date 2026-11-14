import assert from 'node:assert/strict';
import {chmodSync,lstatSync,mkdirSync,mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {auditScratchParent} from '../src/audit-scratch.ts';
import {auditTemporaryRoot} from '../src/composition/audit-temporary.ts';
test('the fixed audit parent and operator roots require ownership and 0700, refuse links and name the socket limit',()=>{
  const scratch=mkdtempSync('/tmp/ar-');
  try{
    const own=join(scratch,'own');auditTemporaryRoot(own);assert.equal(lstatSync(own).mode&0o777,0o700);
    assert.equal(lstatSync(auditTemporaryRoot()).uid,process.getuid?.());assert.match(auditScratchParent(),/backbone-audit-/);
    chmodSync(own,0o750);assert.throws(()=>auditTemporaryRoot(own),/0700/);chmodSync(own,0o700);
    const link=join(scratch,'link');symlinkSync(own,link);assert.throws(()=>auditTemporaryRoot(link),/links are refused/);
    const long=join(scratch,'a'.repeat(100));mkdirSync(long,{mode:0o700});assert.throws(()=>auditTemporaryRoot(long),/100-byte.*--scratch-root/);
  }finally{rmSync(scratch,{recursive:true,force:true});}
});
