import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { childHangTimer } from '../../../scripts/lib/test-child.ts';
import { waitFor } from '../../../scripts/lib/test-hang.ts';
import type { Receipt } from '../src/api.ts';
import { CoreLink } from '../src/composition/core.ts';
import { hostClosed } from '../src/composition/host.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, freshHome, idle, open, value } from './helpers.ts';

test('a kill during connector dispatch holds restart and rewind without a turn marker until verified reconciliation', async () => {
  let recovering = false;
  const model = await startScriptedModel('crash-connector-fixture', messages => {
    const last = messages.findLast(m => m.role === 'user');
    const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map(p => p.text ?? '').join('');
    return text.includes('Call the outside tool') ? { calls: [{ name: 'mcp__notes__lost_note', args: {} }] } : { text: 'Ready.' };
  }, { before: async () => recovering ? { status: 503, message: 'Recovery ends without reissuing the connector call' } : undefined });
  const home = freshHome(), person = freshDir('crash-connector-person-'), log = join(person, 'calls.jsonl');
  writeFileSync(join(person, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [join(import.meta.dirname, 'fake-mcp-server.ts')], env: { FAKE_MCP_LOG: log } } } }));
  const child = spawn(process.execPath, [join(import.meta.dirname, 'fixtures/thread-connector-crash.ts'), home, person], {
    env: { ...process.env, BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
  const timer = childHangTimer(child, 'connector dispatch crash fixture');
  const oldEndpoint = process.env.BACKBONE_MODEL_ENDPOINT, oldModel = process.env.BACKBONE_MODEL_ID;
  let host: ReturnType<typeof open>['host'] | undefined;
  try {
    await waitFor(() => {
      if (child.exitCode !== null) throw Error(errors || 'Crash fixture exited before dispatch');
      return output.includes('"original"') && existsSync(log);
    }, 'fake provider receives the dispatched connector call');
    const { first, original } = JSON.parse(output.trim().split('\n').find(line => line.startsWith('{'))!);
    child.kill('SIGKILL'); await exited; clearTimeout(timer);
    assert.equal(child.signalCode, 'SIGKILL');
    recovering = true;
    process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
    host = open(home, { harness: 'harness-pi', connectors: { env: defaultToolEnv({ HOME: person, PATH: process.env.PATH }), sources: ['claude-code'], callTimeoutMs: 250 } }).host;
    const stopped = await idle(host, original.threadId);
    assert.equal(stopped.turns.at(-1)!.status, 'stopped');
    assert.equal(stopped.turns.at(-1)!.unknownOutcome, undefined, 'the resumed engine did not reissue the connector call');
    const held = (await host.call('connectors.list', {})).held[0];
    assert.equal(held.state, 'waiting');
    for (const state of ['waiting', 'unknown']) {
      if (state === 'unknown') {
        // Inspect the abandoned dispatch through Core's existing observation path, without resending it.
        const link = await CoreLink.open({ home });
        try {
          const claim = (await link.heldClaims()).find(claim => claim.effect === held.effect)!;
          assert.ok(claim);
          await link.observe(claim.effect, claim.claim, 'unknown', 'crash-fixture-unanswered', 'The fake provider received the call but never returned an outcome.');
        } finally { await link.release(); }
        value(await host.call('connectors.decide', { effect: held.effect, argsHash: held.argsHash, verdict: 'discard' }));
        assert.equal((await host.call('connectors.list', {})).held[0].state, 'unknown');
      }
      const results: Receipt<unknown>[] = [await host.call('threads.rewindPreview', first), await host.call('threads.restart', original)];
      for (const result of results) assert.equal(result.ok, false, `${state}: unresolved connector call must hold the control`);
      for (const result of results) assert.match(!result.ok ? result.detail : '', /unknown outcome|inspection|receipts/i);
      assert.equal(value(await host.call('threads.get', { id: original.threadId })).turns.length, 2);
    }
    const receipt = value(await host.connectorEffectDecisions.resolve({ effect: held.effect, argsHash: held.argsHash, answer: 'did_not_happen' }));
    assert.ok(receipt.ledger);
    assert.equal((await host.call('threads.rewindPreview', first)).ok, true);
    recovering = false;
    const continued = value(await host.call('threads.restart', original));
    assert.notEqual(continued.turnId, original.turnId);
    await idle(host, original.threadId);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).tool), ['lost_note']);
  } finally {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    await exited; clearTimeout(timer);
    host?.close(); if (host) await hostClosed(home);
    if (oldEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = oldEndpoint;
    if (oldModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = oldModel;
    await model.close();
  }
});
