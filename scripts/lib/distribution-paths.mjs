// Resolve the static subset we can prove without executing package code. Dynamic paths remain
// outside this static check; the build independently checks the loader's selected-file provenance.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

export function distributionPath(root, target) {
  if (target instanceof URL) {
    if (target.protocol !== 'file:') return false;
    target = fileURLToPath(target);
  }
  if (typeof target !== 'string') return false;
  const lexical = resolve(target);
  let canonical = lexical;
  try { canonical = realpathSync(lexical); } catch { /* A missing distribution is still a dependency. */ }
  for (const path of [lexical, canonical]) {
    const local = relative(root, path).split('\\').join('/');
    if (local.startsWith('distributions/') || /^examples\/(?:distribution|white-label)\//.test(local) || basename(path) === 'distribution.json') return true;
    // A renamed local JSON profile is still a distribution, regardless of its spelling.
    if (!local.startsWith('../') && path.endsWith('.json') && existsSync(path)) {
      try { const json = JSON.parse(readFileSync(path, 'utf8')); if (json.brand && Array.isArray(json.modules)) return true; } catch { /* Not a JSON profile. */ }
    }
  }
  return false;
}

export function resolvedDistributionProblems(root, file, text) {
  const ast = parse(text, { sourceType: 'unambiguous', plugins: ['typescript', ...(file.endsWith('x') ? ['jsx'] : [])], createImportExpressions: true });
  const absolute = resolve(root, file), folder = dirname(absolute), problems = [];
  const aliases = new Map();
  for (const node of ast.program.body) if (node.type === 'ImportDeclaration') {
    for (const spec of node.specifiers) if (spec.type === 'ImportSpecifier') aliases.set(spec.local.name, spec.imported.name);
  }
  for (const statement of ast.program.body) if (statement.type === 'VariableDeclaration') for (const d of statement.declarations) {
    if (d.id.type === 'ObjectPattern' && d.init?.type === 'CallExpression' && d.init.callee.name === 'require' && /^(?:node:)?(?:path|fs|url)$/.test(d.init.arguments[0]?.value ?? '')) {
      for (const p of d.id.properties) if (p.type === 'ObjectProperty' && p.value.type === 'Identifier') aliases.set(p.value.name, p.key.name);
    }
  }
  const nameOf = node => node?.type === 'Identifier' ? aliases.get(node.name) ?? node.name
    : node?.type === 'MemberExpression' ? node.computed ? node.property.value : node.property.name : undefined;
  const lookup = (scope, name) => {
    for (let at = scope; at; at = at.parent) if (at.bindings.has(name)) return { expression: at.bindings.get(name), scope: at };
  };
  const value = (node, scope, depth = 0) => {
    if (!node || depth > 24) return undefined;
    const get = n => value(n, scope, depth + 1);
    if (node.type === 'StringLiteral') return node.value;
    if (node.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;
    if (node.type === 'Identifier') {
      if (node.name === '__dirname') return folder;
      if (node.name === '__filename') return absolute;
      const binding = lookup(scope, node.name);
      return binding ? value(binding.expression, binding.scope, depth + 1) : undefined;
    }
    if (node.type === 'MemberExpression' && node.object.type === 'MetaProperty') {
      if (node.property.name === 'url') return pathToFileURL(absolute).href;
      if (node.property.name === 'dirname') return folder;
      if (node.property.name === 'filename') return absolute;
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const left = get(node.left), right = get(node.right);
      return typeof left === 'string' && typeof right === 'string' ? left + right : undefined;
    }
    if (node.type === 'NewExpression' && node.callee.name === 'URL') {
      const args = node.arguments.map(get);
      if (typeof args[0] === 'string' && (args.length === 1 || typeof args[1] === 'string' || args[1] instanceof URL)) {
        try { return new URL(...args); } catch { return undefined; }
      }
    }
    if (node.type === 'CallExpression') {
      const name = nameOf(node.callee), args = node.arguments.map(get);
      if (name === 'cwd' && node.callee.object?.name === 'process') return root;
      if ((name === 'join' || name === 'resolve') && args.every(a => typeof a === 'string')) {
        // path.join itself does not anchor a path. Consumers below check each possible cwd.
        return name === 'resolve' ? resolve(root, ...args) : args.join('/');
      }
      if (name === 'dirname' && typeof args[0] === 'string') return dirname(args[0]);
      if (name === 'fileURLToPath' && args[0]) { try { return fileURLToPath(args[0]); } catch { return undefined; } }
    }
    return undefined;
  };
  const inspect = (expression, scope, node, imported = false) => {
    const target = value(expression, scope);
    const candidates = target instanceof URL ? [target] : typeof target === 'string'
      ? imported ? target.startsWith('.') || isAbsolute(target) ? [resolve(folder, target)] : []
        : [resolve(root, target), resolve(folder, target)] : [];
    if (candidates.some(path => distributionPath(root, path))) problems.push(`${file}:${node.loc.start.line}: resolved distribution dependency; packages must not import or read distribution configuration. Pass the build input through BACKBONE_DISTRIBUTION.`);
  };
  const visit = (node, parentScope) => {
    if (!node || typeof node.type !== 'string') return;
    let scope = parentScope;
    if (node.type === 'Program' || node.type === 'BlockStatement' || /Function/.test(node.type) || node.type === 'ArrowFunctionExpression') {
      scope = { parent: parentScope, bindings: new Map() };
      for (const parameter of node.params ?? []) if (parameter.type === 'Identifier') scope.bindings.set(parameter.name, null);
      for (const statement of Array.isArray(node.body) ? node.body : []) {
        const declaration = statement.declaration ?? statement;
        if (declaration.type === 'VariableDeclaration') for (const d of declaration.declarations) if (d.id.type === 'Identifier') scope.bindings.set(d.id.name, declaration.kind === 'const' ? d.init : null);
      }
    }
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) inspect(node.source, scope, node, true);
    if (node.type === 'ImportExpression') inspect(node.source, scope, node, true);
    if (node.type === 'CallExpression') {
      const name = nameOf(node.callee);
      if (name === 'require' || node.callee.type === 'Import') inspect(node.arguments[0], scope, node, true);
      if (name === 'readFileSync' || name === 'readFile') inspect(node.arguments[0], scope, node);
    }
    if (node.type === 'NewExpression' && node.callee.name === 'URL') inspect(node, scope, node);
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(n => visit(n, scope));
      else if (child && typeof child === 'object') visit(child, scope);
    }
  };
  visit(ast.program, null);
  return [...new Set(problems)];
}
