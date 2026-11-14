// Disposable real Core and connector activity, with a local fake server and no provider/account.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreLink } from '../../src/composition/core.ts';
import { ConnectorService } from '../../src/connectors/service.ts';
import { MaterialStore } from '../../src/stub/material.ts';
import { defaultToolEnv } from '../../src/tools/places.ts';
import { freshDir, freshHome, value } from '../helpers.ts';
import { typedMaterialGateway } from './typed-material-gateway.ts';

export const AUDIT_PERIOD = { since: '2000-01-01T00:00:00Z', until: '2100-01-01T00:00:00Z' };
export async function auditActivity() {
  const home = freshHome(), person = freshDir('backbone-audit-person-');
  const log = join(person, 'calls.jsonl');
  writeFileSync(join(person, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: process.execPath,
    args: [join(import.meta.dirname, '../fake-mcp-server.ts')], env: { FAKE_MCP_LOG: log } } } }));
  const link = await CoreLink.open({ home });
  const service = new ConnectorService({ home, env: () => defaultToolEnv({ HOME: person, PATH: process.env.PATH }), link: async () => link, callTimeoutMs: 250 });
  try {
    const id = 'claude-code:notes';
    assert.equal(value(await service.refresh(id)).problem, undefined, 'fixture tool listing must succeed before enabling'); value(await service.set(id, { enabled: true }));
    for (const name of ['draft_note', 'plain', 'lost_note', 'refuse_note']) value(await service.set(id, { tool: { name, enabled: true } }));
    value(await service.set(id, { egress: true, seal: service.doorSeal(id)! }));
    const h = await link.startRun(await link.createTask('Audit fixture'));
    const material = new MaterialStore(home, {}, () => {});
    const { gateway } = typedMaterialGateway({ home, link, handle: h, material, threadId: 'audit-thread', turnId: 'audit-turn' });
    await gateway.connector!.prepareProtocol(false);
    let seq = 0;
    const call = (name: string, args: Record<string, unknown> = {}, turn = 'audit-turn') => service.call(service.offered().find(t => t.tool === name)!, args,
      gateway.connector!, { threadId: 'audit-thread', turnId: turn, seq: ++seq }, new AbortController().signal);
    const sign = async (name: string) => {
      const shown = service.toolView(id, name)!;
      value(await service.set(id, { seal: shown.seal, tool: { name, standing: { stamp: shown.stamp } } }));
    };
    const held = await call('draft_note', { text: 'person released this' });
    assert.equal(held.outcome, 'HELD');
    const heldRow = service.list().held.find(row => row.tool === 'draft_note')!;
    assert.equal(value(await service.decide(heldRow.effect, heldRow.argsHash, 'release')).state, 'sent');
    // A distinct pre-send control preserves real FAILED audit coverage. Core admits dispatch,
    // then the person's door closes before the connector's final check and SDK invocation.
    const prevented = await call('draft_note', { text: 'pre-send refusal: never reach the destination' });
    assert.ok(prevented.outcome === 'HELD');
    const begin = link.beginDispatch;
    let admitted = false;
    link.beginDispatch = async (...args) => {
      const begun = await begin.apply(link, args);
      if (args[0] === prevented.effect && begun) {
        admitted = true;
        value(await service.set(id, { egress: false }));
      }
      return begun;
    };
    try {
      const row = service.list().held.find(row => row.effect === prevented.effect)!;
      assert.equal(value(await service.decide(row.effect, row.argsHash, 'release')).state, 'released');
    } finally { link.beginDispatch = begin; }
    assert.equal(admitted, true, 'the known non-delivery happened after Core dispatch admission');
    const failed = await link.effect(prevented.effect);
    assert.equal(failed.status, 'failed');
    assert.equal(await link.connectorEffectPause(failed.id), null, 'known non-delivery cannot leave an UNKNOWN pause');
    const calls = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { tool: string; args: Record<string, unknown> });
    assert.equal(calls().some(call => call.args.text === 'pre-send refusal: never reach the destination'), false);
    value(await service.set(id, { egress: true, seal: service.doorSeal(id)! }));
    await sign('plain');
    const signature = await link.call<string>(link.person(), "SELECT subject FROM app.ledger WHERE entry_type='signature.given' ORDER BY seq DESC LIMIT 1");
    const signed = await call('plain'); assert.equal(signed.outcome, 'SENT');
    // Unlike the pre-send control, the server was invoked. Its refusal prose is UNKNOWN.
    await sign('refuse_note'); const postCallError = await call('refuse_note');
    assert.equal(postCallError.outcome === 'SENT' && postCallError.state, 'unknown');
    assert.equal(calls().filter(call => call.tool === 'refuse_note').length, 1);
    await sign('lost_note'); const unknown = await call('lost_note'); assert.equal(unknown.outcome === 'SENT' && unknown.state, 'unknown');
    const refused = await call('lost_note', {}, 'audit-repeat'); assert.equal(refused.outcome, 'REFUSED');
    const beforeRevocation = await link.call<string>(link.person(), 'SELECT max(seq)::text FROM app.ledger');
    value(await service.set(id, { tool: { name: 'plain', standing: false } }));
    const ended = (await link.read(link.person(), 'SELECT entry_type,subject,actor_id,payload FROM app.ledger WHERE seq>$1::bigint ORDER BY seq', [beforeRevocation])).rows;
    assert.deepEqual(ended, [{ entry_type: 'signature.ended', subject: signature, actor_id: link.id.person,
      payload: { signature, reason: 'person_revoked' } }], 'revocation appends exactly its real Core receipt');
    assert.equal((await call('plain', { x: 'after revocation' }, 'audit-revoked')).outcome, 'HELD');
    const waiting = service.list().held.find(row => row.tool === 'plain' && row.state === 'waiting')!;
    value(await service.decide(waiting.effect, waiting.argsHash, 'discard'));
    await link.finishRun(h, 'succeeded');
    return { home, link, service, log, held: heldRow.effect, signed, unknown, failed, postCallError, refused,
      async close() { await service.close(); await link.close(); } };
  } catch (error) { await service.close(); await link.close(); throw error; }
}
