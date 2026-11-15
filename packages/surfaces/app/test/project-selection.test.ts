import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DEFAULT_PREFS} from '@backbone-next/platform';
import {projectArchiveSelection} from '../src/lib/project-selection.ts';
const projects=[{id:'p'},{id:'hidden',archived:true},{id:'survivor'}];
test('archiving the selected project selects surviving work and preserves the pane',()=>{
  const before={...DEFAULT_PREFS,selectedProjectId:'p',view:'now' as const};
  const after=projectArchiveSelection(before,'p',projects);
  assert.equal(after.selectedProjectId,'survivor');assert.equal(after.selectedThreadId,undefined);assert.equal(after.view,undefined);assert.equal(after.pane,before.pane);
});
test('a late archive response preserves a newer project selection',()=>{
  const current={...DEFAULT_PREFS,selectedProjectId:'newer',selectedThreadId:'newer-thread'};
  assert.equal(projectArchiveSelection(current,'p',projects),current);
});
test('archiving the last project leaves an empty composer selection',()=>{
  const after=projectArchiveSelection({...DEFAULT_PREFS,selectedProjectId:'p'},'p',[{id:'p'}]);
  assert.equal(after.selectedProjectId,undefined);assert.equal(after.selectedThreadId,undefined);
});

 test('an explicitly open chat survives archiving its project',()=>{
  const before={...DEFAULT_PREFS,selectedProjectId:'p',selectedThreadId:'thread'};
  assert.equal(projectArchiveSelection(before,'p',projects),before);
 });

test('startup repairs an archived project selection only when no chat is open',async()=>{
  const {projectRefreshSelection}=await import('../src/lib/project-selection.ts');
  const archived=[{id:'p',archived:true},{id:'survivor'}],prefs={...DEFAULT_PREFS,selectedProjectId:'p'};
  assert.equal(projectRefreshSelection(prefs,undefined,archived).selectedProjectId,'survivor');
  const open={...prefs,selectedThreadId:'thread'};assert.equal(projectRefreshSelection(open,undefined,archived),open);
});
test('refresh repairs only an archive transition and preserves an explicitly open chat',async()=>{
  const {projectRefreshSelection}=await import('../src/lib/project-selection.ts');
  const active=[{id:'p'},{id:'survivor'}],archived=[{id:'p',archived:true},{id:'survivor'}],prefs={...DEFAULT_PREFS,selectedProjectId:'p'};
  assert.equal(projectRefreshSelection(prefs,active,archived).selectedProjectId,'survivor');
  assert.equal(projectRefreshSelection(prefs,archived,archived),prefs);
  const open={...prefs,selectedThreadId:'thread'};assert.equal(projectRefreshSelection(open,active,archived),open);
});
