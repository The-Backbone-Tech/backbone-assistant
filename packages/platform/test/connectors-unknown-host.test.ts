import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import { enableConnector } from '../src/testing/connectors.ts';
// Whole-Host Pi turns distinguish provider checks for effects from person-side read decisions.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoreLink } from '../src/composition/core.ts';
import type { StoredThread } from '../src/composition/thread-journal.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, idle, open, settings, value } from './helpers.ts';

for (const kind of ['effect', 'read'] as const) test(`whole Host: unknown ${kind} stops Pi and leaves only the appropriate person action`, { timeout: TEST_HANG_MS * 2 }, async () => {
  const model = await startScriptedModel('unknown-host-fixture', messages => {
    if (messages.some(m => m.role === 'tool')) return { text: 'This continuation must never be requested.' };
    return { calls: [{ name: 'list_files', args: {} }, { name: kind === 'effect' ? 'mcp__notes__lost_note' : 'mcp__notes__slow', args: {} }, { name: 'mcp__notes__draft_note', args: { text: 'second signed effect' } }] };
  });
  const oldEndpoint = process.env.BACKBONE_MODEL_ENDPOINT, oldModel = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
  try {
    const personHome = freshDir('backbone-unknown-person-'), log = join(personHome, 'calls.jsonl');
    writeFileSync(join(personHome, '.claude.json'), JSON.stringify({ mcpServers: { notes: {
      command: process.execPath, args: [join(import.meta.dirname, 'fake-mcp-server.ts')], env: { FAKE_MCP_LOG: log },
    } } }));
    const { home, host } = open(undefined, { harness: 'harness-pi', connectors: {
      env: defaultToolEnv({ HOME: personHome, PATH: process.env.PATH }), sources: ['claude-code'], callTimeoutMs: 250,
    } });
    const id = 'claude-code:notes', first = kind === 'effect' ? 'lost_note' : 'slow';
    assert.equal(value(await host.call('connectors.refresh', { serverId: id })).problem, undefined, 'fixture tool listing must succeed before enabling');
    value(await enableConnector(host, id));
    for (const name of [first, 'draft_note']) value(await enableConnector(host, id, name));
    value(await host.openConnectorDoor(id, host.connectorDoorSeal(id)!));
    for (const name of kind === 'effect' ? [first, 'draft_note'] : ['draft_note']) {
      const shown = host.connectorToolView(id, name)!;
      value(await host.signConnectorTool(id, name, shown.seal, shown.stamp, false));
    }
    const project = value(await host.call('projects.create', { name: 'Unknown connector', kind: 'folder' }));
    const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Use the connected tools.', attachments: [], settings, clientKey: 'unknown' }));
    const thread = await idle(host, sent.threadId), turn = thread.turns[0];
    assert.equal(thread.summary.running, false);
    assert.equal(turn.status, 'stopped');
    assert.ok(turn.work?.endedAt);
    assert.deepEqual(turn.effects, []);
    assert.equal(model.requests.length, 1, 'no model continuation after the unknown call');
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => (JSON.parse(line) as { tool: string }).tool);
    assert.deepEqual(calls, [first], 'the second, different signed tool never reaches the server');
    const held = (await host.call('connectors.list', {})).held;
    const now = await host.call('work.now', { projectId: project.id });
    assert.deepEqual(now.needsYou.filter(n => n.kind === 'connector'), [], 'no release decision');
    const reads = now.needsYou.filter(n => n.kind === 'connector-read');
    if (kind === 'effect') {
      assert.deepEqual(held.map(h => [h.tool, h.state, h.standing]), [['lost_note', 'unknown', true]]);
      assert.equal(turn.answer?.text, held[0].detail, 'the Host detail is the answer, not generic stopped text or success');
      assert.match(turn.answer!.text, /UNKNOWN.*never sent again; check it there/);
      assert.deepEqual(reads, [], 'an effect creates no read-reconciliation action');
      assert.deepEqual(now.needsYou.map(n => n.kind), ['stopped'], 'only the ordinary stopped-work notice remains');
    } else {
      assert.deepEqual(held, []);
      assert.match(turn.answer!.text, /read is unresolved.*not sent again and no result was handed over/);
      assert.equal(reads.length, 1);
      assert.equal(reads[0].canReconcile, false, 'a response-less read is discard-only');
    }
    // Observe the Host's actual final accounting, rather than manually closing its run.
    const stored = JSON.parse(readFileSync(join(home, 'threads', `${sent.threadId}.json`), 'utf8')) as StoredThread;
    const link = await CoreLink.open({ home });
    try {
      const runs = await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.runs WHERE task_id = $1', [stored.task]);
      assert.deepEqual(runs.rows.map(r => r.status), ['failed'], 'the producer is closed, not waiting for a read decision');
    } finally { await link.release(); }
    value(await host.call('threads.update', { id: sent.threadId, patch: { archived: true } }));
    const archived = await host.call('work.now', { projectId: project.id });
    if (kind === 'effect') assert.deepEqual(archived.needsYou, [], 'archiving clears the ordinary stopped-work notice');
    else {
      assert.deepEqual(archived.needsYou.map(n => n.kind), ['connector-read'], 'archiving cannot hide unresolved read history');
      assert.ok(reads[0].observationId);
      value(await host.call('connectors.resolveRead', { id: reads[0].observationId, verdict: 'discard' }));
      assert.deepEqual((await host.call('work.now', { projectId: project.id })).needsYou, [], 'the person can clear the read card explicitly');
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).tool), [first], 'discard never dispatches another call');
    }
    host.close();
  } finally {
    if (oldEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = oldEndpoint;
    if (oldModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = oldModel;
    await model.close();
  }
});
