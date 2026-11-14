// A connector's answer is kept under a label made from its server and tool names, which the server
// chooses: a "/" there never makes a folder or a ".." segment (172ed98 review, finding D).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Turn } from '../src/api.ts';
import { runHarnessTurn } from '../src/composition/harness-turn.ts';
import type { ConnectorService, OfferedTool } from '../src/connectors/service.ts';
import type { TurnOutcome } from '../src/ports/harness.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { controlledReadCore, controlledReadHandle, typedMaterialGateway } from './fixtures/typed-material-gateway.ts';

test('a server or tool name with "/" is kept as one flat label, never a folder path', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'connector-labels-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const offered: OfferedTool = { name: 'look', serverId: 's', connection: { id: '22222222-2222-4222-8222-222222222222', slug: 's' }, serverName: 'x/../y', tool: 'a/b', description: '', inputSchema: {}, kind: 'read', launch: 'a'.repeat(64), definition: 'b'.repeat(64) };
  const {link,records}=controlledReadCore(home);
  const {gateway}=typedMaterialGateway({home,link,handle:controlledReadHandle,material,threadId:'thread',turnId:'turn-0001'});
  let providerCalls=0;
  const connectors = { offered: () => [offered], ready: async () => {}, call: async (...[tool, args, core, origin, signal]:Parameters<ConnectorService['call']>) => core.readObserved({tool,args,invocation:origin.invocation,signal,stillOffered:()=>true,
    perform:async()=>{providerCalls++;return {observed:true,status:'complete',text:'answer'};}}) } as unknown as ConnectorService;
  const turn: Turn = { id: 'turn-0001', side: false, user: { text: 'Look', attachments: [], at: '' }, work: { startedAt: '', harness: 'controlled', steps: [] }, effects: [], status: 'running' };
  const seen: unknown[] = [];
  const done: TurnOutcome = { status: 'done', answer: 'ok', usage: { input: 0, output: 0 } };
  await runHarnessTurn({ material, projectId: 'project', gateway, writeDelayMs: 0, signal: new AbortController().signal, threadId: 'thread',
    harness: { specificationVersion: 'v1', id: 'controlled', label: 'controlled', start: (_r, context) => ({ events: (async function* () {})(), outcome: (async () => { context.tools.connectors!(); const r = await context.tools.callConnector!('look', {}, new AbortController().signal,{engine:'codex',namespace:JSON.stringify(['native-thread','native-turn']),callId:'native-label-read'}); seen.push(r); return done; })(), stop() {}, steer() {} }) },
    route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'controlled', label: 'controlled', credential: null },
    credential: async () => { throw new Error('No credential in this test'); }, history: [], resumed: false, progress() {}, connectors,
  }, turn, []);
  const names = material.list('project', true).map((e) => e.name);
  assert.equal(names.length, 1, JSON.stringify({ names, seen }));
  assert.ok(!names[0]!.includes('/'), `a flat label: ${names[0]}`);
  assert.equal(providerCalls,1);assert.equal(records.length,1);assert.equal(records[0].sourceKind,'mcp');
  const retained=material.list('project',true)[0];assert.equal(retained.observation?.state,'registered');
  assert.equal(JSON.parse(Buffer.from(material.bytes(retained.id,1)).toString()).result.text,'answer','the real private owner retained the observed result');
});
