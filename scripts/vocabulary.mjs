// Measure changed prose against the merge-base with origin/claude/integration by default.
// Untouched debt stays out; comparisonBase and BACKBONE_VOCABULARY_BASE define overrides.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import { read } from './lib/repo.mjs';

const markdown = file => file === 'README.md' || /^docs\/.*\.md$/.test(file);
const ui = file => file === 'packages/surfaces/app/index.html' || /^packages\/surfaces\/app\/(?:src|electron|server)\/.*\.(?:[jt]sx?|html)$/.test(file);
const rules = [
  [/\b(?:AI operating (?:system|platform)|Backbone is an? operating (?:system|platform))\b/gi, 'open-source AI assistant'],
  [/\b(?:standing signatures?|signed capabilit(?:y|ies)|signatures?|grants?|releases?)\b/gi, 'permission'],
  [/\bheld (?:writes?|calls?)\b/gi, 'held action'],
  [/\bUNKNOWN\b/g, 'unknown outcome'],
  [/\bharness(?:es)?\b/gi, 'engine'],
  [/\b(?:data )?homes?\b/gi, 'data folder'],
];
// Even one file's replacement patch can exceed 1 MiB. Read patches separately below,
// without imposing an arbitrary stdout limit on a valid diff or filename list.
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: Infinity, stdio: ['ignore', 'pipe', 'pipe'] });
const blank = value => value.replace(/[^\n]/g, ' ');
const withoutCode = text => text.replace(/(`+)[^`\n]*?\1/g, blank).replace(/\]\([^)]*\)/g, blank).replace(/https?:\/\/\S+/g, blank)
  .replace(/\b[A-Za-z_$][\w$-]*(?:[./][\w$-]+)+\b/g, blank)
  .replace(/--[a-z][a-z-]*|<[^>]+>|\b(?:HOME|NODE_ENV)\b|\brelease-home-backups?\b/g, blank);

function lineProblems(file, line, number) {
  const text = withoutCode(line), out = [];
  for (const [pattern, preferred] of rules) for (const match of text.matchAll(pattern)) {
    // These are different ideas, not retired product vocabulary.
    if (preferred === 'data folder' && /(?:operating system|system's|user's|person's|\$HOME|~\/|home (?:screen|page|key|button))/i.test(text)) continue;
    if (preferred === 'permission' && /signature/i.test(match[0]) && /(?:Ed25519|cryptograph|detached|public.key|signing key|signature verification)/i.test(text)) continue;
    // In documents "release" keeps its ordinary meanings (to release a hold, a released version); only the app's labels are checked.
    if (preferred === 'permission' && /release/i.test(match[0]) && markdown(file)) continue;
    if (preferred === 'permission' && /release/i.test(match[0]) && /(?:pre-release|package release|release[- ](?:data|artifact|version|notes|basis)|schema release|Helm release)/i.test(text)) continue;
    if (preferred === 'permission' && /signature/i.test(match[0]) && /(?:function signatures?|SQL signatures?|\d+-signature)/i.test(text)) continue;
    if (preferred === 'permission' && /release/i.test(match[0]) && /^(?:release|releases)\s+(?:(?:the|a|an|its|their|this|that)\s+)?(?:lock|descriptor|slot|callback)\b/i.test(text.slice(match.index))) continue;
    out.push(`${file}:${number}: "${match[0]}" is retired in prose; use "${preferred}".`);
  }
  return out;
}

export function fileProblems(file, text, changed) {
  if (!changed.size || /^docs\/history\//.test(file)) return [];
  const out = [];
  const inspect = (value, first) => value.split('\n').forEach((line, i) => {
    if (changed.has(first + i)) out.push(...lineProblems(file, line, first + i));
  });
  if (markdown(file)) {
    let fence, glossary = false;
    text.split('\n').forEach((line, i) => {
      if (file === 'README.md' && /^## /.test(line)) glossary = line.trim() === '## Words used here';
      if (glossary && /^\|/.test(line)) return; // The canonical table must be able to name retired words.
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (fence[0] === marker[0] && marker.length >= fence.length && /^\s*(?:`+|~+)\s*$/.test(line)) fence = undefined;
        return;
      }
      if (!fence && !/^ {4}/.test(line)) inspect(line, i + 1);
    });
  } else if (ui(file)) {
    if (file.endsWith('.html')) inspect(text.replace(/<!--[\s\S]*?-->/g, blank).replace(/<[^>]+>/g, blank), 1);
    else {
      const ast = parse(text, { sourceType: 'unambiguous', plugins: ['typescript', ...(file.endsWith('tsx') ? ['jsx'] : [])] });
      const visit = (node, parent) => {
        if (!node || typeof node.type !== 'string') return;
        if (/^(?:ImportDeclaration|ExportAllDeclaration)$/.test(node.type)) return;
        if (node.type === 'JSXElement' && /^(?:code|pre)$/.test(node.openingElement.name.name)) return;
        if (parent?.type === 'ObjectProperty' && parent.key === node && !parent.computed) return;
        if (['StringLiteral', 'JSXText', 'TemplateElement'].includes(node.type)) {
          const value = node.type === 'StringLiteral' ? text.slice(node.start + 1, node.end - 1) : node.type === 'TemplateElement' ? node.value.raw : node.value;
          const attribute = parent?.type === 'JSXAttribute' && /^(?:title|about|placeholder|aria-label|alt|label)$/.test(parent.name.name);
          // Single machine tokens, paths and package names are code. JSX labels are prose.
          if (node.type === 'JSXText' || attribute || /^(?:Release|Grant|Signature|Harness)$/.test(value) || /\s/.test(value.trim())) inspect(value, node.loc.start.line);
        }
        for (const [key, value] of Object.entries(node)) {
          if (/comments|loc/i.test(key)) continue;
          if (Array.isArray(value)) value.forEach(child => visit(child, node));
          else if (value && typeof value === 'object') visit(value, node);
        }
      };
      visit(ast.program);
    }
  }
  return out;
}

export function comparisonBase(root) {
  // GitHub supplies the whole push/PR range, including a push with several commits.
  if (process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const before = event.pull_request?.base?.sha ?? event.before;
    if (/^[a-f0-9]{40,64}$/.test(before ?? '') && !/^0+$/.test(before))
      return git(root, 'merge-base', 'HEAD', before).trim();
  }
  try { return git(root, 'merge-base', 'HEAD', 'origin/claude/integration').trim(); }
  catch {
    if (!existsSync(join(root, '.git')) && existsSync(join(root, '.public-tree-files.json'))) return null;
    return git(root, 'rev-parse', 'HEAD').trim();
  }
}

export function check(root, { base = process.env.BACKBONE_VOCABULARY_BASE || comparisonBase(root) } = {}) {
  // An archive has no diff. Product static checks still cover its source inventory.
  if (base === null) return [];
  const changed = new Map();
  const files = git(root, 'diff', '--no-ext-diff', '--name-only', '-z', base, '--').split('\0');
  for (const file of files) {
    if (!markdown(file) && !ui(file)) continue;
    const lines = new Set(); let line = 0, inHunk = false;
    const diff = git(root, '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-color', '--unified=0', base, '--', file);
    for (const row of diff.split('\n')) {
      if (row.startsWith('@@')) { line = Number(/\+(\d+)/.exec(row)?.[1] ?? 0); inHunk = true; }
      else if (inHunk && row.startsWith('+')) lines.add(line++);
      else if (inHunk && row.startsWith(' ')) line++;
    }
    changed.set(file, lines);
  }
  const untracked = new Set(git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0'));
  const out = [];
  for (const file of new Set([...changed.keys(), ...untracked])) {
    if ((!markdown(file) && !ui(file)) || !existsSync(join(root, file))) continue;
    const text = read(root, file);
    const lines = untracked.has(file) ? new Set(text.split('\n').map((_, i) => i + 1)) : changed.get(file) ?? new Set();
    out.push(...fileProblems(file, text, lines));
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const problems = check(process.cwd());
  if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
  else console.log('ok    vocabulary (changed prose)');
}
