// Runs the oracle's promises against one target adapter and writes oracle/results/<adapter>.json.
// Each promise is a set of the frozen suite's files; a promise the adapter does not support is
// reported as not implemented instead of being run. `--promise <name>` (repeatable) runs a subset
// and writes oracle/results/partial.json, so a partial run never replaces the full record.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const PROMISES = {
  oracle: ['core/smoke.test.ts', 'core/imports.test.ts', 'core/coverage.test.ts'],
  isolation: ['core/isolation/'],
  mandates: ['core/mandates/'],
  effects: ['core/effects/'],
  ledger: ['core/ledger/'],
  promotion: ['core/promotion/'],
  'rule-of-two': ['core/rule-of-two/'],
  lessons: ['lessons/'],
  scenes: ['behaviour/scenes/'],
  lifecycle: ['behaviour/lifecycle/'],
  journeys: ['behaviour/journey/'],
};

const root = process.cwd();
const oracle = join(root, 'oracle');
const arg = (flag) => process.argv.flatMap((a, i) => (a === flag ? [process.argv[i + 1]] : []));
const name = arg('--adapter')[0] ?? 'successor';
const only = arg('--promise');
const supported = JSON.parse(readFileSync(join(oracle, `adapters/${name}/supports.json`), 'utf8'));
const selected = Object.keys(PROMISES).filter((p) => supported.includes(p) && (only.length === 0 || only.includes(p)));

const raw = join(oracle, `results/raw/${name}.json`);
if (selected.length) {
  const files = selected.flatMap((p) => PROMISES[p]);
  spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', 'oracle/vitest.config.ts', ...files], {
    stdio: 'inherit',
    env: { ...process.env, ORACLE_TARGET: name },
  });
}
const run = selected.length && existsSync(raw) ? JSON.parse(readFileSync(raw, 'utf8')) : { testResults: [] };

const promiseOf = (file) => {
  const path = relative(oracle, file);
  return Object.keys(PROMISES).find((p) => PROMISES[p].some((prefix) => path.startsWith(prefix)));
};
const results = { adapter: name, passed: 0, failed: 0, pending: 0, promises: {} };
for (const promise of Object.keys(PROMISES)) {
  if (!supported.includes(promise)) {
    results.promises[promise] = { state: 'not implemented' };
    results.pending += 1;
    continue;
  }
  if (!selected.includes(promise)) continue;
  const cases = run.testResults.filter((f) => promiseOf(f.name) === promise).flatMap((f) => f.assertionResults);
  const passed = cases.filter((c) => c.status === 'passed').length;
  const failed = cases.length - passed;
  results.promises[promise] = { state: failed === 0 && passed > 0 ? 'pass' : 'fail', passed, failed };
  results.passed += passed;
  results.failed += failed;
}
mkdirSync(join(oracle, 'results'), { recursive: true });
const out = only.length ? 'partial' : name;
writeFileSync(join(oracle, `results/${out}.json`), `${JSON.stringify(results, null, 2)}\n`);
console.log(`oracle (${name}): ${results.passed} passed, ${results.failed} failed, ${results.pending} not implemented`);
for (const [p, r] of Object.entries(results.promises)) console.log(`  ${p}: ${r.state}${r.passed === undefined ? '' : ` (${r.passed} passed, ${r.failed} failed)`}`);
process.exit(results.passed > 0 && results.failed === 0 && results.pending === 0 ? 0 : 1);
