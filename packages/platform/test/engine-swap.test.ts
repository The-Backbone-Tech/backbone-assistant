import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import { acceptAcpTestConfiguration } from '../src/testing/acp.ts';
import { enableConnector } from '../src/testing/connectors.ts';
// A Host chooses its harness once at construction: BACKBONE_HARNESS takes precedence over
// settings.json's harness, then HostOptions.harness, then the stub. Turn settings select a model,
// not a harness. Changing engines therefore closes the Host and reopens the same home.
// Pi runs offline against the scripted model; ACP runs against a local fake agent and requires
// harnesses.harness-acp.acceptsProcessVisibility in the home. Platform Codex tests replace the
// native executable through a copied piece using the adapter factory options seam.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { hostClosed } from '../src/composition/host.ts';
import { removeHarnessState } from '../src/composition/harnesses.ts';
import { type Message, type ScriptedModel, startScriptedModel } from '../src/testing/scripted-model.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, freshHome, idle, open, settings, value } from './helpers.ts';
import { codexFixture } from './engine-swap-codex.ts';

const words = (m: Message) => typeof m.content === 'string' ? m.content : (m.content ?? []).map(p => p.text ?? '').join('');
let model: ScriptedModel;
before(async () => {
  model = await startScriptedModel('swap-model', messages => {
    const start = messages.findLastIndex(m => m.role === 'user');
    const first = words(messages[start]).includes('First turn marker.');
    const done = messages.slice(start + 1).filter(m => m.role === 'tool').length;
    const actions = first ? [
      { name: 'write_file', args: { name: 'swap.md', content: 'Document from first engine.' } },
      { name: 'mcp__notes__plain', args: { x: 'first' } },
    ] : [
      { name: 'mcp__notes__draft_note', args: { text: 'signed second' } },
      { name: 'mcp__notes__plain', args: { x: 'second' } },
      { name: 'read_file', args: { name: 'swap.md' } },
      { name: 'memory_search', args: { query: 'orchard' } },
    ];
    return done < actions.length ? { calls: [actions[done]] } : { text: first ? 'First answer marker.' : 'Second answer marker.' };
  });
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => { delete process.env.BACKBONE_MODEL_ENDPOINT; delete process.env.BACKBONE_MODEL_ID; await model.close(); });

for (const [first, second] of [['harness-pi', 'harness-acp'], ['harness-acp', 'harness-pi'], ['harness-codex', 'harness-pi'], ['harness-pi', 'harness-codex'], ['harness-codex', 'harness-acp'], ['harness-acp', 'harness-codex']] as const) {
  test(`${first} to ${second} retains the person's work`, { timeout: TEST_HANG_MS * 2 }, async () => {
    const home = freshHome(), person = freshDir('swap-person-'), record = join(person, 'agent.jsonl'), log = join(person, 'calls.jsonl');
    const server = join(import.meta.dirname, 'fake-mcp-server.ts'), agent = join(import.meta.dirname, 'engine-swap-agent.mjs');
    writeFileSync(join(person, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [server], env: { FAKE_MCP_LOG: log } } } }));
    const codexRecord = join(person, 'codex.jsonl');
    const piece = first === 'harness-codex' || second === 'harness-codex' ? codexFixture(codexRecord) : undefined;
    process.env.BACKBONE_CODEX_MODEL = 'test-model';
    const opts = { ...(piece ? { pieceDirs: { 'harness-codex': piece } } : {}), connectors: { env: defaultToolEnv({ HOME: person, PATH: process.env.PATH }), sources: ['claude-code'] as ('claude-code')[] } };
    const setEngine = (engine: string) => writeFileSync(join(home, 'settings.json'), JSON.stringify({ harness: engine, harnesses: { 'harness-acp': acceptAcpTestConfiguration(home, { acceptsProcessVisibility: true, agent: 'swap', command: process.execPath, args: [agent], environment: 'person-rights', environmentVariables: ['SWAP_RECORD'] }) } }));
    process.env.SWAP_RECORD = record; setEngine(first);
    const a = open(home, opts).host;
    const id = 'claude-code:notes';
    const listed = value(await a.call('connectors.refresh', { serverId: id }));
    value(await enableConnector(a, id));
    for (const t of listed.tools) value(await enableConnector(a, id, t.name));
    value(await a.openConnectorDoor(id, a.connectorDoorSeal(id)!));
    const shown = a.connectorToolView(id, 'draft_note')!;
    value(await a.signConnectorTool(id, 'draft_note', shown.seal, shown.stamp, false));
    value(await a.call('memory.put', { topic: 'orchard', text: 'The orchard harvest happens on Tuesday.' }));
    const project = value(await a.call('projects.create', { name: 'Swap', kind: 'folder' }));
    const sent = value(await a.call('turns.send', { projectId: project.id, text: first === 'harness-codex' ? 'orchard. First turn marker.' : 'First turn marker.', attachments: [], settings: first === 'harness-codex' ? { ...settings, permission: 'full', model: 'test-model' } : settings, clientKey: 'first' }));
    const before = await idle(a, sent.threadId);
    assert.equal(before.turns[0].status, 'done', before.turns[0].answer?.text ?? '');
    if (first === 'harness-codex') {
      const native = readFileSync(codexRecord, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(entry => entry.prompt);
      assert.match(native.prompt, /orchard harvest happens on Tuesday/);
      assert.ok(native.tools.includes('memory_search'), 'Codex offers the Host memory search tool');
      const response = readFileSync(codexRecord, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(entry => entry.results)?.results[0];
      assert.equal(response?.success, true, 'Codex memory search succeeds');
      assert.match(response.contentItems[0].text, /orchard harvest happens on Tuesday/, 'the tool returns the kept line');
    }
    const pending = (await a.call('connectors.list', {})).held.find(h => h.tool === 'plain' && h.state === 'waiting');
    assert.ok(pending); assert.equal(pending.turnId, before.turns[0].id);
    const document = (await a.call('material.list', { projectId: project.id })).find(file => file.name === 'swap.md');
    assert.ok(document); assert.equal(value(await a.call('material.read', { id: document.id })).text, 'Document from first engine.');
    a.close(); await hostClosed(home);
    if (first === 'harness-acp') await removeHarnessState(home);
    setEngine(second); const b = open(home, opts).host;
    assert.ok((await b.call('connectors.list', {})).held.some(h => h.effect === pending.effect && h.state === 'waiting'));
    const released = value(await b.releaseConnectorCall(pending.effect, pending.argsHash));
    assert.equal(released.state, 'sent'); assert.equal(released.turnId, before.turns[0].id);
    const requestStart = model.requests.length;
    value(await b.call('turns.send', { projectId: project.id, threadId: sent.threadId, text: second === 'harness-codex' ? 'Second turn marker. orchard' : 'Second turn marker.', attachments: [], settings: second === 'harness-codex' ? { ...settings, permission: 'full', model: 'test-model' } : settings, clientKey: 'second' }));
    const after = await idle(b, sent.threadId);
    assert.equal(after.turns[1].status, 'done', after.turns[1].answer?.text ?? '');
    assert.equal(after.summary.id, before.summary.id); assert.equal(after.summary.title, before.summary.title);
    assert.deepEqual(after.turns.map(t => t.user.text), [first === 'harness-codex' ? 'orchard. First turn marker.' : 'First turn marker.', second === 'harness-codex' ? 'Second turn marker. orchard' : 'Second turn marker.']);
    assert.match(after.turns[0].work.harness, first === 'harness-pi' ? /Pi/i : first === 'harness-acp' ? /ACP/i : /Codex/i);
    assert.match(after.turns[1].work.harness, second === 'harness-pi' ? /Pi/i : second === 'harness-acp' ? /ACP/i : /Codex/i);
    const given = second === 'harness-pi' ? model.requests.slice(requestStart).map(r => r.body).join('\n') : second === 'harness-acp' ? readFileSync(record, 'utf8').trim().split('\n').at(-1)! : readFileSync(codexRecord, 'utf8');
    assert.match(given, /First turn marker/); assert.match(given, /First answer marker/);
    assert.match(given, /Document from first engine/); assert.match(given, /orchard harvest happens on Tuesday/);
    if (second === 'harness-codex') {
      const native = readFileSync(codexRecord, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(entry => entry.prompt);
      assert.match(native.prompt, /First turn marker/); assert.match(native.prompt, /First answer marker/);
      assert.match(native.prompt, /orchard harvest happens on Tuesday/);
      assert.equal(native.file, 'Document from first engine.', 'Codex reads the Host-staged workspace copy');
      assert.ok(native.tools.includes('memory_search'), 'Codex offers the Host memory search tool');
      const response = readFileSync(codexRecord, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(entry => entry.results)?.results[0];
      assert.equal(response?.success, true, 'Codex memory search succeeds');
      assert.match(response.contentItems[0].text, /orchard harvest happens on Tuesday/, 'the tool returns the kept line');
    }
    const held = (await b.call('connectors.list', {})).held;
    assert.ok(held.some(h => h.tool === 'draft_note' && h.state === 'sent' && h.standing && h.turnId === after.turns[1].id));
    assert.ok(held.some(h => h.tool === 'plain' && h.state === 'waiting' && h.turnId === after.turns[1].id));
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
    assert.deepEqual(calls.map(c => [c.tool, c.args]), [['plain', { x: 'first' }], ['draft_note', { text: 'signed second' }]]);
    b.close(); await hostClosed(home); delete process.env.SWAP_RECORD; delete process.env.BACKBONE_CODEX_MODEL;
  });
}
