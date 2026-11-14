import { waitFor,hangDetector } from '../../../scripts/lib/test-hang.ts';
// Parallel work: a goal the person owns, depth-one children that never exceed their parent, read-only
// reviewers, and the promises (stop, restart, budgets, UNKNOWN, withdrawal) kept across coordination.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { METHODS, type Turn } from '../src/api.ts';
import { CoreLink } from '../src/composition/core.ts';
import { createParallelWork, issueChildMandate, narrowSettings, type ParallelDeps, type StoredThread } from '../src/composition/parallel-work.ts';
import { ThreadJournal } from '../src/composition/thread-journal.ts';
import { readJson } from '../src/stub/fsx.ts';
import { startScriptedModel, scriptedStep, type Message, type ScriptedModel, type Step } from '../src/testing/scripted-model.ts';
import { pollUntil, b64, freshHome, idle, open, settings, value  } from './helpers.ts';

const text = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
/** A parent asked to delegate starts one child, waits for it, and proposes a goal; a child that tries to delegate is refused. */
function delegating(messages: Message[]): Step {
  const start = messages.findLastIndex((m) => m.role === 'user');
  const asked = text(messages[start]);
  if (/Read the note/.test(asked)) return messages.slice(start + 1).some((m) => m.role === 'tool') ? { text: 'The note says secret.' } : { calls: [{ name: 'read_file', args: { name: 'note.md' } }] };
  const both = /Review both (\S+) (\S+)/.exec(asked);
  if (both) {
    const made = messages.slice(start + 1).flatMap((m) => m.tool_calls ?? []).length;
    return made < 2 ? { calls: [{ name: 'start_child', args: { brief: 'Look it over', role: 'reviewer', reviews: both[made + 1] } }] } : { text: 'Both started.' };
  }
  if (/Propose after reading/.test(asked)) {
    const seen = messages.slice(start + 1).flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name);
    if (!seen.includes('read_file')) return { calls: [{ name: 'read_file', args: { name: 'note.md' } }] };
    if (!seen.includes('propose_goal')) return { calls: [{ name: 'propose_goal', args: { text: 'quoted-in-goal' } }] };
    return { text: 'Proposed.' };
  }
  if (/Delegate after reading/.test(asked)) {
    const seen = messages.slice(start + 1).flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name);
    if (!seen.includes('read_file')) return { calls: [{ name: 'read_file', args: { name: 'note.md' } }] };
    if (!seen.includes('start_child')) return { calls: [{ name: 'start_child', args: { brief: 'Use this: quoted-from-note', role: 'worker' } }] };
    return { text: 'Started.' };
  }
  if (!/Delegate/.test(asked)) return scriptedStep(messages);
  const results = messages.slice(start + 1).filter((m) => m.role === 'tool').map(text);
  const called = messages.slice(start + 1).flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name);
  if (!called.includes('start_child')) return { calls: [{ name: 'start_child', args: { brief: /grandchild/.test(asked) ? 'Delegate nothing, a grandchild' : 'Write an editable brief for the launch', role: 'worker' } }] };
  const thread = /thread (\S+)/.exec(results[0] ?? '')?.[1];
  if (!thread) return { text: `Refused: ${results[0]}` };
  if (!called.includes('await_child')) return { calls: [{ name: 'await_child', args: { thread } }] };
  if (!called.includes('propose_goal')) return { calls: [{ name: 'propose_goal', args: { text: 'Ship the launch brief' } }] };
  return { text: `Report received: ${results[1]}` };
}

let model: ScriptedModel;
before(async () => {
  model = await startScriptedModel('scripted-model', delegating);
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  await model.close();
});

async function parent(options: Parameters<typeof open>[1] = {}, home = freshHome()) {
  const ctx = open(home, options);
  const p = value(await ctx.host.call('projects.create', { name: 'P', kind: 'folder' }));
  const sent = value(await ctx.host.call('turns.send', { projectId: p.id, text: 'Hello', attachments: [], settings, clientKey: 'first' }));
  await idle(ctx.host, sent.threadId);
  return { ...ctx, p, threadId: sent.threadId };
}
type Hosted = Awaited<ReturnType<typeof parent>>;
const child = (s: Hosted, extra: Partial<Parameters<typeof s.host.call<'children.start'>>[1]> = {}) =>
  s.host.call('children.start', { parentThreadId: s.threadId, text: 'Write an editable brief', role: 'worker', clientKey: 'c', ...extra });

test('the new methods are additive on the api port', () => {
  for (const m of ['goals.set', 'goals.clear', 'goals.decide', 'children.start', 'threads.fork'] as const) assert.ok(METHODS.includes(m), m);
});

test('a person sets, changes and clears a goal; each change is on the record and a stale view changes nothing', async () => {
  const s = await parent();
  const first = value(await s.host.call('goals.set', { threadId: s.threadId, text: '  Ship it  ', baseVersion: 0 }));
  assert.deepEqual([first.current?.text, first.current?.by, first.version], ['Ship it', 'person', 1]);
  const stale = await s.host.call('goals.set', { threadId: s.threadId, text: 'Other', baseVersion: 0 });
  assert.deepEqual([stale.ok, !stale.ok && stale.reason], [false, 'STALE_BASE']);
  const empty = await s.host.call('goals.set', { threadId: s.threadId, text: '  ', baseVersion: 1 });
  assert.deepEqual([empty.ok, !empty.ok && empty.reason], [false, 'INVALID']);
  value(await s.host.call('goals.set', { threadId: s.threadId, text: 'Ship it well', baseVersion: 1 }));
  const cleared = value(await s.host.call('goals.clear', { threadId: s.threadId, baseVersion: 2 }));
  assert.equal(cleared.current, null);
  assert.deepEqual(cleared.history.map((h) => h.action), ['set', 'set', 'cleared']);
  assert.equal(value(await s.host.call('threads.get', { id: s.threadId })).goal?.version, 3);
});

test('a parent turn starts a child, reads its report with receipts, and its goal proposal changes nothing until the person accepts', async () => {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Delegate the brief', attachments: [], settings, clientKey: 'k' }));
  value(await host.call('goals.set', { threadId: sent.threadId, text: 'Launch', baseVersion: 0 }));
  await idle(host, sent.threadId);
  await pollUntil(async active => { while (active() && (!(await host.call('threads.get', { id: sent.threadId }).then((r) => value(r).turns[0].status !== 'running')))) await new Promise((r) => setTimeout(r, 10)); }, "packages/platform/test/parallel-work.test.ts:98 polling state");
  const thread = value(await host.call('threads.get', { id: sent.threadId }));
  assert.equal(thread.turns[0].status, 'done', thread.turns[0].answer?.text ?? 'no answer');
  assert.equal(thread.children?.length, 1);
  const kid = thread.children![0];
  assert.deepEqual([kid.role, kid.startedBy, kid.running, kid.handover?.status], ['worker', 'agent', false, 'done']);
  assert.deepEqual(kid.handover?.receipts.map((r) => [r.target, r.outcome]), [['brief.md', 'DONE']]);
  assert.ok(kid.handover?.receipts[0].key, 'the receipt names its effect');
  assert.match(thread.turns[0].answer!.text, /brief\.md/);
  assert.deepEqual(thread.turns[0].handovers, [{ threadId: kid.threadId, turnId: kid.handover!.turnId }]);
  assert.deepEqual(thread.card.subagents, { active: 0, done: 1 });
  const childThread = value(await host.call('threads.get', { id: kid.threadId }));
  assert.equal(childThread.summary.parentId, sent.threadId);
  assert.equal(childThread.goal?.current?.text, 'Launch', 'a child shows the goal of its parent');
  assert.deepEqual(thread.goal?.current?.text, 'Launch', 'a proposal is no rewrite');
  const proposal = thread.goal!.proposals[0];
  assert.deepEqual([proposal.state, proposal.by, proposal.text], ['open', 'agent', 'Ship the launch brief']);
  const now = await host.call('work.now', { projectId: p.id });
  assert.ok(now.needsYou.some((n) => n.kind === 'goal' && n.proposalId === proposal.id && n.threadId === sent.threadId), 'the person sees the proposal');
  const accepted = value(await host.call('goals.decide', { threadId: sent.threadId, proposalId: proposal.id, verdict: 'accept', baseVersion: thread.goal!.version }));
  assert.deepEqual([accepted.current?.text, accepted.current?.by, accepted.current?.fromProposal, accepted.proposals[0].state], ['Ship the launch brief', 'person', proposal.id, 'accepted']);
  assert.equal((await host.call('work.now', { projectId: p.id })).needsYou.some((n) => n.kind === 'goal'), false);
  const again = await host.call('goals.decide', { threadId: sent.threadId, proposalId: proposal.id, verdict: 'decline', baseVersion: accepted.version });
  assert.equal(again.ok, false, 'a decided proposal stays decided');
});

test('a depth-two spawn is refused by name, from the api and from a child turn', async () => {
  const s = await parent();
  const kid = value(await child(s));
  await idle(s.host, kid.threadId);
  const refused = await s.host.call('children.start', { parentThreadId: kid.threadId, text: 'More', role: 'worker', clientKey: 'd' });
  assert.deepEqual([refused.ok, !refused.ok && refused.reason, !refused.ok && refused.outcome], [false, 'DEPTH_LIMIT', 'REFUSED']);
  assert.equal(value(await s.host.call('threads.get', { id: kid.threadId })).children?.length ?? 0, 0);

  const { host } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  const top = value(await host.call('turns.send', { projectId: p.id, text: 'Hello', attachments: [], settings, clientKey: 'a' }));
  await idle(host, top.threadId);
  const onChild = value(await host.call('children.start', { parentThreadId: top.threadId, text: 'Delegate to a grandchild', role: 'worker', clientKey: 'b' }));
  const t = await idle(host, onChild.threadId);
  assert.match(t.turns[0].answer!.text, /DEPTH_LIMIT/);
  assert.equal((await host.call('threads.list', {})).length, 2);
});

test('a child asking for more than its parent is refused, naming the axis; narrower is allowed', async () => {
  assert.deepEqual(narrowSettings(settings, { permission: 'full' }, 'worker'), { wider: 'permission' });
  assert.deepEqual(narrowSettings({ ...settings, mode: 'plan' }, { mode: 'chat' }, 'worker'), { wider: 'mode' });
  assert.deepEqual(narrowSettings({ ...settings, effort: 2 }, { effort: 3 }, 'worker'), { wider: 'effort' });
  assert.deepEqual(narrowSettings(settings, { model: 'other' }, 'worker'), { settings: { ...settings, model: 'other' } }, 'a model is no ceiling: it is checked against what is served (child-model.test.ts)');
  assert.deepEqual(narrowSettings(settings, { permission: 'root' as never }, 'worker'), { wider: 'permission' }, 'a value off the scale is never narrower');
  assert.deepEqual(narrowSettings(settings, { mode: 'free' as never }, 'worker'), { wider: 'mode' });
  assert.deepEqual(narrowSettings(settings, { effort: 'max' as never }, 'worker'), { wider: 'effort' });
  assert.deepEqual(narrowSettings(settings, { effort: 0 as never }, 'worker'), { wider: 'effort' }, 'below the scale is off it too');
  assert.deepEqual(narrowSettings(settings, { permission: undefined, model: undefined }, 'worker'), { settings }, 'left out is the parent\'s');
  assert.deepEqual(narrowSettings({ ...settings, permission: 'full' }, undefined, 'reviewer'), { settings: { ...settings, permission: 'ask' } });
  assert.deepEqual(narrowSettings({ ...settings, permission: 'full' }, { permission: 'auto-review' }, 'worker'), { settings: { ...settings, permission: 'auto-review' } });
  const s = await parent();
  const wider = await child(s, { settings: { permission: 'full' } });
  assert.deepEqual([wider.ok, !wider.ok && wider.reason], [false, 'WIDER_THAN_PARENT']);
  assert.match(!wider.ok ? wider.detail : '', /permission/);
  assert.equal((await s.host.call('threads.list', {})).length, 1);
  const started = value(await child(s));
  await idle(s.host, started.threadId);
  const follow = await s.host.call('turns.send', { threadId: started.threadId, projectId: s.p.id, text: 'Again', attachments: [], settings: { ...settings, permission: 'full' }, clientKey: 'wider' });
  assert.deepEqual([follow.ok, !follow.ok && follow.reason], [false, 'WIDER_THAN_PARENT']);
});

test('clientKey makes a child start idempotent', async () => {
  const s = await parent();
  const a = value(await child(s));
  const b = value(await child(s));
  assert.deepEqual(a, b);
  await idle(s.host, a.threadId);
  assert.equal(value(await s.host.call('threads.get', { id: s.threadId })).children?.length, 1);
});

test('a child writes through the one gateway, as a real effect, under a mandate delegated from its parent', async () => {
  const s = await parent();
  const kid = value(await child(s));
  const t = await idle(s.host, kid.threadId);
  assert.deepEqual(t.turns[0].effects.map((e) => e.outcome), ['DONE']);
  const stored = readJson<{ task: string; child: { mandate: string } }>(join(s.home, 'threads', `${kid.threadId}.json`), null as never);
  const link = await CoreLink.open({ home: s.home });
  try {
    const { rows } = await link.read<{ parent_id: string | null; intent: { child: string } }>(link.person(), 'SELECT parent_id, intent FROM app.mandates WHERE id = $1', [stored.child.mandate]);
    assert.ok(rows[0].parent_id, 'it is delegated, not a second root');
    assert.equal(rows[0].intent.child, kid.threadId);
    const effect = await link.read<{ mandate_id: string; status: string }>(link.system(), 'SELECT mandate_id, status FROM app.effects WHERE task_id = $1', [stored.task]);
    assert.deepEqual(effect.rows.map((r) => [r.mandate_id, r.status]), [[stored.child.mandate, 'succeeded']]);
  } finally { await link.release(); }
});

test('the core caps a child by its parent: revocation cascades, a reviewer has no operations, and budgets count across the tree', async () => {
  const s = await parent();
  const link = await CoreLink.open({ home: s.home });
  try {
    const root = await link.call<string>(link.person(), `SELECT gov.issue_mandate($1, NULL, '"*"', '"*"', '"*"', '["workspace.write_document"]', 2::smallint, NULL, NULL, NULL, 1, $2, 'direct')`, [link.id.agent, new Date(Date.now() + 86_400_000)]);
    const worker = await issueChildMandate(link, link.person(), root, 'worker', { child: 'w', parent: 'p' });
    const reviewer = await issueChildMandate(link, link.person(), root, 'reviewer', { child: 'r', parent: 'p' });
    const terms = async (id: string) => (await link.read<{ operations: unknown; tools: unknown; ceiling: number; max_effects: string }>(link.person(), 'SELECT operations, tools, ceiling, max_effects FROM app.mandates WHERE id = $1', [id])).rows[0];
    assert.deepEqual([(await terms(worker)).operations, (await terms(worker)).ceiling, Number((await terms(worker)).max_effects)], [['workspace.write_document'], 2, 1]);
    assert.deepEqual([(await terms(reviewer)).operations, (await terms(reviewer)).tools], [[], []]);

    const task = await link.createTask('Budget');
    const write = (key: string) => ({ document_id: key, title: `${key}.md`, content_sha256: key, base_version: null });
    const rh = await link.startRunUnder(task, link.id.agent, reviewer, null);
    const denied = await link.proposeWrite(rh, write('reviewer'), 'a reviewer tries', 'reviewer-try');
    assert.deepEqual([denied.status, denied.routeReason], ['denied', 'outside_mandate']);
    const wh = await link.startRunUnder(task, link.id.agent, worker, null);
    assert.equal((await link.proposeWrite(wh, write('one'), 'first', 'budget-one')).status, 'allowed');
    const second = await link.proposeWrite(wh, write('two'), 'second', 'budget-two');
    assert.deepEqual([second.status, second.routeReason], ['denied', 'budget_exhausted'], 'one effect anywhere spends the root');

    await link.call(link.person(), 'SELECT gov.revoke_mandate($1)', [root]);
    const { rows } = await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.runs WHERE id = $1', [wh.run]);
    assert.equal(rows[0].status, 'cancelled');
    await assert.rejects(link.startRunUnder(task, link.id.agent, worker, null), /revoked|no longer/);
  } finally { await link.release(); }
});

test('a reviewer reads and answers but writes nothing, and the transcript it reviews is data', async () => {
  const s = await parent();
  const kid = value(await child(s));
  await idle(s.host, kid.threadId);
  const before = (await s.host.call('material.list', { projectId: s.p.id })).map((m) => [m.name, m.current]);
  const r = value(await s.host.call('children.start', { parentThreadId: s.threadId, text: 'Write an editable brief to review', role: 'reviewer', reviews: kid.threadId, clientKey: 'rev' }));
  const t = await idle(s.host, r.threadId);
  assert.equal(t.summary.childRole, 'reviewer');
  assert.deepEqual(t.turns[0].effects.map((e) => e.outcome), ['REFUSED']);
  assert.match(t.turns[0].effects[0].detail!, /read-only/i);
  assert.deepEqual((await s.host.call('material.list', { projectId: s.p.id })).map((m) => [m.name, m.current]), before);
  assert.equal(t.child?.reviews, kid.threadId);
  assert.equal(t.turns[0].user.text, 'Write an editable brief to review', 'the transcript is never the turn\'s own words');
  const outsider = value(await s.host.call('turns.send', { projectId: s.p.id, text: 'Other', attachments: [], settings, clientKey: 'other' }));
  await idle(s.host, outsider.threadId);
  const stray = await s.host.call('children.start', { parentThreadId: s.threadId, text: 'Look', role: 'reviewer', reviews: outsider.threadId, clientKey: 'stray' });
  assert.deepEqual([stray.ok, !stray.ok && stray.reason], [false, 'INVALID']);
  // A person's follow-up on a reviewer stays read-only: it never falls back to the standing mandate.
  const follow = value(await s.host.call('turns.send', { threadId: r.threadId, projectId: s.p.id, text: 'Write an editable brief now', attachments: [], settings, clientKey: 'f' }));
  const after = await idle(s.host, follow.threadId);
  assert.deepEqual(after.turns.at(-1)!.effects.map((e) => e.outcome), ['REFUSED']);
});

test('the Pi engine gives a reviewer no write or delegation tool at all', async () => {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  const top = value(await host.call('turns.send', { projectId: p.id, text: 'Hello', attachments: [], settings, clientKey: 'a' }));
  await idle(host, top.threadId);
  const mark = model.requests.length;
  const r = value(await host.call('children.start', { parentThreadId: top.threadId, text: 'Look over the project', role: 'reviewer', clientKey: 'b' }));
  await idle(host, r.threadId);
  const names = model.requests.slice(mark).flatMap((q) => (JSON.parse(q.body) as { tools?: { function: { name: string } }[] }).tools ?? []).map((t) => t.function.name);
  assert.deepEqual([...new Set(names)].sort(), ['list_files', 'read_file']);
});

test('stopping a parent stops its running children before it is acknowledged, and a stopped child stays stopped', async () => {
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),entered=new Set<string>();
  const controlled=await startScriptedModel('parent-stop-control',delegating,{before:async messages=>{
    const asked=text(messages.findLast(message=>message.role==='user')!);
    for(const marker of ['PARENT_STOP_A','PARENT_STOP_B'])if(asked.includes(marker)){entered.add(marker);await held;}
  }});
  const endpoint=process.env.BACKBONE_MODEL_ENDPOINT,modelId=process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT=controlled.url;process.env.BACKBONE_MODEL_ID=controlled.model;
  try{
  const s = await parent({harness:'harness-pi'});
  const a = value(await child(s,{text:'Write an editable brief PARENT_STOP_A'}));
  const b = value(await child(s, { clientKey: 'c2', text: 'Write an editable summary PARENT_STOP_B' }));
  await hangDetector(waitFor(async()=>entered.size===2,'both child models are held'),'parent Stop controls reach inference');
  assert.deepEqual(value(await s.host.call('threads.get', { id: s.threadId })).card.subagents, { active: 2, done: 0 });
  const stop = value(await s.host.call('turns.stop', { threadId: s.threadId }));
  assert.equal(stop.stopped, true);
  for (const id of [a.threadId, b.threadId]) {
    const onDisk = readJson<{ turns: { stopRequested?: boolean }[] }>(join(s.home, 'threads', `${id}.json`), null as never);
    assert.equal(onDisk.turns[0].stopRequested, true, 'recorded before the stop is acknowledged');
    const t = await idle(s.host, id);
    assert.notEqual(t.turns[0].status, 'done');
    assert.notEqual(t.turns[0].status, 'running');
  }
  assert.deepEqual(value(await s.host.call('threads.get', { id: s.threadId })).card.subagents, { active: 0, done: 2 });
  }finally{
    release();process.env.BACKBONE_MODEL_ENDPOINT=endpoint;process.env.BACKBONE_MODEL_ID=modelId;await controlled.close();
  }
});

test('stopping a child leaves its parent and siblings alone', async () => {
  const s = await parent({ writeDelayMs: 300 });
  const a = value(await child(s));
  const b = value(await child(s, { clientKey: 'c2', text: 'Write an editable summary' }));
  value(await s.host.call('turns.stop', { threadId: a.threadId }));
  assert.equal((await idle(s.host, b.threadId)).turns[0].status, 'done');
});

/** OS exclusion ends immediately after SIGKILL; Core's six-second run lease still stands.
 * The three-minute detector allows lease expiry and settlement under load; it asserts no latency. */
async function crashIdle(host:Parameters<typeof idle>[0],id:string){
  let turn:ReturnType<typeof value<import('../src/api.ts').Thread>>|undefined;
  await waitFor(async()=>{turn=value(await host.call('threads.get',{id}));return !turn.summary.running;},'original turn after Host crash recovery',{diagnostic:()=>JSON.stringify(turn?.summary)});
  return turn!;
}

/** Starts a host in a process of its own, which starts a child and is killed at `cut`. */
async function killedDuring(home: string, cut: string, harness: string) {
  const script = spawn(process.execPath, [join(import.meta.dirname, 'crash-child.ts'), home], {
    env: { ...process.env, BACKBONE_HARNESS: harness, BACKBONE_CRASH_AT: cut, BACKBONE_CRASH_OCCURRENCE: '1' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  script.stdout.on('data', (d: Buffer) => (out += d.toString()));
  const signal = await new Promise<NodeJS.Signals | null>((resolve) => script.on('exit', (_c, s) => resolve(s)));
  assert.equal(signal, 'SIGKILL', 'the host died at the cut');
  return JSON.parse(out.trim().split('\n').at(-1)!) as { parent: string; child: string; project: string };
}

test('a kill during a child\'s dispatch: on restart the child is not replayed, and its UNKNOWN reaches the parent and work.now', async () => {
  const home = freshHome();
  const { parent: parentId, child: childId, project } = await killedDuring(home, 'write.begun', 'harness-stub');
  const { host } = open(home);
  const t = await crashIdle(host, childId);
  assert.deepEqual(t.turns[0].effects.map((e) => e.outcome), ['UNKNOWN']);
  assert.notEqual(t.turns[0].status, 'done');
  assert.equal((await host.call('material.list', { projectId: project })).length, 0, 'nothing was resent');
  const up = value(await host.call('threads.get', { id: parentId }));
  assert.deepEqual([up.children?.[0].unknown, up.children?.[0].handover?.status], [1, 'unknown']);
  const unknown = (await host.call('work.now', { projectId: project })).needsYou.filter((n) => n.kind === 'unknown');
  assert.deepEqual(unknown.map((n) => [n.threadId, n.parentThreadId]), [[childId, parentId]], 'one item, once, naming both');
  const delivered = value(await host.call('turns.send', { threadId: parentId, projectId: project, text: 'What happened?', attachments: [], settings, clientKey: 'next' }));
  const after = await idle(host, delivered.threadId);
  assert.deepEqual(after.turns.at(-1)!.handovers, [{ threadId: childId, turnId: t.turns[0].id }]);
});

test('a kill after a child\'s proposal: restart finishes the one write, once', async () => {
  const home = freshHome();
  const { child: childId, project } = await killedDuring(home, 'write.proposed', 'harness-stub');
  const { host } = open(home);
  const t = await crashIdle(host, childId);
  assert.deepEqual(t.turns[0].effects.map((e) => e.outcome), ['DONE']);
  const docs = await host.call('material.list', { projectId: project });
  assert.deepEqual(docs.map((d) => d.versions.length), [1]);
});

test('a parent turn resumed after a kill finds its child: no second child, no second effect', async () => {
  const home = freshHome();
  const { parent: parentId, project } = await killedDuring(home, 'write.begun', 'harness-pi');
  const { host } = open(home, { harness: 'harness-pi' });
  // Both runs wait out their leases, one after the other, before they resume.
  let up = value(await host.call('threads.get', { id: parentId }));
  await pollUntil(async active => { for (let i = 0; (active() && (up.summary.running || !up.children?.length)); i++) { await new Promise((r) => setTimeout(r, 10)); up = value(await host.call('threads.get', { id: parentId })); } }, "packages/platform/test/parallel-work.test.ts:331 polling state");
  assert.equal(up.summary.running, false);
  assert.equal(up.children?.length, 1);
  const kid = await idle(host, up.children![0].threadId);
  assert.deepEqual(kid.turns[0].effects.map((e) => e.outcome), ['UNKNOWN']);
  assert.equal((await host.call('material.list', { projectId: project })).length, 0);
  const link = await CoreLink.open({ home });
  try {
    const { rows } = await link.read(link.system(), "SELECT id FROM app.effects WHERE operation = 'workspace.write_document'");
    assert.equal(rows.length, 1, 'one effect in all');
  } finally { await link.release(); }
});

test('a child never resends what a sibling left UNKNOWN', async () => {
  const home = freshHome();
  const { parent: parentId, child: firstId, project } = await killedDuring(home, 'write.begun', 'harness-stub');
  const { host } = open(home);
  await crashIdle(host, firstId);
  const again = value(await host.call('children.start', { parentThreadId: parentId, text: 'Write an editable brief', role: 'worker', clientKey: 'again' }));
  const t = await idle(host, again.threadId);
  assert.deepEqual(t.turns[0].effects.map((e) => e.outcome), ['REFUSED']);
  assert.match(t.turns[0].effects[0].detail!, /UNKNOWN/);
  assert.equal((await host.call('material.list', { projectId: project })).length, 0);
});

test('a report is withheld once a source of the child was withdrawn; its receipts are kept', async () => {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  const source = value(await host.call('material.attach', { projectId: p.id, name: 'note.md', base64: b64('secret'), mediaType: 'text/markdown' }));
  const top = value(await host.call('turns.send', { projectId: p.id, text: 'Hello', attachments: [], settings, clientKey: 'a' }));
  await idle(host, top.threadId);
  const kid = value(await host.call('children.start', { parentThreadId: top.threadId, text: 'Read the note', role: 'worker', clientKey: 'b' }));
  await idle(host, kid.threadId);
  const seen = value(await host.call('threads.get', { id: top.threadId })).children![0].handover!;
  assert.match(seen.text, /secret/);
  assert.deepEqual(seen.reads.map((r) => r.name), ['note.md']);
  value(await host.call('material.lifecycle', { id: source.id, version: source.current, state: 'withdrawn', lifecycle: 0 }));
  const later = value(await host.call('threads.get', { id: top.threadId })).children![0].handover!;
  assert.deepEqual([later.withheld, later.text, later.reads], [true, '', []]);
  const mark = model.requests.length;
  const next = value(await host.call('turns.send', { threadId: top.threadId, projectId: p.id, text: 'What did it find?', attachments: [], settings, clientKey: 'c' }));
  await idle(host, next.threadId);
  assert.ok(model.requests.slice(mark).every((q) => !q.body.includes('The note says secret')), 'the words do not reach the next turn');
  assert.ok(model.requests.slice(mark).some((q) => q.body.includes('withheld')), 'the parent is told why');
});

test('a report read by a parent turn makes its sources the parent\'s reads, so a later withdrawal reaches it', async () => {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  value(await host.call('material.attach', { projectId: p.id, name: 'note.md', base64: b64('secret'), mediaType: 'text/markdown' }));
  const top = value(await host.call('turns.send', { projectId: p.id, text: 'Hello', attachments: [], settings, clientKey: 'a' }));
  await idle(host, top.threadId);
  const kid = value(await host.call('children.start', { parentThreadId: top.threadId, text: 'Read the note', role: 'worker', clientKey: 'b' }));
  await idle(host, kid.threadId);
  value(await host.call('turns.send', { threadId: top.threadId, projectId: p.id, text: 'And so?', attachments: [], settings, clientKey: 'c' }));
  const t = await idle(host, top.threadId);
  assert.ok(t.turns.at(-1)!.reads?.some((r) => r.name === 'note.md' && r.inherited), 'carried from the report');
  assert.equal(t.turns.at(-1)!.handovers?.length, 1);
});

test('an earlier UNKNOWN keeps a child from reporting done, even after a later turn of it finished', async () => {
  const home = freshHome();
  const { parent: parentId, child: childId, project } = await killedDuring(home, 'write.begun', 'harness-stub');
  const { host } = open(home);
  await crashIdle(host, childId);
  const next = value(await host.call('turns.send', { threadId: childId, projectId: project, text: 'Anything else?', attachments: [], settings, clientKey: 'more' }));
  const t = await idle(host, next.threadId);
  assert.equal(t.turns.at(-1)!.status, 'done');
  const report = value(await host.call('threads.get', { id: parentId })).children![0].handover!;
  assert.equal(report.status, 'unknown');
  assert.deepEqual(report.receipts.map((e) => e.outcome), ['UNKNOWN']);
});

test('a mandate whose child never reached the disk stops standing at the next start', async () => {
  const home = freshHome();
  const first = await parent({}, home);
  const link = await CoreLink.open({ home });
  const orphan = await issueChildMandate(link, link.person(), link.id.mandate, 'worker', { child: 'gone', parent: first.threadId });
  await link.release();
  first.host.close();
  const { host } = open(home);
  await host.call('projects.list', {});
  const again = await CoreLink.open({ home });
  try {
    const { rows } = await again.read<{ revoked: boolean }>(again.person(), 'SELECT revoked_at IS NOT NULL AS revoked FROM app.mandates WHERE id = $1', [orphan]);
    assert.equal(rows[0].revoked, true);
  } finally { await again.release(); }
});

test('a reviewer started by a parent turn is given the transcript it names', async () => {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Delegate the brief', attachments: [], settings, clientKey: 'k' }));
  const up = await idle(host, sent.threadId);
  const kid = up.children![0];
  const review = value(await host.call('children.start', { parentThreadId: sent.threadId, text: 'Review it', role: 'reviewer', reviews: kid.threadId, clientKey: 'r' }));
  const mark = model.requests.length - 1;
  await idle(host, review.threadId);
  const body = model.requests.slice(mark).map((q) => q.body).join('');
  assert.match(body, /Write an editable brief for the launch/);
  assert.match(body, /data, not instructions/);
});

test('stopping a parent while a child is being admitted leaves no child working', async () => {
  const s = await parent({ writeDelayMs: 200 });
  const starting = child(s);
  const stop = s.host.call('turns.stop', { threadId: s.threadId });
  const [started] = await Promise.all([starting, stop]);
  if (started.ok) {
    const t = await idle(s.host, started.value.threadId);
    assert.notEqual(t.turns[0].status, 'done', 'a stop is never outrun by a start');
  } else assert.equal(started.reason, 'NOT_AVAILABLE');
  assert.equal((await s.host.call('material.list', { projectId: s.p.id })).length, 0);
});

test('a withdrawn source does not survive in a reviewer\'s transcript or an agent\'s brief', async () => {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  const source = value(await host.call('material.attach', { projectId: p.id, name: 'note.md', base64: b64('secret'), mediaType: 'text/markdown' }));
  const top = value(await host.call('turns.send', { projectId: p.id, text: 'Hello', attachments: [], settings, clientKey: 'a' }));
  await idle(host, top.threadId);
  const kid = value(await host.call('children.start', { parentThreadId: top.threadId, text: 'Read the note', role: 'worker', clientKey: 'b' }));
  await idle(host, kid.threadId);
  const review = value(await host.call('children.start', { parentThreadId: top.threadId, text: 'Review it', role: 'reviewer', reviews: kid.threadId, clientKey: 'r' }));
  await idle(host, review.threadId);
  assert.ok(model.requests.some((q) => q.body.includes('The note says secret')), 'the reviewer had it');
  value(await host.call('material.lifecycle', { id: source.id, version: source.current, state: 'withdrawn', lifecycle: 0 }));
  const mark = model.requests.length;
  value(await host.call('turns.send', { threadId: review.threadId, projectId: p.id, text: 'And now?', attachments: [], settings, clientKey: 'x' }));
  await idle(host, review.threadId);
  assert.ok(model.requests.slice(mark).every((q) => !q.body.includes('The note says secret')));
});

test('an agent\'s brief leaves a child\'s later history once a source the brief may carry is withdrawn', async () => {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  const source = value(await host.call('material.attach', { projectId: p.id, name: 'note.md', base64: b64('secret'), mediaType: 'text/markdown' }));
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Delegate after reading', attachments: [], settings, clientKey: 'k' }));
  const up = await idle(host, sent.threadId);
  const kid = up.children![0];
  assert.match((await idle(host, kid.threadId)).turns[0].user.text, /quoted-from-note/);
  value(await host.call('material.lifecycle', { id: source.id, version: source.current, state: 'withdrawn', lifecycle: 0 }));
  const mark = model.requests.length;
  value(await host.call('turns.send', { threadId: kid.threadId, projectId: p.id, text: 'And now?', attachments: [], settings, clientKey: 'x' }));
  await idle(host, kid.threadId);
  assert.ok(model.requests.slice(mark).every((q) => !q.body.includes('quoted-from-note')));
});

test('a fork does not lift a hold: what its source left UNKNOWN is not resent from the fork', async () => {
  const home = freshHome();
  const { child: childId, project } = await killedDuring(home, 'write.begun', 'harness-stub');
  const { host } = open(home);
  await crashIdle(host, childId);
  const fork = value(await host.call('threads.fork', { id: childId, clientKey: 'f' }));
  const sent = value(await host.call('turns.send', { threadId: fork.id, projectId: project, text: 'Write an editable brief', attachments: [], settings, clientKey: 'again' }));
  const t = await idle(host, sent.threadId);
  assert.deepEqual(t.turns.at(-1)!.effects.map((e) => e.outcome), ['REFUSED']);
  assert.match(t.turns.at(-1)!.effects[0].detail!, /UNKNOWN/);
  assert.equal((await host.call('material.list', { projectId: project })).length, 0);
});

test('deleting a fork in the middle does not lift the hold from the forks after it', async () => {
  const home = freshHome();
  const { child: childId, project } = await killedDuring(home, 'write.begun', 'harness-stub');
  const { host } = open(home);
  await crashIdle(host, childId);
  const middle = value(await host.call('threads.fork', { id: childId, clientKey: 'b' }));
  const last = value(await host.call('threads.fork', { id: middle.id, clientKey: 'c' }));
  value(await host.call('threads.delete', { id: middle.id }));
  const sent = value(await host.call('turns.send', { threadId: last.id, projectId: project, text: 'Write an editable brief', attachments: [], settings, clientKey: 'again' }));
  const t = await idle(host, sent.threadId);
  assert.deepEqual(t.turns.at(-1)!.effects.map((e) => e.outcome), ['REFUSED']);
  assert.equal((await host.call('material.list', { projectId: project })).length, 0);
});

test('recovery does not dispatch a pending write onto what a related thread left UNKNOWN', async () => {
  const home = freshHome();
  const { parent: parentId, child: childId, project } = await killedDuring(home, 'write.proposed', 'harness-stub');
  // While the host is down, a sibling's write of the same document has gone UNKNOWN.
  const link = await CoreLink.open({ home });
  try {
    const { rows } = await link.read<{ args: Record<string, unknown> }>(link.system(), "SELECT args FROM app.effects WHERE operation = 'workspace.write_document'");
    const task = await link.createTask('Sibling');
    const h = await link.startRun(task);
    const effect = await link.proposeWrite(h, { ...rows[0].args, content_sha256: 'sibling' }, 'sibling', 'sibling-write');
    const claim = await link.claimEffect(effect.id);
    await link.beginDispatch(effect.id, claim);
    await link.observe(effect.id, claim, 'unknown', 'sibling', 'cut off');
    const at = new Date().toISOString();
    const journal = new ThreadJournal(home);
    const sibling = { id: 'sibling-turn', side: false, user: { text: 'x', attachments: [], at }, work: { startedAt: at, steps: [], harness: 'h' }, effects: [], status: 'stopped' as const };
    journal.append({ kind: 'turn.reserved', threadId: 'sibling', turn: sibling, clientKey: 'sibling',
      created: { task, summary: { id: 'sibling', projectId: project, title: 'Sibling', pinned: false, unread: false, parentId, childRole: 'worker', archived: false, running: false, updatedAt: at }, child: { parentThreadId: parentId, role: 'worker', startedBy: 'person', settings, at, mandate: '', key: 'sibling' } } });
    journal.append({ kind: 'turn.closed', threadId: 'sibling', turnId: sibling.id, state: { status: 'stopped', effects: [] } });
  } finally { await link.release(); }
  const { host } = open(home);
  const t = await crashIdle(host, childId);
  assert.notEqual(t.turns[0].effects[0].outcome, 'DONE');
  assert.equal((await host.call('material.list', { projectId: project })).length, 0, 'nothing landed');
});

test('a later turn on a reviewer or a narrowed child is refused on a native engine', () => {
  const stored = (role: 'worker' | 'reviewer', permission: 'ask' | 'full') => ({ turns: [], child: { role, settings: { ...settings, permission } } }) as unknown as StoredThread;
  const work = createParallelWork({ native: () => true, journal: { read: () => [] }, threads: new Map(), running: new Map() } as unknown as ParallelDeps);
  const full = { ...settings, permission: 'full' as const };
  assert.equal(work.refuseTurn(stored('reviewer', 'full'), { ...settings })?.ok, false);
  assert.equal(work.refuseTurn(stored('worker', 'ask'), { ...settings })?.ok, false);
  assert.equal(work.refuseTurn(stored('worker', 'full'), full), undefined);
});

test('an accepted goal keeps its sources: once one is withdrawn its words leave later turns, and those turns inherit it', async () => {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  const source = value(await host.call('material.attach', { projectId: p.id, name: 'note.md', base64: b64('secret'), mediaType: 'text/markdown' }));
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Propose after reading', attachments: [], settings, clientKey: 'k' }));
  const up = await idle(host, sent.threadId);
  const proposal = up.goal!.proposals[0];
  assert.deepEqual(proposal.reads?.map((r) => r.name), ['note.md']);
  value(await host.call('goals.decide', { threadId: sent.threadId, proposalId: proposal.id, verdict: 'accept', baseVersion: up.goal!.version }));
  let mark = model.requests.length;
  value(await host.call('turns.send', { threadId: sent.threadId, projectId: p.id, text: 'Next', attachments: [], settings, clientKey: 'n' }));
  const next = await idle(host, sent.threadId);
  assert.ok(model.requests.slice(mark).some((q) => q.body.includes('quoted-in-goal')));
  assert.ok(next.turns.at(-1)!.reads?.some((r) => r.name === 'note.md'), 'a turn given the goal has its sources');
  value(await host.call('material.lifecycle', { id: source.id, version: source.current, state: 'withdrawn', lifecycle: 0 }));
  mark = model.requests.length;
  value(await host.call('turns.send', { threadId: sent.threadId, projectId: p.id, text: 'Later', attachments: [], settings, clientKey: 'l' }));
  await idle(host, sent.threadId);
  assert.ok(model.requests.slice(mark).every((q) => !q.body.includes('quoted-in-goal')));
});

test('stopping a parent reaches a follow-up turn still being admitted on its child', async () => {
  const s = await parent({ writeDelayMs: 200 });
  const kid = value(await child(s, { text: 'Hello again' }));
  await idle(s.host, kid.threadId);
  const sending = s.host.call('turns.send', { threadId: kid.threadId, projectId: s.p.id, text: 'Write an editable brief', attachments: [], settings, clientKey: 'follow' });
  const stop = s.host.call('turns.stop', { threadId: s.threadId });
  const [sent] = await Promise.all([sending, stop]);
  if (sent.ok) assert.notEqual((await idle(s.host, kid.threadId)).turns.at(-1)!.status, 'done');
  else assert.equal(sent.reason, 'NOT_AVAILABLE');
  assert.equal((await s.host.call('material.list', { projectId: s.p.id })).length, 0, 'nothing landed');
});

test('the same reviewer brief on two targets is two reviewers', async () => {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  const top = value(await host.call('turns.send', { projectId: p.id, text: 'Hello', attachments: [], settings, clientKey: 'a' }));
  await idle(host, top.threadId);
  const one = value(await host.call('children.start', { parentThreadId: top.threadId, text: 'Hello one', role: 'worker', clientKey: 'one' }));
  const two = value(await host.call('children.start', { parentThreadId: top.threadId, text: 'Hello two', role: 'worker', clientKey: 'two' }));
  await idle(host, one.threadId);
  await idle(host, two.threadId);
  value(await host.call('turns.send', { threadId: top.threadId, projectId: p.id, text: `Review both ${one.threadId} ${two.threadId}`, attachments: [], settings, clientKey: 'b' }));
  const up = await idle(host, top.threadId);
  const reviewers = (up.children ?? []).filter((c) => c.role === 'reviewer');
  assert.equal(reviewers.length, 2);
  for (const r of reviewers) await idle(host, r.threadId);
  const targets = await Promise.all(reviewers.map(async (r) => value(await host.call('threads.get', { id: r.threadId })).child?.reviews));
  assert.deepEqual(targets.sort(), [one.threadId, two.threadId].sort());
});

test('an exact copy of what any thread left UNKNOWN is not resent, while a changed write from an unrelated thread goes through', async () => {
  const home = freshHome();
  const { child: childId, project } = await killedDuring(home, 'write.begun', 'harness-stub');
  const { host } = open(home);
  await crashIdle(host, childId);
  const copy = value(await host.call('turns.send', { projectId: project, text: 'Write an editable brief', attachments: [], settings, clientKey: 'copy' }));
  const t = await idle(host, copy.threadId);
  assert.deepEqual(t.turns[0].effects.map((e) => e.outcome), ['REFUSED']);
  assert.equal((await host.call('material.list', { projectId: project })).length, 0);
  const changed = value(await host.call('turns.send', { projectId: project, text: 'Write an editable brief, changed', attachments: [], settings, clientKey: 'changed' }));
  assert.deepEqual((await idle(host, changed.threadId)).turns[0].effects.map((e) => e.outcome), ['DONE']);
});

test('a child cannot be deleted while its parent has a turn running, which could start it again', async () => {
  const s = await parent({ writeDelayMs: 1_000 });
  const kid = value(await child(s, { text: 'Hello again' }));
  await idle(s.host, kid.threadId);
  value(await s.host.call('turns.send', { threadId: s.threadId, projectId: s.p.id, text: 'Write an editable brief', attachments: [], settings, clientKey: 'long' }));
  const del = await s.host.call('threads.delete', { id: kid.threadId });
  assert.deepEqual([del.ok, !del.ok && del.reason], [false, 'NOT_AVAILABLE']);
  value(await s.host.call('turns.stop', { threadId: s.threadId }));
  await idle(s.host, s.threadId);
  value(await s.host.call('threads.delete', { id: kid.threadId }));
});

test('deleting and moving keep a family together, and deleting a child ends its mandate', async () => {
  const s = await parent();
  const kid = value(await child(s));
  await idle(s.host, kid.threadId);
  const del = await s.host.call('threads.delete', { id: s.threadId });
  assert.deepEqual([del.ok, !del.ok && del.reason], [false, 'NOT_AVAILABLE']);
  const other = value(await s.host.call('projects.create', { name: 'Q', kind: 'folder' }));
  assert.equal((await s.host.call('threads.update', { id: s.threadId, patch: { projectId: other.id } })).ok, false);
  assert.equal((await s.host.call('threads.update', { id: kid.threadId, patch: { projectId: other.id } })).ok, false);
  const stored = readJson<{ child: { mandate: string } }>(join(s.home, 'threads', `${kid.threadId}.json`), null as never);
  value(await s.host.call('threads.delete', { id: kid.threadId }));
  const link = await CoreLink.open({ home: s.home });
  try {
    const { rows } = await link.read<{ revoked: boolean }>(link.person(), 'SELECT revoked_at IS NOT NULL AS revoked FROM app.mandates WHERE id = $1', [stored.child.mandate]);
    assert.equal(rows[0].revoked, true);
  } finally { await link.release(); }
  value(await s.host.call('threads.delete', { id: s.threadId }));
});

test('a fork is an independent chat: the original is unchanged and no receipt or child comes with it', async () => {
  const s = await parent();
  value(await s.host.call('goals.set', { threadId: s.threadId, text: 'Goal', baseVersion: 0 }));
  const written = value(await s.host.call('turns.send', { threadId: s.threadId, projectId: s.p.id, text: 'Write an editable brief', attachments: [], settings, clientKey: 'w' }));
  await idle(s.host, written.threadId);
  const kid = value(await child(s));
  await idle(s.host, kid.threadId);
  const before = JSON.stringify(value(await s.host.call('threads.get', { id: s.threadId })));
  const fork = value(await s.host.call('threads.fork', { id: s.threadId, clientKey: 'f' }));
  assert.deepEqual(value(await s.host.call('threads.fork', { id: s.threadId, clientKey: 'f' })).id, fork.id, 'the same fork');
  assert.equal(fork.parentId, undefined);
  const t = value(await s.host.call('threads.get', { id: fork.id }));
  assert.deepEqual([t.turns.length, t.children?.length ?? 0, t.forkedFrom?.threadId, t.goal?.current?.text], [2, 0, s.threadId, 'Goal']);
  assert.ok(t.turns.every((turn) => !turn.effects.length));
  const original = value(await s.host.call('threads.get', { id: s.threadId }));
  assert.ok(!t.turns.some((turn) => original.turns.some((o) => o.id === turn.id)), 'turn ids are never shared');
  const next = value(await s.host.call('turns.send', { threadId: fork.id, projectId: s.p.id, text: 'And now?', attachments: [], settings, clientKey: 'n' }));
  await idle(s.host, next.threadId);
  assert.equal(JSON.stringify(value(await s.host.call('threads.get', { id: s.threadId }))).length, before.length, 'the original is unchanged');
});
