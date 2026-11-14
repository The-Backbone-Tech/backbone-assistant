import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {readAudit} from '../src/audit.ts';
import {verifyAuditFile} from '../src/audit-file.ts';
import {CoreLink} from '../src/composition/core.ts';
import {exportAudit,coreAuditSource} from './fixtures/audit-collect.ts';
import {freshHome,freshDir} from './helpers.ts';
import {AUDIT_PERIOD} from './fixtures/audit-activity.ts';
test('file verification streams UTF-8 records across 64 KiB boundaries and rejects noncanonical tails and BOM', {timeout: TEST_HANG_MS * 2},async()=>{
  const link=await CoreLink.open({home:freshHome()}),dir=freshDir('audit-file-');
  try{
    const run=await link.startRun(await link.createTask('Unicode readback'));
    const effect=await link.proposeWrite(run,{fixture:true},'á🙂'.repeat(20000),'audit-unicode');
    const claim=await link.claimEffect(effect.id);await link.beginDispatch(effect.id,claim);await link.observe(effect.id,claim,'succeeded','a'.repeat(64),'Fixture');await link.finishRun(run,'succeeded');
    const made=await exportAudit(coreAuditSource(link),{...AUDIT_PERIOD,includeContent:true}),file=join(dir,'unicode.jsonl');
    assert.ok(Buffer.byteLength(made.jsonl)>65536);writeFileSync(file,made.jsonl);
    assert.equal((await verifyAuditFile(file)).count,readAudit(made.jsonl).events.length);
    for(const bytes of ['\uFEFF'+made.jsonl,made.jsonl.slice(0,-1),made.jsonl.trimEnd()+' \n']){
      writeFileSync(file,bytes);await assert.rejects(verifyAuditFile(file));
    }
  }finally{await link.close();}
});
