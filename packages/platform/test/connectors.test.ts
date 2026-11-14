import { document, systemFixture } from './policy-fixture.ts';
import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
// The person's MCP servers behind one governed crossing (connectors/service.ts): found in their own
// configs with no variable's value kept, offered only as enabled and pinned, read with an honest
// status and recorded as the run's source, and an effect held for the person on its exact statement,
// never sent.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CoreLink, type RunHandle } from '../src/composition/core.ts';
import { blocked, type ConnectorCore, ConnectorService, EGRESS_CLOSED, type OfferedTool } from '../src/connectors/service.ts';
import { discover, secretValues, shownOf } from '../src/connectors/discover.ts';
import { movesCredentialCache } from '../src/connectors/credential-args.ts';
import { open } from './helpers.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, freshHome, value } from './helpers.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { typedMaterialGateway } from './fixtures/typed-material-gateway.ts';

const server = join(import.meta.dirname, 'fake-mcp-server.ts');
/** Stands for a value a config keeps beside a server, such as a token: it must never reach the home. */
const KEPT_VALUE = 'value-only-in-the-persons-config-41d9';
const links: CoreLink[] = [];
const services: ConnectorService[] = [];
after(async () => { await Promise.all(services.map((s) => s.close())); await Promise.all(links.map((l) => l.close())); });

/** A home and a person whose configs hold the fake server, Backbone's own door, and a server from Codex. */
function person(policyAdmission?: () => void) {
  const home = freshHome();
  const personHome = freshDir('backbone-person-');
  const log = join(personHome, 'calls.jsonl');
  const write = (variant = 'plain', more: Record<string, string> = {}, logFile = log) => writeFileSync(join(personHome, '.claude.json'), JSON.stringify({ mcpServers: {
    notes: { command: process.execPath, args: [server], env: { FAKE_MCP_LOG: logFile, FAKE_MCP_VARIANT: variant, NOTES_VALUE: KEPT_VALUE, ...more } },
    'backbone-door': { command: process.execPath, args: ['/somewhere/backbone-mcp', 'serve'] },
  } }));
  write();
  mkdirSync(join(personHome, '.codex'));
  writeFileSync(join(personHome, '.codex', 'config.toml'), `[mcp_servers.tracker]\ncommand = "tracker-mcp"\nargs = ["--stdio"]\n[mcp_servers.tracker.env]\nTRACKER_VALUE = "${KEPT_VALUE}"\n`);
  const t = defaultToolEnv({ HOME: personHome, PATH: process.env.PATH });
  const box: { link?: CoreLink } = {};
  const service = new ConnectorService({ home, policyAdmission, env: () => t, link: async () => (box.link ??= await CoreLink.open({ home })), callTimeoutMs: 3_000 });
  services.push(service);
  return { home, personHome, log, service, box, write };
}
type Person = ReturnType<typeof person>;

async function run(p: Person) {
  const link = (p.box.link ??= await CoreLink.open({ home: p.home }));
  links.push(link);
  const h: RunHandle = await link.startRun(await link.createTask('Connectors'));
  const material=new MaterialStore(p.home,{},()=>{});
  const {gateway,observations}=typedMaterialGateway({home:p.home,link,handle:h,material,threadId:'t',turnId:'turn-1'});
  const core:ConnectorCore=gateway.connector!;
  await core.prepareProtocol(false);
  return { link, h, core, observations };
}

async function enableAll(p: Person, id = 'claude-code:notes') {
  const listed = await p.service.refresh(id);
  assert.ok(listed.ok, JSON.stringify(listed));
  await p.service.set(id, { enabled: true });
  for (const t of listed.value.tools) await p.service.set(id, { tool: { name: t.name, enabled: true } });
}
const tool = (p: Person, name: string): OfferedTool => p.service.offered().find((t) => t.tool === name)!;
// Native identities belong to this controlled engine fixture, never an argument/display fallback.
const originFor = (seq=1) => ({ threadId: 't', turnId: 'turn-1', seq,
  invocation:{engine:'codex' as const,namespace:JSON.stringify(['fixture-native-thread','fixture-native-turn']),callId:`native-fixture-call-${seq}`} });
const origin = originFor();
const calls = (p: Person) => (existsSync(p.log) ? readFileSync(p.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string }) : []);
const EFFECTS = ['delete_note', 'plain', 'odd', 'draft_note', 'refuse_note', 'lost_note'];

test('servers are found in the person\'s configs, without Backbone\'s own door, and no variable\'s value is kept or shown', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  const view = p.service.list();
  assert.deepEqual(view.servers.map((s) => s.id).sort(), ['claude-code:notes', 'codex:tracker']);
  assert.deepEqual(view.servers.find((s) => s.id === 'codex:tracker')?.envNames, ['TRACKER_VALUE']);
  assert.equal(view.egress, 'per-server');
  assert.ok(view.servers.every((x) => !x.egress), 'every door closed until the person opens one');
  await enableAll(p);
  assert.doesNotMatch(JSON.stringify(p.service.list()), new RegExp(KEPT_VALUE));
  const kept = readdirSync(join(p.home, 'connectors')).map((f) => readFileSync(join(p.home, 'connectors', f), 'utf8')).join('');
  assert.doesNotMatch(kept, new RegExp(KEPT_VALUE), 'the home keeps no value of a variable');
});

test('each tool is a read or an effect: annotations, the person\'s word over them, and an effect when it says nothing', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  const listed = await p.service.refresh('claude-code:notes');
  assert.ok(listed.ok);
  const kinds = Object.fromEntries(listed.value.tools.map((t) => [t.name, `${t.kind}/${t.annotated}`]));
  assert.deepEqual(kinds, { busy: 'read/read', delete_note: 'effect/effect', draft_note: 'effect/effect', echo_value: 'read/read', lost_note: 'effect/effect', list_pages: 'read/read', mixed: 'read/read', odd: 'effect/effect', plain: 'effect/unannotated', refuse_note: 'effect/effect', search: 'read/read', slow: 'read/read' });
  assert.ok(listed.value.tools.every((t) => !t.enabled), 'nothing is on until the person turns it on');
  const said = await p.service.set('claude-code:notes', { tool: { name: 'plain', override: 'read' } });
  assert.ok(said.ok);
  assert.equal(said.value.tools.find((t) => t.name === 'plain')?.kind, 'read');
  const back = await p.service.set('claude-code:notes', { tool: { name: 'search', override: 'effect' } });
  assert.ok(back.ok);
  assert.equal(back.value.tools.find((t) => t.name === 'search')?.kind, 'effect');
});

test('an engine is offered only what the person enabled, and a server or tool that changed is off until enabled again', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  assert.deepEqual(p.service.offered(), [], 'nothing before the person chooses');
  const refused = await p.service.set('claude-code:notes', { enabled: true });
  assert.equal(refused.ok, false, 'not before its tools are listed');
  await p.service.refresh('claude-code:notes');
  await p.service.set('claude-code:notes', { enabled: true });
  await p.service.set('claude-code:notes', { tool: { name: 'search', enabled: true } });
  assert.deepEqual(p.service.offered().map((t) => [t.name, t.kind]), [['mcp__notes__search', 'read']]);
  // A variable added to how it starts is a change of the server.
  p.write('plain', { EXTRA: 'x' });
  assert.deepEqual(p.service.offered(), []);
  assert.equal(p.service.list().servers.find((s) => s.id === 'claude-code:notes')?.changed, true);
  // Enabled again, then its tool's description changes under the approval: that tool turns off, and says why.
  await p.service.set('claude-code:notes', { enabled: true });
  p.write('swapped', { EXTRA: 'x' });
  const relisted = await p.service.refresh('claude-code:notes');
  assert.ok(relisted.ok);
  const search = relisted.value.tools.find((t) => t.name === 'search')!;
  assert.equal(search.changed, true);
  assert.equal(search.enabled, false);
  assert.deepEqual(p.service.offered(), []);
});

test('a read comes back with how complete it is, and is recorded first as the connection\'s untrusted, private answer', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  await enableAll(p);
  const { link, h, core, observations } = await run(p);
  const signal = new AbortController().signal;
  const full = await p.service.call(tool(p, 'search'), { q: 'launch' }, core, origin, signal);
  assert.equal(full.outcome === 'READ' && full.status, 'complete');
  assert.match(full.outcome === 'READ' ? full.text : '', /note about launch/);
  const paged = await p.service.call(tool(p, 'list_pages'), {}, core, originFor(2), signal);
  assert.equal(paged.outcome === 'READ' && paged.status, 'partial');
  assert.match(paged.outcome === 'READ' ? paged.detail ?? '' : '', /not everything/);
  const limited = await p.service.call(tool(p, 'busy'), {}, core, originFor(3), signal);
  assert.equal(limited.outcome === 'READ' && limited.status, 'rate-limited');
  assert.match(limited.outcome === 'READ' ? limited.detail ?? '' : '', /says nothing about what exists/);
  const slow = await p.service.call(tool(p, 'slow'), {}, core, originFor(4), signal);
  assert.equal(slow.outcome,'UNKNOWN','a dispatched call without an observed SDK result cannot fabricate a source');
  assert.equal(core.pending(),false,'no observed response awaits registration; this is not acknowledgement of the uncertain dispatch');
  const unresolved=observations.forProject(link.id.workspace,'project').filter(value=>value.request.origin.callId===originFor(4).invocation.callId);
  assert.equal(unresolved.length,1,'the exact original native invocation remains in retained history');
  const uncertain=unresolved[0];
  assert.equal(uncertain.phase,'unknown');assert.equal(uncertain.dispatched,true);
  assert.equal(uncertain.response,undefined);assert.equal(uncertain.material,undefined);assert.equal(uncertain.confirmation,undefined);assert.deepEqual(uncertain.tentatives,[]);
  assert.equal(calls(p).filter(call=>call.tool==='slow').length,1);
  const repeated=await p.service.call(tool(p,'slow'),{},core,originFor(4),signal);
  assert.equal(repeated.outcome,'UNKNOWN','the same uncertain invocation never becomes a fresh provider request');
  assert.equal(calls(p).filter(call=>call.tool==='slow').length,1,'uncertain native invocation was not sent twice');
  assert.deepEqual(observations.get(uncertain.id),uncertain,'the unresolved original history was neither acknowledged nor replaced');
  const { rows } = await link.read<{ kind: string; trust: string; sensitive: boolean }>(link.system(), 'SELECT source_kind AS kind, trust, sensitive FROM app.episodes WHERE run_id = $1 ORDER BY created_at', [h.run]);
  assert.deepEqual(rows.map((r) => [r.kind, r.trust, r.sensitive]), Array(3).fill(['mcp', 'untrusted', true]), 'each observed result is recorded; a timeout manufactures no fourth episode');
  const { rows: marks } = await link.read<{ untrusted: boolean; sensitive: boolean }>(link.system(), 'SELECT tainted_untrusted AS untrusted, tainted_sensitive AS sensitive FROM app.runs WHERE id = $1', [h.run]);
  assert.deepEqual({ ...marks[0] }, { untrusted: true, sensitive: true }, 'the run carries what it read');
});

test('an effect is held for the person on its exact statement, and a release sends nothing', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  await enableAll(p);
  const { link, core } = await run(p);
  const signal = new AbortController().signal;
  for (const [i, [name, args]] of ([['delete_note', { id: 'n1' }], ['plain', { x: 'y' }], ['odd', {}]] as const).entries()) {
    const held = await p.service.call(tool(p, name), args, core, originFor(i + 1), signal);
    assert.equal(held.outcome, 'HELD', name);
  }
  assert.deepEqual(calls(p).filter((c) => EFFECTS.includes(c.tool)), [], 'no effect reached the server');
  const del = p.service.list().held.find((h) => h.tool === 'delete_note')!;
  assert.equal(del.statement, 'Call delete_note on notes with exactly: {"id":"n1"}');
  const { rows } = await link.read<{ status: string; effect_class: number; operation: string }>(link.system(), 'SELECT status, effect_class, operation FROM app.effects WHERE id = $1', [del.effect]);
  assert.deepEqual({ ...rows[0] }, { status: 'awaiting_checker', effect_class: 5, operation: 'mcp.c_notes.delete_note' });
  const wrong = await p.service.decide(del.effect, 'not-the-statement', 'release');
  assert.equal(wrong.ok, false, 'an answer on another statement decides nothing');
  const released = await p.service.decide(del.effect, del.argsHash, 'release');
  assert.ok(released.ok);
  assert.equal(released.value.state, 'released');
  // 10 November 2026, owner direction: a send is a signed tool like any other; closing the door still prevents dispatch.
  assert.equal(released.value.detail, EGRESS_CLOSED, 'the closed door prevents dispatch');
  const { rows: after } = await link.read<{ status: string; verdict: string }>(link.system(), 'SELECT e.status, d.status AS verdict FROM app.effects e JOIN app.decisions d ON d.id = e.decision_id WHERE e.id = $1', [del.effect]);
  assert.deepEqual({ ...after[0] }, { status: 'cancelled', verdict: 'approved' }, 'the word is recorded; the crossing stayed closed');
  const plain = p.service.list().held.find((h) => h.tool === 'plain')!;
  const discarded = await p.service.decide(plain.effect, plain.argsHash, 'discard');
  assert.ok(discarded.ok);
  assert.equal(discarded.value.state, 'discarded');
  assert.deepEqual(calls(p).filter((c) => EFFECTS.includes(c.tool)), [], 'still nothing sent');
});

test('a tool swapped since it was enabled is not called, and turns off', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  await enableAll(p);
  const offered = tool(p, 'search');
  const { core } = await run(p);
  await p.service.close();
  // It starts the same way (the same variable names), and now describes the tool differently.
  p.write('swapped');
  const again = new ConnectorService({ home: p.home, env: () => defaultToolEnv({ HOME: p.personHome, PATH: process.env.PATH }), link: async () => p.box.link!, callTimeoutMs: 3_000 });
  services.push(again);
  const answer = await again.call(offered, { q: 'x' }, core, origin, new AbortController().signal);
  assert.equal(answer.outcome, 'REFUSED');
  assert.match(answer.outcome === 'REFUSED' ? answer.detail : '', /changed since the person enabled it/);
  assert.equal(again.offered().some((t) => t.tool === 'search'), false);
  assert.deepEqual(calls(p).filter((c) => c.tool === 'search'), []);
});

test('a value from the server\'s config never leaves it: not in an answer, an error or a listing problem', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  await enableAll(p);
  const { core } = await run(p);
  const echoed = await p.service.call(tool(p, 'echo_value'), {}, core, origin, new AbortController().signal);
  assert.equal(echoed.outcome, 'READ');
  assert.doesNotMatch(JSON.stringify(echoed), new RegExp(KEPT_VALUE));
  assert.match(echoed.outcome === 'READ' ? echoed.text : '', /configured with \[hidden\]/);
  await p.service.close();
  p.write('plain', { FAKE_MCP_FAIL_START: '1' });
  const failing = new ConnectorService({ home: p.home, env: () => defaultToolEnv({ HOME: p.personHome, PATH: process.env.PATH }), link: async () => p.box.link!, callTimeoutMs: 3_000 });
  services.push(failing);
  const listed = await failing.refresh('claude-code:notes');
  assert.ok(listed.ok);
  assert.ok(listed.value.problem, 'it could not be listed');
  assert.doesNotMatch(JSON.stringify(failing.list()) + readFileSync(join(p.home, 'connectors', 'mcp.json'), 'utf8'), new RegExp(KEPT_VALUE));
});

test('a tool the person makes an effect, or turns off, while a call is on its way is not called as a read', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  await enableAll(p);
  const { core } = await run(p);
  // A changed value means the call starts the server afresh, which takes a moment; the person changes their mind meanwhile.
  p.write('plain', {}, join(p.personHome, 'second.jsonl'));
  const pending = p.service.call(tool(p, 'search'), { q: 'launch' }, core, origin, new AbortController().signal);
  await p.service.set('claude-code:notes', { tool: { name: 'search', override: 'effect' } });
  assert.equal((await pending).outcome, 'HELD');
  p.write('plain', {}, join(p.personHome, 'third.jsonl'));
  const off = p.service.call(tool(p, 'list_pages'), {}, core, originFor(2), new AbortController().signal);
  await p.service.set('claude-code:notes', { tool: { name: 'list_pages', enabled: false } });
  assert.equal((await off).outcome, 'REFUSED');
  const reached = ['calls.jsonl', 'second.jsonl', 'third.jsonl'].flatMap((f) => (existsSync(join(p.personHome, f)) ? readFileSync(join(p.personHome, f), 'utf8').trim().split('\n').filter(Boolean) : []));
  assert.deepEqual(reached, [], 'neither reached the server');
});

test('a server whose config now points elsewhere gets a new session, never the old one', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  await enableAll(p);
  const { core } = await run(p);
  assert.equal((await p.service.call(tool(p, 'search'), { q: 'a' }, core, origin, new AbortController().signal)).outcome, 'READ');
  const elsewhere = join(p.personHome, 'elsewhere.jsonl');
  p.write('plain', {}, elsewhere);
  assert.equal((await p.service.call(tool(p, 'search'), { q: 'b' }, core, originFor(2), new AbortController().signal)).outcome, 'READ');
  assert.deepEqual(readFileSync(elsewhere, 'utf8').trim().split('\n').map((l) => JSON.parse(l).args.q), ['b'], 'the second call reached the server the config names now');
  assert.deepEqual(calls(p).filter((c) => c.tool === 'search').length, 1);
});

test('an answer is partial when either its structured part or its text says more remain', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  await enableAll(p);
  const { core } = await run(p);
  const mixed = await p.service.call(tool(p, 'mixed'), {}, core, origin, new AbortController().signal);
  assert.equal(mixed.outcome === 'READ' && mixed.status, 'partial');
});

test('a short credential, and a value a server puts in its own listing, are hidden too', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  p.write('leaky', { PIN_CODE: '73x' });
  await enableAll(p);
  const { core } = await run(p);
  const listed = JSON.stringify(p.service.list()) + JSON.stringify(p.service.offered()) + readFileSync(join(p.home, 'connectors', 'mcp.json'), 'utf8');
  assert.doesNotMatch(listed, new RegExp(KEPT_VALUE), 'not in what is shown, offered to an engine or kept');
  assert.match(listed, /such as \[hidden\]/);
  const echoed = await p.service.call(tool(p, 'echo_value'), {}, core, origin, new AbortController().signal);
  assert.equal(echoed.outcome === 'READ' && echoed.text, 'configured with [hidden] and pin [hidden]');
});

test('an offer a turn holds is for the server and definition it saw: one changed since is never called in its place', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  await enableAll(p);
  const { core } = await run(p);
  const offeredToTheTurn = tool(p, 'search');
  // The config now starts another server; the person lists it and turns it on again, and the turn calls what it was offered.
  const elsewhere = join(p.personHome, 'elsewhere.jsonl');
  p.write('swapped', {}, elsewhere);
  await enableAll(p);
  const stale = await p.service.call(offeredToTheTurn, { q: 'meant for the first' }, core, origin, new AbortController().signal);
  assert.equal(stale.outcome, 'REFUSED');
  assert.ok(!existsSync(elsewhere) || readFileSync(elsewhere, 'utf8').trim() === '', 'nothing reached the server the config names now');
  assert.deepEqual(calls(p).filter((c) => c.tool === 'search'), [], 'nor the one it named before');
  assert.equal((await p.service.call(tool(p, 'search'), { q: 'fresh' }, core, originFor(2), new AbortController().signal)).outcome, 'READ', 'a fresh offer works');
});

test('the egress door: a call the person releases on a server they opened is sent once; blocklisted, closed, turned-down and unanswered calls each say so', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  await enableAll(p);
  const { link, core } = await run(p);
  const signal = new AbortController().signal;
  const hold = async (name: string, args: Record<string, unknown>, seq: number) => {
    assert.equal((await p.service.call(tool(p, name), args, core, originFor(seq), signal)).outcome, 'HELD', name);
    return p.service.list().held.find((h) => h.tool === name && h.state === 'waiting')!;
  };
  const status = async (effect: string) => (await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.effects WHERE id = $1', [effect])).rows[0].status;

  // Closed by default: released, recorded, not sent.
  const closed = await hold('draft_note', { text: 'first' }, 1);
  assert.equal(value(await p.service.decide(closed.effect, closed.argsHash, 'release')).detail, EGRESS_CLOSED);
  assert.equal(calls(p).filter((c) => c.tool === 'draft_note').length, 0);

  // The door opens only on a server that is on.
  await p.service.set('claude-code:notes', { enabled: false });
  assert.equal((await p.service.set('claude-code:notes', { egress: true, seal: p.service.doorSeal('claude-code:notes')! })).ok, false);
  await p.service.set('claude-code:notes', { enabled: true });
  assert.equal((await p.service.set('claude-code:notes', { egress: true, seal: 'what-was-shown-earlier' })).ok, false, 'a server that changed while the person was asked is not opened');
  assert.ok((await p.service.set('claude-code:notes', { egress: true, seal: p.service.doorSeal('claude-code:notes')! })).ok);
  assert.equal(p.service.list().servers.find((s) => s.id === 'claude-code:notes')!.egress, true);

  // Open: a released draft is sent, once, and the core records it done.
  const draft = await hold('draft_note', { text: 'second' }, 2);
  const sent = value(await p.service.decide(draft.effect, draft.argsHash, 'release'));
  assert.equal(sent.state, 'sent');
  assert.deepEqual(calls(p).filter((c) => c.tool === 'draft_note').map((c) => (c as unknown as { args: unknown }).args), [{ text: 'second' }]);
  assert.equal((await p.service.decide(draft.effect, draft.argsHash, 'release')).ok, true);
  assert.equal(calls(p).filter((c) => c.tool === 'draft_note').length, 1, 'deciding again sends nothing more');
  assert.notEqual(await status(draft.effect), 'cancelled');

  // 10 November 2026, owner direction: a send is a signed tool like any other; the person can release this exact listed call.
  const del = await hold('delete_note', { id: 'n1' }, 3);
  assert.equal(value(await p.service.decide(del.effect, del.argsHash, 'release')).state, 'sent');
  assert.equal(calls(p).filter((c) => c.tool === 'delete_note').length, 1);
  assert.equal(await status(del.effect), 'succeeded');

  // Security review M2: server refusal prose after invocation is not proof of no effect.
  const refused = await hold('refuse_note', {}, 4);
  assert.equal(value(await p.service.decide(refused.effect, refused.argsHash, 'release')).state, 'unknown');

  // No answer: UNKNOWN, never sent again.
  const lost = await hold('lost_note', {}, 5);
  const unknown = value(await p.service.decide(lost.effect, lost.argsHash, 'release'));
  assert.equal(unknown.state, 'unknown');
  assert.match(unknown.detail, /UNKNOWN/);
  await p.service.decide(lost.effect, lost.argsHash, 'release');
  assert.equal(calls(p).filter((c) => c.tool === 'lost_note').length, 1, 'an UNKNOWN is never sent again');

  // Another account under the same names: the door's seal no longer holds, so nothing is sent.
  const before = await hold('draft_note', { text: 'third' }, 6);
  p.write('plain', { NOTES_VALUE: 'another-account-token-value' });
  const resealed = value(await p.service.decide(before.effect, before.argsHash, 'release'));
  assert.equal(resealed.state, 'released');
  assert.match(resealed.detail, /changed since this call was held/);
  assert.equal(calls(p).filter((c) => c.tool === 'draft_note').length, 1, 'still only the one draft');

  // Turning the server off closes its door.
  await p.service.set('claude-code:notes', { enabled: false });
  assert.equal(p.service.list().servers.find((s) => s.id === 'claude-code:notes')!.egress, false);
});

test('the blocklist reads every casing and joining, and arguments that ask to send', () => {
  for (const name of ['postmessage', 'buynow', 'chargecard', 'reorder', 'send_email', 'sendEmail', 'sendemail', 'SEND', 'gmail.send', 'deleteMessage', 'trash_thread', 'reply_all', 'forward', 'make_payment', 'pay', 'publish_post', 'share', 'invite_user', 'post', 'transfer_funds'])
    assert.equal(blocked(name), true, name);
  for (const name of ['draft_gmail_message', 'create_draft', 'add_label', 'search', 'read_thread', 'list_drafts', 'draft_note', 'display_draft', 'support_ticket_draft'])
    assert.equal(blocked(name), false, name);
  // 10 November 2026, owner direction: a send is a signed tool like any other; the list classifies names, never arguments.
  assert.equal(blocked('create_draft', { to: 'a@b.c', send: true }), false, 'arguments do not change name classification');
  assert.equal(blocked('create_draft', { options: { sendNow: 'yes' } }), false, 'nested arguments remain data');
  assert.equal(blocked('create_draft', { send: false }), false);
  let deep: Record<string, unknown> = { send: true };
  for (let i = 0; i < 10; i++) deep = { inner: deep };
  assert.equal(blocked('create_draft', deep), false, 'deep arguments remain data');
  let deeper: Record<string, unknown> = { note: 'ok' };
  for (let i = 0; i < 40; i++) deeper = { inner: deeper };
  assert.equal(blocked('create_draft', deeper), false, 'name classification never traverses arguments');
});

test('what is shown of a server hides credentials in its address and arguments', () => {
  assert.equal(shownOf({ transport: 'http', url: 'https://user:pass@mcp.example.com/v1?token=abc&x=1#frag', headers: {} }), 'https://***@mcp.example.com/v1?token=***&x=***');
  assert.equal(shownOf({ transport: 'stdio', command: 'srv', args: ['--token', 'abc123', '--api-key=xyz', '--access-token=short', '--name', 'ok', `sk-${'a'.repeat(20)}`], env: {} }), 'srv --token *** --api-key=*** --access-token=*** --name ok ***');
  assert.equal(shownOf({ transport: 'http', url: `https://hooks.example.com/services/${'T'.repeat(40)}/x`, headers: {} }), 'https://hooks.example.com/services/***/x');
});

test('the api cannot release a call or open a door: only the app\'s main process can, after asking the person', async () => {
  const { host } = open();
  const release = await host.call('connectors.decide', { effect: 'e', argsHash: 'h', verdict: 'release' });
  assert.equal(release.ok, false);
  assert.match(release.ok ? '' : release.detail, /Only the person releases/);
  const read = await host.call('connectors.set', { serverId: 'claude-code:notes', tool: { name: 'plain', override: 'read' } });
  assert.equal(read.ok, false, 'nor say a tool only reads when it does not say so itself');
  const door = await host.call('connectors.set', { serverId: 'claude-code:notes', egress: true });
  assert.equal(door.ok, false);
  assert.match(door.ok ? '' : door.detail, /Only the person allows sending/);
});

test('a credential in a server address is hidden as written and as decoded, so an echo of either is caught', () => {
  const token = 'tok/en+with spaces&more_and_long_enough_to_be_a_secret_value_1234';
  const enc = encodeURIComponent(token);
  const values = secretValues({ transport: 'http', url: `https://u:${encodeURIComponent('p@ss')}@mcp.example.com/${enc}?key=${encodeURIComponent('k=1&2')}`, headers: {} });
  for (const v of ['p@ss', encodeURIComponent('p@ss'), 'k=1&2', encodeURIComponent('k=1&2'), token, enc]) assert.ok(values.includes(v), v);
});

test('the person\'s word that a tool only reads goes when the tool changes', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  await enableAll(p);
  assert.ok((await p.service.set('claude-code:notes', { tool: { name: 'search', override: 'read' } })).ok);
  p.write('swapped');
  await p.service.refresh('claude-code:notes');
  const search = p.service.list().servers.find((x) => x.id === 'claude-code:notes')!.tools.find((t) => t.name === 'search')!;
  assert.equal(search.override, undefined, 'the override was for the tool they saw');
  assert.equal(search.enabled, false);
});

test('a read whose argument is a relative alias to a credential place in the server\'s own folder is refused before the server sees it', async () => {
  const p = person();
  const folder = freshDir('backbone-server-folder-');
  mkdirSync(join(p.personHome, '.ssh'));
  symlinkSync(join(p.personHome, '.ssh'), join(folder, 'plain'));
  writeFileSync(join(p.personHome, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [server], cwd: folder, env: { FAKE_MCP_LOG: p.log } } } }));
  await enableAll(p);
  const { core } = await run(p);
  const signal = new AbortController().signal;
  const refused = await p.service.call(tool(p, 'search'), { q: 'plain/id_ed25519' }, core, origin, signal);
  assert.equal(refused.outcome, 'REFUSED');
  assert.match(refused.detail ?? '', /credentials/);
  const calls = existsSync(p.log) ? readFileSync(p.log, 'utf8') : '';
  assert.doesNotMatch(calls, /id_ed25519/, 'the server never saw it');
  const fine = await p.service.call(tool(p, 'search'), { q: 'launch' }, core, originFor(2), signal);
  assert.notEqual(fine.outcome, 'REFUSED', JSON.stringify(fine));
});

test('a server whose config moves its sign-in cache, by its variable or its home, over stdio or HTTP, is never offered', async () => {
  const p = person();
  writeFileSync(join(p.personHome, '.claude.json'), JSON.stringify({ mcpServers: {
    notes: { command: process.execPath, args: [server], env: { FAKE_MCP_LOG: p.log } },
    homed: { command: process.execPath, args: [server], env: { FAKE_MCP_LOG: p.log, HOME: freshDir('backbone-other-home-') } },
    remote: { url: 'http://127.0.0.1:9/mcp', env: { MCP_REMOTE_CONFIG_DIR: freshDir('backbone-moved-') } },
  } }));
  for (const id of ['claude-code:notes', 'claude-code:homed']) await enableAll(p, id);
  const servers = new Set(p.service.offered().map((t) => t.serverName));
  assert.ok(servers.has('notes'));
  assert.ok(!servers.has('homed'), 'its own HOME');
  const remote = discover(p.home, defaultToolEnv({ HOME: p.personHome, PATH: process.env.PATH }), ['claude-code']).find((d) => d.server.name === 'remote')!;
  assert.equal(remote.launch.transport, 'http');
  assert.equal(movesCredentialCache(remote.launch), true, 'a cache variable beside an address is seen');
});

test('a server started inside, or pointed at, a credential place is never offered', async () => {
  const p = person();
  mkdirSync(join(p.personHome, '.ssh'));
  writeFileSync(join(p.personHome, '.claude.json'), JSON.stringify({ mcpServers: {
    notes: { command: process.execPath, args: [server], env: { FAKE_MCP_LOG: p.log } },
    rooted: { command: process.execPath, args: [server, '--root', join(p.personHome, '.ssh')], env: { FAKE_MCP_LOG: p.log } },
    inside: { command: process.execPath, args: [server], cwd: join(p.personHome, '.ssh'), env: { FAKE_MCP_LOG: p.log } },
  } }));
  for (const id of ['claude-code:notes', 'claude-code:rooted', 'claude-code:inside']) await enableAll(p, id);
  const servers = new Set(p.service.offered().map((t) => t.serverName));
  assert.ok(servers.has('notes'));
  assert.ok(!servers.has('rooted'), 'an argument naming a credential place');
  assert.ok(!servers.has('inside'), 'started inside one');
});

test('a read-only turn is refused, not held, when a tool it calls counts as an action now', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  await enableAll(p);
  const { core } = await run(p);
  const signal = new AbortController().signal;
  const refused = await p.service.call(tool(p, 'draft_note'), { text: 'from a reviewer' }, core, { ...origin, readOnly: true }, signal);
  assert.equal(refused.outcome, 'REFUSED');
  assert.match((refused as { detail: string }).detail, /only reads/);
  assert.deepEqual(p.service.list().held, [], 'nothing is held for the person from a review');
  assert.deepEqual(calls(p).filter((c) => c.tool === 'draft_note'), [], 'and nothing reached the server');
  assert.equal((await p.service.call(tool(p, 'draft_note'), { text: 'ordinary' }, core, originFor(2), signal)).outcome, 'HELD', 'the control: an ordinary turn\'s call is held');
});

test('a server\'s answer kept as a document stays untrusted when another task reads it later', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  await enableAll(p);
  const { link, core } = await run(p);
  const signal = new AbortController().signal;
  assert.equal((await p.service.call(tool(p, 'search'), { q: 'x' }, core, origin, signal)).outcome, 'READ');
  const material = new MaterialStore(join(p.home, 'material-test'), {}, () => {});
  const search = tool(p, 'search');
  const kept = material.create('project', 'From notes · search.md', 'text/markdown', Buffer.from('server words'), 'original', 'person', undefined, 'managed', undefined, { connection: search.connection.id, tool: 'search' });
  const typed = material.create('project', 'mine.md', 'text/markdown', Buffer.from('my words'), 'original', 'person');
  // Kept before origins were recorded: a managed original with no fromServer.
  const older = material.create('project', 'From notes · search · old.md', 'text/markdown', Buffer.from('older server words'), 'original', 'person', undefined, 'managed');
  // Another task, later: a worker reading what an earlier turn kept.
  const later = await link.startRun(await link.createTask('Later work'));
  const {gateway}=typedMaterialGateway({home:p.home,link,handle:later,threadId:'later',turnId:'later-1',material});
  for(const entry of [kept,typed,older])await gateway.read({materialId:entry.id,name:entry.name,version:entry.current,withdrawals:0,profile:'harness'});
  const trust = async (content: string) => (await link.read<{ trust: string }>(link.system(), 'SELECT trust FROM app.episodes WHERE run_id = $1 AND content = $2', [later.run, content])).rows.map((r) => r.trust);
  assert.deepEqual(await trust('server words'), ['untrusted'], 'the server\'s words keep their mark');
  assert.deepEqual(await trust('my words'), ['trusted'], 'the control: the person\'s own words are trusted');
  assert.deepEqual(await trust('older server words'), ['untrusted'], 'one kept before origins were recorded is untrusted too');
});

test('a standing signature: the person signs one tool once and its calls go out with no question each; a change in what was signed ends it', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  await enableAll(p);
  const { link, core } = await run(p);
  const signal = new AbortController().signal;
  const id = 'claude-code:notes';
  const call = (name: string, args: Record<string, unknown>, more: { turnId?: string; readOnly?: boolean } = {}) => p.service.call(tool(p, name), args, core, { ...origin, turnId: 'turn-standing', ...more }, signal);
  const sentTo = (name: string) => calls(p).filter((c) => c.tool === name).length;
  // As the app's main process does: the seal and the definition the person was shown, then their click.
  const sign = (name: string, standing: { blockedToo?: boolean } = {}) => p.service.set(id, { seal: p.service.doorSeal(id)!, tool: { name, standing: { stamp: p.service.toolView(id, name)?.stamp ?? 'nothing-to-sign-as-it-is-now', ...standing } } });
  const stored = () => JSON.parse(readFileSync(join(p.home, 'connectors', 'mcp.json'), 'utf8')) as { servers: Record<string, { tools: Record<string, { standing?: { home: string } }> }> };
  const shown = (name: string) => p.service.list().servers.find((s) => s.id === id)!.tools.find((t) => t.name === name)!;

  // No signature without an open door, and none by default: an effect waits for the person, as before.
  assert.equal((await sign('draft_note')).ok, false, 'a tool is signed only through an open door');
  assert.ok((await p.service.set(id, { egress: true, seal: p.service.doorSeal(id)! })).ok);
  const waiting = await call('draft_note', { text: 'unsigned' });
  assert.equal(waiting.outcome, 'HELD');
  assert.equal(sentTo('draft_note'), 0);

  // The signature is for the server as the person was shown it, for an effect, and a blocklisted tool needs the stronger one.
  assert.match(p.service.toolView(id, 'draft_note')?.stamp ?? '', /^[0-9a-f]{64}$/, 'what the person is shown carries the stamp the click signs');
  assert.equal(p.service.toolView(id, 'search'), null, 'a read has nothing to sign');
  assert.equal((await p.service.set(id, { seal: 'what-was-shown-earlier', tool: { name: 'draft_note', standing: { stamp: p.service.toolView(id, 'draft_note')!.stamp } } })).ok, false);
  const stale = await p.service.set(id, { seal: p.service.doorSeal(id)!, tool: { name: 'draft_note', standing: { stamp: 'the-tool-as-shown-before-it-changed' } } });
  assert.match(stale.ok ? '' : stale.detail, /changed while you were asked/, 'a tool listed or turned on again while the question was open is not signed by the old click');
  assert.equal((await sign('search')).ok, false, 'a read needs no signature');
  // 10 November 2026, owner direction: a send is a signed tool like any other; one signature suffices.
  assert.equal((await sign('delete_note')).ok, true, 'the same signing path applies to a listed tool');
  value(await p.service.set(id, { tool: { name: 'delete_note', standing: false } }));
  assert.equal(shown('draft_note').standing, undefined);

  // Signed once: the next call goes out at once, exactly once, with the person's approval recorded on that signature.
  assert.ok(value(await sign('draft_note')).tools.find((t) => t.name === 'draft_note')!.standing);
  const out = await call('draft_note', { text: 'signed' });
  assert.equal(out.outcome, 'SENT');
  assert.equal(out.outcome === 'SENT' && out.state, 'sent');
  assert.deepEqual(calls(p).filter((c) => c.tool === 'draft_note').map((c) => (c as unknown as { args: unknown }).args), [{ text: 'signed' }]);
  const again = await call('draft_note', { text: 'signed' });
  assert.equal(again.outcome, 'SENT', 'the same call from the same turn is the same call');
  assert.equal(sentTo('draft_note'), 1, 'and it is not sent twice');
  const effect = out.outcome === 'SENT' ? out.effect : '';
  const record = p.service.list().held.find((h) => h.effect === effect)!;
  assert.equal(record.state, 'sent');
  assert.equal(record.standing, true, 'the record says nobody was asked about this one call');
  const { rows } = await link.read<{ status: string; verdict: string; note: string }>(link.system(),
    'SELECT e.status, d.status AS verdict, d.note FROM app.effects e JOIN app.decisions d ON d.id = e.decision_id WHERE e.id = $1', [effect]);
  assert.equal(rows[0].status, 'succeeded');
  assert.equal(rows[0].verdict, 'approved');
  assert.match(rows[0].note, /standing signature for draft_note/);

  // Another tool of the same server is not signed by it, and a turn that only reads never sends.
  assert.equal((await call('plain', {})).outcome, 'HELD');
  // A call the person released themselves, asked again by the same turn, is not passed off as the signature's.
  const byHand = p.service.list().held.find((h) => h.tool === 'plain' && h.state === 'waiting')!;
  assert.equal(value(await p.service.decide(byHand.effect, byHand.argsHash, 'release')).state, 'sent');
  const repeated = await call('plain', {});
  assert.equal(repeated.outcome, 'SENT');
  assert.equal(repeated.outcome === 'SENT' && repeated.standing, false);
  assert.equal(out.outcome === 'SENT' && out.standing, true);
  assert.equal((await call('draft_note', { text: 'from a review' }, { readOnly: true })).outcome, 'REFUSED');

  // Both an invoked server refusal and silence are uncertain; neither may be retried.
  assert.ok((await sign('refuse_note')).ok);
  assert.ok((await sign('lost_note')).ok);
  const turned = await call('refuse_note', {});
  assert.equal(turned.outcome === 'SENT' && turned.state, 'unknown');
  const lost = await call('lost_note', {});
  assert.equal(lost.outcome === 'SENT' && lost.state, 'unknown');
  const lostAgain = await call('lost_note', {});
  assert.equal(lostAgain.outcome === 'SENT' && lostAgain.state, 'unknown');
  assert.equal(sentTo('lost_note'), 1, 'an UNKNOWN is never sent again');

  // 10 November 2026, owner direction: a send is a signed tool like any other; signed tool arguments are data.
  const sending = await call('draft_note', { text: 'x', send: true });
  assert.equal(sending.outcome, 'SENT');
  assert.equal(sending.outcome === 'SENT' && sending.state, 'sent');
  assert.equal(sentTo('draft_note'), 2);

  // 10 November 2026: after an unknown outcome a standing signature releases nothing more for that tool on that connection until the person resolves it.
  const lostHeld = p.service.list().held.find((h) => h.tool === 'lost_note' && h.state === 'unknown')!;
  value(await p.service.resolveUnknown(lostHeld.effect, lostHeld.argsHash, 'did_not_happen'));

  // 10 November 2026, owner direction: a send is a signed tool like any other; an unsigned listed call waits for the person.
  const del = await call('delete_note', { id: 'n1' });
  assert.equal(del.outcome, 'HELD');
  const delHeld = p.service.list().held.find((h) => h.tool === 'delete_note' && h.state === 'waiting')!;
  assert.equal(value(await p.service.decide(delHeld.effect, delHeld.argsHash, 'release')).state, 'sent');
  const early = await call('delete_note', { id: 'n0' });
  assert.equal(early.outcome, 'HELD');
  assert.ok((await sign('delete_note', { blockedToo: true })).ok);
  assert.equal(shown('delete_note').standing?.blockedToo, true);
  // 10 November 2026, owner direction: a send is a signed tool like any other; a person release remains their exact one-call approval.
  const earlyHeld = p.service.list().held.find((h) => h.tool === 'delete_note' && h.state === 'waiting')!;
  assert.equal(value(await p.service.decide(earlyHeld.effect, earlyHeld.argsHash, 'release')).state, 'sent');
  assert.equal(calls(p).filter((c) => c.tool === 'delete_note').length, 2);
  const deleted = await call('delete_note', { id: 'n2' });
  assert.equal(deleted.outcome === 'SENT' && deleted.state, 'sent');
  assert.deepEqual(calls(p).filter((c) => c.tool === 'delete_note').map((c) => (c as unknown as { args: unknown }).args), [{ id: 'n1' }, { id: 'n0' }, { id: 'n2' }]);

  // Ended by the person: the next call waits again.
  assert.ok((await p.service.set(id, { tool: { name: 'draft_note', standing: false } })).ok);
  assert.equal(shown('draft_note').standing, undefined);
  assert.equal((await call('draft_note', { text: 'after ending it' })).outcome, 'HELD');

  // Ended while a call is on its way out: approved on the signature, then the signature ends before the send. Nothing goes.
  assert.ok((await sign('draft_note')).ok);
  const real = p.box.link!;
  let afterApproval: (() => Promise<unknown>) | undefined;
  p.box.link = new Proxy(real, { get(target, key) {
    const v = Reflect.get(target, key, target) as unknown;
    if (typeof v !== 'function') return v;
    if (key !== 'call') return (v as (...a: unknown[]) => unknown).bind(target);
    return async (...a: unknown[]) => {
      const r = await (v as (...x: unknown[]) => Promise<unknown>).apply(target, a);
      if (String(a[1]).includes('gov.answer_decision') && afterApproval) { const then = afterApproval; afterApproval = undefined; await then(); }
      return r;
    };
  } }) as CoreLink;
  afterApproval = () => p.service.set(id, { tool: { name: 'draft_note', standing: false } });
  const midway = await call('draft_note', { text: 'ended on its way' });
  p.box.link = real;
  assert.equal(midway.outcome, 'REFUSED');
  assert.match(midway.outcome === 'REFUSED' ? midway.detail : '', /your signature for it changed/);
  assert.equal(sentTo('draft_note'), 2, 'the approved call did not go out');
  const stopped = p.service.list().held.find((h) => h.tool === 'draft_note' && (h.args as { text?: string }).text === 'ended on its way')!;
  assert.equal((await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.effects WHERE id = $1', [stopped.effect])).rows[0].status, 'cancelled');

  // A signature is for exactly what was signed. Under another account with the same names it does not apply: it is not shown, and
  // the call waits for the person. It applies again only when what is there is exactly what was signed.
  assert.ok((await sign('draft_note')).ok);
  p.write('plain', { NOTES_VALUE: 'another-account-token-value' });
  assert.equal(shown('draft_note').standing, undefined, 'not shown as signed under another account');
  assert.equal((await call('draft_note', { text: 'other account' }, { turnId: 'turn-other-account' })).outcome, 'HELD', 'the signature was for the account it was given on, so this waits for the person');
  assert.equal(sentTo('draft_note'), 2);
  p.write();
  assert.ok(shown('draft_note').standing, 'the account that was signed for');
  const back = await call('draft_note', { text: 'first account again' }, { turnId: 'turn-first-account-again' });
  assert.equal(back.outcome, 'SENT');
  assert.equal(sentTo('draft_note'), 3);

  // A signature is for the data home it was given in: the same record under another home's path signs nothing.
  const moved = stored();
  assert.ok(moved.servers[id].tools.draft_note.standing);
  moved.servers[id].tools.draft_note.standing!.home = '/another/home/that/holds/a/copy';
  writeFileSync(join(p.home, 'connectors', 'mcp.json'), JSON.stringify(moved));
  assert.equal(shown('draft_note').standing, undefined);
  assert.equal((await call('draft_note', { text: 'copied home' }, { turnId: 'turn-copied-home' })).outcome, 'HELD');
  assert.equal(sentTo('draft_note'), 3);

  // Closing the door ends every signature given through it; opening it again does not bring them back.
  await p.service.set(id, { enabled: true });
  assert.ok((await p.service.set(id, { egress: true, seal: p.service.doorSeal(id)! })).ok);
  assert.ok((await sign('draft_note')).ok);
  assert.ok((await p.service.set(id, { egress: false })).ok);
  assert.ok((await p.service.set(id, { egress: true, seal: p.service.doorSeal(id)! })).ok);
  assert.equal(shown('draft_note').standing, undefined);
  assert.equal(shown('delete_note').standing, undefined);
  assert.equal((await call('draft_note', { text: 'door reopened' })).outcome, 'HELD');
  assert.equal(sentTo('draft_note'), 3);
});

/** A link that runs `then` once, right after the named core call or link method returns: a change, or a crash, at that exact boundary. */
function interrupting(real: CoreLink) {
  /** `fail`: the named core call is not made at all, once, as when the record cannot be reached at that moment. */
  const at: { on?: string; then?: () => Promise<unknown>; fail?: string } = {};
  const fire = async (name: string) => { if (at.on && at.then && name.includes(at.on)) { const then = at.then; at.on = undefined; at.then = undefined; await then(); } };
  const link = new Proxy(real, { get(target, key) {
    const v = Reflect.get(target, key, target) as unknown;
    if (typeof v !== 'function') return v;
    // Only the asynchronous crossings a decision and a send make are watched; everything else is the real link's own.
    if (key !== 'call' && key !== 'read' && key !== 'beginDispatch') return (v as (...x: unknown[]) => unknown).bind(target);
    return async (...a: unknown[]) => {
      const name = key === 'beginDispatch' ? 'beginDispatch' : String(a[1]);
      if (key === 'call' && at.fail && name.includes(at.fail)) { at.fail = undefined; throw new Error('the record could not be reached'); }
      const r = await (v as (...x: unknown[]) => Promise<unknown>).apply(target, a);
      await fire(name);
      return r;
    };
  } }) as CoreLink;
  return { link, at };
}

test('a standing signature under adversity: an old question, a change seen by a listing, an ending at every step of a send, and a crash between the approval and the send', { timeout: TEST_HANG_MS * 2 }, async () => {
  const p = person();
  await enableAll(p);
  const { link, core } = await run(p);
  const signal = new AbortController().signal;
  const id = 'claude-code:notes';
  const call = (name: string, args: Record<string, unknown>, turnId = 'turn-adversity') => p.service.call(tool(p, name), args, core, { ...origin, turnId }, signal);
  const sentTo = (name: string) => calls(p).filter((c) => c.tool === name).length;
  const stamp = (name: string) => p.service.toolView(id, name)!.stamp;
  const sign = (name: string, asked = stamp(name)) => p.service.set(id, { seal: p.service.doorSeal(id)!, tool: { name, standing: { stamp: asked } } });
  const end = (name: string) => p.service.set(id, { tool: { name, standing: false } });
  const open = () => p.service.set(id, { egress: true, seal: p.service.doorSeal(id)! });
  const stored = () => JSON.parse(readFileSync(join(p.home, 'connectors', 'mcp.json'), 'utf8')) as { servers: Record<string, { egress?: true; tools: Record<string, { standing?: object }> }> };
  const status = async (effect: string) => (await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.effects WHERE id = $1', [effect])).rows[0].status;
  const heldFor = (text: string) => p.service.list().held.find((h) => (h.args as { text?: string; x?: string }).text === text || (h.args as { x?: string }).x === text)!;
  assert.ok((await open()).ok);

  // An old question is not answered after a change: the tool turned off and on, or the door closed and opened, with the same definition throughout.
  const before = stamp('draft_note');
  await p.service.set(id, { tool: { name: 'draft_note', enabled: false } });
  await p.service.set(id, { tool: { name: 'draft_note', enabled: true } });
  assert.equal((await sign('draft_note', before)).ok, false, 'turned off and on while the question was open');
  const reopened = stamp('draft_note');
  await p.service.set(id, { egress: false });
  assert.ok((await open()).ok);
  assert.equal((await sign('draft_note', reopened)).ok, false, 'the door closed and opened while the question was open');
  assert.ok((await sign('draft_note')).ok, 'a question asked now is answered');

  // Looking never erases or closes anything: under another account the signature does not apply and nothing is sent, and a
  // configuration read at a bad moment costs the person neither their door nor their signatures.
  const signedNow = () => p.service.list().servers.find((x) => x.id === id)!.tools.find((t) => t.name === 'draft_note')!.standing;
  p.write('plain', { NOTES_VALUE: 'another-account-token-value' });
  assert.equal(signedNow(), undefined);
  assert.equal((await call('draft_note', { text: 'under the other account' })).outcome, 'HELD');
  assert.equal(sentTo('draft_note'), 0);
  p.write();
  assert.ok(signedNow(), 'exactly what was signed is there again');
  assert.ok(stored().servers[id].egress);
  await end('draft_note');

  // A tool that disappears and is found again never reproduces the stamp of a question asked before.
  const old = stamp('draft_note');
  const gone = stored();
  delete gone.servers[id].tools.draft_note;
  writeFileSync(join(p.home, 'connectors', 'mcp.json'), JSON.stringify(gone));
  assert.ok((await p.service.refresh(id)).ok);
  await p.service.set(id, { tool: { name: 'draft_note', enabled: true } });
  assert.notEqual(stamp('draft_note'), old);
  assert.equal((await sign('draft_note', old)).ok, false, 'the question asked before it disappeared signs nothing');

  // Ending the signature stops the call at every step of its way out: after the approval, after the claim, and after the dispatch has begun.
  const { link: watched, at } = interrupting(p.box.link!);
  const real = p.box.link!;
  p.box.link = watched;
  for (const boundary of ['gov.answer_decision', 'gov.claim_effect', 'beginDispatch']) {
    assert.ok((await sign('draft_note')).ok);
    at.on = boundary;
    at.then = () => end('draft_note');
    const out = await call('draft_note', { text: `ended after ${boundary}` });
    assert.equal(at.on, undefined, `${boundary} was reached`);
    assert.equal(out.outcome, 'REFUSED', boundary);
    assert.equal(sentTo('draft_note'), 0, `nothing reached the server when it ended after ${boundary}`);
    assert.ok(['cancelled', 'failed'].includes(await status(heldFor(`ended after ${boundary}`).effect)), boundary);
  }

  // A crash after the approval was recorded on one signature: the call is recovered on that signature or not at all, never on a later one.
  assert.ok((await sign('draft_note')).ok);
  at.on = 'gov.answer_decision';
  at.then = async () => { throw new Error('the host died here'); };
  assert.equal((await call('draft_note', { text: 'approved, then a crash' })).outcome, 'HELD', 'not sent, and still there to recover');
  assert.equal(await status(heldFor('approved, then a crash').effect), 'allowed');
  await end('draft_note');
  assert.ok((await sign('draft_note')).ok, 'a later signature for the same tool');
  const recovered = await call('draft_note', { text: 'approved, then a crash' });
  assert.equal(recovered.outcome, 'REFUSED');
  assert.equal(sentTo('draft_note'), 0, 'the later signature did not send what the earlier one approved');
  assert.equal(await status(heldFor('approved, then a crash').effect), 'cancelled');
  // The later signature works for its own calls.
  const fresh = await call('draft_note', { text: 'under the later signature' });
  assert.equal(fresh.outcome, 'SENT');
  assert.equal(fresh.outcome === 'SENT' && fresh.standing, true);
  assert.equal(sentTo('draft_note'), 1);

  // A crash after the person's own release: the recovered call goes out once, as theirs, even though the tool has been signed since.
  assert.equal((await call('plain', { x: 'released by hand, then a crash' })).outcome, 'HELD');
  const byHand = heldFor('released by hand, then a crash');
  at.on = 'gov.answer_decision';
  at.then = async () => { throw new Error('the host died here'); };
  await assert.rejects(p.service.decide(byHand.effect, byHand.argsHash, 'release'), /Core answer could not be confirmed/);
  assert.ok((await sign('plain')).ok);
  const again = await call('plain', { x: 'released by hand, then a crash' });
  assert.equal(again.outcome, 'SENT');
  assert.equal(again.outcome === 'SENT' && again.standing, false, 'the record says the person released it');
  assert.equal(sentTo('plain'), 1);
  assert.equal(p.service.list().held.find((h) => h.effect === byHand.effect)!.standing, undefined);
  // And a discard after such a crash ends the call in the core too.
  await end('plain');
  assert.equal((await call('plain', { x: 'approved, crashed, then discarded' })).outcome, 'HELD');
  const toDiscard = heldFor('approved, crashed, then discarded');
  at.on = 'gov.answer_decision';
  at.then = async () => { throw new Error('the host died here'); };
  await assert.rejects(p.service.decide(toDiscard.effect, toDiscard.argsHash, 'release'));
  assert.equal(value(await p.service.decide(toDiscard.effect, toDiscard.argsHash, 'discard')).state, 'discarded');
  assert.equal(await status(toDiscard.effect), 'cancelled');
  assert.equal(sentTo('plain'), 1);

  // The claim for dispatch was taken but its answer was lost: the call is not shown as ended while the core holds it claimed;
  // it waits, and a discard cancels it in the core as well.
  assert.equal((await call('plain', { x: 'claimed, then the answer was lost' })).outcome, 'HELD');
  const claimed = heldFor('claimed, then the answer was lost');
  at.on = 'gov.claim_effect';
  at.then = async () => { throw new Error('the answer to the claim was lost'); };
  assert.equal(value(await p.service.decide(claimed.effect, claimed.argsHash, 'release')).state, 'waiting');
  assert.equal(at.on, undefined);
  assert.equal(await status(claimed.effect), 'claimed');
  assert.equal(value(await p.service.decide(claimed.effect, claimed.argsHash, 'discard')).state, 'discarded');
  assert.equal(await status(claimed.effect), 'cancelled');
  assert.equal(sentTo('plain'), 1);

  // A cancel the record does not take: the call is not shown as ended while it is still open there; it waits, and a later discard ends it.
  const draftsBefore = sentTo('draft_note');
  at.on = 'gov.answer_decision';
  at.then = () => end('draft_note');
  at.fail = 'gov.cancel_effect';
  const stuck = await call('draft_note', { text: 'ended on its way, and the cancel was lost' });
  assert.equal(stuck.outcome, 'HELD', 'still waiting, not reported as ended');
  const open1 = heldFor('ended on its way, and the cancel was lost');
  assert.equal(open1.state, 'waiting');
  assert.equal(await status(open1.effect), 'allowed');
  assert.equal(sentTo('draft_note'), draftsBefore);
  assert.equal(value(await p.service.decide(open1.effect, open1.argsHash, 'discard')).state, 'discarded');
  assert.equal(await status(open1.effect), 'cancelled');

  // Two processes on one home. One reads a call as still waiting and is overtaken: the other approves it on the signature of
  // that moment and dies before sending; that signature is ended and a later one given. The first, resuming, must not erase
  // the word the core was answered on, and nothing goes out on the later signature.
  assert.ok((await sign('draft_note')).ok);
  const second = interrupting(real);
  const otherProcess = new ConnectorService({ home: p.home, env: () => defaultToolEnv({ HOME: p.personHome, PATH: process.env.PATH }), link: async () => second.link, callTimeoutMs: 3_000 });
  services.push(otherProcess);
  at.on = 'SELECT status, decision_id, args_hash';
  at.then = async () => {
    second.at.on = 'gov.answer_decision';
    second.at.then = async () => { throw new Error('the other process died here'); };
    const theirs = otherProcess.offered().find((t) => t.tool === 'draft_note')!;
    assert.equal((await otherProcess.call(theirs, { text: 'overtaken' }, core, { ...origin, turnId: 'turn-adversity' }, signal)).outcome, 'HELD');
    assert.equal(second.at.on, undefined, 'the other process answered the core, then died');
    await end('draft_note');
    assert.ok((await sign('draft_note')).ok, 'a later signature');
  };
  const overtaken = await call('draft_note', { text: 'overtaken' });
  assert.equal(at.on, undefined);
  assert.equal(overtaken.outcome, 'REFUSED', 'approved on a signature that has ended: not sent on the later one');
  assert.equal((await call('draft_note', { text: 'overtaken' })).outcome, 'REFUSED', 'and asking again does not send it either');
  assert.equal(sentTo('draft_note'), draftsBefore);
  assert.equal(await status(heldFor('overtaken').effect), 'cancelled');

  // The word was written on one signature and the core was not seen to answer (the answer failed, or its reply was lost and it
  // may still commit). That signature ends and a later one is given: the call is cancelled, never sent on the later signature.
  at.fail = 'gov.answer_decision';
  assert.equal((await call('draft_note', { text: 'written, and the answer was lost' })).outcome, 'HELD');
  const uncertain = heldFor('written, and the answer was lost');
  assert.equal(await status(uncertain.effect), 'awaiting_checker');
  await end('draft_note');
  assert.ok((await sign('draft_note')).ok, 'a later signature');
  const afterLoss = await call('draft_note', { text: 'written, and the answer was lost' });
  assert.equal(afterLoss.outcome, 'REFUSED');
  assert.match(afterLoss.outcome === 'REFUSED' ? afterLoss.detail : '', /signature that has since ended/);
  assert.equal(sentTo('draft_note'), draftsBefore);
  assert.equal(await status(uncertain.effect), 'cancelled');

  // A discard that is overtaken by another process beginning to send: it is not recorded as "discarded, nothing was sent".
  await end('plain');
  assert.equal((await call('plain', { x: 'discarded while another process sends' })).outcome, 'HELD');
  const racing = heldFor('discarded while another process sends');
  at.on = 'SELECT status, decision_id, args_hash';
  at.then = async () => {
    second.at.on = 'beginDispatch';
    second.at.then = async () => { throw new Error('the other process stopped after beginning to send'); };
    await assert.rejects(otherProcess.decide(racing.effect, racing.argsHash, 'release'), /stopped after beginning to send/);
  };
  const outcome = value(await p.service.decide(racing.effect, racing.argsHash, 'discard'));
  assert.equal(at.on, undefined);
  assert.equal(await status(racing.effect), 'dispatching');
  // 10 November 2026, owner direction: a send is a signed tool like any other; dispatch in progress is not UNKNOWN.
  assert.equal(outcome.state, 'waiting', 'still dispatching is not an UNKNOWN outcome');

  // A record from before the counter existed, whose highest revision belongs to a tool the next listing no longer finds: the
  // counter is put above it before the listing removes it.
  const ghostly = stored() as unknown as { gen?: number; servers: Record<string, { tools: Record<string, unknown> }> };
  ghostly.servers[id].tools.ghost = { enabled: false, definition: 'gone', listed: { name: 'ghost', description: 'No longer listed.', inputSchema: {} }, rev: 9_999 };
  delete ghostly.gen;
  writeFileSync(join(p.home, 'connectors', 'mcp.json'), JSON.stringify(ghostly));
  assert.ok((await p.service.refresh(id)).ok);
  assert.equal((stored() as unknown as typeof ghostly).servers[id].tools.ghost, undefined);
  assert.ok(((stored() as unknown as { gen: number }).gen) >= 9_999);

  // A process that stopped while it held the lock, long enough for the lock to be taken over: another process ended a signature
  // meanwhile. The stopped process's change, computed on its older reading, must not bring the signature back.
  await end('draft_note');
  assert.ok((await sign('draft_note')).ok);
  const file = join(p.home, 'connectors', 'mcp.json');
  const inner = p.service as unknown as { change<T>(work: (s: Record<string, unknown>) => T): Promise<T> };
  let overtakenOnce = false;
  await inner.change((s) => {
    if (!overtakenOnce) {
      overtakenOnce = true;
      const newer = JSON.parse(readFileSync(file, 'utf8')) as { ver?: number; servers: Record<string, { tools: Record<string, { standing?: object }> }> };
      delete newer.servers[id].tools.draft_note.standing;
      newer.ver = (newer.ver ?? 0) + 1;
      writeFileSync(file, JSON.stringify(newer));
    }
    s.heldTask = s.heldTask;
  });
  assert.equal(stored().servers[id].tools.draft_note.standing, undefined, 'the older reading was not saved over the ending');
  assert.equal((await call('draft_note', { text: 'after an ending that a stale save must not undo' })).outcome, 'HELD');
  assert.equal(sentTo('draft_note'), draftsBefore);

  // A home whose record has revisions but no counter yet: the counter starts above them, so no earlier stamp comes back.
  const legacy = stored() as unknown as { gen?: number; servers: Record<string, { rev?: number; tools: Record<string, { rev?: number }> }> };
  const highest = Math.max(legacy.servers[id].rev ?? 0, ...Object.values(legacy.servers[id].tools).map((t) => t.rev ?? 0));
  delete legacy.gen;
  writeFileSync(join(p.home, 'connectors', 'mcp.json'), JSON.stringify(legacy));
  const stampBefore = stamp('plain');
  await p.service.set(id, { tool: { name: 'plain', enabled: false } });
  await p.service.set(id, { tool: { name: 'plain', enabled: true } });
  assert.notEqual(stamp('plain'), stampBefore);
  assert.ok(((stored() as unknown as { gen: number }).gen) > highest);
  p.box.link = real;
});

for (const boundary of ['release', 'gov.claim_effect', 'beginDispatch', 'admission-error']) test(`policy refusal after ${boundary} settles an unsent connector call without UNKNOWN`, async t => {
  let admissionError = false;
  const p = person(() => { if (admissionError) throw new Error('private telemetry settings detail'); }), fixture = systemFixture(t, document());
  await enableAll(p);
  const { link: real, core } = await run(p);
  value(await p.service.set('claude-code:notes', { egress: true, seal: p.service.doorSeal('claude-code:notes')! }));
  const offered = tool(p, 'draft_note');
  assert.equal((await p.service.call(offered, { text: 'never sent under refused policy' }, core, origin, new AbortController().signal)).outcome, 'HELD');
  const held = p.service.list().held.at(-1)!;
  const { link, at } = interrupting(real); p.box.link = link;
  if (boundary === 'release') fixture.tamper();
  else { at.on = boundary === 'admission-error' ? 'beginDispatch' : boundary; at.then = async () => { if (boundary === 'admission-error') admissionError = true; else fixture.tamper(); }; }
  const released = value(await p.service.decide(held.effect, held.argsHash, 'release'));
  assert.equal(at.on, undefined, 'the selected boundary was reached');
  if (boundary === 'admission-error') assert.doesNotMatch(released.detail, /private telemetry settings detail/);
  else assert.match(released.detail, /Managed policy refused \(signature\)/);
  assert.ok(['released', 'failed'].includes(released.state));
  assert.equal(calls(p).filter(call => call.tool === 'draft_note').length, 0);
  const status = (await real.read<{status:string}>(real.system(), 'SELECT status FROM app.effects WHERE id = $1', [held.effect])).rows[0].status;
  assert.equal(status, ['beginDispatch', 'admission-error'].includes(boundary) ? 'failed' : 'cancelled');
  assert.equal((await real.connectorEffectPause(held.effect)), null, 'the tool is not left dispatching or unknown');
});
