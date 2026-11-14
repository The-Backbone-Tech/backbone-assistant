import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SOLUTIONS_RUN } from '../src/selection-tools.ts';

test('an MCP task retains memory off and refuses an unrecognised memory setting', () => {
  const task = { projectId: 'project', text: 'Check report', task: { needs: ['files'], network: false, spend: 'none' }, clientKey: 'memory-off',
    settings: { permission: 'ask', model: 'model', effort: 3, runsOn: 'this-computer', mode: 'chat', memory: 'off' } };
  assert.equal((SOLUTIONS_RUN.inputSchema.parse(task).settings as { memory?: string }).memory, 'off');
  assert.equal(SOLUTIONS_RUN.inputSchema.safeParse({ ...task, settings: { ...task.settings, memory: 'disabled' } }).success, false);
});
