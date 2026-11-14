import assert from 'node:assert/strict';
import { test } from 'node:test';
import { savedSelection, savedTask } from '../src/lib/task-selection.ts';
const task = { needs: ['model', 'files'], network: false, spend: 'none', structured: true };
const submission = { projectId: 'p', threadId: 't', text: 'Prepare the brief', attachments: ['source-a', 'source-b'], task, settings: { permission: 'ask', model: 'small', effort: 2, runsOn: 'this-computer', mode: 'chat' } };
test('retry metadata preserves the original task, destination, text and permission settings', () => {
  assert.deepEqual(savedTask(JSON.stringify(task)), task);
  assert.deepEqual(savedSelection(JSON.stringify(submission)), submission);
});
test('incomplete or invalid retry metadata is refused rather than widened to defaults', () => {
  for (const raw of [undefined, '', '{}', '{', JSON.stringify({ ...task, network: 'false' }), JSON.stringify({ ...task, spend: 'unlimited' }), JSON.stringify({ ...task, needs: ['unknown'] }), JSON.stringify({ ...task, needs: [] })]) assert.equal(savedTask(raw), undefined);
  for (const value of [{ ...submission, attachments: undefined }, { ...submission, attachments: [1] }, { ...submission, settings: undefined }, { ...submission, settings: { ...submission.settings, permission: 'anything' } }, { ...submission, settings: { ...submission.settings, effort: 99 } }, { ...submission, projectId: '' }, { ...submission, task: { ...task, spend: 'unlimited' } }]) assert.equal(savedSelection(JSON.stringify(value)), undefined);
});
