// Coverage is an observation of a particular gate, never a field in the plan.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { testNames } from './lib/test-source.mjs';

export function tapResults(text) {
  const results = new Map();
  for (const line of text.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    // Top-level TAP titles only: a child without its enclosing suite is ambiguous.
    const match = line.match(/^(not ok|ok) \d+ - (.*?)(?:\s+# (SKIP|TODO)\b.*)?$/);
    if (!match) continue;
    const [, outcome, name, skipped] = match;
    const passed = outcome === 'ok' && !skipped;
    results.set(name, results.has(name) ? false : passed);
  }
  return results;
}

function proofPassed(proof, evidence, gate, installed = false) {
  const suite = gate?.suites?.find(s => s.name === proof.suite);
  if (suite?.status !== 'completed' || suite.exitCode !== 0 || suite.timedOut || suite.signal) return false;
  if (installed && (gate.kind !== 'gate' || suite.reusedFrom ||
      suite.command !== 'pnpm --filter @backbone-next/app e2e:installed' ||
      suite.packagedApp?.commit !== gate.commit || !/^[a-f0-9]{64}$/.test(suite.packagedApp?.sha256 || ''))) return false;
  const log = join(evidence, `${proof.suite}.log`);
  if (!existsSync(log)) return false;
  const text = readFileSync(log, 'utf8');
  if (!installed && tapResults(text).get(proof.name) === true) return true;
  // Playwright list reporter includes the source file, line and title on each result.
  const file = proof.file.split('/e2e/')[1];
  if (!file) return false;
  const lines = text.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(line => line.replace(/\s+\([\d.]+(?:ms|s|m)\)\s*$/, '')).filter(line => line.includes(`e2e/${file}:`) && line.trimEnd().endsWith(`› ${proof.name}`));
  // The existing goals project launches Electron and asserts isPackaged when installed.
  const installedProject = line => /\[electron\]\s*›/.test(line) ||
    (file === 'goals.spec.ts' && /\[goals\]\s*›/.test(line));
  return lines.length > 0 && lines.every(line => /^\s*✓/.test(line) && (!installed || installedProject(line)));
}

export function inspectJourneys(root, { evidence, commit } = {}) {
  const families = JSON.parse(readFileSync(join(root, 'docs/journeys.json'), 'utf8'));
  let gate;
  if (evidence && existsSync(join(evidence, 'gate.json'))) {
    try { gate = JSON.parse(readFileSync(join(evidence, 'gate.json'), 'utf8')); } catch { /* Incomplete evidence proves nothing. */ }
  }
  const qualified = Boolean(commit && gate?.commit === commit && gate.dirty === false);
  const problems = [];
  const sourceExists = proof => {
    try { return testNames(readFileSync(join(root, proof.file), 'utf8')).includes(proof.name); }
    catch { return false; }
  };
  for (const family of families) for (const journey of family.journeys) {
    const proof = journey.provingTest;
    let exists = false;
    const supporting = (journey.supportingTests || []).filter(sourceExists);
    if (proof) {
      try { exists = testNames(readFileSync(join(root, proof.file), 'utf8')).includes(proof.name); } catch { /* Missing or unparsable proof. */ }
      if (!exists) problems.push(`${journey.id}: proving test no longer exists: ${proof.file} :: ${proof.name}`);
    }
    const level = proof?.level || (journey.requiresInstalled ? 'installed' : 'test');
    const sufficient = !journey.evidenceRequired || level === journey.evidenceRequired;
    journey.coverage = !exists ? supporting.length ? 'partial' : 'missing'
      : proof.scope === 'partial' || !sufficient ? 'partial' : 'present';
    journey.status = !proof ? journey.requiresInstalled ? 'installed evidence pending' : 'unproven' : !exists ? 'missing' : journey.requiresInstalled
      ? qualified && proofPassed({ ...proof, suite: 'app-installed' }, evidence, gate, true) ? 'green' : 'installed evidence pending'
      : qualified && proofPassed(proof, evidence, gate) ? 'green' : 'unverified';
    // A seeded test cannot stand in for live model behaviour or a person's work.
    if (journey.status === 'green' && (!sufficient || proof.scope === 'partial')) journey.status = 'unverified';
  }
  return { families, problems, counts: journeyCounts(families), evidenceCommit: gate?.commit ?? null, qualified };
}

export function check(root) {
  return inspectJourneys(root).problems;
}

const emptyCounts = () => ({ total: 0, present: 0, partial: 0, missing: 0, green: 0 });
const addCount = (counts, journey) => {
  counts.total++;
  counts[journey.coverage]++;
  if (journey.status === 'green') counts.green++;
};

const emptyKinds = () => Object.fromEntries(['platform', 'configuration', 'optional'].map(kind => [kind, emptyCounts()]));

export function journeyCounts(families) {
  const total = emptyCounts(), byKind = emptyKinds(), byFamily = {}, byConfiguration = {};
  for (const family of families) {
    const row = byFamily[family.id] = { ...emptyCounts(), byKind: emptyKinds() };
    for (const journey of family.journeys) {
      // Older plan fixtures default to platform; new entries carry explicit kinds.
      const kind = journey.kind || 'platform';
      addCount(total, journey); addCount(row, journey);
      addCount(byKind[kind] ||= emptyCounts(), journey);
      addCount(row.byKind[kind] ||= emptyCounts(), journey);
      // One journey may activate in several configurations; these columns overlap.
      if (kind === 'configuration') for (const configuration of new Set(journey.configuration || [])) {
        addCount(byConfiguration[configuration] ||= emptyCounts(), journey);
      }
    }
  }
  return { total, byKind, byFamily, byConfiguration };
}

export function journeyTable(result) {
  const counts = result.counts || journeyCounts(result.families);
  const cell = c => `${c?.present || 0}/${c?.partial || 0}/${c?.missing || 0}`;
  return ['Source coverage: present/partial/missing. Present names an existing full-scope test at the required level; green additionally requires matching execution evidence.',
    'Family | Platform P/P/M | Configuration P/P/M | Optional P/P/M | Green / journeys',
    '--- | --- | --- | --- | ---',
    ...result.families.map(f => {
      const c = counts.byFamily[f.id];
      return `${f.id}. ${f.name} | ${cell(c.byKind.platform)} | ${cell(c.byKind.configuration)} | ${cell(c.byKind.optional)} | ${c.green} / ${c.total}`;
    }),
    ...['platform', 'configuration', 'optional'].map(kind => `${kind}: ${cell(counts.byKind[kind])}`),
    ...Object.entries(counts.byConfiguration).sort(([a], [b]) => a.localeCompare(b)).map(([name, c]) => `Activated ${name}: ${cell(c)} (${c.total} journeys)`),
    `No green journey: ${result.families.filter(f => !f.journeys.some(j => j.status === 'green')).map(f => f.id).join(', ') || 'none'}`,
    `Installed evidence pending: ${result.families.flatMap(f => f.journeys.filter(j => j.status === 'installed evidence pending').map(j => j.id)).join(', ') || 'none'}`].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error('usage: node scripts/journeys.mjs [evidence-directory]');
  const root = process.cwd();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const evidence = resolve(args[0] || process.env.BACKBONE_JOURNEY_EVIDENCE || `.gate/${commit.slice(0, 7)}`);
  const result = inspectJourneys(root, { evidence, commit });
  console.log(`Evidence: ${evidence}; commit: ${result.evidenceCommit || 'none'}; matches HEAD: ${result.qualified}`);
  console.log(journeyTable(result));
  for (const problem of result.problems) console.error(problem);
  process.exitCode = result.problems.length ? 1 : 0;
}
