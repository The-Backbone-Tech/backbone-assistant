// The generated block of a piece's README (docs/repo-design.md, Docs for AI and people): written from
// its backbone.module.json, never by hand. A README beside a manifest carries the block between the
// markers below, and it must equal what the manifest says now. `--write` regenerates the blocks;
// pnpm regen refreshes source-derived manifest fields first, this block next, then the digest.
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listFiles, read } from './lib/repo.mjs';

export const BEGIN = '<!-- generated from backbone.module.json by scripts/module-readme.mjs; do not edit -->';
export const END = '<!-- end of generated block -->';

const list = (xs) => (xs.length ? xs.join(', ') : 'none');
const ports = (xs) => list(xs.map((p) => `${p.port} ${p.range}`));

/** The block's lines. The digest is left out: the README is part of what it covers. */
export function render(m) {
  const c = m.capabilities;
  return [
    BEGIN,
    '| Field | Value |',
    '| --- | --- |',
    `| id | \`${m.id}\` (${m.kind}) |`,
    `| version, licence | ${m.version}, ${m.licence} |`,
    `| publisher | ${m.publisher.name}, namespace \`${m.publisher.namespace}\` (${m.publisher.verification.method}, ${m.publisher.verification.status}) |`,
    `| stability | ${m.stability} |`,
    `| provides | ${ports(m.provides)} |`,
    `| consumes | ${ports(m.consumes)} |`,
    `| capabilities | planes: ${list(c.planes)}; effect classes: ${list(c.effectClasses.map(String))}; operations: ${list(c.operations)}; network: ${list(c.network)}; secrets: ${c.secrets} |`,
    `| data | owns: ${list(m.data.owns)}; migrations: ${m.data.migrations.length}; export: ${m.data.export} |`,
    `| depends on | ${list(m.dependsOn.map((d) => `${d.name} ${d.version}${d.licence ? ` (${d.licence})` : ''}`))} |`,
    `| conformance | ${m.conformance.quality.level}: ${m.conformance.suite.map((s) => `\`${s}\``).join(', ')} |`,
    ...m.conformance.quality.exemptions.map((e) => `| exemption | ${e.rule}: ${e.reason} |`),
    `| removal | ${m.removal.rule}; ${m.removal.refusedWhileUnknown ? 'refused while one of its effects is UNKNOWN' : 'no programmatic UNKNOWN removal guard'} |`,
    END,
  ].join('\n');
}

/** The README text with its block replaced, or null when it has no markers. */
export function withBlock(text, manifest) {
  const start = text.indexOf(BEGIN);
  const stop = text.indexOf(END);
  if (start < 0 || stop < start) return null;
  return text.slice(0, start) + render(manifest) + text.slice(stop + END.length);
}

export function readmeProblems(root, files, { write = false } = {}) {
  const problems = [];
  for (const f of files.filter((x) => x.endsWith('/backbone.module.json') && existsSync(join(root, x)))) {
    const readme = join(dirname(f), 'README.md');
    if (!existsSync(join(root, readme))) continue;
    const text = read(root, readme);
    const manifest = JSON.parse(read(root, f));
    const next = withBlock(text, manifest);
    if (next === null) problems.push(`${readme}: add the generated block (the two marker lines from scripts/module-readme.mjs), then run node scripts/module-readme.mjs --write.`);
    else if (next !== text) {
      if (write) writeFileSync(join(root, readme), next);
      else problems.push(`${readme}: the generated block is out of date with ${f}; run node scripts/module-readme.mjs --write.`);
    }
  }
  return problems;
}

export function check(root) {
  return readmeProblems(root, listFiles(root));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const problems = readmeProblems(root, listFiles(root), { write: process.argv.includes('--write') });
  for (const p of problems) console.log(`- ${p}`);
  process.exit(problems.length ? 1 : 0);
}
