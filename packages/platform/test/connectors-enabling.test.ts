import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import { enableConnector } from '../src/testing/connectors.ts';
// Regression at the Host boundary: the app's API used to grant an annotated read without a person.
// The narrower API line and local door are exercised too; neither carries connector settings.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Receipt } from '../src/api.ts';
import { CoreLink } from '../src/composition/core.ts';
import { serveApiLine } from '../src/composition/api-line.ts';
import { grantDoor } from '../src/composition/gateway.ts';
import { attachApi } from '../src/doors/api-line.ts';
import { connectDoor } from '../src/doors/client.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, idle, open, settings, value } from './helpers.ts';

function person(definitions?: Record<string, string>) {
  const personHome = freshDir('connector-enabling-');
  const log = join(personHome, 'calls.jsonl');
  const definitionsFile = join(personHome, 'definitions.json');
  if (definitions) writeFileSync(definitionsFile, JSON.stringify(definitions));
  writeFileSync(join(personHome, '.claude.json'), JSON.stringify({ mcpServers: { notes: {
    command: process.execPath, args: [join(import.meta.dirname, 'fake-mcp-server.ts')], env: { FAKE_MCP_LOG: log, ...(definitions ? { FAKE_MCP_DEFINITIONS_FILE: definitionsFile } : {}) },
  } } }));
  const opened = open(undefined, { harness: 'harness-pi', doors: true, connectors: {
    env: defaultToolEnv({ HOME: personHome, PATH: process.env.PATH }), sources: ['claude-code'],
  } });
  return { ...opened, log, personHome, definitionsFile };
}
const serverId = 'claude-code:notes';
const changes = [{ serverId, enabled: true }, { serverId, tool: { name: 'search', enabled: true } }] as const;

test('the app API cannot enable a server and an annotated tool and thereby read in a real Pi turn', { timeout: TEST_HANG_MS * 2 }, async () => {
  const model = await startScriptedModel('scripted-model', (messages) => messages.some((m) => m.role === 'tool')
    ? { text: 'Finished.' } : { calls: [{ name: 'mcp__notes__search', args: { q: 'launch' } }] });
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
  const { host, log } = person();
  try {
    value(await host.call('connectors.refresh', { serverId }));
    const receipts = [];
    for (const change of changes) receipts.push(await host.call('connectors.set', change));
    const project = value(await host.call('projects.create', { name: 'Launch', kind: 'folder' }));
    const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Search notes.', settings, attachments: [], clientKey: 'enable' }));
    await idle(host, sent.threadId);
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((s) => JSON.parse(s).tool) : [];
    assert.deepEqual({ granted: receipts.map((r) => r.ok), calls }, { granted: [false, false], calls: [] },
      'no person confirmed anything: an annotated read must not be granted or dispatched');
    for (const r of receipts) assert.equal(r.ok ? '' : r.detail, 'Turning a connector on is done by the person in the desktop app.');
  } finally {
    host.close();
    delete process.env.BACKBONE_MODEL_ENDPOINT;
    delete process.env.BACKBONE_MODEL_ID;
    await model.close();
  }
});

test('real API-line and local door clients cannot enable either a server or tool, even with a live grant', async () => {
  const { host, home } = person();
  value(await host.call('connectors.refresh', { serverId }));
  const lineServer = await serveApiLine({ home, call: host.call });
  const line = await attachApi(home);
  assert.ok(line);
  const door = connectDoor({ home, grant: 'enabling-test' });
  try {
    await grantDoor({ home, name: 'enabling-test', operations: ['outbox.write'], ceiling: 3 });
    assert.equal(await door.ready(), 'ready');
    for (const change of changes) {
      const a = await (line.call as (method: string, args: unknown) => Promise<Receipt<unknown>>)('connectors.set', change);
      const d = await door.call('connectors.set' as never, change as never) as Receipt<unknown>;
      assert.equal(a.ok, false);
      assert.equal(d.ok, false);
    }
    const server = (await host.call('connectors.list', {})).servers[0];
    assert.equal(server.enabled, false);
    assert.ok(server.tools.every((t) => !t.enabled));
  } finally { line.close(); await door.close(); await lineServer.close(); }
});

test('only the person enables; API disable stays available and saved choices survive a Host reopen', async () => {
  const { host, home, personHome } = person();
  value(await host.call('connectors.refresh', { serverId }));
  // Build the existing choices through the unchanged service, exactly where the old API
  // forwarded enables. Use its real registration and seal writer, never a hand-made record.
  const { ConnectorService } = await import('../src/connectors/service.ts');
  const link = await CoreLink.open({ home });
  const legacy = new ConnectorService({ home, env: () => defaultToolEnv({ HOME: personHome, PATH: process.env.PATH }), link: async () => link });
  try {
    value(await legacy.set(serverId, { enabled: true }));
    value(await legacy.set(serverId, { tool: { name: 'search', enabled: true } }));
  } finally { await legacy.close(); await link.release(); }
  const saved = readFileSync(join(home, 'connectors', 'mcp.json'), 'utf8');
  host.close();
  const { hostClosed } = await import('../src/composition/host.ts');
  await hostClosed(home);
  // Same persisted choices, a fresh Host: this fix installs no migration that ends old enables.
  const { host: next } = open(home, { connectors: { env: defaultToolEnv({ HOME: personHome, PATH: process.env.PATH }), sources: ['claude-code'] } });
  const server = (await next.call('connectors.list', {})).servers[0];
  assert.equal(server.enabled, true);
  assert.equal(server.tools.find((t) => t.name === 'search')?.enabled, true);
  assert.equal(readFileSync(join(home, 'connectors', 'mcp.json'), 'utf8'), saved, 'opening the new Host preserves the old choices byte for byte');
  value(await next.call('connectors.set', { serverId, tool: { name: 'search', enabled: false } }));
  value(await next.call('connectors.set', { serverId, enabled: false }));
  const off = (await next.call('connectors.list', {})).servers[0];
  assert.equal(off.enabled, false);
  assert.equal(off.tools.find((t) => t.name === 'search')?.enabled, false);
});

test('combined patches, truthy enable values and nested or batch shapes never smuggle an enable', async () => {
  const { host } = person();
  value(await host.call('connectors.refresh', { serverId }));
  for (const patch of [
    { enabled: true, egress: false },
    { enabled: false, tool: { name: 'search', enabled: true, override: 'effect', standing: false } },
    { enabled: 'yes' }, { tool: { name: 'search', enabled: 1 } },
    { patch: { enabled: true } }, { tools: [{ name: 'search', enabled: true }] },
    { tool: { name: 'search', patch: { enabled: true } } },
  ]) {
    await host.call('connectors.set', { serverId, ...patch } as never);
    const server = (await host.call('connectors.list', {})).servers[0];
    assert.equal(server.enabled, false);
    assert.ok(server.tools.every((t) => !t.enabled));
  }
  await host.call('connectors.set', [{ serverId, enabled: true }] as never);
  assert.equal((await host.call('connectors.list', {})).servers[0].enabled, false);
});

test('neither saying read nor clearing an effect override back to an annotated read widens authority over the API', async () => {
  const { host } = person();
  value(await host.call('connectors.refresh', { serverId }));
  value(await enableConnector(host, serverId));
  value(await enableConnector(host, serverId, 'search'));
  value(await host.call('connectors.set', { serverId, tool: { name: 'search', override: 'effect' } }));
  for (const override of ['read', null] as const) {
    assert.equal((await host.call('connectors.set', { serverId, tool: { name: 'search', override } })).ok, false);
    assert.equal((await host.call('connectors.list', {})).servers[0].tools.find((t) => t.name === 'search')?.kind, 'effect');
  }
  value(await host.markConnectorToolRead(serverId, 'search', true));
  const search = (await host.call('connectors.list', {})).servers[0].tools.find((t) => t.name === 'search')!;
  assert.equal(search.kind, 'read');
  assert.equal(search.override, undefined);
});

test('enabling a blocked plugin is refused in fixed words without its name, by original or withheld ID', async () => {
  const user = freshDir('blocked-enable-');
  const plugin = join(user, '.codex', 'plugins', 'cache', 'curated', 'private-label', '1.0.0');
  mkdirSync(join(plugin, '.codex-plugin'), { recursive: true });
  writeFileSync(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'private-label' }));
  writeFileSync(join(plugin, 'mcp.json'), JSON.stringify({ mcpServers: { privateServer: { command: 'never-run', env: { TOKEN: ['sk', 'live', '0123456789abcdefABCDEF'].join('-') } } } }));
  writeFileSync(join(user, '.codex', 'config.toml'), '[plugins."private-label@curated"]\nenabled = true\n');
  const { host } = open(undefined, { connectors: { env: defaultToolEnv({ HOME: user }), sources: ['codex-plugin'] } });
  const blocked = (await host.call('connectors.list', {})).servers[0];
  assert.ok(blocked.blocked);
  assert.match(blocked.id, /withheld-/);
  for (const id of [blocked.id, 'codex-plugin:private-label@curated/privateServer']) for (const change of changes) {
    const r = await host.call('connectors.set', { ...change, serverId: id });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.detail, 'Turning a connector on is done by the person in the desktop app.');
    assert.doesNotMatch(JSON.stringify(r), /private-label|privateServer/);
  }
});

test('a stale native enable question grants neither a replacement launch nor a replacement tool definition', async () => {
  const { host, personHome } = person();
  value(await host.call('connectors.refresh', { serverId }));
  const serverQuestion = (await host.connectorEnableView(serverId))!;
  const config = join(personHome, '.claude.json');
  const original = readFileSync(config, 'utf8');
  const changed = JSON.parse(original);
  changed.mcpServers.notes.env.FAKE_MCP_VARIANT = 'swapped';
  writeFileSync(config, JSON.stringify(changed));
  assert.equal((await host.enableConnector(serverId, undefined, serverQuestion.stamp)).ok, false);
  assert.equal((await host.call('connectors.list', {})).servers[0].enabled, false);
  writeFileSync(config, original);
  value(await enableConnector(host, serverId));
  const toolQuestion = (await host.connectorEnableView(serverId, 'search'))!;
  writeFileSync(config, JSON.stringify(changed));
  value(await host.call('connectors.refresh', { serverId }));
  assert.equal((await host.enableConnector(serverId, 'search', toolQuestion.stamp)).ok, false);
  writeFileSync(config, original);
  value(await host.call('connectors.refresh', { serverId }));
  const tool = (await host.call('connectors.list', {})).servers[0].tools.find((t) => t.name === 'search')!;
  assert.equal(tool.enabled, false, 'refresh never restores an old enable after a definition changes back');
});

test('single enabling refuses a snapshot overtaken during Core registration at its admitted write', async (t) => {
  const { host } = person();
  value(await host.call('connectors.refresh', { serverId }));
  const question = (await host.connectorEnableView(serverId))!;
  let entered!: () => void, release!: () => void;
  const registering = new Promise<void>((r) => { entered = r; });
  const proceed = new Promise<void>((r) => { release = r; });
  const call = CoreLink.prototype.call;
  t.mock.method(CoreLink.prototype, 'call', async function(this: CoreLink, ...args: Parameters<typeof call>) {
    if (args[1].includes('gov.register_connection')) { entered(); await proceed; }
    return call.apply(this, args);
  });
  const enabling = host.enableConnector(serverId, undefined, question.stamp);
  try {
    // Registration is real and outside the service lock. A person-side local disable overtakes it.
    await registering;
    value(await host.call('connectors.set', { serverId, enabled: false }));
    release();
    assert.notEqual((await host.connectorEnableView(serverId))!.stamp, question.stamp, 'the local disable changed the approved snapshot');
    // 10 November 2026: the service owner applied the reserved in-write stamp check; a stale native question grants nothing.
    assert.equal((await enabling).ok, false, 'the local disable wins over registration');
    assert.equal((await host.call('connectors.list', {})).servers[0].enabled, false);
  } finally { release(); await enabling; }
});

test('a server-tools question binds the exact capped set, enables it in one write and leaves the rest off', async () => {
  const { host, home } = person();
  value(await host.call('connectors.refresh', { serverId }));
  const server = (await host.connectorEnableView(serverId))!;
  value(await host.enableConnector(serverId, undefined, server.stamp));
  const question = (await host.connectorToolsEnableView(serverId))!;
  assert.equal(question.tools.length, 8);
  assert.equal(question.remaining, 4);
  const before = JSON.parse(readFileSync(join(home, 'connectors', 'mcp.json'), 'utf8'));
  value(await host.enableConnectorTools(serverId, question.tools, question.stamp));
  const after = JSON.parse(readFileSync(join(home, 'connectors', 'mcp.json'), 'utf8'));
  assert.equal(after.ver, before.ver + 1, 'the complete set is saved once');
  assert.equal(after.gen, before.gen + question.tools.length, 'each choice gets one fresh revision');
  assert.equal((await host.enableConnectorTools(serverId, question.tools, question.stamp)).ok, false, 'an old question is not replayed');
  const enabled = (await host.call('connectors.list', {})).servers[0].tools.filter((t) => t.enabled).map((t) => t.name);
  assert.deepEqual(enabled.sort(), [...question.tools].sort());
  const next = (await host.connectorToolsEnableView(serverId))!;
  assert.equal(next.tools.length, 4);
  assert.equal(next.remaining, 0);
  assert.notEqual(question.stamp, next.stamp);
});

test('server-tools stamps reject a changed definition, changed selection and a set changed while waiting for the lock', async () => {
  const { host, home, personHome, definitionsFile } = person({ draft_note: 'Draft a note, not shared.' });
  value(await host.call('connectors.refresh', { serverId }));
  const server = (await host.connectorEnableView(serverId))!;
  value(await host.enableConnector(serverId, undefined, server.stamp));
  const question = (await host.connectorToolsEnableView(serverId))!;
  assert.equal((await host.enableConnectorTools(serverId, question.tools.slice(1), question.stamp)).ok, false);
  const { withHomeLock } = await import('../src/composition/home-lock.ts');
  const { ConnectorService } = await import('../src/connectors/service.ts');
  const local = new ConnectorService({ home, env: () => defaultToolEnv({ HOME: personHome, PATH: process.env.PATH }),
    reconcileOnOpen: false, link: async () => { throw new Error('Local narrowing must not open Core.'); } });
  let entered!: () => void, release!: () => void;
  const locked = new Promise<void>((r) => { entered = r; });
  const proceed = new Promise<void>((r) => { release = r; });
  const holder = withHomeLock(home, async () => {
    entered(); await proceed;
    value(await local.set(serverId, { tool: { name: question.tools[0], enabled: false } }));
  });
  await locked;
  const pending = host.enableConnectorTools(serverId, question.tools, question.stamp);
  try {
    release(); await holder;
    assert.equal((await pending).ok, false);
    assert.ok((await host.call('connectors.list', {})).servers[0].tools.every((t) => !t.enabled));
  } finally { release(); await holder; await local.close(); }
  const beforeDefinitionChange = (await host.connectorToolsEnableView(serverId))!;
  writeFileSync(definitionsFile, JSON.stringify({ draft_note: 'Changed beyond the native preview: ' + 'x'.repeat(10_000) }));
  value(await host.call('connectors.refresh', { serverId }));
  assert.equal((await host.call('connectors.list', {})).servers[0].enabled, true, 'the launch itself has not changed');
  assert.equal((await host.enableConnectorTools(serverId, beforeDefinitionChange.tools, beforeDefinitionChange.stamp)).ok, false);
  assert.ok((await host.call('connectors.list', {})).servers[0].tools.every((t) => !t.enabled));
});

test('the person-only single enable rejects an omitted stamp at runtime', async () => {
  const { host } = person();
  value(await host.call('connectors.refresh', { serverId }));
  assert.equal((await (host.enableConnector as (id: string) => Promise<Receipt<unknown>>)(serverId)).ok, false);
  assert.equal((await host.call('connectors.list', {})).servers[0].enabled, false);
});


test('the single-enable start check refuses a changed choice before any Core registration', async (t) => {
  const { host } = person();
  value(await host.call('connectors.refresh', { serverId }));
  const question = (await host.connectorEnableView(serverId))!;
  value(await host.call('connectors.set', { serverId, enabled: false }));
  let registrations = 0;
  const call = CoreLink.prototype.call;
  t.mock.method(CoreLink.prototype, 'call', function(this: CoreLink, ...args: Parameters<typeof call>) {
    if (args[1].includes('gov.register_connection')) registrations++;
    return call.apply(this, args);
  });
  assert.equal((await host.enableConnector(serverId, undefined, question.stamp)).ok, false);
  assert.equal(registrations, 0);
  assert.equal((await host.call('connectors.list', {})).servers[0].enabled, false);
});
