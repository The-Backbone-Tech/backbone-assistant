import { waitFor } from '../../../scripts/lib/test-hang.ts';
import { acceptAcpTestConfiguration } from '../src/testing/acp.ts';
import { enableConnector } from '../src/testing/connectors.ts';
// ACP agent-owned route through the real Host, local fake agent and disposable homes only.
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pieceDigest } from '../src/pieces/digest.ts';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, freshHome, idle, open, settings, value } from './helpers.ts';
const fixture = fileURLToPath(new URL('../../modules/harness-acp/test/fake-agent.mjs', import.meta.url));
function acp(mode = 'normal', options?: Parameters<typeof open>[1], tool?: { name: string; args: object }) {
  const home = freshHome();
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ harness: 'harness-acp', harnesses: { 'harness-acp': acceptAcpTestConfiguration(home, { acceptsProcessVisibility: true, agent: 'fake', command: process.execPath, args: [fixture], environment: process.platform === 'darwin' ? 'restricted-writes' : 'person-rights', environmentVariables: ['ACP_FAKE_MODE', 'ACP_FAKE_HOST_HOME', 'ACP_FAKE_TOOL', 'ACP_FAKE_ARGS'] }) } }));
  const variables = { ACP_FAKE_MODE: mode, ACP_FAKE_HOST_HOME: home, ...(tool ? { ACP_FAKE_TOOL: tool.name, ACP_FAKE_ARGS: JSON.stringify(tool.args) } : {}) };
  const previous = Object.fromEntries(Object.keys(variables).map(name => [name, process.env[name]]));
  Object.assign(process.env, variables);
  try { return open(home, options); } finally { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
}
test('a home selects ACP and completes a streamed turn using the agent-owned route', async () => {
  const { host } = acp();
  const project = value(await host.call('projects.create', { name: 'ACP', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Reply ready.', attachments: [], settings, clientKey: 'first' }));
  const turn = (await idle(host, sent.threadId)).turns[0];
  assert.equal(turn.status, 'done', turn.answer?.text ?? ''); assert.equal(turn.answer?.text, 'ready');
  assert.match(turn.work.harness, /ACP.*fake.*model chosen by the agent/);
  const model = await host.call('settings.model.get', {});
  assert.equal(model.active?.kind, 'agent');
  const second = value(await host.call('turns.send', { projectId: project.id, threadId: sent.threadId, text: 'Again.', attachments: [], settings, clientKey: 'second' }));
  assert.equal((await idle(host, second.threadId)).turns[1].status, 'done');
});
test('ACP MCP writes reach the Host gateway and canonical material', async () => {
  const { host } = acp('mcp-write');
  const project = value(await host.call('projects.create', { name: 'ACP tools', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Create a brief.', attachments: [], settings, clientKey: 'write' }));
  const turn = (await idle(host, sent.threadId)).turns[0];
  assert.equal(turn.status, 'done', turn.answer?.text ?? '');
  assert.equal(turn.effects[0]?.outcome, 'DONE');
  const material = (await host.call('material.list', { projectId: project.id })).find(m => m.name === 'brief.md');
  assert.ok(material);
});
test('a named model is refused instead of claiming the ACP agent honored it', async () => {
  const { host } = acp();
  const project = value(await host.call('projects.create', { name: 'ACP model', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Hi', attachments: [], settings: { ...settings, model: 'specific-model' }, clientKey: 'named' }));
  const turn = (await idle(host, sent.threadId)).turns[0];
  assert.equal(turn.status, 'refused'); assert.match(turn.answer?.text ?? '', /cannot honor a named model/);
});

test('Host Stop ends a running ACP prompt as stopped', async () => {
  const { host } = acp('wait');
  const project = value(await host.call('projects.create', { name: 'ACP Stop', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Wait', attachments: [], settings, clientKey: 'wait' }));
  let streamed = false;
  await waitFor(async () => {
    const turn = value(await host.call('threads.get', { id: sent.threadId })).turns[0];
    streamed = turn.answer?.text === 'rea';
    return streamed;
  }, 'ACP prompt streams its readiness marker');
  assert.ok(streamed, 'the fake entered its running prompt');
  value(await host.call('turns.stop', { threadId: sent.threadId }));
  assert.equal((await idle(host, sent.threadId)).turns[0].status, 'stopped');
});
for (const mode of ['die', 'malformed']) test(`the Host survives ACP ${mode} input without false success`, async () => {
  const { host } = acp(mode);
  const project = value(await host.call('projects.create', { name: 'ACP transport', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Hi', attachments: [], settings, clientKey: mode }));
  const turn = (await idle(host, sent.threadId)).turns[0];
  if (mode === 'die') { assert.equal(turn.status, 'stopped'); assert.ok(turn.failure); }
  else { assert.equal(turn.status, 'done'); assert.equal(turn.answer?.text, 'ready'); }
  assert.equal((await host.call('projects.list', {})).length, 1, 'Host remains usable');
});

test('an ACP permission refusal is recorded in the Host work block', async () => {
  const { host } = acp('permission');
  const project = value(await host.call('projects.create', { name: 'ACP permission', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Ask permission.', attachments: [], settings, clientKey: 'permission' }));
  const turn = (await idle(host, sent.threadId)).turns[0];
  assert.equal(turn.status, 'done');
  assert.match(turn.answer?.text ?? '', /permission:reject/);
  assert.ok(turn.work.steps.some(step => /no approval.*refused/.test(step.label)));
});

test('the Host passes its data-home deny to the registered ACP factory', async () => {
  const home = freshHome(), piece = freshDir('acp-deny-piece-'); mkdirSync(join(piece, 'src'));
  const manifest = JSON.parse(readFileSync(new URL('../../modules/harness-acp/backbone.module.json', import.meta.url), 'utf8'));
  manifest.dependsOn = [];
  writeFileSync(join(piece, 'backbone.module.json'), JSON.stringify(manifest));
  writeFileSync(join(piece, 'package.json'), JSON.stringify({ type: 'module', name: 'owned-acp-factory-canary', exports: { '.': './src/index.ts' } }));
  writeFileSync(join(piece, 'src/index.ts'), `export function createAcpHarness(options) { return { specificationVersion:'v1',id:'owned-factory',label:'Owned ACP factory canary',start(){return {events:{async *[Symbol.asyncIterator](){}},outcome:Promise.resolve({status:'done',answer:JSON.stringify(options.extraDenies),usage:{input:0,output:0}}),stop(){},steer(){}}} }; }`);
  manifest.digest = pieceDigest(piece); writeFileSync(join(piece, 'backbone.module.json'), JSON.stringify(manifest));
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ harness: 'harness-acp', harnesses: { 'harness-acp': acceptAcpTestConfiguration(home, { acceptsProcessVisibility: true, agent: 'owned-factory', command: process.execPath, args: [] }) } }));
  const { host } = open(home, { pieceDirs: { 'harness-acp': piece } });
  const project = value(await host.call('projects.create', { name: 'Own home deny', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Report configured denies', settings, attachments: [], clientKey: 'deny' }));
  const turn = (await idle(host, sent.threadId)).turns[0];
  assert.equal(turn.status, 'done'); assert.ok(JSON.parse(turn.answer!.text).includes(home));
});

test('the restricted-writes fake agent cannot directly read the Host data home', async () => {
  if (process.platform !== 'darwin') return;
  const { host } = acp('read-host');
  const project = value(await host.call('projects.create', { name: 'ACP home boundary', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Probe owned Host canary', settings, attachments: [], clientKey: 'read-home' }));
  const turn = (await idle(host, sent.threadId)).turns[0];
  assert.equal(turn.status, 'done'); assert.equal(turn.answer?.text, 'refused:EPERM');
});

test('an ACP connector read through the real Host refuses missing native identity before contacting the fake provider', async () => {
  const personHome = freshDir('backbone-acp-connectors-'), log = join(personHome, 'calls.jsonl');
  const server = join(import.meta.dirname, 'fake-mcp-server.ts');
  writeFileSync(join(personHome, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [server], env: { FAKE_MCP_LOG: log } } } }));
  const { host } = acp('mcp-connector', { connectors: { env: defaultToolEnv({ HOME: personHome, PATH: process.env.PATH }), sources: ['claude-code'] } });
  const listed = value(await host.call('connectors.refresh', { serverId: 'claude-code:notes' }));
  assert.ok(listed.tools.some(tool => tool.name === 'search'));
  value(await enableConnector(host, 'claude-code:notes'));
  value(await enableConnector(host, 'claude-code:notes', 'search'));
  const project = value(await host.call('projects.create', { name: 'ACP connector identity', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Read the owned fake notes', settings, attachments: [], clientKey: 'connector-identity' }));
  const turn = (await idle(host, sent.threadId)).turns[0];
  assert.equal(turn.status, 'done', turn.answer?.text ?? '');
  assert.match(turn.answer?.text ?? '', /REFUSED/); assert.match(turn.answer?.text ?? '', /native connector invocation identity is unavailable/);
  assert.equal(existsSync(log) ? readFileSync(log, 'utf8').trim() : '', '', 'no tool call reaches the fake provider');
  assert.ok((await host.call('material.list', { projectId: project.id, includeHidden: true })).every(file => !file.fromServer));
});


test('an ACP turn sends a signed connector effect once, records its authority and leaves nothing waiting', async () => {
  const personHome = freshDir('backbone-acp-signed-'), log = join(personHome, 'calls.jsonl'), id = 'claude-code:notes';
  const server = join(import.meta.dirname, 'fake-mcp-server.ts');
  writeFileSync(join(personHome, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [server], env: { FAKE_MCP_LOG: log } } } }));
  const { host } = acp('mcp-tool', { connectors: { env: defaultToolEnv({ HOME: personHome, PATH: process.env.PATH }), sources: ['claude-code'] } }, { name: 'connector_mcp__notes__draft_note', args: { text: 'ACP signed draft' } });
  const listed = value(await host.call('connectors.refresh', { serverId: id })); assert.ok(listed.tools.some(tool => tool.name === 'draft_note'));
  value(await enableConnector(host, id));
  value(await enableConnector(host, id, 'draft_note'));
  value(await host.openConnectorDoor(id, host.connectorDoorSeal(id)!));
  const shown = host.connectorToolView(id, 'draft_note')!;
  value(await host.signConnectorTool(id, 'draft_note', shown.seal, shown.stamp, false));
  const project = value(await host.call('projects.create', { name: 'ACP signed connector', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Draft the signed note.', settings, attachments: [], clientKey: 'signed' }));
  const turn = (await idle(host, sent.threadId)).turns[0];
  assert.equal(turn.status, 'done');
  const result = JSON.parse(turn.answer!.text); assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { outcome: 'SENT', state: 'sent', detail: 'Sent to notes.' });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(call => call.tool === 'draft_note');
  assert.deepEqual(calls.map(call => call.args), [{ text: 'ACP signed draft' }], 'the signed effect reaches the fake server exactly once');
  const view = await host.call('connectors.list', {});
  assert.deepEqual(view.held.map(call => [call.tool, call.state, call.standing]), [['draft_note', 'sent', true]]);
  assert.ok(turn.work.steps.some(step => /On your standing signature for draft_note on notes: Sent to notes/.test(step.label)));
  assert.deepEqual((await host.call('work.now', { projectId: project.id })).needsYou.filter(item => item.kind === 'connector'), []);
});
