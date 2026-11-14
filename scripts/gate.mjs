import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync, globSync, readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeLock, releaseLock } from './heavy-slots.mjs';
import { gateResults } from './test-results.mjs';
import { prepareInstalled, installedResult } from './gate-installed.mjs';

// Each deliberately excluded package must have a reason beside its name.
const packageAllowlist = new Set();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function discoverPackages(workspaceRoot, allowlist = packageAllowlist) {
  const yaml = readFileSync(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8');
  const section = yaml.match(/^packages:\s*(?:#.*)?\n((?:(?:[ \t]+.*|\s*)\n?)*)/m);
  if (!section) throw new Error('Missing packages list in pnpm-workspace.yaml');
  const patterns = section[1].split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
    const match = line.match(/^-\s+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s#]+))\s*(?:#.*)?$/);
    if (!match) throw new Error(`Unsupported workspace package pattern: ${line}`);
    return match[1] ?? match[2] ?? match[3];
  });
  const dirs = new Set(['.']);
  for (const pattern of patterns.filter(p => !p.startsWith('!'))) {
    for (const dir of globSync(pattern, { cwd: workspaceRoot, exclude: ['**/node_modules/**'] })) dirs.add(dir);
  }
  for (const pattern of patterns.filter(p => p.startsWith('!'))) {
    for (const dir of globSync(pattern.slice(1), { cwd: workspaceRoot })) dirs.delete(dir);
  }
  const packages = [...dirs].filter(dir => existsSync(path.join(workspaceRoot, dir, 'package.json'))).map(dir => {
    const pkg = JSON.parse(readFileSync(path.join(workspaceRoot, dir, 'package.json'), 'utf8'));
    if (!pkg.name) throw new Error(`Workspace package has no name: ${dir}`);
    return pkg;
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (new Set(packages.map(pkg => pkg.name)).size !== packages.length) throw new Error('Duplicate workspace package name');
  const noTest = packages.filter(pkg => !Object.hasOwn(pkg.scripts ?? {}, 'test')).map(pkg => pkg.name);
  const tested = packages.filter(pkg => Object.hasOwn(pkg.scripts ?? {}, 'test') && !allowlist.has(pkg.name));
  tested.sort((a, b) => (a.name === '@backbone-next/platform' ? -1 : b.name === '@backbone-next/platform' ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const suites = tested.map(pkg => ({ name: pkg.name.split('/').pop(), command: 'pnpm', args: ['--filter', pkg.name, 'test'] }));
  if (new Set(suites.map(suite => suite.name)).size !== suites.length) throw new Error('Duplicate package suite name');
  return { suites, noTest, excluded: packages.filter(pkg => allowlist.has(pkg.name)).map(pkg => pkg.name) };
}

const discovery = discoverPackages(root);
export const suites = [
  ...discovery.suites,
  { name: 'check', command: 'pnpm', args: ['check'] },
  { name: 'app-e2e', command: 'pnpm', args: ['--filter', '@backbone-next/app', 'e2e'] },
  { name: 'app-installed', command: 'pnpm', args: ['--filter', '@backbone-next/app', 'e2e:installed'] },
  { name: 'oracle', command: 'pnpm', args: ['oracle'] },
];
if (new Set(suites.map(suite => suite.name)).size !== suites.length) throw new Error('Duplicate gate suite name');

export function parseCounts(output) {
  const oracle = [...output.matchAll(/oracle \(successor\):\s*(\d+) passed,\s*(\d+) failed,\s*(\d+) not implemented/g)];
  if (oracle.length === 1) return { passed: +oracle[0][1], failed: +oracle[0][2], unimplemented: +oracle[0][3] };
  const passes = [...output.matchAll(/^# pass (\d+)\s*$/gm)];
  const failures = [...output.matchAll(/^# fail (\d+)\s*$/gm)];
  if (passes.length === 1 && failures.length === 1) return { passed: +passes[0][1], failed: +failures[0][1] };
  const playwright = [...output.matchAll(/^\s*(\d+) (passed|failed)(?:\s*\([^\n]*\))?\s*$/gm)];
  if (playwright.length && playwright.filter(x => x[2] === 'passed').length <= 1 && playwright.filter(x => x[2] === 'failed').length <= 1 && passes.length === 0 && failures.length === 0) {
    return { passed: +(playwright.find(x => x[2] === 'passed')?.[1] ?? 0), failed: +(playwright.find(x => x[2] === 'failed')?.[1] ?? 0) };
  }
  return { passed: 'unknown', failed: 'unknown' };
}

function git(...args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}
function version(command) {
  const r = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}
function options(args) {
  const result = { wait: 0, allowDirty: false, list: false, suiteTimeout: 45 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--allow-dirty') result.allowDirty = true;
    else if (arg === '--keep-going') {} // Continuing is the default.
    else if (arg === '--list') result.list = true;
    else if (['--out', '--only', '--wait', '--suite-timeout'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} needs a value`);
      result[arg === '--suite-timeout' ? 'suiteTimeout' : arg.slice(2)] = args[++i];
    } else throw new Error(`Unknown option: ${arg}`);
  }
  result.wait = Number(result.wait);
  if (!Number.isFinite(result.wait) || result.wait < 0) throw new Error('--wait must be a non-negative number of minutes');
  result.suiteTimeout = Number(result.suiteTimeout);
  if (!Number.isFinite(result.suiteTimeout) || result.suiteTimeout <= 0 || result.suiteTimeout * 60000 > 2 ** 31 - 1) throw new Error('--suite-timeout must be a positive number of minutes within the timer limit');
  return result;
}

function killChild(child, signal) {
  if (!child?.pid) return;
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
}
function runSuite(suite, log, onChild, timeoutMinutes) {
  return new Promise((resolve, reject) => {
    // Create before spawning; every chunk goes straight to disk, even if the suite never exits.
    const fd = openSync(log, 'w');
    const child = spawn(suite.command, suite.args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    onChild(child);
    let timedOut = false, escalation;
    const timer = setTimeout(() => {
      timedOut = true;
      writeSync(fd, `\nGate: ${suite.name} timed out after ${timeoutMinutes} minutes\n`);
      killChild(child, 'SIGTERM');
      escalation = setTimeout(() => killChild(child, 'SIGKILL'), 5000);
    }, timeoutMinutes * 60000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { writeSync(fd, chunk); });
    child.on('error', error => { writeSync(fd, `\n${error.message}\n`); });
    child.on('close', async (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation); closeSync(fd);
      try { resolve({ exitCode: code, signal, timedOut, ...parseCounts(await readFile(log, 'utf8')) }); }
      catch (error) { reject(error); }
    });
  });
}

async function saveRecord(out, record) {
  const lines = [`commit ${record.commit}`, `branch ${record.branch}`, `dirty ${record.dirty}`, `node ${record.node}; pnpm ${record.pnpm}; ${record.machine.platform} ${record.machine.arch}`, `start ${record.start}; end ${record.end}`];
  for (const s of record.suites) lines.push(`== ${s.name}: ${s.command} :: ${s.status} :: exit ${s.exitCode ?? `signal ${s.signal}`} :: ${s.passed} passed, ${s.failed} failed${s.unimplemented === undefined ? '' : `, ${s.unimplemented} not implemented`} :: ${s.durationSeconds}s${s.expectedOracle ? ' :: expected: only unimplemented oracle families remain' : ''}`);
  lines.push(`overall: ${record.overall}${record.interrupted ? ` (${record.interrupted})` : ''}`);
  // Atomic replacement keeps a cancelled write from corrupting the last usable snapshot.
  for (const [name, contents] of [['gate.json', JSON.stringify(record, null, 2) + '\n'], ['gate-summary.txt', lines.join('\n') + '\n']]) {
    await writeFile(path.join(out, `${name}.tmp`), contents);
    await rename(path.join(out, `${name}.tmp`), path.join(out, name));
  }
  return lines;
}

export async function main(args = process.argv.slice(2), suiteList = suites) {
  const opts = options(args);
  if (opts.list) {
    for (const suite of suiteList) console.log(`${suite.name}: ${[suite.command, ...suite.args].join(' ')}`);
    console.log('no test script:');
    for (const name of discovery.noTest) console.log(`  ${name}`);
    if (discovery.excluded.length) { console.log('deliberately not gated:'); for (const name of discovery.excluded) console.log(`  ${name}`); }
    return 0;
  }
  const selected = opts.only ? opts.only.split(',').map(name => {
    const suite = suiteList.find(item => item.name === name);
    if (!suite) throw new Error(`Unknown suite: ${name}`);
    return suite;
  }) : suiteList;
  if (new Set(selected.map(s => s.name)).size !== selected.length) throw new Error('Duplicate suite name');
  const commit = git('rev-parse', 'HEAD');
  const branch = git('branch', '--show-current') || '(detached)';
  const dirty = git('status', '--porcelain', '--untracked-files=normal');
  if (dirty && !opts.allowDirty) throw new Error('Working tree is dirty; commit changes or pass --allow-dirty');
  const out = path.resolve(opts.out || `.gate/${commit.slice(0, 7)}`);
  const lock = path.resolve(process.env.BACKBONE_HEAVY_LOCK || path.join(os.homedir(), 'backbone-next-worktrees/.heavy.lock'));
  const start = new Date().toISOString();
  const token = `${process.pid}-${start}-${Math.random()}`;
  let child, interrupted;
  const signalHandler = signal => {
    interrupted = signal;
    killChild(child, signal);
  };
  const onInt = () => signalHandler('SIGINT');
  const onTerm = () => signalHandler('SIGTERM');
  await mkdir(path.dirname(lock), { recursive: true });
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  try { await takeLock(lock, { pid: process.pid, branch, commit, start, token }, opts.wait, () => interrupted); }
  catch (error) { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); throw error; }
  const record = { kind: 'gate', commit, branch, dirty: Boolean(dirty), dirtyFiles: dirty ? dirty.split('\n') : [], node: process.version, pnpm: version('pnpm'), machine: { platform: process.platform, arch: process.arch }, start, end: null, suites: [], overall: 'running' };
  const results = gateResults(process.cwd(), record, out);
  try {
    await mkdir(out, { recursive: true });
    await saveRecord(out, record);
    for (const suite of selected) {
      if (interrupted) break;
      const began = Date.now();
      const command = [suite.command, ...suite.args].join(' ');
      const entry = { name: suite.name, command, start: new Date(began).toISOString(), end: null, status: 'running', passed: 'unknown', failed: 'unknown' };
      record.suites.push(entry);
      await saveRecord(out, record);
      console.log(`Running ${suite.name}: ${command}`);
      if (suite.name === 'app-installed') prepareInstalled(process.cwd());
      let result = results.reuse(suite, entry) ?? await runSuite(suite, path.join(out, `${suite.name}.log`), value => { child = value; }, opts.suiteTimeout);
      child = undefined;
      if (suite.name === 'app-installed') result = await installedResult(process.cwd(), record.commit, result);
      const oracleLog = suite.name === 'oracle' ? await readFile(path.join(out, `${suite.name}.log`), 'utf8') : '';
      const pending = [...oracleLog.matchAll(/^\s*(\S+): not implemented\s*$/gm)].map(match => match[1]).sort();
      const expectedOracle = suite.name === 'oracle' && !result.timedOut && result.exitCode === 1 && result.passed > 0 && result.failed === 0 && result.unimplemented === 2 && pending.join(',') === 'lifecycle,scenes' && !/^\s*\S+: fail(?:\s|$)/m.test(oracleLog);
      Object.assign(entry, result, { end: new Date().toISOString(), status: result.timedOut ? 'timed out' : 'completed', durationSeconds: (Date.now() - began) / 1000, expectedOracle });
      await saveRecord(out, record);
    }
    record.end = new Date().toISOString();
    record.interrupted = interrupted || null;
    record.overall = !interrupted && record.suites.length === selected.length && record.suites.every(s => !s.timedOut && (s.exitCode === 0 || s.expectedOracle)) ? 'passed' : 'failed';
    const lines = await saveRecord(out, record);
    try { results.publish(); } catch (error) { console.error(`Gate result index unavailable: ${error.message}`); }
    console.log(lines.join('\n'));
    return interrupted ? (interrupted === 'SIGINT' ? 130 : 143) : record.overall === 'passed' ? 0 : 1;
  } finally {
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    await releaseLock(lock, token);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
