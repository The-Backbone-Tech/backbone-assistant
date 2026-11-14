// Gate evidence is authoritative. This CLI only reads it; author runs have no publication path.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir, platform, arch, release } from 'node:os';
import { dirname, join, resolve, matchesGlob } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const snapshots = new Map();
const snapshot = (root, tree) => snapshots.get(`${resolve(root)}:${tree}`);
const git = (root, args, env) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: env || process.env, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const readAt = (root, tree, file) => { const captured = snapshot(root, tree); if (captured) { if (!captured.texts.has(file)) throw new Error(`Missing input ${file}`); return captured.texts.get(file); } return git(root, ['show', `${tree}:${file}`]); };
const objectAt = (root, tree, file) => { const captured = snapshot(root, tree); if (captured) return captured.objects.get(file) || null; try { return git(root, ['rev-parse', '--verify', `${tree}:${file}`]); } catch { return null; } };
const environmentKey = () => hash(JSON.stringify(Object.entries(process.env).filter(([name]) => (name.startsWith('BACKBONE_') && !/^(?:BACKBONE_HEAVY_|BACKBONE_TEST_PG$|BACKBONE_TEST_RESULTS$|BACKBONE_GUIDE_STEP$)/.test(name)) || ['NODE_OPTIONS', 'CI'].includes(name)).sort(([a], [b]) => a.localeCompare(b))));
export const resultStore = () => process.env.BACKBONE_TEST_RESULTS || join(homedir(), 'backbone-next-worktrees/.gate-results');

/** Canonical Git tree hashes, including uncommitted inputs, without writing the author's index or objects. */
export function captureTree(root) {
  const temporary = mkdtempSync(join(tmpdir(), 'suite-input-'));
  try {
    const objects = join(temporary, 'objects'); mkdirSync(objects);
    const env = { ...process.env, GIT_INDEX_FILE: join(temporary, 'index'), GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(root, git(root, ['rev-parse', '--git-path', 'objects'])) };
    try { git(root, ['read-tree', 'HEAD'], env); } catch { git(root, ['read-tree', '--empty'], env); }
    git(root, ['add', '-A', '--', '.'], env);
    const tree = git(root, ['write-tree'], env);
    if (snapshot(root, tree)) return tree;
    const captured = { objects: new Map(), texts: new Map(), files: [] };
    for (const row of git(root, ['ls-tree', '-r', '-t', '-z', tree], env).split('\0').filter(Boolean)) {
      const tab = row.indexOf('\t'), [, type, object] = row.slice(0, tab).split(' '), file = row.slice(tab + 1);
      captured.objects.set(file, object);
      if (type === 'blob') captured.files.push(file);
      if (file === 'pnpm-workspace.yaml' || file.endsWith('/package.json')) captured.texts.set(file, git(root, ['show', `${tree}:${file}`], env));
    }
    snapshots.set(`${resolve(root)}:${tree}`, captured);
    while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value);
    return tree;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function workspacePackages(root, tree) {
  const yaml = readAt(root, tree, 'pnpm-workspace.yaml');
  const patterns = [...yaml.matchAll(/^\s+-\s+["']?([^"'\s]+)["']?\s*$/gm)].map(m => m[1]);
  const files = snapshot(root, tree)?.files || git(root, ['ls-tree', '-r', '--name-only', '-z', tree]).split('\0').filter(Boolean);
  const packages = files.filter(file => file.endsWith('/package.json') && patterns.some(p => !p.startsWith('!') && matchesGlob(dirname(file), p)) && !patterns.some(p => p.startsWith('!') && matchesGlob(dirname(file), p.slice(1)))).map(file => ({ dir: dirname(file), ...JSON.parse(readAt(root, tree, file)) }));
  if (packages.some(p => typeof p.name !== 'string') || new Set(packages.map(p => p.name)).size !== packages.length) throw new Error('Workspace package identities are missing or duplicated');
  return packages;
}

export function workspaceEdges(packages) {
  const names = new Set(packages.map(pkg => pkg.name));
  return new Map(packages.map(pkg => [pkg.name, [...new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(section => Object.entries(pkg[section] || {}).filter(([name, version]) => names.has(name) && version.startsWith('workspace:')).map(([name]) => name)))]]));
}

export function packageInput(root, tree, suite, versions) {
  if (suite.command !== 'pnpm' || suite.args?.[0] !== '--filter' || suite.args?.[2] !== 'test' || /(?:^|[-/])(check|oracle|e2e|native|installed)(?:$|[-/])/.test(suite.name)) return null;
  const packages = workspacePackages(root, tree), byName = new Map(packages.map(p => [p.name, p]));
  const packageName = suite.args[1];
  if (!byName.has(packageName) || !versions.node || !versions.pnpm || Object.values(versions).includes('unknown')) return null;
  const edges = workspaceEdges(packages), closure = new Set();
  const visit = name => { if (closure.has(name)) return; closure.add(name); for (const dep of edges.get(name)) visit(dep); };
  visit(packageName);
  const input = {
    format: 1, package: packageName,
    trees: [...closure].sort().map(name => ({ package: name, dir: byName.get(name).dir, tree: objectAt(root, tree, byName.get(name).dir) })),
    lockfile: objectAt(root, tree, 'pnpm-lock.yaml'), node: versions.node, pnpm: versions.pnpm,
    machine: { platform: platform(), arch: arch(), release: release() }, command: [suite.command, ...suite.args],
    environment: environmentKey(),
    // Include existing cross-package audits/fixtures without inventing runtime dependency edges.
    externalTrees: Object.fromEntries([
      ...(closure.has('@backbone-next/platform') ? ['packages', 'docs/contracts'] : []),
      ...(closure.has('@backbone/core') ? ['packages/platform/test/fixtures/material-guard-legacy.json'] : []),
    ].map(file => [file, objectAt(root, tree, file)])),
    // Shared runners and configuration are inputs too; changing them must never reuse an old pass.
    shared: Object.fromEntries(['scripts', 'schemas', 'conformance', 'oracle', 'package.json', 'pnpm-workspace.yaml', '.npmrc', '.gitignore', '.gitattributes'].map(file => [file, objectAt(root, tree, file)])),
  };
  if (!input.lockfile) return null;
  return { key: hash(JSON.stringify(input)), input };
}

/** Installed acceptance always runs; other mandatory suites offer authors a conservative whole-repository key. */
export function suiteInput(root, tree, suite, versions) {
  if (suite.name === 'app-installed') return null; // Every installed run packages the gate commit afresh.
  const packaged = packageInput(root, tree, suite, versions);
  if (packaged) return { ...packaged, gateMayReuse: true };
  if (!versions.node || !versions.pnpm || Object.values(versions).includes('unknown')) return null;
  const input = { format: 1, suite: suite.name, tree, lockfile: objectAt(root, tree, 'pnpm-lock.yaml'), node: versions.node, pnpm: versions.pnpm,
    machine: { platform: platform(), arch: arch(), release: release() }, environment: environmentKey(), command: [suite.command, ...suite.args] };
  if (!input.lockfile) return null;
  return { key: hash(JSON.stringify(input)), input, gateMayReuse: false };
}

function gatePass(record, entry) {
  return entry?.name !== 'app-installed' && record.kind === 'gate' && record.dirty === false && Boolean(record.end) && entry?.status === 'completed' && entry.exitCode === 0 && !entry.signal && !entry.timedOut && !(entry.failed > 0) && /^[a-f0-9]{64}$/.test(entry.inputKey || '') && !entry.reusedFrom;
}

/** Called only after gate.json is finalized. A failed overall gate can still prove a passed package. */
export function publishGate(store, run) {
  const record = JSON.parse(readFileSync(join(run, 'gate.json'), 'utf8'));
  let written = 0;
  for (const entry of record.suites || []) {
    if (!gatePass(record, entry)) continue;
    const log = join(run, `${entry.name}.log`);
    if (!existsSync(log)) continue;
    mkdirSync(store, { recursive: true });
    const target = join(store, `${entry.inputKey}.json`), temporary = `${target}.${randomUUID()}`;
    writeFileSync(temporary, JSON.stringify({ run: resolve(run), suite: entry.name, key: entry.inputKey, command: entry.command, logHash: hash(readFileSync(log)) }) + '\n', { flag: 'wx' });
    renameSync(temporary, target); written++;
  }
  return written;
}

export function findGatePass(store, input) {
  if (!input) return null;
  try {
    const found = JSON.parse(readFileSync(join(store, `${input.key}.json`), 'utf8'));
    const record = JSON.parse(readFileSync(join(found.run, 'gate.json'), 'utf8'));
    const entry = record.suites?.find(s => s.name === found.suite && s.inputKey === input.key);
    const log = join(found.run, `${found.suite}.log`);
    const logBytes = readFileSync(log);
    if (found.key !== input.key || !gatePass(record, entry) || entry.command !== input.input.command.join(' ') || entry.command !== found.command || hash(logBytes) !== found.logHash) return null;
    return { ...found, entry, log, logBytes };
  } catch { return null; }
}

/** Small gate adapter: no eligible package or uncertain key means execute the suite normally. */
export function gateResults(root, record, out) {
  const store = resultStore();
  const versions = { node: record.node, pnpm: record.pnpm };
  const keyFor = (suite, tree) => { try { return suiteInput(root, tree || captureTree(root), suite, versions); } catch { return null; } };
  const seen = [];
  return {
    reuse(suite, entry) {
      const input = keyFor(suite); if (!input || record.dirty) return null;
      entry.inputKey = input.key; seen.push({ suite, entry, input });
      if (!input.gateMayReuse) return null;
      const found = findGatePass(store, input); if (!found || found.run === resolve(out)) return null;
      writeFileSync(join(out, `${suite.name}.log`), found.logBytes);
      return { exitCode: 0, signal: null, timedOut: false, passed: found.entry.passed, failed: found.entry.failed, reusedFrom: found.run, reuse: `reused from ${found.run}` };
    },
    publish() {
      let finalTree;
      try { finalTree = captureTree(root); } catch { /* Unknown final inputs are never indexed. */ }
      for (const item of seen) if (!finalTree || keyFor(item.suite, finalTree)?.key !== item.input.key) delete item.entry.inputKey;
      // Persist the final validated keys before indexing the authoritative acceptance record.
      const temporary = join(out, 'gate.json.results.tmp');
      writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n'); renameSync(temporary, join(out, 'gate.json'));
      return publishGate(store, out);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let [name, ...command] = process.argv.slice(2);
  const mandatory = name === '--suite';
  if (mandatory) [name, ...command] = command;
  if (!name) throw new Error('usage: node scripts/test-results.mjs <package> [suite command...] | --suite <name> [command...]');
  const version = cmd => { const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : 'unknown'; };
  const defaults = { check: ['pnpm', 'check'], oracle: ['pnpm', 'oracle'], 'app-e2e': ['pnpm', '--filter', '@backbone-next/app', 'e2e'], 'app-installed': ['pnpm', '--filter', '@backbone-next/app', 'e2e:installed'] };
  const words = command.length ? command : mandatory ? defaults[name] : ['pnpm', '--filter', name, 'test'];
  if (!words) throw new Error('This suite needs its exact command');
  const input = suiteInput(process.cwd(), captureTree(process.cwd()), { name: name.split('/').pop(), command: words[0], args: words.slice(1) }, { node: process.version, pnpm: version('pnpm') });
  const found = findGatePass(resultStore(), input);
  console.log(found ? `reused from ${found.run}; key ${input.key}; ${words.join(' ')}` : `No matching gate pass; run: ${words.join(' ')}`);
  process.exitCode = found ? 0 : 1;
}
