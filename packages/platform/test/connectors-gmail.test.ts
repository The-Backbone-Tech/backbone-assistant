import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
// The Gmail read connector on the fake Gmail MCP server (connector-mail), which mirrors workspace-mcp:
// a search with more pages is partial, a 429 is a rate limit and never "no mail", a draft or a send is
// held for the person, and nothing is ever sent.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fakeGmailPreset, GMAIL_TOOLS, readFakeGmailState, serversJson } from '@backbone-next/connector-mail';
import { CoreLink } from '../src/composition/core.ts';
import { type ConnectorCore, ConnectorService } from '../src/connectors/service.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, freshHome } from './helpers.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { typedMaterialGateway } from './fixtures/typed-material-gateway.ts';

const services: ConnectorService[] = [];
const links: CoreLink[] = [];
after(async () => { await Promise.all(services.map((s) => s.close())); await Promise.all(links.map((l) => l.close())); });

test('Gmail through its MCP server: reads say how complete they are, and drafts and sends are held unsent', { timeout: TEST_HANG_MS * 2 }, async () => {
  const home = freshHome();
  const state = join(freshDir('backbone-gmail-'), 'state.json');
  const preset = fakeGmailPreset({ state, faults: `rate-limit@${GMAIL_TOOLS.search}#3` });
  mkdirSync(join(home, 'connectors'), { recursive: true });
  writeFileSync(join(home, 'connectors', 'servers.json'), JSON.stringify(serversJson(preset)));
  const link = await CoreLink.open({ home });
  links.push(link);
  const service = new ConnectorService({ home, env: () => defaultToolEnv({ HOME: freshDir('backbone-person-'), PATH: process.env.PATH }), link: async () => link, sources: ['home'], callTimeoutMs: 5_000 });
  services.push(service);
  const id = `home:${preset.name}`;
  assert.ok((await service.refresh(id)).ok);
  assert.ok((await service.set(id, { enabled: true })).ok);
  for (const [name, kind] of Object.entries(preset.overrides)) assert.ok((await service.set(id, { tool: { name, enabled: true, override: kind } })).ok, name);
  assert.deepEqual(service.offered().filter((t) => t.kind === 'effect').map((t) => t.tool).sort(), [GMAIL_TOOLS.draft, GMAIL_TOOLS.send].sort());

  const h = await link.startRun(await link.createTask('Mail'));
  const {gateway}=typedMaterialGateway({home,link,handle:h,material:new MaterialStore(home,{},()=>{}),threadId:'t',turnId:'turn-g'});
  const core:ConnectorCore=gateway.connector!;
  await core.prepareProtocol(false);
  const tool = (name: string) => service.offered().find((t) => t.tool === name)!;
  const signal = new AbortController().signal;
  // Controlled engine-native IDs, distinct for each legitimate call even when arguments match.
  const originFor=(seq=1)=>({threadId:'t',turnId:'turn-g',seq,invocation:{engine:'codex' as const,namespace:JSON.stringify(['gmail-native-thread','gmail-native-turn']),callId:`native-gmail-call-${seq}`}});
  const origin=originFor();
  const email = 'marta@lumenworkshop.example';

  const first = await service.call(tool(GMAIL_TOOLS.search), { query: 'in:inbox', user_google_email: email, page_size: 5 }, core, origin, signal);
  assert.equal(first.outcome === 'READ' && first.status, 'partial', 'more mail exists than the page shows');
  const none = await service.call(tool(GMAIL_TOOLS.search), { query: 'subject:zzzz-no-such-mail', user_google_email: email }, core, originFor(2), signal);
  assert.equal(none.outcome === 'READ' && none.status, 'complete', 'only a complete answer may say there is none');
  const limited = await service.call(tool(GMAIL_TOOLS.search), { query: 'in:inbox', user_google_email: email }, core, originFor(3), signal);
  assert.equal(limited.outcome === 'READ' && limited.status, 'rate-limited', 'a 429 is never an empty inbox');
  assert.equal(limited.outcome==='READ'&&limited.observed,true,'this fake Gmail 429 is an actual isError result, not an exception guessed from text');

  const draft = await service.call(tool(GMAIL_TOOLS.draft), { user_google_email: email, to: 'someone@example.com', subject: 'Re: launch', body: 'Draft.' }, core, originFor(4), signal);
  const send = await service.call(tool(GMAIL_TOOLS.send), { user_google_email: email, to: 'someone@example.com', subject: 'Re: launch', body: 'Sent?' }, core, originFor(5), signal);
  assert.deepEqual([draft.outcome, send.outcome], ['HELD', 'HELD']);
  const held = service.list().held.find((x) => x.tool === GMAIL_TOOLS.send)!;
  assert.ok((await service.decide(held.effect, held.argsHash, 'release')).ok);
  const after = readFakeGmailState(state);
  assert.deepEqual([after.drafts.length, after.sendRequests.length, after.sent.length], [0, 0, 0], 'nothing reached the mailbox, released or not');
});
