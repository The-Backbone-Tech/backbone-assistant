// 10 November 2026, product owner decision: Backbone is one product in this repository.
// Its configuration may live beside packages. Packages and the default build must stay
// independent of it: builds select a distribution only through BACKBONE_DISTRIBUTION.
// Keep the other neutrality checks: no product requirement IDs in core or branded shipped strings.
// Comments and ADRs may record history; they do not exempt package dependencies.
import { resolvedDistributionProblems } from './lib/distribution-paths.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { isTest, isText, listFiles, read } from './lib/repo.mjs';

// The marks TRADEMARKS.md reserves. A distribution sets its own name in its brand profile instead.
export const RESERVED = /\bBackbone\b|thebackbone/i;
const RESERVED_CASED = /\bBackbone\b|thebackbone/;
const REQUIREMENT_ID = /\bR-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/;
const SELF = new Set(['scripts/contamination.mjs', 'scripts/checks.test.mjs']);
const HISTORY = /^docs\/adr\//;
const CODE = /\.(?:[cm]?[jt]sx?)$/;

/** Text in a source file that reaches a person or a model: string literals, template text, JSX text. */
export function shippedStrings(file, text) {
  if (file.endsWith('.html')) return text.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  if (file.endsWith('.sql')) return [...text.replace(/--[^\n]*/g, '').matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]);
  if (!CODE.test(file)) return [];
  const ast = parse(text, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'], errorRecovery: true });
  const out = [];
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'StringLiteral' || node.type === 'JSXText') out.push(node.value);
    else if (node.type === 'TemplateElement') out.push(node.value.cooked ?? node.value.raw);
    else if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast.program);
  return out;
}

/** Shipped source: packages outside their tests, journeys and test helpers. */
export const shipped = (f) => f.startsWith('packages/') && !isTest(f) && !/\/(?:test|tests|e2e|testing)\//.test(f) && !f.endsWith('.md');

export function fileProblems(file, text, root = process.cwd()) {
  const problems = [];
  if (SELF.has(file) || HISTORY.test(file)) return problems;
  for (const [i, line] of text.split('\n').entries()) {
    if ((file.startsWith('packages/') || (file === 'scripts/lib/brand.mjs' || /^scripts\/(?:build|package)[^/]*\.mjs$/.test(file)) || file === 'package.json') &&
        /\bdistributions(?:[\\/]+|['"`]\s*,\s*['"`])backbone\b/.test(line)) {
      problems.push(`${file}:${i + 1}: depends on the Backbone distribution; packages and the default build must be independent. Select a brand through BACKBONE_DISTRIBUTION at build time.`);
    }
    if (/\bvision\.md\b/.test(line)) {
      problems.push(`${file}:${i + 1}: cites vision.md, the Way's purpose; give the mechanism's own reason (docs/architecture.md, a contract or an ADR).`);
    }
    if (file.startsWith('packages/core/') && REQUIREMENT_ID.test(line)) {
      problems.push(`${file}:${i + 1}: names product requirement ${REQUIREMENT_ID.exec(line)[0]} in the core; cite the invariant (docs/architecture.md, I-n) or the contract instead.`);
    }
  }
  if (file.startsWith('packages/') && CODE.test(file)) problems.push(...resolvedDistributionProblems(root, file, text));
  if (shipped(file)) {
    for (const s of shippedStrings(file, text)) {
      if (RESERVED_CASED.test(s)) {
        problems.push(`${file}: shipped text "${s.trim().slice(0, 60)}" names a reserved brand; take the name from the brand profile (scripts/lib/brand.mjs) or say it neutrally.`);
      }
    }
  }
  return problems;
}

export function check(root) {
  const problems = [];
  for (const f of listFiles(root)) {
    if (!isText(f) || !existsSync(join(root, f))) continue;
    problems.push(...fileProblems(f, read(root, f), root));
  }
  return problems;
}
