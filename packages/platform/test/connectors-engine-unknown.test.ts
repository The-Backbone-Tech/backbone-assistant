import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
// Both real engines through runHarnessTurn, the real connector service/Core and the local MCP
// server. Codex uses its fake JSONL client; Pi uses a scripted model. No outside provider or account.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Turn } from '../src/api.ts';
import { CoreLink } from '../src/composition/core.ts';
import { HARNESSES, loadHarness } from '../src/composition/harnesses.ts';
import { runHarnessTurn } from '../src/composition/harness-turn.ts';
import { PIECES, pieceOnDisk } from '../src/composition/pieces.ts';
import { releaseSnapshots } from '../src/composition/snapshot.ts';
import { ConnectorService } from '../src/connectors/service.ts';
import type { HarnessV1, ModelRoute } from '../src/ports/harness.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, freshHome, value } from './helpers.ts';
import { typedMaterialGateway } from './fixtures/typed-material-gateway.ts';

for (const engine of ['harness-pi', 'harness-codex'] as const) {
  for (const response of ['unknown', 'refusal', 'sent'] as const) test(`${engine}: signed ${response} controls the next different effect`, { timeout: TEST_HANG_MS * 2 }, async () => {
    const home = freshHome(), personHome = freshDir('backbone-effect-person-');
    const log = join(personHome, 'calls.jsonl');
    writeFileSync(join(personHome, '.claude.json'), JSON.stringify({ mcpServers: { notes: {
      command: process.execPath, args: [join(import.meta.dirname, 'fake-mcp-server.ts')], env: { FAKE_MCP_LOG: log },
    } } }));
    const link = await CoreLink.open({ home });
    const service = new ConnectorService({ home, env: () => defaultToolEnv({ HOME: personHome, PATH: process.env.PATH }), link: async () => link, callTimeoutMs: 250 });
    // Security review M2 replaces the old server-refusal => FAILED contract. An error reply
    // after invocation is UNKNOWN and must stop the same dependent batch as a missing reply.
    const state = response === 'sent' ? 'sent' : 'unknown';
    const first = response === 'unknown' ? 'lost_note' : response === 'refusal' ? 'refuse_note' : 'plain';
    let continuations = 0;
    const model = await startScriptedModel('effect-fixture', messages => {
      if (messages.some(m => m.role === 'tool')) { continuations++; return { text: JSON.stringify(messages.filter(m => m.role === 'tool')) }; }
      return { calls: [{ name: 'list_files', args: {} }, { name: `mcp__notes__${first}`, args: {} }, { name: 'mcp__notes__draft_note', args: { text: 'different second effect' } }] };
    });
    try {
      const id = 'claude-code:notes';
      assert.equal(value(await service.refresh(id)).problem, undefined, 'fixture tool listing must succeed before enabling');
      value(await service.set(id, { enabled: true }));
      for (const name of [first, 'draft_note']) value(await service.set(id, { tool: { name, enabled: true } }));
      value(await service.set(id, { egress: true, seal: service.doorSeal(id)! }));
      for (const name of [first, 'draft_note']) {
        const shown = service.toolView(id, name)!;
        value(await service.set(id, { seal: shown.seal, tool: { name, standing: { stamp: shown.stamp } } }));
      }
      const nativeOptions = { command: [process.execPath, join(PIECES['harness-codex'].dir, 'test/fixtures/native.mjs'), 'connector-effects'], temporaryRoot: personHome, requestTimeoutMs: 3_000, turnTimeoutMs: 10_000 };
      const loaded = await loadHarness(link, pieceOnDisk(PIECES[engine].dir), home, HARNESSES[engine], engine === 'harness-codex' ? { options: nativeOptions } : {}, []);
      const handle = await link.startRun(await link.createTask('Signed effects'), loaded.registration);
      const material = new MaterialStore(home, {}, () => {});
      const { gateway, observations } = typedMaterialGateway({ home, link, handle, material, projectId: 'project', threadId: 'thread', turnId: 'turn' });
      const turn: Turn = { id: 'turn', side: false, user: { text: 'Call the signed tools.', attachments: [], at: '' }, work: { startedAt: '', harness: engine, steps: [] }, effects: [], status: 'running' };
      let status: string | undefined;
      // Observe the actual engine outcome as well as the Host's person-facing projection.
      const harness: HarnessV1 = { ...loaded.engine, start(request, context) {
        const running = loaded.engine.start(request, context);
        return { ...running, outcome: running.outcome.then(result => { status = result.status; return result; }) };
      } };
      const route: ModelRoute = engine === 'harness-pi'
        ? { kind: 'endpoint', provider: 'openai-compatible', baseUrl: model.url, model: model.model, label: 'scripted', credential: null }
        : { kind: 'native', provider: 'codex', baseUrl: '', model: 'test-model', label: 'fake native', credential: null };
      await runHarnessTurn({ material, projectId: 'project', gateway, writeDelayMs: 0, signal: new AbortController().signal, threadId: 'thread', harness, route,
        credential: async () => { throw new Error('No credential'); }, history: [], resumed: false, progress() {}, connectors: service,
      }, turn, []);
      const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { tool: string; args: unknown }) : [];
      assert.deepEqual(calls.map(c => c.tool), state === 'unknown' ? [first] : [first, 'draft_note']);
      assert.equal(status, state === 'unknown' ? 'interrupted' : 'done');
      assert.equal(turn.status, state === 'unknown' ? 'stopped' : 'done');
      const records = service.list().held;
      const record = records.find(r => r.tool === first)!;
      assert.equal(record.state, state);
      assert.equal(record.standing, true);
      assert.equal(records.some(r => r.state === 'waiting'), false, 'no unanswerable release decision');
      assert.deepEqual(turn.effects, [], 'connector effects never become document recovery work');
      assert.deepEqual(observations.forRun({ workspace: link.id.workspace, project: 'project', thread: 'thread', turn: 'turn', run: handle.run }), [], 'no read observation or read-resolution action');
      assert.equal(gateway.connector!.pending(), false, 'the producer run needs no read decision');
      if (state === 'unknown') {
        assert.equal(turn.answer?.text, record.detail);
        assert.match(turn.answer!.text, /UNKNOWN.*never sent again; check it there/);
        assert.equal(records.some(r => r.tool === 'draft_note'), false, 'the second effect was never proposed');
      } else {
        assert.match(turn.answer!.text, /Sent to notes/);
        if (engine === 'harness-codex') assert.match(turn.answer!.text, /"success":true/);
      }
      if (engine === 'harness-pi') assert.equal(continuations, state === 'unknown' ? 0 : 1);
      await link.finishRun(handle, turn.status === 'done' ? 'succeeded' : 'failed');
      const runs = await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.runs WHERE id = $1', [handle.run]);
      assert.equal(runs.rows[0].status, state === 'unknown' ? 'failed' : 'succeeded', 'producer run can close without a read decision');
    } finally { await model.close(); await service.close(); await link.close(); releaseSnapshots(home); }
  });
}
