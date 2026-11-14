import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { observeChild } from './lib/test-child.ts';
import { waitFor } from './lib/test-hang.ts';

function child(t, source, { ipc = false } = {}) {
  const proc = spawn(process.execPath, ['-e', source], { stdio: ipc ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'] });
  const ended = new Promise(resolve => proc.once('close', resolve));
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); await ended; });
  return { proc, output: observeChild(proc, 'fixture') };
}

test('ready waits for the child line, including a line split over writes, and retains output', async t => {
  const { proc, output } = child(t, `
    process.stdout.write('Starting\\n');
    process.on('message', step => {
      if (step === 'prefix') {
        process.stderr.write('diagnostic\\n');
        process.stdout.write('Serving the ');
      }
      if (step === 'suffix') process.stdout.write('doors\\n');
    });
  `, { ipc: true });
  await output.waitForOutput(/^Starting$/m);
  let ready = false;
  const waiting = output.waitForOutput(/^Serving the doors$/m).then(() => { ready = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, false, 'starting is not ready');
  proc.send('prefix');
  // The parent observes the partial write before authorizing the suffix: no scheduler delay
  // can coalesce the two writes or make a partial ready line satisfy the complete-line wait.
  await output.waitForOutput(/Serving the $/);
  assert.equal(ready, false, 'a partial ready line is not ready');
  // stdout and stderr are independent pipes; stdout readiness does not drain stderr.
  await waitFor(() => /diagnostic/.test(output.stderr), 'fixture stderr diagnostic', { diagnostic: () => output.diagnostic('stderr still pending').message });
  proc.send('suffix');
  await waiting;
  assert.match(output.stdout, /^Serving the doors$/m);
  assert.match(output.stderr, /diagnostic/);
  await output.waitForOutput(/^Serving the doors$/m); // Also sees output already received.
});

test('an early exit fails with stdout, stderr, exit code and signal', async t => {
  const { output } = child(t, `console.log('partial startup');console.error('why it stopped');process.exitCode=7;`);
  await assert.rejects(output.waitForOutput(/^Serving$/m), error => {
    for (const part of ['fixture exited before readiness', 'exit code: 7', 'signal: null', 'partial startup', 'why it stopped']) assert.ok(error.message.includes(part), error.message);
    return true;
  });
});

test('a deliberate refusal can return exit without pretending readiness', async t => {
  const { output } = child(t, `console.error('refused');process.exitCode=2;`);
  assert.equal(await output.waitForOutput(/^Serving$/m, { allowExit: true }), 'exit');
  assert.equal(output.exitCode, 2);
  assert.match(output.stderr, /refused/);
});

test('the hang detector reports partial output and current process state', async t => {
  const { output } = child(t, `console.log('Starting');console.error('still starting');setInterval(()=>{},1000);`);
  await output.waitForOutput(/^Starting$/m);
  await waitFor(() => /still starting/.test(output.stderr), 'fixture stderr before the diagnostic assertion', { diagnostic: () => output.diagnostic('stderr still pending').message });
  await assert.rejects(output.waitForOutput(/^Serving$/m, { hangMs: 20 }), error => {
    for (const part of ['hang detector', 'exit code: null', 'signal: null', 'Starting', 'still starting']) assert.ok(error.message.includes(part), error.message);
    return true;
  });
});

test('a signal exit is diagnosed and never mistaken for readiness', async t => {
  const { proc, output } = child(t, `console.log('Starting');setInterval(()=>{},1000);`);
  await output.waitForOutput(/^Starting$/m);
  const waiting = output.waitForOutput(/^Serving$/m);
  proc.kill('SIGTERM');
  await assert.rejects(waiting, /signal: SIGTERM/);
});

test('spawn errors fail the wait with diagnostics', async t => {
  const proc = spawn('/not-a-real-test-program', [], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ended = new Promise(resolve => proc.once('close', resolve));
  t.after(() => ended);
  const output = observeChild(proc, 'missing fixture');
  await assert.rejects(output.waitForOutput(/^Serving$/m), /ENOENT[\s\S]*stdout:[\s\S]*stderr:/);
});
