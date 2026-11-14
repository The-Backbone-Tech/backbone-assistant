// The same capable agent, used directly and through Backbone, killed in the middle of work. A person then
// changes a file and asks to continue. The direct arm uses the client's own session resume, its best case,
// and both arms are killed at the same point: once the first note is seen finished. Direct shows that in
// the folder, Backbone in its checkpoint, a command later, which favours neither on timing under load.
// Same client, model and prompts. Spends the signed-in client's quota.
//
//   node packages/platform/examples/continuity.ts [model] [repetitions]
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Receipt } from '../src/api.ts';
import { CoreLink } from '../src/composition/core.ts';
import { createHost, type Host, removeDataHome } from '../src/composition/host.ts';
import { freshDataHome } from '../src/testing/data-home.ts';

const child = process.argv[2] === '--child';
const model = (child ? process.argv[4] : process.argv[2]) ?? 'gpt-6.1-terra';
const repetitions = Number(process.argv[3] ?? 3);
const value = <T>(r: Receipt<T>): T => { if (!r.ok) throw new Error(r.detail); return r.value; };
const settings = { permission: 'full', model, effort: 2, runsOn: 'this-computer', mode: 'chat' } as const;
const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((n) => `${n}.md`);
const body = (name: string, owner = 'Dana') => `# ${name}\n\nThis note covers the ${name.slice(0, -3)} workstream.\nOwner: ${owner}.\n`;
const ASK = `Review these notes one at a time, in order: ${NAMES.join(', ')}. For each, read it, think about it, and rewrite it so it ends with one final line starting "Reviewed:" and one word describing it. Finish each note before you read the next. Keep everything else.`;
const GO_ON = 'Continue where you left off.';
const REVIEWED = /^Reviewed:/gm;

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

if (child) {
  const host = await start(process.argv[3]!);
  const p = value(await host.call('projects.create', { name: 'Case', kind: 'folder' }));
  // Attachments are read-only originals, so the agent first makes the working notes it then reviews.
  const seed = value(await host.call('material.attach', { projectId: p.id, name: 'seed.md', base64: Buffer.from('x\n').toString('base64'), mediaType: 'text/markdown' }));
  const made = value(await host.call('turns.send', { projectId: p.id, text: `Create these files with exactly this text and nothing else.\n${NAMES.map((n) => `${n}:\n${body(n)}`).join('\n')}`, attachments: [seed.id], settings, clientKey: 'a' }));
  await settled(host, made.threadId);
  const attachments = (await host.call('material.list', { projectId: p.id })).filter((m) => NAMES.includes(m.name)).map((m) => m.id);
  if (attachments.length !== NAMES.length) throw new Error('the working notes were not created');
  const sent = value(await host.call('turns.send', { threadId: made.threadId, projectId: p.id, text: ASK, attachments, settings, clientKey: 'b' }));
  console.log(JSON.stringify({ projectId: p.id, threadId: sent.threadId }));
  await settled(host, sent.threadId);
  console.log('finished'); // nothing was cut short: the parent discards this run
  await new Promise(() => void setInterval(() => undefined, 1000)); // killed by the parent
}

const client = (dir: string, args: string[]) => {
  const run = spawn('codex', [...args], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  run.stdout.on('data', (b: Buffer) => (out += b));
  return { run, session: () => /"thread_id":"([^"]+)"/.exec(out)?.[1], done: new Promise<void>((r) => run.on('exit', () => r())) };
};
const kill = (pid: number) => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } };
const count = (text: string) => text.match(REVIEWED)?.length ?? 0;

async function directArm() {
  const dir = mkdtempSync(join(tmpdir(), 'continuity-'));
  for (const name of NAMES) writeFileSync(join(dir, name), body(name));
  const read = (name: string) => readFileSync(join(dir, name), 'utf8');
  const began = Date.now();
  const flags = ['--skip-git-repo-check', '--ignore-user-config', '-s', 'workspace-write', '-m', model, '-c', 'model_reasoning_effort=low', '--json'];
  const first = client(dir, ['exec', ...flags, ASK]);
  let exited = false;
  void first.done.then(() => (exited = true));
  for (;;) {
    const finished = NAMES.filter((n) => count(read(n)) > 0).length;
    if (finished > 0 || exited) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const killedAt = Date.now() - began;
  kill(first.run.pid!); await first.done;
  const finishedAtKill = NAMES.filter((n) => count(read(n)) > 0).length;
  writeFileSync(join(dir, 'alpha.md'), read('alpha.md').replace('Owner: Dana', 'Owner: Lee'));
  const resume = await new Promise<string>((resolve) => {
    execFile('codex', ['exec', 'resume', first.session() ?? '--last', '--skip-git-repo-check', '-m', model, '-c', 'sandbox_mode="workspace-write"', '-c', 'model_reasoning_effort=low', GO_ON],
      { cwd: dir, timeout: 240_000 }, (e, out) => resolve(e ? `failed: ${e.message.slice(0, 160)}` : out.trim().slice(-240))).stdin?.end();
  });
  return { arm: 'direct', killedAt, session: first.session() !== undefined, finishedAtKill, personKept: read('alpha.md').includes('Owner: Lee'),
    reviewed: NAMES.map((n) => count(read(n))), told: resume };
}

async function backboneArm(limit: number) {
  const home = freshDataHome('continuity');
  const first = spawn(process.execPath, [import.meta.filename, '--child', home, model], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const gone = new Promise<void>((r) => first.on('exit', () => r()));
  let finished = false;
  const line = await new Promise<string>((resolve) => { let out = ''; first.stdout.on('data', (b: Buffer) => { out += b; if (out.includes('\n')) resolve(out.split('\n')[0]!); finished ||= out.includes('finished'); }); });
  const { projectId, threadId } = JSON.parse(line) as { projectId: string; threadId: string };
  const began = Date.now();
  const folder = join(home, 'checkpoints');
  const checkpointed = () => (existsSync(folder) ? readdirSync(folder).flatMap((n) => (JSON.parse(readFileSync(join(folder, n), 'utf8')) as { files: { name: string }[] }).files.map((f) => f.name)) : []);
  let seen: string[] = [];
  while (!seen.length && !finished && Date.now() - began < limit) { try { seen = checkpointed(); } catch { /* being written */ } await new Promise((r) => setTimeout(r, 50)); }
  const killAt = Date.now() - began;
  kill(first.pid!);
  const finishedBeforeKill = finished;
  await gone;
  const host = await start(home);
  try {
    // A copy: the Host hands out live threads, and the turn sent below would otherwise replace this reading.
    const before = structuredClone(await settled(host, threadId));
    const list = () => host.call('material.list', { projectId });
    const docs = await list();
    const now = await host.call('work.now', { projectId });
    const alpha = docs.find((m) => m.name === 'alpha.md')!;
    const finishedAtKill = (await Promise.all(docs.filter((m) => NAMES.includes(m.name)).map(async (m) => count(value(await host.call('material.read', { id: m.id })).text!)))).filter(Boolean).length;
    const text = value(await host.call('material.read', { id: alpha.id })).text!;
    value(await host.call('material.save', { id: alpha.id, text: text.replace('Owner: Dana', 'Owner: Lee'), baseVersion: alpha.current }));
    const attachments = (await list()).filter((m) => NAMES.includes(m.name)).map((m) => m.id);
    const sent = value(await host.call('turns.send', { threadId, projectId, text: GO_ON, attachments, settings, clientKey: 'c' }));
    const turn = (await settled(host, sent.threadId)).turns.at(-1)!;
    const after = await list();
    const texts = await Promise.all(NAMES.map(async (n) => value(await host.call('material.read', { id: after.find((m) => m.name === n)!.id })).text!));
    return { arm: 'backbone', killedAt: killAt, finishedBeforeKill, checkpointedAtKill: seen, answerAtRestart: before.turns.at(-1)!.answer?.text, statusAtRestart: before.turns.at(-1)!.status, effectsAtRestart: before.turns.at(-1)!.effects.map((e) => e.outcome),
      unfinishedShown: JSON.stringify(now).slice(0, 240), finishedAtKill, personKept: texts[0]!.includes('Owner: Lee'), reviewed: texts.map(count),
      beside: after.filter((m) => !NAMES.includes(m.name) && m.name !== 'seed.md').map((m) => m.name), status: turn.status, told: (turn.answer?.text ?? turn.refusal?.detail ?? '').slice(0, 240) };
  } finally { host.close(); await CoreLink.whenClosed(home); await removeDataHome(home); }
}

for (let i = 0; i < repetitions; i++) console.log(JSON.stringify({ i, ...await directArm() }));
// A model may do everything in one command, leaving no point to cut. Such runs test nothing and are not counted.
for (let i = 0, attempt = 0; i < repetitions && attempt < repetitions * 4; attempt++) {
  const run = await backboneArm(180_000);
  console.log(JSON.stringify({ i: run.finishedBeforeKill ? null : i, attempt, ...run }));
  if (!run.finishedBeforeKill) i++;
}
process.exit(0);
