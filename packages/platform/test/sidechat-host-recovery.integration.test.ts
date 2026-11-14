import { hangDetector } from '../../../scripts/lib/test-hang.ts';
// Real Host + Core crash and recovery; a synthetic loopback model is the only external endpoint.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoreLink } from '../src/composition/core.ts';
import { startScriptedModel, type Message } from '../src/testing/scripted-model.ts';
import { freshHome, open, value } from './helpers.ts';

const words = (message: Message) => typeof message.content === 'string' ? message.content : (message.content ?? []).map((piece) => piece.text ?? '').join('');

test('Host cold recovery settles the side run and returns the same stopped turn without re-sending', async (t) => {
  const home = freshHome();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const model = await startScriptedModel('side-host-crash', () => ({ text: 'SYNTHETIC ANSWER' }), {
    before: async (messages) => { if (words(messages.findLast((message) => message.role === 'user')!).includes('SIDE HOST CRASH')) { entered(); await held; } },
  });
  t.after(async () => { release(); await model.close(); });
  const child = spawn(process.execPath, [join(import.meta.dirname, 'sidechat-host-crash.ts'), home], {
    env: { ...process.env, BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', (value: Buffer) => { output += value.toString(); });
  child.stderr.on('data', (value: Buffer) => { errors += value.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await hangDetector(Promise.race([started, exited.then((result) => { throw new Error(`Child exited before side inference: ${JSON.stringify(result)} ${errors}`); })]), 'side inference startup', {diagnostic:()=>`exit=${child.exitCode}; signal=${child.signalCode}\nstdout:\n${output}\nstderr:\n${errors}`});
  const sent = JSON.parse(output.trim().split('\n').at(-1)!) as { threadId: string; turnId: string };
  child.kill('SIGKILL');
  assert.equal((await exited).signal, 'SIGKILL');
  release();
  const count = model.requests.filter((request) => request.body.includes('SIDE HOST CRASH')).length;
  const savedEndpoint = process.env.BACKBONE_MODEL_ENDPOINT, savedModel = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  t.after(() => {
    if (savedEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = savedEndpoint;
    if (savedModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = savedModel;
  });
  const { host } = open(home, { harness: 'harness-pi' });
  const retried = await host.call('sidechat.ask', { threadId: sent.threadId, text: 'SIDE HOST CRASH', clientKey: 'side-crash-key' });
  assert.ok(retried.ok);
  assert.equal(retried.value.status, 'stopped');
  assert.equal(retried.value.sideRecoveryPending, undefined);
  assert.match(retried.value.answer?.text ?? '', /unknown/i);
  assert.equal(model.requests.filter((request) => request.body.includes('SIDE HOST CRASH')).length, count, 'no automatic or retry inference');
  const thread = value(await host.call('threads.get', { id: sent.threadId }));
  assert.equal(thread.sideTurns.length, 1);
  assert.equal(thread.sideTurns[0].id, retried.value.id);
  assert.ok(retried.value.sideRun?.runId);
  const link = await CoreLink.open({ home });
  try {
    const rows = await link.read<{ status: string; piece_id: string }>(link.system(), 'SELECT status, piece_id FROM app.runs WHERE id = $1', [retried.value.sideRun.runId]);
    assert.equal(rows.rows[0]?.status, 'failed');
    assert.equal(rows.rows[0]?.piece_id, retried.value.sideRun.pieceId);
  } finally { await link.release(); }
});
