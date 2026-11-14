// Docs that point at real things: relative links, repository paths and pnpm commands must exist,
// and the always-loaded instruction files stay short, single-sourced and free of repeats.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { listFiles, read } from './lib/repo.mjs';
import { excluded } from './lib/docker-context.mjs';

export const AGENTS_MAX_LINES = 100;
// Repository folders a backticked path may start with; anything else (old-repo prior art, globs) is prose.
export const REPO_DIRS = ['packages', 'docs', 'scripts', 'acceptance', 'oracle', 'radar', 'distributions', 'verticals', 'eval', 'schemas', 'conformance', '.claude', '.github'];
// A path in the other repository is written as a plain reference, `backbone-way:docs/plan.md` or
// historical references, never as a link. References to files now here use local links.
export const MARKER = /\b(backbone-way|backbone-base|backbone-owner):([\w.%@/-]*[\w/])/g;
const PNPM_BUILTINS = new Set(['install', 'i', 'add', 'remove', 'update', 'exec', 'dlx', 'create', 'why', 'list', 'ls', 'outdated', 'audit', 'store', 'config', 'init', 'licenses', 'rebuild', 'link', 'unlink', 'prune', 'fetch', 'deploy', 'pack', 'publish', 'env', 'setup', 'root', 'bin', 'patch', 'approve-builds']);

// Markdown split into prose (code fences removed) and code (fence bodies plus inline code spans).
export function splitMarkdown(text) {
  const prose = [];
  const code = [];
  let fence = null;
  text.split('\n').forEach((line, i) => {
    const open = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (open && line.trim().startsWith(fence)) fence = null;
      else code.push({ line: i + 1, text: line });
      return;
    }
    if (open) {
      fence = open[1];
      return;
    }
    prose.push({ line: i + 1, text: line });
    for (const m of line.matchAll(/`([^`]+)`/g)) code.push({ line: i + 1, text: m[1], inline: true });
  });
  return { prose, code };
}

export function linkTargets(text) {
  const out = [];
  for (const { line, text: l } of splitMarkdown(text).prose) {
    const withoutCode = l.replace(/`[^`]*`/g, '');
    for (const m of withoutCode.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push({ line, target: m[1] });
  }
  return out;
}

export function linkProblems(root, file, text) {
  const problems = [];
  for (const { line, target } of linkTargets(text)) {
    if (/^(?:[a-z]+:|#)/i.test(target)) continue;
    const path = decodeURIComponent(target.split('#')[0].split('?')[0]);
    if (!path) continue;
    const resolved = path.startsWith('/') ? join(root, path) : join(root, dirname(file), path);
    if (!existsOnCase(root, normalize(resolved))) {
      problems.push(`${file}:${line}: link to ${target} points at nothing; fix or remove the link. A path in the other repository is a plain reference (\`backbone-way:<path>\` or \`backbone-base:<path>\`), not a link.`);
    }
  }
  return problems;
}

// macOS is case-insensitive; CI is not. Check each path segment's exact spelling.
function existsOnCase(root, abs) {
  if (!existsSync(abs)) return false;
  const rel = abs.slice(normalize(root).length).split('/').filter(Boolean);
  let dir = normalize(root);
  for (const seg of rel) {
    if (seg === '..' || seg === '.') {
      dir = join(dir, seg);
      continue;
    }
    if (!readdirSafe(dir).includes(seg)) return false;
    dir = join(dir, seg);
  }
  return true;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function repoPath(token, dirs = REPO_DIRS) {
  const t = token.replace(/[.,;:)]+$/, '').replace(/:\d+(?:-\d+)?$/, '');
  if (!dirs.some((d) => t === d || t.startsWith(`${d}/`))) return null;
  if (/[<>*{}…|$]|\.\.\.|\s/.test(t)) return null;
  return t;
}

export function pathProblems(root, file, text, dirs = REPO_DIRS) {
  const problems = [];
  for (const { line, text: c, inline } of splitMarkdown(text).code) {
    if (!inline) continue;
    const path = repoPath(c, dirs);
    if (path && !existsOnCase(root, join(root, path)) && !ignored(root, path)) {
      problems.push(`${file}:${line}: \`${path}\` does not exist; fix it, mark an old-repository path as \`backbone-oss:<path>\`, or a path in the other repository as \`backbone-way:<path>\` or \`backbone-base:<path>\`.`);
    }
  }
  return problems;
}

// Build output (dist/, evidence/) may be named in guides; it is never committed.
function ignored(root, path) {
  if (!existsSync(join(root, '.git')) && existsSync(join(root, '.public-tree-files.json'))) {
    const patterns = read(root, '.gitignore').split('\n').filter(line => line && !line.startsWith('#')).map(line => line.replace(/\/$/, '')).flatMap(line => [line, '**/' + line]);
    return excluded(path, patterns.join('\n'));
  }
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// `pnpm <script>`, `pnpm run <script>`, `pnpm --filter <pkg> <script>` and `node <file>` in code.
export function commandsIn(codeText) {
  const out = [];
  for (const m of codeText.matchAll(/\bpnpm\s+(?:(?:--filter|-F)(?:=|\s+)(\S+)\s+|(?:--dir|-C)(?:=|\s+)(\S+)\s+)?(?:run\s+)?([a-z][\w:.-]*)/g)) {
    out.push({ kind: 'pnpm', filter: m[1], ...(m[2] ? { dir: m[2] } : {}), script: m[3] });
  }
  for (const m of codeText.matchAll(/\bnode\s+(?:--?[\w-]+(?:=\S+)?\s+)*((?:\.\/)?[\w./-]+\.(?:m?js|ts))\b/g)) out.push({ kind: 'node', file: m[1] });
  return out;
}

export function commandProblems(file, text, packages, root) {
  const problems = [];
  const rootPkg = packages.find((p) => p.dir === '.');
  for (const { line, text: c } of splitMarkdown(text).code) {
    for (const cmd of commandsIn(c)) {
      if (cmd.kind === 'node') {
        if (!/[*]/.test(cmd.file) && !cmd.file.startsWith('..') && !existsSync(join(root, cmd.file)) && !existsSync(join(root, dirname(file), cmd.file))) {
          problems.push(`${file}:${line}: \`node ${cmd.file}\` names a file that does not exist.`);
        }
        continue;
      }
      if (cmd.dir) {
        const pkg = packages.find(p => p.dir === cmd.dir);
        if (!pkg) problems.push(`${file}:${line}: pnpm --dir ${cmd.dir} names no workspace package.`);
        else if (!PNPM_BUILTINS.has(cmd.script) && !(cmd.script in (pkg.scripts ?? {}))) problems.push(`${file}:${line}: ${cmd.dir} has no "${cmd.script}" script.`);
      } else if (cmd.filter) {
        if (/[*!./]/.test(cmd.filter.replace(/^@[^/]+\//, ''))) continue;
        const pkg = packages.find((p) => p.name === cmd.filter);
        if (!pkg) problems.push(`${file}:${line}: \`pnpm --filter ${cmd.filter}\` names no workspace package.`);
        else if (!PNPM_BUILTINS.has(cmd.script) && !(cmd.script in (pkg.scripts ?? {}))) {
          problems.push(`${file}:${line}: \`pnpm --filter ${cmd.filter} ${cmd.script}\`: ${cmd.filter} has no "${cmd.script}" script.`);
        }
      } else if (!PNPM_BUILTINS.has(cmd.script) && !(cmd.script in (rootPkg?.scripts ?? {}))) {
        problems.push(`${file}:${line}: \`pnpm ${cmd.script}\` is not a script in the root package.json.`);
      }
    }
  }
  return problems;
}

/**
 * Plain references into the other repository (`backbone-way:<path>`, `backbone-base:<path>`) must name
 * something that exists there. `repos` maps each marker to that repository's root; a marker whose
 * repository is not at hand is left unchecked, so this repository needs no sibling checkout. Build output
 * that repository ignores (its dist/) may be named, as in guides.
 */
export function markerProblems(file, text, repos = {}, root) {
  const problems = [];
  for (const { line, text: l } of splitMarkdown(text).prose) {
    for (const m of l.matchAll(MARKER)) {
      // A moved path is local even when an optional legacy checkout is supplied.
      if ((m[1] === 'backbone-way' && /^distributions\/backbone(?:\/|$)/.test(m[2])) ||
          (root && m[1] === 'backbone-base' && existsOnCase(root, join(root, m[2]))) ||
          (root && m[1] === 'backbone-owner' && /^docs\/(?:execution\.md$|history\/(?:execution-|integration-record-))/.test(m[2]) && existsOnCase(root, join(root, m[2]))) ||
          (m[1] === 'backbone-way' && /^acceptance(?:\/|$)/.test(m[2]))) {
        problems.push(`${file}:${line}: ${m[0]} is now in this repository; use a relative link.`);
        continue;
      }
      const other = repos[m[1]];
      if (!other) continue;
      let path;
      try { path = decodeURIComponent(m[2]).replace(/\/$/, ''); }
      catch { problems.push(`${file}:${line}: ${m[0]} has an invalid encoded path.`); continue; }
      if (!existsOnCase(other, join(other, path)) && !ignored(other, path)) problems.push(`${file}:${line}: ${m[1]}:${m[2]} names nothing in ${m[1]}; fix the reference.`);
    }
  }
  return problems;
}

export function workspacePackages(root, files) {
  return files
    .filter((f) => basename(f) === 'package.json' && !f.includes('node_modules/') && existsSync(join(root, f)))
    .map((f) => {
      const m = JSON.parse(read(root, f));
      return { dir: dirname(f), name: m.name, scripts: m.scripts };
    });
}

const norm = (l) => l.replace(/[`*_|#>-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

// Instruction files: one source per folder, no line repeated from an ancestor, no command redefined.
export function instructionProblems(docs) {
  const problems = [];
  const byDir = new Map();
  for (const d of docs) byDir.set(dirname(d.file), { ...byDir.get(dirname(d.file)), [basename(d.file)]: d });
  for (const [dir, pair] of byDir) {
    if (pair['CLAUDE.md'] && pair['AGENTS.md'] && pair['CLAUDE.md'].text.trim() !== '@AGENTS.md') {
      problems.push(`${pair['CLAUDE.md'].file}: beside an AGENTS.md it must be exactly "@AGENTS.md", so the two never drift apart.`);
    }
    if (dir === '.' && pair['AGENTS.md']) {
      const n = pair['AGENTS.md'].text.trimEnd().split('\n').length;
      if (n > AGENTS_MAX_LINES) problems.push(`AGENTS.md: ${n} lines (limit ${AGENTS_MAX_LINES}); move detail into an indexed doc.`);
    }
  }
  const agents = docs.filter((d) => basename(d.file) === 'AGENTS.md');
  for (const child of agents) {
    const childDir = dirname(child.file);
    for (const parent of agents) {
      const parentDir = dirname(parent.file);
      if (parent === child || !(parentDir === '.' || childDir.startsWith(`${parentDir}/`))) continue;
      const parentLines = new Set(parent.text.split('\n').map(norm).filter((l) => l.length >= 30));
      child.text.split('\n').forEach((l, i) => {
        if (parentLines.has(norm(l))) problems.push(`${child.file}:${i + 1}: repeats a line from ${parent.file}; say it once, in the nearest common file.`);
      });
      const cmds = (t) => new Map([...t.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|$/gm)].map((m) => [m[1], m[2]]));
      const parentCmds = cmds(parent.text);
      for (const [cmd, desc] of cmds(child.text)) {
        if (parentCmds.has(cmd) && parentCmds.get(cmd) !== desc) problems.push(`${child.file}: describes \`${cmd}\` differently from ${parent.file}; one file owns each command.`);
      }
    }
  }
  for (const d of docs) {
    for (const m of d.text.matchAll(/^@(\S+)\s*$/gm)) {
      if (!existsSync(join(d.root, dirname(d.file), m[1]))) problems.push(`${d.file}: imports @${m[1]}, which does not exist.`);
    }
  }
  return problems;
}

/**
 * `options`, for a repository that runs these checks on itself from another one (the Way runs the
 * Base's): `repoDirs`, its own top folders; `repos`, the roots behind each cross-repository marker;
 * `packages`, further workspace packages its commands may name (the linked Base's).
 */
export function check(root, options = {}) {
  const files = listFiles(root).filter((f) => !f.includes('node_modules/'));
  const md = files.filter((f) => f.endsWith('.md') && existsSync(join(root, f)));
  const packages = [...workspacePackages(root, files), ...(options.packages ?? [])];
  const problems = [];
  for (const f of md) {
    const text = read(root, f);
    problems.push(
      ...linkProblems(root, f, text),
      ...pathProblems(root, f, text, options.repoDirs),
      ...commandProblems(f, text, packages, root),
      ...markerProblems(f, text, options.repos, root),
    );
  }
  const instr = md.filter((f) => ['AGENTS.md', 'CLAUDE.md'].includes(basename(f))).map((f) => ({ root, file: f, text: read(root, f) }));
  problems.push(...instructionProblems(instr));
  return problems;
}
