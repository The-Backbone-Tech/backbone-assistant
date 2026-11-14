// Export committed source, never the worktree or its private Git history.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONFIG = 'scripts/public-tree.json';
const INVENTORY = '.public-tree-files.json';
const git = (root, ...args) => execFileSync('git', args, { cwd: root, maxBuffer: 128 * 1024 * 1024 });
const safePath = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..');
const excluded = (file, config) => config.exclusions.some(entry => entry.path.endsWith('/') ? (file === entry.path.slice(0, -1) || file.startsWith(entry.path)) : file === entry.path);

function validate(config) {
  if (!Array.isArray(config.exclusions) || !config.replacements || !Array.isArray(config.forbiddenPatterns)) throw new Error('Invalid public tree policy');
  for (const entry of config.exclusions) if (!safePath(entry.path.replace(/\/$/, '')) || !entry.reason?.trim()) throw new Error('Each exclusion needs a safe path and reason');
  for (const [target, source] of Object.entries(config.replacements)) if (!safePath(target) || !safePath(source) || !source.startsWith('public/')) throw new Error('Replacements must name safe public templates');
  for (const rule of config.forbiddenPatterns) new RegExp(rule.source, rule.flags ?? 'i');
}

export function selectFiles(files, config) { return files.filter(file => !excluded(file, config)).sort(); }
export function replacementFor(file, config) { return config.replacements[file] ?? file; }

// Only an explicitly marked test/fixture line (or the immediately preceding line) can
// contain a synthetic match. Production files and documentation cannot opt out.
function synthetic(file, lines, index) {
  file = file.replace(/^public\//, '').replace(/\.txt$/, '');
  return /(?:^|\/)(?:test|tests|fixture|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
    && /public-tree: synthetic/.test(`${lines[index - 1] ?? ''}\n${lines[index]}`);
}

export function scanText(file, text, config) {
  const hits = [], lines = text.split('\n');
  for (const rule of config.forbiddenPatterns) {
    const pattern = new RegExp(rule.source, rule.flags ?? 'i');
    lines.forEach((line, index) => {
      pattern.lastIndex = 0;
      if (pattern.test(line) && !(rule.syntheticAllowed && synthetic(file, lines, index))) hits.push({ file, line: index + 1, rule: rule.id });
    });
  }
  return hits;
}

export function checkTree(root, config) {
  validate(config);
  const hits = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      // Git metadata and installed dependencies are not the publication source tree.
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const at = join(dir, entry.name), file = relative(root, at).split(sep).join('/');
      if (excluded(file, config)) hits.push({ file, line: 1, rule: 'excluded-file' });
      hits.push(...scanText(file, file, config).map(hit => ({ ...hit, rule: `filename-${hit.rule}` })));
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) { hits.push({ file, line: 1, rule: 'non-regular-file' }); continue; }
      if (entry.isDirectory()) walk(at);
      else {
        const bytes = readFileSync(at);
        // Scan binary payloads too: ASCII secrets and identities must not hide there.
        hits.push(...scanText(file, bytes.toString('utf8'), config));
      }
    }
  };
  walk(root);
  return hits;
}

export function exportTree(root, output) {
  root = realpathSync(root); output = resolve(output);
  if (realpathSync(git(root, 'rev-parse', '--show-toplevel').toString().trim()) !== root) throw new Error('Export requires a Git checkout at the source root');
  if (existsSync(output)) throw new Error('Output directory already exists; choose a new directory');
  if (output === root || output.startsWith(root + sep)) throw new Error('Output must be outside the source checkout');
  const head = git(root, 'rev-parse', '--verify', 'HEAD').toString().trim();
  const config = JSON.parse(git(root, 'show', `${head}:${CONFIG}`).toString()); validate(config);
  // ls-files supplies the tracked candidates; ls-tree restricts them to HEAD,
  // including when the index has staged additions or deletions.
  const committed = new Set(git(root, 'ls-tree', '-r', '--name-only', '-z', head).toString().split('\0').filter(Boolean));
  const tracked = git(root, 'ls-files', '--with-tree=' + head, '-z').toString().split('\0').filter(file => committed.has(file));
  const files = selectFiles([...new Set(tracked)], config);
  for (const file of files) if (!safePath(file) || !committed.has(replacementFor(file, config))) throw new Error(`Missing committed replacement or unsafe path: ${file}`);
  for (const target of Object.keys(config.replacements)) if (!files.includes(target)) throw new Error(`Replacement target not selected: ${target}`);
  const snapshot = mkdtempSync(join(tmpdir(), 'backbone-public-source-'));
  mkdirSync(dirname(output), { recursive: true });
  const stage = mkdtempSync(join(dirname(output), '.backbone-public-tree-'));
  try {
    execFileSync('tar', ['-xf', '-', '-C', snapshot], { input: git(root, 'archive', head) });
    for (const file of files) {
      const source = join(snapshot, replacementFor(file, config));
      // No symlinks, including parent components, may escape the committed snapshot.
      for (let at = source; at !== snapshot; at = dirname(at)) if (lstatSync(at).isSymbolicLink()) throw new Error(`Committed symbolic link: ${file}`);
      if (!lstatSync(source).isFile()) throw new Error(`Not a regular committed file: ${file}`);
      const target = join(stage, file); mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target); chmodSync(target, lstatSync(source).mode & 0o777);
    }
    // A source archive has no index. Its build checks use this exact committed
    // inventory until the recipient initializes a new Git repository.
    writeFileSync(join(stage, INVENTORY), JSON.stringify({ files: [...new Set([...files, INVENTORY])].sort() }, null, 2) + '\n');
    // Public README prose belongs to the piece digest just like any other file.
    // Use the product's own algorithm; do not bypass the loader's integrity check.
    if (files.some(file => file.endsWith('/backbone.module.json'))) {
      execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { readFileSync, writeFileSync } from 'node:fs';
        import { dirname } from 'node:path';
        import { pieceDigest } from './packages/platform/src/pieces/digest.ts';
        const { files } = JSON.parse(readFileSync('.public-tree-files.json', 'utf8'));
        for (const file of files.filter(file => file.endsWith('/backbone.module.json'))) {
          const manifest = JSON.parse(readFileSync(file, 'utf8'));
          manifest.digest = pieceDigest(dirname(file));
          writeFileSync(file, JSON.stringify(manifest, null, 2) + '\\n');
        }
      `], { cwd: stage, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    const hits = checkTree(stage, config);
    if (hits.length) throw new Error(formatHits(hits));
    renameSync(stage, output);
    return { head, files: new Set([...files, INVENTORY]).size, bytes: [...new Set([...files, INVENTORY])].reduce((sum, file) => sum + lstatSync(join(output, file)).size, 0) };
  } finally { rmSync(snapshot, { recursive: true, force: true }); rmSync(stage, { recursive: true, force: true }); }
}

const formatHits = hits => hits.map(hit => `${hit.file}:${hit.line}: ${hit.rule}`).join('\n');
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), check = args[0] === '--check';
    if (args.length !== (check ? 2 : 1) || args.at(-1).startsWith('-')) throw new Error('usage: node scripts/public-tree.mjs [--check] <output-dir>');
    const output = resolve(args.at(-1));
    if (check) {
      // The policy beside this script is reviewed source, not a file supplied by
      // the tree under inspection that could disable the checks.
      const config = JSON.parse(readFileSync(new URL('./public-tree.json', import.meta.url), 'utf8'));
      const hits = checkTree(output, config);
      if (hits.length) { console.error(formatHits(hits)); process.exitCode = 1; }
      else console.log('Public tree check passed.');
    } else {
      const result = exportTree(resolve(import.meta.dirname, '..'), output);
      console.log(`Exported ${result.files} files (${result.bytes} bytes) from ${result.head}. Public tree check passed.`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
