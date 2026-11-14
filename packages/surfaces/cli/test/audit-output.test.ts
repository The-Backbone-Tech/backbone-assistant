import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {test} from 'node:test';
import {writeAuditOutput} from '../src/audit-output.ts';
test('a stalled CLI output write rejects within its no-progress bound',async()=>{
  const stream=new Writable({write(){}});
  await assert.rejects(writeAuditOutput(stream,'not drained',10),/No audit output progress/);stream.destroy();
});
