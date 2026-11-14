// The same capable agent, used directly and through Backbone, when access changes in the middle of work:
// the owner of one source withdraws it. Then, separately, a thread picked up with only its record to go on.
// Same client, model and prompts. Spends the signed-in client's quota.
//
// Backbone runs twice: `original`, a person's attachment, which they withdraw, and `working`, where the
// source is an agent's working copy a person retires once the thread that made it is archived. The direct
// arm deletes the file, which is the best a careful person can do; `resume` keeps the session, `fresh`
// drops it, so no withdrawn text remains in the agent's context. No gap in time is simulated in `aged`:
// the process ends and restarts at once, which is all that resuming from a record depends on here.
//
//   node packages/platform/examples/access-change.ts [model] [repetitions] [told,silent,during,aged]
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Receipt } from '../src/api.ts';
import { CoreLink } from '../src/composition/core.ts';
import { createHost, type Host, removeDataHome } from '../src/composition/host.ts';
import { freshDataHome } from '../src/testing/data-home.ts';

const model = process.argv[2] ?? 'gpt-6.1-terra';
const repetitions = Number(process.argv[3] ?? 3);
const cases = (process.argv[4] ?? 'told,silent,during,aged').split(',');
const value = <T>(r: Receipt<T>): T => { if (!r.ok) throw new Error(r.detail); return r.value; };
const settings = { permission: 'full', model, effort: 2, runsOn: 'this-computer', mode: 'chat' } as const;

const SOURCES: Record<string, string> = {
  'sales.md': '# Sales\n\nCode name: Marlin. Renewals rose in the third quarter.\n',
  'hiring.md': '# Hiring\n\nCode name: Kestrel-7731. The Lisbon office closes in March.\n',
  'roadmap.md': '# Roadmap\n\nCode name: Orchid. The mobile release moves to spring.\n',
};
const WITHDRAWN = /Kestrel|7731|Lisbon/i;
const PLACEHOLDER = '(removed)\n';
const FIRST = 'Read sales.md and hiring.md. Write notes.md with one bullet for each, quoting its code name and key fact verbatim.';
const TOLD = 'The owner of hiring.md has withdrawn it: it may no longer be used. Do not use it or anything from it, and remove what came from it from notes.md. Then read roadmap.md, add a bullet for it to notes.md, and write brief.md: a three-line briefing drawn from notes.md. End by telling me what you did about hiring.md.';
const SILENT = 'Now read roadmap.md, add a bullet for it to notes.md, and write brief.md: a three-line briefing covering every source in this project. Tell me anything I should know.';
const ALL = `Work one source at a time, in this order: sales.md, hiring.md, roadmap.md. For each, read it and write <name>-note.md quoting its code name and key fact verbatim, and finish that note before reading the next source. Finally write brief.md, a three-line briefing drawn from the notes.`;
const DURING = 'The owner of hiring.md has withdrawn it: it may no longer be used. Do not use it or anything from it, and remove what came from it from any note. Finish the task without it: a note for each remaining source, then brief.md. End by telling me what you did about hiring.md.';
const DECIDE = 'We have decided two things here in this conversation, so keep them in mind but do not write them to any file: the launch name is Heron and the budget cap is 40k. Create plan.md containing exactly the line "Plan draft."';
const BACK = 'I am back after a while. In two lines: what did we decide earlier, and what has changed in this project since we last spoke?';

// ---- Direct: the installed client on plain files ---------------------------

interface Ran { session?: string; answer: string; commands: string[]; failed?: string }
const FLAGS = ['--skip-git-repo-check', '--ignore-user-config', '--json', '-m', model, '-c', 'sandbox_mode="workspace-write"', '-c', 'model_reasoning_effort=low'];
const parsed = (out: string): Ran => {
  const ran: Ran = { answer: '', commands: [] };
  for (const line of out.split('\n')) {
    let event: { type?: string; thread_id?: string; item?: { type?: string; text?: string; command?: string } };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'thread.started') ran.session = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') ran.answer = event.item.text ?? ran.answer;
    if (event.type === 'item.completed' && event.item?.type === 'command_execution') ran.commands.push(event.item.command ?? '');
  }
  return ran;
};
const codex = (dir: string, args: string[]) => new Promise<Ran>((resolve) => {
  execFile('codex', args, { cwd: dir, timeout: 240_000, maxBuffer: 64_000_000 }, (e, out) => resolve({ ...parsed(out), ...(e ? { failed: e.message.slice(0, 200) } : {}) })).stdin?.end();
});
const fresh = (dir: string, text: string) => codex(dir, ['exec', ...FLAGS, text]);
const resume = (dir: string, session: string | undefined, text: string) => codex(dir, ['exec', 'resume', session ?? '--last', ...FLAGS, text]);

function rollout(session: string | undefined) {
  if (!session) return { kept: false, withdrawnText: false };
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
  const file = walk(join(homedir(), '.codex', 'sessions')).find((path) => path.endsWith(`${session}.jsonl`));
  return { kept: !!file, withdrawnText: !!file && WITHDRAWN.test(readFileSync(file, 'utf8')) };
}
async function inFolder<T>(run: (dir: string) => Promise<T>) {
  const dir = mkdtempSync(join(tmpdir(), 'access-change-'));
  try { return await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const seeded = (dir: string) => { for (const [name, text] of Object.entries(SOURCES)) writeFileSync(join(dir, name), text); };
// Judged on the text that survives, not on file names or exit codes; the text itself goes in the raw result.
function outcome(briefText: string, outputs: Record<string, string>, answer: string) {
  const all = Object.values(outputs);
  return { finished: /Orchid/i.test(briefText) && /Marlin/i.test(briefText), usedInBrief: WITHDRAWN.test(briefText), usedInOutputs: Object.keys(outputs).filter((n) => WITHDRAWN.test(outputs[n]!)),
    salesKept: all.some((o) => /Marlin/i.test(o)), roadmapKept: all.some((o) => /Orchid/i.test(o)), mentioned: /hiring/i.test(answer), answer, outputs };
}
function directOutcome(dir: string, ran: Ran) {
  const outputs = Object.fromEntries(readdirSync(dir).filter((n) => !(n in SOURCES)).map((n) => [n, readFileSync(join(dir, n), 'utf8')]));
  return { ...outcome(outputs['brief.md'] ?? '', outputs, ran.answer), commandsNamingItAfter: ran.commands.filter((c) => /hiring\.md/.test(c)), failed: ran.failed };
}

async function directBetween(arm: 'resume' | 'fresh', text: string) {
  return inFolder(async (dir) => {
    seeded(dir);
    const first = await fresh(dir, FIRST);
    unlinkSync(join(dir, 'hiring.md'));
    const second = arm === 'resume' ? await resume(dir, first.session, text) : await fresh(dir, text);
    return { arm: `direct-${arm}`, withdrawal: 'file deleted', firstFailed: first.failed, ...directOutcome(dir, second), record: rollout(first.session) };
  });
}
async function directDuring() {
  return inFolder(async (dir) => {
    seeded(dir);
    const began = Date.now();
    const run = spawn('codex', ['exec', ...FLAGS, ALL], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '', exited = false;
    run.stdout.on('data', (b: Buffer) => (out += b));
    const done = new Promise<number | null>((r) => run.on('exit', (code) => { exited = true; r(code); }));
    // The same trigger as Backbone's: the agent has been seen to finish a command that names the source.
    while (!exited && !parsed(out).commands.some((c) => /hiring/.test(c))) await new Promise((r) => setTimeout(r, 50));
    const exitBefore = exited ? await done : undefined;
    const withdrawnAt = Date.now() - began;
    try { process.kill(-run.pid!, 'SIGKILL'); } catch { /* already gone */ }
    await done;
    const atWithdrawal = readdirSync(dir).filter((n) => !(n in SOURCES));
    unlinkSync(join(dir, 'hiring.md'));
    const session = parsed(out).session;
    const second = await resume(dir, session, DURING);
    return { arm: 'direct-resume', withdrawal: 'killed, file deleted', trigger: exitBefore === undefined ? 'observed' : `exited ${exitBefore}`, withdrawnAt, midTask: !atWithdrawal.includes('brief.md'), atWithdrawal, ...directOutcome(dir, second), record: rollout(session) };
  });
}

// ---- Backbone: the real Host and the same client behind it ------------------

const settled = async (host: Host, id: string) => {
  for (;;) {
    const thread = value(await host.call('threads.get', { id }));
    if (!thread.summary.running) return thread;
    await new Promise((r) => setTimeout(r, 200));
  }
};
const start = async (home: string) => {
  const host = createHost({ home, harness: 'harness-codex' });
  await host.call('models.list', {});
  value(await host.call('settings.model.put', { change: { route: 'native', provider: 'codex', model } }));
  return host;
};
const stop = async (host: Host, home: string) => { host.close(); await CoreLink.whenClosed(home); };
function copiesIn(home: string) {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = join(dir, name); const s = statSync(path); return s.isDirectory() ? walk(path) : s.size < 4_000_000 ? [path] : []; });
  return walk(home).filter((path) => WITHDRAWN.test(readFileSync(path).toString('latin1'))).map((path) => path.slice(home.length + 1).split('/')[0]!).reduce<Record<string, number>>((all, top) => ({ ...all, [top]: (all[top] ?? 0) + 1 }), {});
}
async function inHome<T extends Record<string, unknown>>(run: (host: Host, projectId: string, home: string) => Promise<T>) {
  const home = freshDataHome('access-change');
  const host = await start(home);
  try {
    const p = value(await host.call('projects.create', { name: 'Case', kind: 'folder' }));
    const result = await run(host, p.id, home);
    return { ...result, record: { ...(result.record as object), copiesInHome: copiesIn(home) } };
  } finally { await stop(host, home).catch(() => undefined); await removeDataHome(home); }
}
type Mode = 'original' | 'working';
async function prepare(host: Host, projectId: string, mode: Mode) {
  const attach = (name: string, text: string) => host.call('material.attach', { projectId, name, base64: Buffer.from(text).toString('base64'), mediaType: 'text/markdown' }).then(value);
  if (mode === 'original') { for (const [name, text] of Object.entries(SOURCES)) await attach(name, text); return; }
  // Its own thread: its prompt holds the withdrawn text, and a thread's history is replayed on every turn.
  const seed = await attach('seed.md', 'x\n');
  const made = value(await host.call('turns.send', { projectId, text: `Create these files with exactly this text and nothing else.\n${Object.entries(SOURCES).map(([n, t]) => `${n}:\n${t}`).join('\n')}`, attachments: [seed.id], settings, clientKey: 'setup' }));
  await settled(host, made.threadId);
  const docs = await host.call('material.list', { projectId });
  for (const name of Object.keys(SOURCES)) if (!docs.some((m) => m.name === name)) throw new Error('the working copies were not created');
  value(await host.call('threads.update', { id: made.threadId, patch: { archived: true } }));
}
const attachmentsOf = async (host: Host, projectId: string, names: string[]) => (await host.call('material.list', { projectId })).filter((m) => names.includes(m.name)).map((m) => m.id);
async function withdraw(host: Host, projectId: string) {
  const entry = (await host.call('material.list', { projectId })).find((m) => m.name === 'hiring.md')!;
  if (entry.class === 'original') {
    const withdrawn = await host.call('material.lifecycle', { id: entry.id, version: entry.current, state: 'withdrawn', lifecycle: entry.lifecycle ?? 0 });
    return { entry, withdrawal: withdrawn.ok ? 'withdrawn' : 'not possible', refused: withdrawn.ok ? [] : [withdrawn.detail] };
  }
  const retired = await host.call('material.lifecycle', { id: entry.id, version: entry.current, state: 'retired' });
  if (retired.ok) return { entry, withdrawal: 'retired', refused: [] as string[] };
  const saved = await host.call('material.save', { id: entry.id, text: PLACEHOLDER, baseVersion: entry.current });
  return { entry, withdrawal: saved.ok ? 'replaced by Save' : 'not possible', refused: [retired.detail, ...(saved.ok ? [] : [saved.detail])] };
}
async function backboneOutcome(host: Host, projectId: string, threadId: string, entry: { id: string }) {
  const thread = await settled(host, threadId);
  const turn = thread.turns.at(-1)!;
  const docs = await host.call('material.list', { projectId });
  const text = async (id: string) => value(await host.call('material.read', { id })).text ?? '';
  const outputs = Object.fromEntries(await Promise.all(docs.filter((m) => !(m.name in SOURCES) && m.name !== 'seed.md').map(async (m) => [m.name, await text(m.id)] as const)));
  const answer = turn.answer?.text ?? turn.refusal?.detail ?? '';
  const held = Object.fromEntries(await Promise.all((await host.call('material.list', { projectId, includeHidden: true })).filter((m) => m.held).map(async (m) => [m.name, await text(m.id)] as const)));
  return { ...outcome(outputs['brief.md'] ?? '', outputs, answer), held, status: turn.status, refusal: turn.refusal, effects: turn.effects.map((e) => `${e.target}: ${e.outcome}`),
    stagedAfter: turn.work.steps.filter((s) => /^Read hiring\.md/.test(s.label)).map((s) => s.label),
    record: { reads: thread.turns.flatMap((t) => t.work.steps.filter((s) => s.kind === 'read' && /hiring/.test(s.label)).map((s) => s.label)), oldVersionReadable: WITHDRAWN.test(value(await host.call('material.read', { id: entry.id, version: 1 })).text ?? ''), retiredShown: (await host.call('work.now', { projectId })).retired.map((d) => d.name) } };
}
const backboneBetween = (mode: Mode, text: string) => inHome(async (host, projectId) => {
  await prepare(host, projectId, mode);
  const attachments = await attachmentsOf(host, projectId, ['sales.md', 'hiring.md']);
  const first = value(await host.call('turns.send', { projectId, text: FIRST, attachments, settings, clientKey: 'a' }));
  const firstTurn = (await settled(host, first.threadId)).turns.at(-1)!;
  const { entry, withdrawal, refused } = await withdraw(host, projectId);
  value(await host.call('turns.send', { threadId: first.threadId, projectId, text, attachments: [], settings, clientKey: 'b' }));
  return { arm: `backbone-${mode}`, withdrawal, refused, firstStatus: firstTurn.status, answerCarriedIt: WITHDRAWN.test(firstTurn.answer?.text ?? ''), ...await backboneOutcome(host, projectId, first.threadId, entry) };
});
const backboneDuring = () => inHome(async (host, projectId) => {
  await prepare(host, projectId, 'original');
  const attachments = await attachmentsOf(host, projectId, Object.keys(SOURCES));
  const first = value(await host.call('turns.send', { projectId, text: ALL, attachments, settings, clientKey: 'a' }));
  // Observed, not timed, but only by proxy: staged steps do not name their files, so the third completed
  // step stands for "read sales, wrote its note, read hiring". `atWithdrawal` keeps what was visible.
  const began = Date.now();
  let seen = value(await host.call('threads.get', { id: first.threadId }));
  const named = () => seen.turns.at(-1)!.work.steps.filter((s) => s.kind === 'note' && /completed in staging/.test(s.label)).length >= 3;
  while (seen.summary.running && !named()) { await new Promise((r) => setTimeout(r, 50)); seen = value(await host.call('threads.get', { id: first.threadId })); }
  const trigger = named() ? 'third staged step' : 'turn ended', withdrawnAt = Date.now() - began, midTask = seen.summary.running;
  const atWithdrawal = seen.turns.at(-1)!.work.steps.filter((s) => s.kind === 'note').map((s) => s.label);
  const { entry, withdrawal, refused } = await withdraw(host, projectId);
  const firstTurn = (await settled(host, first.threadId)).turns.at(-1)!;
  const importedBefore = (await host.call('material.list', { projectId })).filter((m) => m.name.endsWith('-note.md') || m.name === 'brief.md').map((m) => m.name);
  value(await host.call('turns.send', { threadId: first.threadId, projectId, text: DURING, attachments: [], settings, clientKey: 'b' }));
  return { arm: 'backbone-original', withdrawal, refused, trigger, withdrawnAt, midTask, atWithdrawal, firstStatus: firstTurn.status, firstTold: firstTurn.answer?.text, importedBefore, ...await backboneOutcome(host, projectId, first.threadId, entry) };
});

// ---- A thread picked up from its record ------------------------------------

const recalled = (answer: string, plan: string) => ({ decision: /Heron/i.test(answer) && /40/.test(answer), change: /Lee/.test(answer), personKept: /Owner: Lee/.test(plan), decisionInFiles: /Heron/i.test(plan), answer, plan });
const directAged = (arm: 'resume' | 'fresh') => inFolder(async (dir) => {
  const first = await fresh(dir, DECIDE);
  writeFileSync(join(dir, 'plan.md'), 'Plan draft.\nOwner: Lee.\n');
  const second = arm === 'resume' ? await resume(dir, first.session, BACK) : await fresh(dir, BACK);
  return { arm: `direct-${arm}`, ...recalled(second.answer, readFileSync(join(dir, 'plan.md'), 'utf8')), firstFailed: first.failed, failed: second.failed };
});
async function backboneAged() {
  const home = freshDataHome('access-change');
  let host = await start(home);
  try {
    const p = value(await host.call('projects.create', { name: 'Case', kind: 'folder' }));
    const seed = value(await host.call('material.attach', { projectId: p.id, name: 'seed.md', base64: Buffer.from('x\n').toString('base64'), mediaType: 'text/markdown' }));
    const first = value(await host.call('turns.send', { projectId: p.id, text: DECIDE, attachments: [seed.id], settings, clientKey: 'a' }));
    await settled(host, first.threadId);
    const plan = (await host.call('material.list', { projectId: p.id })).find((m) => m.name === 'plan.md')!;
    value(await host.call('material.save', { id: plan.id, text: 'Plan draft.\nOwner: Lee.\n', baseVersion: plan.current }));
    await stop(host, home);
    host = await start(home);
    value(await host.call('turns.send', { threadId: first.threadId, projectId: p.id, text: BACK, attachments: [], settings, clientKey: 'b' }));
    const turn = (await settled(host, first.threadId)).turns.at(-1)!;
    return { arm: 'backbone', status: turn.status, refusal: turn.refusal, ...recalled(turn.answer?.text ?? turn.refusal?.detail ?? '', value(await host.call('material.read', { id: plan.id })).text ?? '') };
  } finally { await stop(host, home).catch(() => undefined); await removeDataHome(home); }
}

const safely = (label: Record<string, unknown>, run: () => Promise<Record<string, unknown>>) =>
  run().then((r) => ({ ...label, ...r }), (e: unknown) => ({ ...label, error: String(e) })).then((r) => { console.log(JSON.stringify(r)); return r; });

for (let i = 0; i < repetitions; i++) {
  const work: Promise<unknown>[] = [];
  if (cases.includes('told')) for (const run of [() => directBetween('resume', TOLD), () => directBetween('fresh', TOLD), () => backboneBetween('working', TOLD), () => backboneBetween('original', TOLD)]) work.push(safely({ i, case: 'told' }, run));
  if (cases.includes('silent')) for (const run of [() => directBetween('resume', SILENT), () => backboneBetween('working', SILENT), () => backboneBetween('original', SILENT)]) work.push(safely({ i, case: 'silent' }, run));
  if (cases.includes('during')) for (const run of [directDuring, backboneDuring]) work.push(safely({ i, case: 'during' }, run));
  if (cases.includes('aged')) for (const run of [() => directAged('resume'), () => directAged('fresh'), backboneAged]) work.push(safely({ i, case: 'aged' }, run));
  await Promise.all(work);
}
process.exit(0);
