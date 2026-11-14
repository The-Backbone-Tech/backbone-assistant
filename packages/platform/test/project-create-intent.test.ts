import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideProjectIntent, type ProjectIntent } from '../src/composition/project-create-intent.ts';

const project = { id:'project-id',name:'Example',kind:'folder' as const,createdAt:'now',dir:'example-project-id' };
const reserved: ProjectIntent = { key:'intent-1',name:'Example',kind:'folder',project,phase:'reserved' };
test('the reserved identity is stable, changed fields refuse, and started work is not repeated', () => {
  assert.deepEqual(decideProjectIntent(null,reserved,undefined),{action:'reserve',intent:reserved});
  const start=decideProjectIntent(reserved,reserved,undefined); assert.equal(start.action,'start');
  assert.equal(decideProjectIntent(reserved,{...reserved,name:'Different'},undefined).action,'conflict');
  assert.equal(decideProjectIntent({...reserved,phase:'started'},reserved,undefined).action,'unknown');
  assert.equal(decideProjectIntent({...reserved,phase:'started'},reserved,{...project,dir:'other'}).action,'unknown');
  assert.deepEqual(decideProjectIntent({...reserved,phase:'started'},reserved,project),{action:'ready',intent:{...reserved,phase:'ready'}});
  assert.equal(decideProjectIntent({...reserved,phase:'ready'},reserved,undefined).action,'unknown');
  assert.equal(decideProjectIntent({...reserved,phase:'ready'},reserved,project).action,'ready');
});
