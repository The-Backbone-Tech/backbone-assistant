import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent, ModelRoute, ToolHost } from '@backbone-next/platform/ports';
import { createCodexHarness, prompt, type ConditionalDraftHost } from '../src/index.ts';
import { NativeClient, configValue, filesystemFor, overrides, verifyConfig } from '../src/native.ts';
import { NativeSubAgents, NativeTurnEvents } from '../src/events.ts';

const frame = { threadId: 'thread', turnId: 'turn' };
const call = { type: 'mcpToolCall', id: 'native-call', server: 'codex_apps', tool: 'calendar_search', status: 'inProgress', arguments: { private: 'private-canary' } };
const completed = { ...call, status: 'completed', result: { content: [{ type: 'text', text: 'private-result-canary' }] } };

test('full preserves native apps, plugins and configured MCP choices without enabling disabled servers', () => {
  const args = overrides(['enabled', 'disabled'], 'full');
  for (const flag of ['features.skill_search=true', 'features.skip_host_skill_discovery=false', 'skills.include_instructions=true']) assert.ok(args.includes(flag), flag);
  assert.ok(!args.some(arg => /^features\.(apps|plugins)=/.test(arg)), 'native global feature choices are inherited too');
  assert.ok(!args.some(arg => arg.startsWith('mcp_servers.')), 'Codex retains every server setting, including disabled ones');
  for (const flag of ['features.hooks=false', 'features.computer_use=false', 'permissions.backbone-native-staged.network.enabled=false']) assert.ok(args.includes(flag), flag);
  const words = prompt({ threadId: 't', turnId: 'u', text: 'Read calendar', history: [], attachments: [], effort: 3, resumed: false }, [], 'full');
  assert.match(words, /native connectors, apps, MCP servers and plugins/);
});

test('full exposes only native skill and plugin-package roots through the Codex credential deny', () => {
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = '/srv/codex-test';
  try {
    const map = filesystemFor('full');
    assert.equal(map['/srv/codex-test'], 'deny');
    assert.equal(map['/srv/codex-test/skills'], 'read');
    assert.equal(map['/srv/codex-test/plugins/cache'], 'read');
    assert.equal(map['/srv/codex-test/auth.json'], undefined, 'credentials inherit the parent deny');
    assert.equal(filesystemFor('contained')['/srv/codex-test/skills'], undefined);
    assert.equal(filesystemFor('full', ['/srv/codex-test'])['/srv/codex-test/skills'], undefined, 'explicit arrangement denies win');
    assert.equal(filesystemFor('full', ['/srv/codex-test/skills/private'])['/srv/codex-test/skills/private'], 'deny');
  } finally { if (prior === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior; }
});

test('full admits a client with globally disabled apps/plugins and keeps its disabled MCP server off', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-disabled-'));
  const client = new NativeClient({ environment: 'full', command: [process.execPath, join(import.meta.dirname, 'fixtures/native.mjs'), 'native-disabled'], requestTimeoutMs: 2000 }, root, ['demo', 'disabled']);
  try {
    await client.initialize();
    const config = configValue(await client.request('config/read', { cwd: root, includeLayers: false }));
    verifyConfig(config, ['demo', 'disabled'], 'full', [], undefined, root);
    assert.equal((config.features as Record<string, unknown>).apps, false);
    assert.equal((config.features as Record<string, unknown>).plugins, false);
    assert.equal(((config.mcp_servers as Record<string, Record<string, unknown>>).disabled).enabled, false);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

for (const environment of ['contained', 'bare', 'readOnly'] as const) test(`${environment} keeps native account tools and skill discovery off`, () => {
  const args = overrides(['mail'], environment);
  for (const flag of ['features.apps=false', 'features.plugins=false', 'mcp_servers.mail.enabled=false', 'skills.include_instructions=false', 'features.skip_host_skill_discovery=true']) assert.ok(args.includes(flag), flag);
});

test('native MCP activity records identity and reported completion without copying account content', () => {
  const p = new NativeTurnEvents('thread');
  const started = p.receive('item/started', { ...frame, item: call });
  const ended = p.receive('item/completed', { ...frame, item: completed });
  assert.equal(started[0]?.type, 'tool');
  assert.deepEqual([...started, ...ended].map(event => event.type === 'tool' && [event.tool, event.phase]), [['native_connector', 'proposed'], ['native_connector', 'done']]);
  assert.match(JSON.stringify(ended), /codex_apps.*calendar_search/);
  assert.doesNotMatch(JSON.stringify([...started, ...ended]), /private.*canary/);
  assert.deepEqual(p.receive('item/completed', { ...frame, item: completed }), []);
  assert.throws(() => p.receive('item/completed', { ...frame, item: { ...completed, result: { content: [] } } }), /changed/);
});

test('terminal snapshots project native MCP calls and never call failed or unfinished activity done', () => {
  for (const status of ['completed', 'failed', 'inProgress']) {
    const p = new NativeTurnEvents('thread');
    p.receive('item/started', { ...frame, item: call });
    const events = p.receive('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: status === 'inProgress' ? [] : [{ ...completed, status }] } });
    assert.equal(events.find(event => event.type === 'tool')?.phase, status === 'completed' ? 'done' : status === 'failed' ? 'failed' : 'unknown');
  }
});

test('a native tool reported read-only can fail without implying an uncertain account write', () => {
  const p = new NativeTurnEvents('thread');
  const events = p.receive('item/completed', { ...frame, item: { ...call, status: 'failed', readOnlyHint: true, error: { message: 'private-error-canary' } } });
  assert.equal(events[0]?.type === 'tool' && events[0].phase, 'failed');
  assert.doesNotMatch(JSON.stringify(events), /private-error-canary/);
});

test('sub-agent native MCP calls use the same scope validation and uncertainty rules', () => {
  const agents = new NativeSubAgents('root');
  agents.fromRoot('item/completed', { threadId: 'root', turnId: 'turn', item: { type: 'subAgentActivity', kind: 'started', agentThreadId: 'child', agentPath: '/root/helper' } });
  agents.receive('turn/started', { threadId: 'child', turn: { id: 'child-turn', rootTurnId: 'turn' } });
  const events = agents.receive('turn/completed', { threadId: 'child', turn: { id: 'child-turn', rootTurnId: 'turn', status: 'completed', items: [{ ...completed, status: 'failed' }] } });
  assert.ok(events.some(event => event.type === 'tool' && event.tool === 'native_connector' && event.phase === 'failed'));
  assert.equal(!!agents.unknown, false);
});

for (const mode of ['native-mcp', 'native-mcp-read-failed', 'native-mcp-failed', 'native-mcp-pending', 'native-mcp-stop', 'native-mcp-crash']) test(`${mode}: startup and calls survive full admission; uncertainty stops imports`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'backbone-native-connectors-'));
  try {
    const harness = createCodexHarness({ environment: 'full', command: [process.execPath, join(import.meta.dirname, 'fixtures/native.mjs'), mode], temporaryRoot: root, requestTimeoutMs: 2000, turnTimeoutMs: 3000 });
    let writes = 0;
    const tools: ToolHost & ConditionalDraftHost = { list: async () => [], read: async () => null, write: async () => { throw new Error('No unconditional write'); },
      writeIfVersion: async () => { writes++; return { outcome: 'DONE', name: 'draft.md', version: 1 }; },
    };
    const turn = harness.start({ threadId: 't', turnId: 'u', text: 'Read only', history: [], attachments: [], effort: 3, resumed: false }, {
      route: { kind: 'native', provider: 'codex', model: 'test-model', credential: null } as unknown as ModelRoute,
      credential: async () => { throw new Error('No API credentials'); },
      tools,
    });
    const events: HarnessEvent[] = [];
    const collected = (async () => { for await (const event of turn.events) { events.push(event); if (mode === 'native-mcp-stop' && event.type === 'tool' && event.tool === 'native_connector' && event.phase === 'proposed') turn.stop(); } })();
    const outcome = await turn.outcome; await collected;
    assert.equal(outcome.status, mode === 'native-mcp' || mode === 'native-mcp-read-failed' || mode === 'native-mcp-failed' ? 'done' : 'interrupted', outcome.error ?? 'Native turn ended');
    assert.ok(events.some(event => event.type === 'tool' && event.tool === 'native_connector' && event.phase === (mode === 'native-mcp' ? 'done' : mode === 'native-mcp-read-failed' || mode === 'native-mcp-failed' ? 'failed' : 'unknown')));
    assert.equal(writes, mode === 'native-mcp' || mode === 'native-mcp-read-failed' || mode === 'native-mcp-failed' ? 1 : 0, 'only a completed turn imports the staged draft through writeIfVersion');
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const complete of [false, true]) test(`read-only native activity stays read-only through cutoff (complete=${complete})`, () => {
  const p = new NativeTurnEvents('thread');
  const events = p.receive(complete ? 'item/completed' : 'item/started', { ...frame, item: { ...(complete ? completed : call), readOnlyHint: true } });
  events.push(...p.receive('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [] } }));
  assert.ok(events.length > 0);
  assert.ok(events.every(e => e.type === 'tool' && e.readOnly === true));
  assert.ok(events.every(e => e.type !== 'tool' || e.phase !== 'unknown'));
});

test('a shared project request overrides Full and refuses a client that still runs account tools',async()=>{
 const root=await mkdtemp(join(tmpdir(),'backbone-shared-native-'));
 try{
  const harness=createCodexHarness({environment:'full',command:[process.execPath,join(import.meta.dirname,'fixtures/native.mjs'),'native-mcp'],temporaryRoot:root,requestTimeoutMs:2000,turnTimeoutMs:3000});
  let writes=0;
  const tools:ToolHost & ConditionalDraftHost={list:async()=>[],read:async()=>null,write:async()=>{throw new Error('No unconditional write');},writeIfVersion:async()=>{writes++;return{outcome:'DONE',name:'draft.md',version:1};}};
  const turn=harness.start({threadId:'t',turnId:'u',text:'Work',history:[],attachments:[],effort:3,resumed:false,nativeAccountTools:false},{tools,route:{kind:'native',provider:'codex',model:'test-model',credential:null} as unknown as ModelRoute,credential:async()=>{throw new Error('No API key');}});
  const collected=(async()=>{for await(const _ of turn.events){/* Drain the fixed fake protocol. */}})();
  const outcome=await turn.outcome;await collected;
  assert.equal(outcome.status,'failed');
  assert.equal(writes,0,'unoffered native activity cannot import staged output');
 }finally{await rm(root,{recursive:true,force:true});}
});
