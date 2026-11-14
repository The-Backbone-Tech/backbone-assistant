import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceExecution, workspaceFailure, WorkspaceRefusal } from '../src/workspace/result.ts';

test('workspace status distinguishes completed failures from unconfirmed execution without inferring refusal from stderr', () => {
  for (const code of [0, 1, 2, 125, 127]) {
    const result = workspaceExecution(JSON.stringify({ code, stdout: 'private output', stderr: 'Operation not permitted' }));
    assert.equal(result.phase, code === 0 ? 'done' : 'failed');
    assert.match(result.detail, new RegExp(`status ${code}`));
    assert.doesNotMatch(result.detail, /private output|Operation not permitted/);
  }
  for (const reason of ['stopped', 'time limit', 'command output could not be confirmed', 'workspace cleanup unconfirmed', 'private reason', null]) {
    assert.equal(workspaceExecution(JSON.stringify({ code: 0, stdout: '', stderr: '', reason })).phase, 'unknown');
  }
});

test('only an explicit pre-execution refusal receives a fixed refused status', () => {
  for (const refused of ['policy', 'admission', 'setup']) {
    const result = workspaceExecution(JSON.stringify({ code: null, stdout: '', stderr: '', refused }));
    assert.equal(result.phase, 'refused');
    assert.doesNotMatch(result.detail, /may have changed/);
    assert.equal(workspaceExecution(JSON.stringify({ code: 125, stdout: '', stderr: '', refused })).phase, 'unknown');
    assert.equal(workspaceExecution(JSON.stringify({ code: null, stdout: '', stderr: '', refused, reason: 'cleanup unconfirmed' })).phase, 'unknown');
  }
  assert.equal(workspaceExecution(JSON.stringify({ code: null, stdout: '', stderr: '', refused: 'unrecognized' })).phase, 'unknown');
});

test('missing, malformed and non-JSON workspace replies remain unknown without parser exceptions or retained output', () => {
  for (const value of [undefined, 'Host private output', 'null', '[]', '42', '{}', '{',
    JSON.stringify({ code: null, stdout: '', stderr: '' }), JSON.stringify({ code: -1, stdout: '', stderr: '' }),
    JSON.stringify({ code: 0, stdout: '' }), JSON.stringify({ code: '0', stdout: '', stderr: '' })]) {
    const result = workspaceExecution(value);
    assert.equal(result.phase, 'unknown');
    assert.doesNotMatch(result.detail, /private output/);
  }
});

test('only certified pre-command exceptions are refused and their diagnostic is kept out of status detail', () => {
  const error = new WorkspaceRefusal('private diagnostic');
  assert.equal(workspaceFailure(error).phase, 'unknown');
  assert.equal(WorkspaceRefusal.beforeCommand(error), error, 'certifying a refusal preserves the rejection object');
  assert.equal(workspaceFailure(error).phase, 'refused');
  assert.doesNotMatch(workspaceFailure(error).detail, /private diagnostic/);
  assert.equal(workspaceFailure(new Error(error.message)).phase, 'unknown');
});
