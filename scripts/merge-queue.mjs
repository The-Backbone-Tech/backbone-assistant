#!/usr/bin/env node
// Ready units are pinned inputs. Only mechanical operations may change their candidate.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync, openSync, closeSync, fstatSync, constants, statfsSync, realpathSync } from 'node:fs';
import { loadavg } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import native from 'fs-native-extensions';
import { inspectQueue } from './queue-check.mjs';
import { discoverPackages, parseCounts } from './gate.mjs';
import { git, validateQueue, integrationLine } from './lib/merge-queue.mjs';
import { cherryPickUnit, generatedPaths } from './lib/merge-queue-mechanical.mjs';
import { inspectDocsTail, carryDocsTail, assertDocsDelta } from './lib/merge-queue-docs.mjs';
import { inspectUnitBinding, chooseBatch, classifyFailure, attributeFailingFiles, failureEnvelope } from './lib/merge-queue-policy.mjs';
import { preflight, withQueueHeavyLease, archiveEvidence, assertRecordTarget, appendIntegrationRecord, driverSnapshot, assertDriverUnchanged, validatePostGate, runPostGate, expectedOracleOnly, fastForwardIntegration } from './lib/merge-queue-runtime.mjs';

const integration = 'refs/heads/claude/integration', tracking = 'refs/remotes/origin/claude/integration';
const driverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const atomic = (file, value) => { const temp = `${file}.${randomUUID()}`; writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temp, file); };
const space = root => { const stat = statfsSync(root); return stat.bavail * stat.bsize; };
const expand = (args, values) => args.map(arg => arg.replace(/\{(root|head|out|session|failure|file|test)\}/g, (_, key) => values[key] ?? ''));
const escapePattern = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** argv only; native proof, lease and static-check environment is scoped to the child. */
export function runCommand(cwd, command, args, context = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...context.env }, stdio: [context.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let output = '', interrupted;
    const forward = signal => { interrupted = signal; if (child.pid) try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    const handlers = Object.fromEntries(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => forward(signal)]));
    for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; if (context.log) appendFileSync(context.log, chunk); process.stdout.write(chunk); });
    if (context.stdin) { child.stdin.on('error', () => {}); child.stdin.end(context.stdin); }
    const cleanup = () => { for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => { cleanup(); if (signal || interrupted) reject(new Error(`Interrupted command: ${signal || interrupted}`)); else resolveRun({ code, output }); });
  });
}

function remoteHead(root) {
  const rows = git(root, ['ls-remote', '--exit-code', 'origin', integration]).split('\n').filter(line => line.split(/\s+/)[1] === integration);
  if (rows.length !== 1 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?\s/.test(rows[0])) throw new Error('Remote integration head is unknown');
  return rows[0].split(/\s+/)[0];
}

/** Push only an ancestor-checked history with an exact server-side base lease. */
export async function publishCandidate({ root, base, head, gateHead, qualifiedHead, out, integrationWorktree, stackBranch }, options = {}) {
  const remote = options.remoteHead || remoteHead, command = options.command || runCommand;
  const common = resolve(root, git(root, ['rev-parse', '--git-common-dir'])), pending = join(common, 'merge-queue-pending.json');
  if (existsSync(pending)) throw new Error(`Publication needs reconciliation first: ${pending}`);
  const before = remote(root);
  if (before !== base) return { status: 'remote-moved', observed: before, reason: 'Remote integration moved before push; nothing sent. Refresh only an eligible docs tail.' };
  git(root, ['merge-base', '--is-ancestor', base, head]);
  let documentationPaths;
  if (gateHead) {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(gateHead)) throw new Error('Publication binding needs the exact tested SHA');
    if (qualifiedHead) git(root, ['merge-base', '--is-ancestor', qualifiedHead, gateHead]);
    git(root, ['merge-base', '--is-ancestor', gateHead, head]);
    documentationPaths = assertDocsDelta(root, gateHead, head);
  }
  const intent = { phase: 'publishing', base, head, testedSha: gateHead || null, qualifiedHead: qualifiedHead || null,
    codeUnchanged: gateHead ? true : null, documentationPaths: documentationPaths || null, out, stackBranch, at: new Date().toISOString() };
  writeFileSync(pending, JSON.stringify(intent, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  let result, error, observed;
  try { result = await command(root, 'git', ['push', '--porcelain', `--force-with-lease=${integration}:${base}`, 'origin', `${head}:${integration}`], { phase: 'publication push', log: join(out, 'push.log') }); }
  catch (caught) { error = caught.message; }
  try { observed = remote(root); } catch (caught) { error = caught.message; }
  if (observed !== head) {
    // Porcelain names this exact ref as rejected. A known remote read-back plus
    // the server lease rejection proves this attempt did not publish anything.
    const rejected = result?.code !== 0 && result?.output?.split('\n').some(line => {
      const [flag, refs, summary] = line.split('\t');
      return flag === '!' && refs?.endsWith(`:${integration}`) && /^\[rejected\] \((?:stale info|fetch first|non-fast-forward)\)/.test(summary || '');
    });
    if (observed && rejected) {
      atomic(join(out, 'publication.json'), { ...intent, phase: 'rejected-not-published', observed, exitCode: result.code });
      rmSync(pending);
      return { status: 'remote-moved', reason: 'Remote lease rejected; nothing published. Refresh only an eligible docs tail.', observed };
    }
    atomic(pending, { ...intent, phase: 'needs-reconciliation', observed, error, exitCode: result?.code });
    return { status: 'needs-review', reason: `Publication unconfirmed; never resend blindly. Inspect ${pending}`, observed };
  }
  // The remote outcome is now known. A local repair failure must never cause another push.
  atomic(pending, { ...intent, phase: 'published-needs-local-sync', observed });
  try {
    const synchronize = options.syncIntegration || fastForwardIntegration;
    const synced = await synchronize({ repository: root, integrationWorktree, base: options.localBase || base, head, stackBranch });
    atomic(join(out, 'publication.json'), { ...intent, phase: 'published', observed, synced }); rmSync(pending);
    return { status: 'published', synced };
  } catch (caught) {
    atomic(pending, { ...intent, phase: 'published-needs-local-sync', observed, error: caught.message });
    return { status: 'published-needs-local-sync', reason: `Remote confirmed; repair local integration without pushing again: ${caught.message}`, receipt: pending };
  }
}

function readGate(out, head, expected) {
  const record = JSON.parse(readFileSync(join(out, 'gate.json'), 'utf8')), names = record.suites?.map(s => s.name) || [];
  if (record.kind !== 'gate' || record.commit !== head || record.dirty !== false || !record.end || record.interrupted || names.length !== expected.length || new Set(names).size !== names.length || expected.some(name => !names.includes(name)) || !['passed', 'failed'].includes(record.overall) || record.suites.some(s => !['completed', 'timed out'].includes(s.status))) throw new Error(`Incomplete or mismatched gate evidence: ${out}`);
  const failures = record.suites.filter(s => {
    const oracle = s.name === 'oracle' && s.expectedOracle && existsSync(join(out, 'oracle.log')) && expectedOracleOnly(readFileSync(join(out, 'oracle.log'), 'utf8'), s.exitCode);
    return s.status !== 'completed' || s.signal || s.timedOut || !(s.exitCode === 0 || oracle) || s.failed > 0;
  });
  if ((record.overall === 'passed') !== (failures.length === 0)) throw new Error(`Inconsistent gate outcome: ${out}`);
  return { record, failures };
}

export function needsInstallProof(files) {
  return files.some(file => /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.dockerignore)$/.test(file) || /^(?:deploy\/|scripts\/(?:lib\/)?(?:bundle|packag|install|brand|docker|cli-runtime)|packages\/surfaces\/(?:cli|app)\/(?:scripts\/|src\/(?:main|index)\.))/.test(file));
}

function stageGeneratedChanges(root) {
  const generated = generatedPaths(root);
  const tracked = new Set(git(root, ['ls-files', '-z']).split('\0').filter(Boolean));
  for (const file of tracked) {
    if (file.endsWith('/backbone.module.json')) generated.add(file);
    if (file.endsWith('/README.md') && existsSync(join(root, dirname(file), 'backbone.module.json'))
      && readFileSync(join(root, file), 'utf8').includes('<!-- generated from backbone.module.json')) generated.add(file);
  }
  const changed = [...new Set([
    ...git(root, ['diff', '--name-only', '-z', 'HEAD']).split('\0'),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))];
  const unexpected = changed.filter(file => !generated.has(file) || !existsSync(join(root, file)));
  if (unexpected.length) throw new Error(`Unexpected generated output paths; refuse to stage: ${unexpected.join(', ')}`);
  if (changed.length) git(root, ['add', '--', ...changed]);
}

/** One file/title only; preserve shared-cluster and installed-app consumer boundaries. */
export function isolatedTestPlan(root, failure) {
  const file = failure.files?.find(value => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(value));
  if (!file || !failure.test || file.startsWith('/') || file.split('/').includes('..')) return null;
  // Runners prefix nested names with suite/file/project text. Positive evidence
  // below must still prove exactly one test ran, so a broad/empty match cannot pass.
  const pattern = escapePattern(failure.test);
  if (failure.suite === 'app-installed') return [process.execPath, join(driverRoot, 'scripts/merge-queue-isolated.mjs'), root, file, failure.test, failure.project || (file.endsWith('/goals.spec.ts') ? 'goals' : 'electron')];
  if (file.includes('/e2e/')) return ['pnpm', '--dir', 'packages/surfaces/app', 'e2e', file.split('/e2e/')[1], '--grep', pattern, '--workers=1', ...(failure.project ? ['--project', failure.project] : [])];
  if (file.startsWith('packages/core/')) return [process.execPath, 'scripts/no-leftovers.mjs', 'pnpm', '--dir', 'packages/core', 'exec', 'vitest', 'run', relative('packages/core', file), '-t', pattern];
  const parts = file.split('/'); let pkg;
  for (let count = parts.length - 1; count > 1; count--) { const at = parts.slice(0, count).join('/'); if (existsSync(join(root, at, 'package.json'))) { pkg = JSON.parse(readFileSync(join(root, at, 'package.json'), 'utf8')); break; } }
  const node = [process.execPath, '--test', '--test-name-pattern', pattern, file];
  if (pkg?.scripts?.test?.includes('with-test-cluster')) return [process.execPath, 'scripts/no-leftovers.mjs', process.execPath, 'scripts/with-test-cluster.mjs', ...node];
  return existsSync(join(root, 'scripts/no-leftovers.mjs')) ? [process.execPath, 'scripts/no-leftovers.mjs', ...node] : node;
}

function runtimeConfig(queue, options) {
  const runtime = { ...queue.runtime, ...options.runtime };
  validatePostGate(runtime);
  if (!runtime.integrationWorktree && !options.publish) throw new Error('runtime.integrationWorktree must name the dedicated integration checkout before gating');
  if (!options.notify && (!Array.isArray(runtime.authorRelay) || !runtime.authorRelay.length || runtime.authorRelay.some(arg => typeof arg !== 'string' || !arg || /[\0\r\n]/.test(arg)))) throw new Error('runtime.authorRelay argv must deliver failures to their named authoring sessions');
  return runtime;
}
function validateTools(root, runtime) {
  for (const argv of [runtime.nativeCollector, runtime.restoredNative, ['pnpm'], ['colima'], ['bash'], ['git']]) {
    const executable = argv[0];
    const available = executable.includes('/') ? existsSync(resolve(root, executable)) : spawnSync('which', [executable], { stdio: 'ignore' }).status === 0;
    if (!available) throw new Error(`Required qualification executable is unavailable: ${executable}`);
    if (/^(?:node|python\d?(?:\.\d+)?|bash|sh)$/.test(executable.split('/').pop()) && argv[1] && !argv[1].startsWith('-') && !existsSync(resolve(root, argv[1]))) throw new Error('Configured native proof script is missing; refuse before gating');
  }
}
function bindingFor(root, unit, queue) {
  const value = unit.review || queue.reviews?.[unit.name];
  if (!value) return null;
  if (typeof value !== 'string') throw new Error(`${unit.name}: review binding must name a local JSON file`);
  try { return JSON.parse(readFileSync(resolve(root, value), 'utf8')); } catch { throw new Error(`${unit.name}: cannot read its review binding JSON`); }
}
function localIntegration(root, runtime, base) {
  if (!runtime.integrationWorktree) return base; // Only the injected publication seam omits a real checkout.
  const target = realpathSync(resolve(root, runtime.integrationWorktree));
  if (target === realpathSync(root)) throw new Error('The integration checkout must be distinct from the running driver');
  if (git(target, ['rev-parse', '--git-common-dir']) === '') throw new Error('Invalid integration checkout');
  if (realpathSync(resolve(target, git(target, ['rev-parse', '--git-common-dir']))) !== realpathSync(resolve(root, git(root, ['rev-parse', '--git-common-dir'])))) throw new Error('Integration checkout belongs to another repository');
  if (git(target, ['symbolic-ref', '-q', 'HEAD']) !== integration || git(target, ['status', '--porcelain'])) throw new Error('Integration checkout must be clean and on claude/integration');
  const local = git(target, ['rev-parse', 'HEAD']); git(root, ['merge-base', '--is-ancestor', local, base]); return local;
}

export async function runQueue(root, queue, options = {}) {
  root = realpathSync(root);
  const units = validateQueue(queue), remoteBase = git(root, ['rev-parse', '--verify', `${tracking}^{commit}`]);
  const base = queue.qualifiedHead ?? options.qualifiedHead;
  const docsTail = inspectDocsTail(root, base, remoteBase);
  for (const unit of units) if (git(root, ['rev-parse', '--verify', `${unit.name}^{commit}`]) !== unit.head) throw new Error(`Queued head moved: ${unit.name}`);
  if (git(root, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Merge queue needs a clean caller checkout; keep queue/evidence under .gate');
  const selected = chooseBatch(units, queue.policy || {});
  const plan = { status: 'planned', base, remoteBase, docsTail, units, selected: selected.map(unit => unit.name), mode: queue.policy?.mode || 'serial', steps: ['build from qualifiedHead; cherry-pick each unit own range relative to remote integration', 'install, prune, regenerate; static checks without guide-steps', 'bound ACCEPT and frozen Core diff; idle disk/load/lock preflight', 'one full gate; at most one classified environment/flake retry', 'native collector, restored native, Docker, CLI install, oracle cleanup', 'merge gated code into verified docs-only remote tail; append record; lease push and local fast-forward'] };
  if (options.dryRun || !units.length) {
    const inspected = units.length ? (options.inspect || inspectQueue)(root, units.map(unit => unit.name), { regeneration: () => [] }) : { rows: [] };
    const reviews = units.map(unit => { try { return { unit: unit.name, ...inspectUnitBinding(root, unit, remoteBase, bindingFor(root, unit, queue)) }; } catch (error) { return { unit: unit.name, accepted: false, reasons: [error.message] }; } });
    return { ...plan, inspection: inspected.rows, reviews };
  }
  const runtime = runtimeConfig(queue, options), remote = options.remoteHead || remoteHead;
  if (remote(root) !== remoteBase) throw new Error('Remote integration moved; refresh it before building');
  const common = resolve(root, git(root, ['rev-parse', '--git-common-dir'])), fd = openSync(join(common, 'merge-queue.control'), constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()) || !native.tryLock(fd)) throw new Error('Merge queue is already running or its control file is unsafe');
    if (existsSync(join(common, 'merge-queue-pending.json'))) throw new Error('Previous publication needs reconciliation; inspect the common Git merge-queue-pending.json');
    const driver = (options.snapshot || driverSnapshot)(driverRoot);
    return await execute(root, queue, plan, { ...options, runtime, remote, driver });
  } finally { closeSync(fd); }
}

async function execute(root, queue, plan, options) {
  let out = resolve(root, queue.out || join('.gate', 'merge-queue', randomUUID()));
  if (!out.startsWith(join(root, '.gate') + '/')) throw new Error('Queue evidence must stay in its owned .gate directory');
  for (let parent = dirname(out); parent !== root; parent = dirname(parent)) if (existsSync(parent) && realpathSync(parent) !== parent) throw new Error('Queue evidence ancestors cannot be symbolic links');
  let initialEnvironment, admissionError, archived = null;
  try { initialEnvironment = await (options.preflight || preflight)(root, { ...options.runtime, ownedReceipt: join(out, 'heavy-lease.json'), freeBytes: options.freeBytes, load: options.load }); }
  catch (error) { admissionError = error; out = join(root, '.gate', 'merge-queue-refusals', randomUUID()); }
  // Never rotate an evidence directory until process/lease admission proves it idle.
  if (!admissionError) archived = archiveEvidence(out);
  mkdirSync(out, { recursive: true });
  const state = { ...plan, status: 'building', out, archived, returned: [], failures: [], successes: [], attempts: [], phases: [], units: [], deferred: [] };
  const save = () => atomic(join(out, 'queue.json'), state);
  const check = () => (options.assertDriver || assertDriverUnchanged)(options.driver);
  const command = options.command || runCommand;
  const observe = options.observe || (where => ({ at: new Date().toISOString(), freeBytes: (options.freeBytes || space)(where), load: (options.load || loadavg)() }));
  const notify = async (unit, failure, testedSha) => {
    const envelope = failureEnvelope(unit, failure, testedSha); state.failures.push(envelope); save();
    const target = join(out, `return-${state.failures.length}.json`); atomic(target, envelope);
    try {
      if (options.notify) await options.notify(envelope, target);
      else {
      const argv = expand(options.runtime.authorRelay, { root, session: unit.session, failure: target, out });
      const result = await command(root, argv[0], argv.slice(1), { phase: 'author session return', stdin: JSON.stringify(envelope), env: { BACKBONE_QUEUE_AUTHOR_SESSION: unit.session, BACKBONE_QUEUE_FAILURE: target }, log: join(out, 'relay.log') });
      if (result.code !== 0) throw new Error(`Author-session delivery failed for ${unit.session}; durable return retained at ${target}`);
      }
      envelope.deliveredTo = unit.session;
    } catch (error) {
      // A failed relay may already have delivered. Retain the envelope and never resend it here.
      envelope.delivery = 'needs-reconciliation'; envelope.deliveryError = error.message; state.deliveryPending = true;
    }
    atomic(target, envelope); save(); return envelope;
  };
  const stage = async (cwd, phase, argv, env = {}) => {
    check(); const entry = { phase, command: argv, start: new Date().toISOString() }, began = Date.now(); state.phases.push(entry); save();
    const log = join(out, `phase-${state.phases.length}.log`);
    try { const result = await command(cwd, argv[0], argv.slice(1), { env, phase, log }); entry.exitCode = result.code; if (result.code !== 0) { const error = new Error(`${phase} failed (${result.code}); ${log}`); error.log = log; error.output = result.output; error.phase = phase; throw error; } return result; }
    finally { entry.durationSeconds = (Date.now() - began) / 1000; save(); }
  };
  let base = plan.base, remoteBase = plan.remoteBase, pending = [...plan.units], attached = false, candidate;
  const remove = () => { if (attached) { git(root, ['worktree', 'remove', '--force', candidate]); attached = false; } };
  const inspect = options.inspect || inspectQueue;
  save();
  try {
    if (admissionError) { state.units = plan.units.filter(unit => plan.selected.includes(unit.name)); throw admissionError; }
    state.environment = initialEnvironment;
    while (pending.length) {
      check();
      const inventories = pending.map(unit => ({ ...unit, files: git(root, ['diff', '--no-renames', '--name-only', '-z', git(root, ['merge-base', remoteBase, unit.head]), unit.head]).split('\0').filter(Boolean) }));
      const batch = chooseBatch(inventories, queue.policy || {}); pending = pending.filter(unit => !batch.some(selected => selected.name === unit.name));
      state.units = batch; state.gateHead = null; state.gateOut = null;
      // Admission precedes snapshot extraction or installation. A doomed run costs seconds.
      state.environment = await (options.preflight || preflight)(root, { ...options.runtime, ownedReceipt: archived ? join(archived, 'heavy-lease.json') : undefined, freeBytes: options.freeBytes, load: options.load }); save();
      if (options.remote(root) !== remoteBase) throw new Error('Remote integration moved; discard candidate before gating');
      const localBase = localIntegration(root, options.runtime, remoteBase);
      const bound = [];
      for (const unit of batch) {
        let binding;
        try { binding = bindingFor(root, unit, queue); } catch (error) { binding = { invalid: error.message }; }
        const proof = inspectUnitBinding(root, unit, remoteBase, binding);
        Object.assign(unit, { reviewedSha: proof.reviewedSha, patchId: proof.patchId, files: proof.files, reviewBinding: proof });
        if (!proof.accepted) state.returned.push(await notify(unit, { causeClass: 'integration', reason: proof.reasons.join('; '), action: 'return to author' }, null));
        else bound.push(unit);
      }
      if (!bound.length) continue;
      // queue-check's snapshot regeneration loads the unit's own driver. Bind
      // review first so an unreviewed oracle change cannot execute even there.
      const inspected = inspect(root, bound.map(unit => unit.name)), accepted = [];
      for (const unit of bound) {
        const row = inspected.rows.find(row => row.branch === unit.name);
        if (!row || row.sha !== unit.head || row.regen.length) {
          const reason = [...(row?.regen || []), ...(!row || row.sha !== unit.head ? ['Queue head changed'] : [])].join('; ');
          state.returned.push(await notify(unit, { causeClass: 'integration', reason, action: 'return to author' }, null));
        } else accepted.push(unit);
      }
      if (!accepted.length) continue;
      const number = state.attempts.length + state.successes.length + state.returned.length + 1;
      candidate = join(out, `candidate-${number}`); git(root, ['worktree', 'add', '--detach', candidate, base]); attached = true;
      let needsRelock = false;
      const stacked = [];
      for (const unit of accepted) {
        const picked = cherryPickUnit(candidate, unit, { base: remoteBase }); needsRelock ||= picked.needsRelock;
        if (picked.judgement) {
          const schemaJudgement = picked.judgement.some(item => Object.hasOwn(item, 'entry'));
          state.returned.push(await notify(unit, { causeClass: 'integration', reason: picked.reason, judgement: picked.judgement, conflicts: picked.conflicts, action: schemaJudgement ? 'person must align these entries' : 'return to author' }, null));
          if (schemaJudgement) {
            state.status = 'needs-judgement'; state.deferred = [...accepted.filter(other => !state.returned.some(item => item.name === other.name && item.unitHead === other.head)), ...pending]; save(); return state;
          }
          continue;
        }
        if (picked.conflicts.length) state.returned.push(await notify(unit, { causeClass: 'integration', reason: picked.reason || 'Non-mechanical conflict', conflicts: picked.conflicts, action: 'return to author' }, null));
        else stacked.push(unit);
      }
      if (!stacked.length) { remove(); continue; }
      state.units = stacked;
      // Pin even pre-gate failures so the authored tree stays inspectable after
      // removing its build worktree. Successful publication releases this ref.
      const ref = `refs/heads/merge-queue/${out.split('/').pop()}/${number}`;
      git(root, ['update-ref', ref, git(candidate, ['rev-parse', 'HEAD'])]); state.candidateRef = ref; save();
      assertRecordTarget(candidate);
      if (!options.command) validateTools(candidate, options.runtime);
      await stage(candidate, 'install', ['pnpm', 'install', needsRelock ? '--no-frozen-lockfile' : '--frozen-lockfile', '--offline']);
      await stage(candidate, 'prune', ['pnpm', 'prune']);
      await stage(candidate, 'regenerate', ['pnpm', 'regen']);
      await stage(candidate, 'static checks', [process.execPath, 'scripts/check.mjs'], { BACKBONE_GUIDE_STEP: '1' });
      stageGeneratedChanges(candidate);
      if (git(candidate, ['diff', '--cached', '--name-only'])) git(candidate, ['-c', 'core.hooksPath=scripts/hooks', 'commit', '-s', '-m', 'Regenerate serial queue candidate', '--trailer', 'Agent: merge-queue']);
      const testedSha = git(candidate, ['rev-parse', 'HEAD']); state.gateHead = testedSha;
      git(root, ['update-ref', ref, testedSha]);
      const expected = options.expectedSuites || [...discoverPackages(candidate).suites.map(s => s.name), 'check', 'app-e2e', 'app-installed', 'oracle'];
      let retries = 0, qualified = false, blocked = false;
      const underLease = options.withLease || withQueueHeavyLease;
      await underLease(async lease => {
        const guard = () => { check(); lease.assertValid(); };
        if (needsInstallProof(stacked.flatMap(unit => unit.files))) await stage(candidate, 'pre-gate CLI install', ['pnpm', 'test:install'], lease.env);
        for (let attempt = 0; ; attempt++) {
          guard();
          const gateOut = join(out, `gate-${number}-${attempt}`); archiveEvidence(gateOut);
          const began = Date.now(), gateAttempt = { head: testedSha, reviewed: stacked.map(unit => ({ unit: unit.name, sha: unit.reviewedSha })), out: gateOut, start: new Date(began).toISOString() };
          state.attempts.push(gateAttempt); state.status = 'gating'; save();
          let result;
          try { result = await command(candidate, 'pnpm', ['gate', '--out', gateOut], { env: lease.env, phase: 'gate', log: join(out, `gate-${number}-${attempt}.log`) }); }
          finally {
            gateAttempt.end = new Date().toISOString(); gateAttempt.durationSeconds = (Date.now() - began) / 1000; save();
            // The oracle's tracked reports are output, never a candidate source edit.
            await stage(candidate, 'restore oracle results', ['git', 'checkout', '--', 'oracle/results'], lease.env);
          }
          const evidence = readGate(gateOut, testedSha, expected);
          if (result.code !== (evidence.record.overall === 'passed' ? 0 : 1)) throw new Error(`Gate command/evidence disagree: ${gateOut}`);
          if (!evidence.failures.length) { state.gateOut = gateOut; qualified = true; break; }
          const observations = observe(candidate); state.environment = observations; save(); // df/load FIRST, before blame.
          const details = evidence.failures.map(entry => {
            const log = join(gateOut, `${entry.name}.log`), text = readFileSync(log, 'utf8');
            const failure = { ...classifyFailure(text, { root: candidate, suite: entry.name, environment: observations.freeBytes < 20 * 1024 ** 3 }), suite: entry.name, log, text, environment: observations };
            failure.mapping = attributeFailingFiles(candidate, failure, stacked); return failure;
          });
          const allRetryable = details.every(failure => failure.retryable);
          const unmapped = details.find(failure => failure.mapping.units.length === 0 || !failure.mapping.complete || failure.mapping.unassigned.length);
          if (retries === 0 && allRetryable) {
            if (unmapped) {
              const unassigned = unmapped.mapping.unassigned;
              const reportedCase = unmapped.cases?.find(item => unassigned.includes(item.file));
              const isolatedFailure = { ...unmapped, files: reportedCase ? [reportedCase.file] : unassigned.length ? unassigned : unmapped.files, test: reportedCase?.test || unmapped.test, project: reportedCase?.project || unmapped.project };
              const argv = isolatedTestPlan(candidate, isolatedFailure);
              if (argv) {
                retries++; guard();
                const isolated = await command(candidate, argv[0], argv.slice(1), { env: lease.env, phase: 'isolated retry', log: join(out, `isolated-${number}.log`) });
                const counts = parseCounts(isolated.output || '');
                unmapped.isolated = { command: argv, exitCode: isolated.code, ...counts, log: join(out, `isolated-${number}.log`) };
                if (isolated.code === 0 && counts.passed === 1 && counts.failed === 0 && (!unmapped.cases || unmapped.cases.length <= 1)) { unmapped.causeClass = 'test-state/flake'; unmapped.reason = 'Unassigned failure passed its one isolated locked retry; a fresh complete gate is still required'; }
              }
              else unmapped.isolated = { notRun: 'No unambiguous single-file/title selector; agent judgement required' };
              for (const unit of stacked) await notify(unit, { ...unmapped, text: undefined, action: 'diagnose; no unit dropped' }, testedSha);
              blocked = true; break;
            }
            for (const failure of details) for (const unit of stacked) await notify(unit, { ...failure, text: undefined, action: 'one classified full-gate retry' }, testedSha);
            retries++; continue;
          }
          for (const failure of details) {
            const names = failure.mapping.units;
            for (const unit of stacked) {
              const mayDrop = failure.causeClass === 'product defect' && failure.mapping.complete && !failure.mapping.unassigned.length && names.includes(unit.name);
              const report = await notify(unit, { ...failure, text: undefined, action: mayDrop ? 'return mapped unit to author' : 'diagnose; no unit dropped' }, testedSha);
              if (mayDrop) state.returned.push(report);
              else blocked = true;
            }
          }
          break; // No batch-and-bisect and no retry of an unclassified product failure.
        }
        if (!qualified) return;
        guard();
        const proofOptions = { ...options.runtime, env: lease.env, nativeCollector: expand(options.runtime.nativeCollector, { root: candidate, head: testedSha, out }), restoredNative: expand(options.runtime.restoredNative, { root: candidate, head: testedSha, out }), onPhase: entry => { state.postGate ||= []; if (!state.postGate.includes(entry)) state.postGate.push(entry); save(); } };
        state.postGate = await (options.postGate || runPostGate)(candidate, command, proofOptions);
        guard();
        if (git(candidate, ['status', '--porcelain']) || git(candidate, ['rev-parse', 'HEAD']) !== testedSha) throw new Error('Candidate changed during qualification; discard evidence');
        // Docs races get a bounded publication retry, never another full gate.
        // Only known nonpublication can repeat: uncertain sends retain their intent.
        let publication, head, stackBranch;
        for (let docsAttempt = 0; docsAttempt < 3; docsAttempt++) {
          guard();
          if (docsAttempt) git(candidate, ['reset', '--hard', testedSha]);
          const publicationBase = options.remote(root);
          if (spawnSync('git', ['cat-file', '-e', `${publicationBase}^{commit}`], { cwd: root, stdio: 'ignore' }).status !== 0) {
            await stage(root, 'fetch docs tail', ['git', 'fetch', '--no-tags', '--no-write-fetch-head', 'origin', publicationBase], lease.env);
          }
          guard();
          state.docsTail = carryDocsTail(candidate, { qualifiedHead: base, remoteBase: publicationBase, gatedHead: testedSha }); save();
          const line = integrationLine(readFileSync(join(state.gateOut, 'gate-summary.txt'), 'utf8'), stacked, testedSha).trimEnd() + ` Reviewed ${stacked.map(unit => `${unit.name}:${unit.reviewedSha || 'not-required'}`).join(', ')}; native, Docker and CLI install passed.\n`;
          appendIntegrationRecord(candidate, line);
          git(candidate, ['add', '--', 'docs/execution.md']); git(candidate, ['-c', 'core.hooksPath=scripts/hooks', 'commit', '-s', '-m', 'Record qualified serial queue candidate', '--trailer', 'Agent: merge-queue']);
          head = git(candidate, ['rev-parse', 'HEAD']);
          if (git(candidate, ['diff', '--name-only', state.docsTail.head, head]) !== 'docs/execution.md') throw new Error('Record commit changed qualified inputs');
          assertDocsDelta(candidate, testedSha, head);
          await stage(candidate, 'record static checks', [process.execPath, 'scripts/check.mjs'], { ...lease.env, BACKBONE_GUIDE_STEP: '1' });
          guard();
          if (git(candidate, ['status', '--porcelain']) || git(candidate, ['rev-parse', 'HEAD']) !== head) throw new Error('Record static checks changed publication inputs');
          git(root, ['update-ref', ref, head]);
          stackBranch = queue.stackBranch || `claude/queue-stack-${out.split('/').pop()}-${number}`;
          const publicationOut = join(out, `publication-${number}-${docsAttempt}`); mkdirSync(publicationOut);
          const attempt = { base: publicationBase, head, testedSha, reviewed: stacked.map(unit => ({ name: unit.name, sha: unit.reviewedSha })), out: publicationOut };
          (state.publicationAttempts ||= []).push(attempt); save();
          const publish = options.publish || (value => publishCandidate(value, { remoteHead: options.remote, command, localBase }));
          publication = await publish({ root, base: publicationBase, qualifiedHead: base, head, gateHead: testedSha, out: publicationOut, integrationWorktree: options.runtime.integrationWorktree && resolve(root, options.runtime.integrationWorktree), stackBranch });
          Object.assign(attempt, publication);
          if (publication.status === 'remote-moved') attempt.causeClass = 'integration';
          save();
          if (publication.status !== 'remote-moved') break;
        }
        Object.assign(state, publication, { head, stackBranch });
        if (publication.status === 'published' || publication.status === 'published-needs-local-sync') state.successes.push({ units: stacked.map(unit => unit.name), head, testedSha, reviewed: stacked.map(unit => ({ name: unit.name, sha: unit.reviewedSha })) });
        save();
        if (publication.status === 'published') {
          git(root, ['update-ref', '-d', ref, head]); state.candidateRef = null; base = head; remoteBase = head;
        } else blocked = true;
      }, { ...options.runtime, root: candidate, receipt: join(out, 'heavy-lease.json'), freeBytes: options.freeBytes, load: options.load });
      remove();
      if (blocked) { state.status = state.status.startsWith('published-') || state.status === 'remote-moved' ? state.status : 'needs-review'; state.deferred = [...stacked.filter(unit => !state.returned.some(item => item.name === unit.name && item.unitHead === unit.head)), ...pending]; save(); return state; }
    }
    state.status = state.deliveryPending ? 'needs-review' : state.successes.length ? 'published' : 'returned'; save(); return state;
  } catch (error) {
    state.status = 'failed'; state.reason = error.message; state.environment = error.environment || state.environment;
    if (attached) {
      try {
        const snapshot = join(out, 'candidate-failure.patch');
        const collect = options.failureSnapshot || (where => {
          const result = spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd: where, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });
          if (result.status !== 0) throw new Error(`Failure snapshot git diff: ${result.stderr || result.error?.message || result.status}`);
          return { patch: result.stdout, status: git(where, ['status', '--porcelain', '--untracked-files=all']) };
        });
        const tree = collect(candidate); writeFileSync(snapshot, tree.patch);
        state.failedTree = { ref: state.candidateRef, patch: snapshot, status: tree.status };
      } catch (snapshotError) {
        // Diagnostic collection must not replace the failure or skip its notice.
        state.failedTree = { ref: state.candidateRef, error: snapshotError.message };
      }
    }
    if (!error.environment) state.environment = observe(attached ? candidate : root);
    if (error.phases) state.postGate = error.phases;
    const log = error.log, source = error.output || error.phases?.map(phase => phase.output || phase.error || '').join('\n') || (log && existsSync(log) ? readFileSync(log, 'utf8') : error.message);
    for (const unit of state.units) await notify(unit, { ...classifyFailure(source, { environment: Boolean(error.environment), integration: /record|binding|conflict|static/.test(error.message) }), reason: error.message, log: log || null, action: 'diagnose; no automatic drop' }, state.gateHead || null);
    save(); throw error;
  } finally { remove(); }
}

export async function main(args = process.argv.slice(2)) {
  const dryRun = args.includes('--dry-run'), positional = args.filter(arg => arg !== '--dry-run');
  if (positional.length !== 1 || positional[0].startsWith('-')) throw new Error('usage: node scripts/merge-queue.mjs [--dry-run] <queue.json>');
  const queue = JSON.parse(readFileSync(resolve(positional[0]), 'utf8')); validateQueue(queue);
  if (!dryRun) { const refreshed = await runCommand(process.cwd(), 'git', ['fetch', 'origin', 'claude/integration']); if (refreshed.code !== 0) throw new Error('Cannot refresh integration'); }
  const result = await runQueue(process.cwd(), queue, { dryRun }); console.log(JSON.stringify(result, null, 2));
  return ['planned', 'published'].includes(result.status) && !result.returned?.length ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
