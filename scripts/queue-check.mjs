// No checkout of an author's worktree and no test execution. Inspect committed snapshots only.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { regenerationProblems } from './regen.mjs';
import { workspaceEdges } from './test-results.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hotspot = file => /(?:^|\/)(?:host|core|personal|service)\.ts$/.test(file) || file.endsWith('/backbone.module.json');

function snapshotRegeneration(root) {
  // Older queued branches predate regen; use this registry for those branches only.
  if (!existsSync(join(root, 'scripts/regen.mjs'))) return regenerationProblems(root);
  const result = spawnSync(process.execPath, ['scripts/regen.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) return [];
  return [(result.stderr + result.stdout).trim() || result.error?.message || `regeneration exited ${result.status}`];
}

function inspectSnapshot(root, sha, regeneration) {
  const scratch = mkdtempSync(join(tmpdir(), 'backbone-queue-'));
  try {
    const archive = execFileSync('git', ['archive', sha], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', scratch], { input: archive });
    git(scratch, 'init', '-q'); git(scratch, 'add', '-A');
    if (existsSync(join(root, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    const files = git(scratch, 'ls-files', '-z').split('\0').filter(Boolean);
    const packages = files.filter(file => file.startsWith('packages/') && file.endsWith('/package.json')).map(file => ({ dir: dirname(file), ...JSON.parse(readFileSync(join(scratch, file), 'utf8')) }));
    return { regen: regeneration(scratch), packages };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function inspectQueue(root, branches, { integration = 'origin/claude/integration', regeneration = snapshotRegeneration } = {}) {
  if (!branches.length) throw new Error('usage: node scripts/queue-check.mjs <branch>...');
  const head = git(root, 'rev-parse', '--verify', `${integration}^{commit}`);
  const commands = new Set();
  const rows = branches.map(branch => {
    if (branch.startsWith('-')) throw new Error('Branch names cannot start with a dash');
    const sha = git(root, 'rev-parse', '--verify', `${branch}^{commit}`);
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', head, sha], { cwd: root });
    if (![0, 1].includes(ancestor.status)) throw new Error(`Cannot determine base of ${branch}`);
    const base = git(root, 'merge-base', head, sha);
    const files = git(root, 'diff', '--name-only', '-z', base, sha).split('\0').filter(Boolean);
    const snapshot = inspectSnapshot(root, sha, regeneration);
    const globalInput = files.some(file => ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', '.npmrc'].includes(file));
    const packages = snapshot.packages.filter(pkg => files.some(file => file.startsWith(`${pkg.dir}/`)));
    const affected = new Set((globalInput ? snapshot.packages : packages).map(pkg => pkg.name)), edges = workspaceEdges(snapshot.packages);
    for (let changed = true; changed;) {
      changed = false;
      for (const [name, deps] of edges) if (!affected.has(name) && deps.some(dep => affected.has(dep))) { affected.add(name); changed = true; }
    }
    const checkNeeded = files.some(file => /^(?:scripts|docs)\//.test(file) || /(^|\/)[^/]+\.md$/.test(file) || /\/scripts\//.test(file) || /(^|\/)(?:generate|generator)[^/]*\.[cm]?[jt]s$/.test(file));
    if (checkNeeded) commands.add('pnpm check');
    for (const pkg of packages) {
      if (pkg.scripts?.test) commands.add(`pnpm --filter ${pkg.name} test`);
      if (pkg.scripts?.typecheck) commands.add(`pnpm --filter ${pkg.name} typecheck`);
      if (pkg.scripts?.e2e) commands.add(`pnpm --filter ${pkg.name} e2e`);
    }
    return { branch, sha, stale: ancestor.status === 1, packages: packages.map(pkg => pkg.name), dependents: [...affected].filter(name => !packages.some(pkg => pkg.name === name)), checkNeeded, hotspots: files.filter(hotspot), regen: snapshot.regen, conflicts: [] };
  });
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const result = spawnSync('git', ['merge-tree', '--write-tree', rows[i].sha, rows[j].sha], { cwd: root, encoding: 'utf8' });
    if (![0, 1].includes(result.status)) throw new Error(`merge-tree failed: ${result.stderr}`);
    if (result.status === 1) { rows[i].conflicts.push(rows[j].branch); rows[j].conflicts.push(rows[i].branch); }
  }
  return { head, rows, commands: [...commands], failed: rows.some(row => row.stale || row.conflicts.length || row.regen.length) };
}

export function queueTable(result) {
  return [`Integrated head: ${result.head}`, 'Branch | Base | run: changed packages | gate covers: dependents | Conflicts | Regen | Hotspots | pnpm check', '--- | --- | --- | --- | --- | --- | --- | ---',
    ...result.rows.map(r => `${r.branch} | ${r.stale ? 'STALE' : 'current'} | run: ${r.packages.join(', ') || 'none'} | gate covers: ${r.dependents.join(', ') || 'none'} | ${r.conflicts.join(', ') || 'none'} | ${r.regen.length ? 'DIRTY' : 'clean'} | ${r.hotspots.join(', ') || 'none'} | ${r.checkNeeded ? 'needed (scripts/docs/generators)' : 'not needed'}`),
    ...result.rows.flatMap(r => r.regen.map(p => `${r.branch}: ${p}`)), 'Run changed-package suites under the heavy wrapper (first consult scripts/test-results.mjs for identical gate passes); dependents are covered by the stack gate:', ...result.commands].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = inspectQueue(process.cwd(), process.argv.slice(2));
    console.log(queueTable(result));
    process.exitCode = result.failed ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
