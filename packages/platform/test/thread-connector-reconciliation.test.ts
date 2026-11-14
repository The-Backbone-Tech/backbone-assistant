// The original connector call is reconciled through the person boundary, never resent.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
import { hostClosed } from '../src/composition/host.ts';
import { enableConnector } from '../src/testing/connectors.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, idle, open, settings, value } from './helpers.ts';

test('the person reconciles the exact connector effect before restart or rewind can proceed', { timeout: TEST_HANG_MS * 2 }, async () => {
  const model = await startScriptedModel('reconcile-thread-fixture', messages => {
    const last = messages.findLast(m => m.role === 'user');
    const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map(part => part.text ?? '').join('');
    return text.includes('Call the outside tool')
      ? { calls: [{ name: 'mcp__notes__lost_note', args: {} }] }
      : { text: 'Ready to continue.' };
  });
  const oldEndpoint = process.env.BACKBONE_MODEL_ENDPOINT, oldModel = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  try {
    const personHome = freshDir('reconcile-connector-person-'), log = join(personHome, 'calls.jsonl');
    writeFileSync(join(personHome, '.claude.json'), JSON.stringify({ mcpServers: { notes: {
      command: process.execPath, args: [join(import.meta.dirname, 'fake-mcp-server.ts')], env: { FAKE_MCP_LOG: log },
    } } }));
    const options = { harness: 'harness-pi', connectors: { env: defaultToolEnv({ HOME: personHome, PATH: process.env.PATH }), sources: ['claude-code'] as const, callTimeoutMs: 250 } };
    const { home, host } = open(undefined, { ...options, connectors: { ...options.connectors, sources: [...options.connectors.sources] } });
    const id = 'claude-code:notes';
    value(await host.call('connectors.refresh', { serverId: id }));
    value(await enableConnector(host, id)); value(await enableConnector(host, id, 'lost_note'));
    value(await host.openConnectorDoor(id, host.connectorDoorSeal(id)!));
    const shown = host.connectorToolView(id, 'lost_note')!;
    value(await host.signConnectorTool(id, 'lost_note', shown.seal, shown.stamp, false));
    const project = value(await host.call('projects.create', { name: 'Reconciled connector', kind: 'folder' }));
    const first = value(await host.call('turns.send', { projectId: project.id, text: 'Ready', attachments: [], settings, clientKey: 'first' }));
    await idle(host, first.threadId);
    const original = value(await host.call('turns.send', { threadId: first.threadId, projectId: project.id, text: 'Call the outside tool', attachments: [], settings, clientKey: 'effect' }));
    const stopped = await idle(host, first.threadId);
    assert.equal(stopped.turns.at(-1)?.unknownOutcome, true, JSON.stringify({ turn: stopped.turns.at(-1), requests: model.requests.map(r => r.body) }));
    const held = (await host.call('connectors.list', {})).held.find(h => h.state === 'unknown')!;
    assert.ok(held); assert.equal((await host.call('threads.restart', original)).ok, false);
    assert.equal((await host.call('threads.rewindPreview', first)).ok, false);
    const receipt = value(await host.connectorEffectDecisions.resolve({ effect: held.effect, argsHash: held.argsHash, answer: 'did_not_happen' }));
    assert.ok(receipt.ledger);
    host.close(); await hostClosed(home);
    const reopened = open(home, { ...options, connectors: { ...options.connectors, sources: [...options.connectors.sources] } }).host;
    try {
      assert.equal((await reopened.call('threads.rewindPreview', first)).ok, true, 'the witnessed reconciliation releases rewind');
      const restarted = value(await reopened.call('threads.restart', original));
      assert.notEqual(restarted.turnId, original.turnId);
      await idle(reopened, first.threadId);
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).tool), ['lost_note']);
    } finally { reopened.close(); await hostClosed(home); }
  } finally {
    if (oldEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = oldEndpoint;
    if (oldModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = oldModel;
    await model.close();
  }
});
