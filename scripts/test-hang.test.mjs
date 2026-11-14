import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hangDetector, waitFor } from './lib/test-hang.ts';

test('a settled operation retains its value and rejection', async () => {
  assert.equal(await hangDetector(Promise.resolve(42), 'open'), 42);
  const failure = new Error('original');
  await assert.rejects(hangDetector(Promise.reject(failure), 'close'), error => error === failure);
});
test('a hang names the pending step and reads diagnostics only when it trips', async t => {
  const log = t.mock.method(console, 'error', () => {});
  let state = 'opening', calls = 0;
  const pending = hangDetector(new Promise(() => {}), 'hostClosed(home)', {
    hangMs: 10, diagnostic: () => { calls++; return `state=${state}; child stdout=ready; exit=null`; },
  });
  state = 'closing';
  await assert.rejects(pending, /hostClosed\(home\).*10 ms hang detector[\s\S]*state=closing; child stdout=ready; exit=null/);
  assert.equal(calls, 1);
  assert.match(log.mock.calls[0].arguments[0], /hostClosed\(home\)[\s\S]*state=closing/);
});
test('polling observes the condition and diagnoses the pending condition', async t => {
  t.mock.method(console, 'error', () => {});
  let calls = 0;
  await waitFor(() => ++calls === 2, 'lock hand-over', { intervalMs: 1 });
  assert.equal(calls, 2);
  await assert.rejects(waitFor(() => false, 'lock hand-over', { hangMs: 10, intervalMs: 1, diagnostic: () => 'holder=first' }), /lock hand-over[\s\S]*holder=first/);
});

test('a child watchdog prints accumulated output and exit state before killing', async t => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { childHangTimer, observeChild } = await import('./lib/test-child.ts');
  const child = new EventEmitter();
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => { killed = true; } });
  let killed = false, tripped = false;
  const output = observeChild(child, 'crash cut');
  child.stdout.write('starting'); child.stderr.write('waiting for lock');
  assert.equal(observeChild(child, 'shutdown'), output, 'a later observer retains startup output');
  const log = t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  childHangTimer(child, 'crash cut', () => { tripped = true; });
  t.mock.timers.tick(180_000);
  assert.equal(tripped, true); assert.equal(killed, true);
  assert.match(log.mock.calls[0].arguments[0], /crash cut[\s\S]*exit code: null[\s\S]*signal: null[\s\S]*stdout:\nstarting[\s\S]*stderr:\nwaiting for lock/);
});
