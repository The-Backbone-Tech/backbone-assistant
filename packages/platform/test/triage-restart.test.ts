import { TEST_HANG_MS, waitFor } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { lapseDispatchClaims } from '../src/testing/time.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import { freshHome, open } from './helpers.ts';

test('F7: normal host startup automatically resumes a job killed during a draft', { timeout: 180000 }, async () => {
  const model = await startScriptedModel();
  const previousEndpoint = process.env.BACKBONE_MODEL_ENDPOINT;
  const previousModel = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
  const home = freshHome();
  try {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-triage.ts'), home], { env: { ...process.env, BACKBONE_HARNESS: 'harness-pi', BACKBONE_CRASH_AT: 'triage.draft.begun' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (b) => output += b); child.stderr.on('data', (b) => output += b);
    assert.equal(await new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal ?? code))), 'SIGKILL', output);
    const { host } = open(home, { harness: 'harness-pi' });
    // No call to recover() or run(): exercise the same startup path as the desktop.
    // Poll until shortly before the case timeout rather than a fixed 20 s: under a loaded full suite
    // startup can take longer, and the property is that it resumes without a manual run, not how fast.
    await waitFor(() => !!host.triage!.stored.items.m47?.done, 'restarted inbox completes all 47 requests', { diagnostic: () => JSON.stringify(Object.entries(host.triage!.stored.items).map(([id, item]) => [id, item.done])) });
    assert.equal(host.triage!.stored.items.m47?.done, true, 'startup must schedule the continuation');
    const view = await host.call('triage.get', {});
    assert.equal(view.brief.done[0].outcome, 'UNKNOWN');
    assert.equal(new Set(view.brief.done.map((d) => d.message.id)).size, view.brief.done.length);
    await host.triage!.whenIdle();
    host.close();
  } finally {
    if (previousEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = previousEndpoint;
    if (previousModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = previousModel;
    await model.close();
  }
});

test('R3: normal startup preserves Stop after SIGKILL during a provider read', { timeout: TEST_HANG_MS * 2 }, async () => {
  const model = await startScriptedModel();
  const previousEndpoint = process.env.BACKBONE_MODEL_ENDPOINT, previousModel = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  const home = freshHome();
  try {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-triage-stop.ts'), home], { env: { ...process.env, BACKBONE_HARNESS: 'harness-pi' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (b) => output += b); child.stderr.on('data', (b) => output += b);
    assert.equal(await new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal ?? code))), 'SIGKILL', output);
    const { host } = open(home, { harness: 'harness-pi' });
    await host.triage!.recover(); await host.triage!.whenIdle();
    assert.equal(host.triage!.stored.stoppedByPerson, true);
    assert.equal(host.triage!.stored.runs.length, 1, 'startup cannot dispatch a new run after Stop');
    assert.equal(host.triage!.stored.runs[0].outcome, 'stopped');
    assert.equal(host.triage!.stored.items.m02, undefined);
    assert.equal(Object.values(host.triage!.stored.items).filter((i) => i.done).length, 0);
    host.close();
  } finally {
    if (previousEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = previousEndpoint;
    if (previousModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = previousModel;
    await model.close();
  }
});

test('connection recovery revokes a root whose issuance reply died with the process', { timeout: TEST_HANG_MS * 2 }, async () => {
  const home = freshHome();
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-triage-connect.ts'), home], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (b) => output += b); child.stderr.on('data', (b) => output += b);
  assert.equal(await new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal ?? code))), 'SIGKILL', output);
  const { host } = open(home);
  await host.triage!.recover(); await host.triage!.whenIdle();
  assert.equal(host.triage!.stored.connection, null);
  const { CoreLink } = await import('../src/composition/core.ts');
  const link = await CoreLink.open({ home });
  try {
    const { rows } = await link.read(link.person(), "SELECT id FROM app.mandates WHERE intent->>'phase' = 'before-formation' AND revoked_at IS NULL");
    assert.equal(rows.length, 0);
  } finally { await link.release(); host.close(); }
});


for (const cut of ['before', 'after'] as const) test(`normal startup sweeps and probes a mailbox write killed ${cut} provider commit`, { timeout: TEST_HANG_MS * 2 }, async () => {
  const model = await startScriptedModel();
  const previousEndpoint = process.env.BACKBONE_MODEL_ENDPOINT, previousModel = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  const home = freshHome();
  try {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-triage-mail.ts'), home, cut], { env: { ...process.env, BACKBONE_HARNESS: 'harness-pi' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (b) => output += b); child.stderr.on('data', (b) => output += b);
    assert.equal(await new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal ?? code))), 'SIGKILL', output);
    // Test-only clock advance for the dispatch lease and grace; production sweep logic is unchanged.
    await lapseDispatchClaims(home);
    const { host } = open(home, { harness: 'harness-pi' });
    await host.triage.recover(); await host.triage.whenIdle();
    const rows = [...(await host.triage.effects()).values()].filter((r) => r.operation.startsWith('mail.') && r.args.op === 'modify');
    assert.equal(rows.length, 1, 'startup never issues another mailbox modification');
    assert.equal(rows[0].status, cut === 'after' ? 'succeeded' : 'failed');
    const { FakeMailbox } = await import('@backbone-next/connector-mail');
    const provider = new FakeMailbox({ stateFile: join(home, 'mailbox', 'sample.json') });
    assert.equal(provider.truth.applied.length, cut === 'after' ? 1 : 0);
    host.close();
  } finally {
    if (previousEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = previousEndpoint;
    if (previousModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = previousModel;
    await model.close();
  }
});
