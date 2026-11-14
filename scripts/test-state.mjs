// Syntax inspection avoids matching examples embedded as strings in rule self-tests.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isTest, listFiles } from './lib/repo.mjs';
import { syntax, walk, callName, literal } from './lib/test-source.mjs';

export function stateProblems(text) {
  const ast = syntax(text), bindings = new Map(), aliases = new Map(), problems = [];
  walk(ast, (node, ancestors) => {
    if (node.type === 'ImportSpecifier') aliases.set(node.local.name, node.imported.name);
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      const scope = ancestors.findLast(a => ['BlockStatement', 'Program'].includes(a.type));
      const entries = bindings.get(node.id.name) || [];
      entries.push({ init: node.init, scope, at: node.start }); bindings.set(node.id.name, entries);
    }
  });
  const name = node => aliases.get(callName(node)) || callName(node);
  const deref = (node, seen = new Set()) => {
    if (node?.type === 'Identifier' && !seen.has(node.start)) {
      const binding = bindings.get(node.name)?.filter(b => b.scope.start <= node.start && b.scope.end >= node.end && b.at <= node.start).sort((a, b) => (a.scope.end - a.scope.start) - (b.scope.end - b.scope.start) || b.at - a.at)[0];
      if (binding) return deref(binding.init, new Set([...seen, node.start]));
    }
    return node?.type === 'AwaitExpression' ? deref(node.argument, seen) : node;
  };
  const tempRoot = node => { node = deref(node); return node?.type === 'CallExpression' && name(node.callee) === 'tmpdir'; };
  const auditRoot = node => { node = deref(node); return node?.type === 'CallExpression' && ['auditTemporaryRoot', 'auditScratchParent'].includes(name(node.callee)) && node.arguments.length === 0; };
  const sharedPath = node => {
    node = deref(node);
    return tempRoot(node) || /^\/(?:private\/)?tmp(?:\/|$)/.test(literal(node) || '') || (node?.type === 'CallExpression' && ['join', 'resolve'].includes(name(node.callee)) && tempRoot(node.arguments[0]));
  };
  const lockPath = node => {
    node = deref(node);
    return /(?:^|\/)\.lock$|\.lock$/.test(literal(node) || '') || (node?.type === 'CallExpression' && ['join', 'resolve'].includes(name(node.callee)) && node.arguments.some(arg => /\.lock$/.test(literal(arg) || '')));
  };
  const add = (rule, node) => problems.push({ rule, line: node.loc.start.line, source: text.slice(node.start, node.end) });
  walk(ast, (node, ancestors) => {
    const randomized = ancestors.some(a => a.type === 'CallExpression' && ['mkdtemp', 'mkdtempSync'].includes(name(a.callee)));
    if (literal(node) !== undefined && /^\/(?:private\/)?tmp(?:\/|$)/.test(literal(node)) && !randomized) add('fixed-temp', node);
    if (node.type !== 'CallExpression') return;
    const callee = name(node.callee);
    if ((callee === 'auditTemporaryRoot' || callee === 'sweepAuditTemporary') && node.arguments.length === 0) add('shared-audit-root', node);
    const auditPath = path => { path = deref(path); return auditRoot(path) || (path?.type === 'CallExpression' && ['join', 'resolve'].includes(name(path.callee)) && auditRoot(path.arguments[0])); };
    if (['mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'readdir', 'readdirSync', 'rm', 'rmSync', 'writeFile', 'writeFileSync', 'symlink', 'symlinkSync'].includes(callee) && node.arguments.slice(0, callee.startsWith('symlink') ? 2 : 1).some(auditPath)) add('shared-audit-root', node);
    if (['join', 'resolve'].includes(callee) && tempRoot(node.arguments[0]) && literal(node.arguments[1]) !== undefined && !randomized) add('fixed-temp', node);
    if (['readdir', 'readdirSync', 'glob', 'globSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync'].includes(callee) && sharedPath(node.arguments[0])) add('shared-sweep', node);
    const readOnlyOpen = ['open', 'openSync'].includes(callee) && literal(node.arguments[1]) === 'r';
    if (!readOnlyOpen && ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'open', 'openSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'rename', 'renameSync', 'mkdir', 'mkdirSync', 'symlink', 'symlinkSync', 'link', 'linkSync', 'copyFile', 'copyFileSync', 'truncate', 'truncateSync'].includes(callee) && node.arguments.slice(0, /^(?:rename|symlink|link|copyFile)/.test(callee) ? 2 : 1).some(lockPath)) add('handmade-lock', node);
  });
  return problems;
}

export function check(root) {
  const exceptionsPath = join(root, 'scripts/test-state-exceptions.json');
  const { note, exceptions } = existsSync(exceptionsPath) ? JSON.parse(readFileSync(exceptionsPath, 'utf8')) : {
    note: 'Known-offender burn-down list: remove repaired entries; new offenders are refused.', exceptions: [],
  };
  if (typeof note !== 'string' || !note.trim() || !Array.isArray(exceptions)) return ['Test-state exceptions need a burn-down note and an exceptions array.'];
  const problems = [], used = new Map();
  for (const e of exceptions) if (typeof e.owner !== 'string' || !e.owner.trim()) problems.push(`${e.file}: test-state exception needs its owning package or lane; ${note}`);
  for (const file of listFiles(root).filter(isTest)) {
    if (!existsSync(join(root, file))) continue;
    let findings;
    try { findings = stateProblems(readFileSync(join(root, file), 'utf8')); }
    catch (error) { problems.push(`${file}: cannot inspect test state: ${error.message}`); continue; }
    for (const finding of findings) {
      const index = exceptions.findIndex(e => e.file === file && e.rule === finding.rule && e.source === finding.source && e.reason && typeof e.owner === 'string' && e.owner.trim() && Number.isInteger(e.count) && e.count > 0);
      if (index >= 0) used.set(index, (used.get(index) || 0) + 1);
      if (index < 0 || used.get(index) > exceptions[index].count) problems.push(`${file}:${finding.line}: ${finding.rule}: ${finding.source}; ${note}`);
    }
  }
  exceptions.forEach((e, i) => { if ((used.get(i) || 0) < e.count || !used.has(i)) problems.push(`${e.file}: unused or invalid test-state exception (${e.rule}, owner ${e.owner ?? 'missing'}): ${e.source}; remove or reduce it. ${note}`); });
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const problems = check(process.cwd());
  for (const problem of problems) console.error(problem);
  process.exitCode = problems.length ? 1 : 0;
}
