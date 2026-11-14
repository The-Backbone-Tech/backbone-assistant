// Turn the last run into RESULTS.md: `node oracle/report.ts [--context "<model, effort…>"]`.
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Coverage, SpecGap, Status } from './core/coverage.ts';
import { coverage as effects } from './core/effects/coverage.ts';
import { coverage as isolation } from './core/isolation/coverage.ts';
import { coverage as ledger } from './core/ledger/coverage.ts';
import { coverage as mandates } from './core/mandates/coverage.ts';
import { coverage as promotion } from './core/promotion/coverage.ts';
import { coverage as ruleOfTwo } from './core/rule-of-two/coverage.ts';
import { coverage as journey } from './behaviour/journey/coverage.ts';
import { coverage as lifecycle } from './behaviour/lifecycle/coverage.ts';
import { coverage as scenes } from './behaviour/scenes/coverage.ts';
import { LESSONS } from './lessons/cases.ts';
import { REGISTER } from './lessons/register.ts';
import type { BindingUse } from './target.ts';

const PROMISES: Coverage[] = [isolation, mandates, effects, ledger, promotion, ruleOfTwo];
const target = process.env.ORACLE_TARGET ?? 'legacy';
const here = (p: string) => new URL(p, import.meta.url);
const CORE = fileURLToPath(here('./core/'));
const ORACLE = fileURLToPath(here('./'));

interface Assertion {
  ancestorTitles: string[];
  title: string;
  status: string;
}
const run = JSON.parse(await readFile(here(`./results/raw/${target}.json`), 'utf8')) as {
  startTime: number;
  numPassedTests: number;
  numFailedTests: number;
  numTotalTests: number;
  testResults: { name: string; assertionResults: Assertion[] }[];
};

/** Every case of the run, by its oracle name (`promise/file.test.ts > describe > it`, relative to core/ or the oracle). */
const results = new Map<string, string>();
for (const file of run.testResults) {
  const base = file.name.startsWith(CORE) ? relative(CORE, file.name) : relative(ORACLE, file.name);
  for (const a of file.assertionResults) results.set([base, ...a.ancestorTitles, a.title].join(' > '), a.status);
}

const usage: Record<string, BindingUse[]> = {};
for (const f of await readdir(here('./results/usage/'))) {
  if (!f.startsWith(`${target}.`)) continue;
  // A case may be recorded by more than one target accessor in its file: keep every use.
  for (const [name, uses] of Object.entries(JSON.parse(await readFile(here(`./results/usage/${f}`), 'utf8')) as Record<string, BindingUse[]>)) {
    usage[name] = [...(usage[name] ?? []), ...uses];
  }
}

const lines: string[] = [];
const say = (s = '') => lines.push(s);
const pct = (n: number, d: number) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`);
const git = (...args: string[]) => execFileSync('git', args, { cwd: ORACLE, encoding: 'utf8' }).trim();

say('# Oracle: results (core and behaviour)');
say();
say(`- **Target:** \`${target}\` at \`${git('rev-parse', '--short=8', 'HEAD')}\` (branch \`${git('rev-parse', '--abbrev-ref', 'HEAD')}\`), base \`3e9f9c3b\`.`);
say(`- **Run:** ${new Date(run.startTime).toISOString()}; Node ${process.version}; embedded PostgreSQL 18 (embedded-postgres 18.4.0-beta.17) through \`${target === 'legacy' ? 'packages/db/src/testing.ts' : 'packages/core/src/db/testing.ts'}\`.`);
say('- **Command:** `pnpm exec vitest run --config oracle/vitest.config.ts`, then `node oracle/report.ts`.');
const context = process.argv.indexOf('--context');
if (context > 0) say(`- **Made by:** ${process.argv[context + 1]}`);
say(`- **Totals:** ${run.numPassedTests} passed, ${run.numFailedTests} failed, of ${run.numTotalTests} cases (expected failures count as passed).`);
say();

say('## Pass count per promise');
say();
say('| Promise | Oracle cases | Passed | Failed | Legacy cases | Ported | Narrowed | Adversary | Gap | Deferred | Black-box share |');
say('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
const totals = { cases: 0, passed: 0, failed: 0, legacy: 0, ported: 0, narrowed: 0, adversary: 0, gap: 0, deferred: 0 };
const missing: string[] = [];
for (const p of PROMISES) {
  const mine = [...results].filter(([name]) => name.startsWith(`${p.promise}/`));
  const passed = mine.filter(([, s]) => s === 'passed').length;
  const count = (status: Status) => Object.values(p.cases).filter((c) => c.status === status).length;
  const legacy = Object.keys(p.cases).length;
  const row = { ported: count('ported'), narrowed: count('narrowed'), adversary: count('adversary'), gap: count('gap'), deferred: count('deferred') };
  for (const [name, entry] of Object.entries(p.cases)) {
    for (const o of entry.oracle ?? []) if (results.get(o) !== 'passed') missing.push(`${name} → ${o} (${results.get(o) ?? 'not run'})`);
  }
  const blackBox = row.ported + row.narrowed + row.adversary;
  say(
    `| ${p.promise} | ${mine.length} | ${passed} | ${mine.length - passed} | ${legacy} | ${row.ported} | ${row.narrowed} | ${row.adversary} | ${row.gap} | ${row.deferred} | ${pct(blackBox, legacy - row.deferred)} |`,
  );
  totals.cases += mine.length;
  totals.passed += passed;
  totals.failed += mine.length - passed;
  totals.legacy += legacy;
  for (const k of ['ported', 'narrowed', 'adversary', 'gap', 'deferred'] as const) totals[k] += row[k];
}
const blackBox = totals.ported + totals.narrowed + totals.adversary;
say(
  `| **all six** | ${totals.cases} | ${totals.passed} | ${totals.failed} | ${totals.legacy} | ${totals.ported} | ${totals.narrowed} | ${totals.adversary} | ${totals.gap} | ${totals.deferred} | ${pct(blackBox, totals.legacy - totals.deferred)} |`,
);
say();
say('Black-box share = (ported + narrowed + adversary) / (legacy cases − deferred). Deferred cases are black-boxable but exercise a surface outside the six promises; counted over every legacy case the share is ' +
  `${pct(blackBox, totals.legacy)}. Through public crossings and views alone, without the adversary port: ${pct(totals.ported + totals.narrowed, totals.legacy - totals.deferred)}. ` +
  `Cases that could not be made black-box: ${totals.gap} of ${totals.legacy - totals.deferred} (${pct(totals.gap, totals.legacy - totals.deferred)}).`);
say();
const other = [...results].filter(([name]) => !PROMISES.some((p) => name.startsWith(`${p.promise}/`)));
say(`Outside the promises: ${other.filter(([, s]) => s === 'passed').length} of ${other.length} passed (${[...new Set(other.map(([n]) => n.split(' > ')[0]))].join(', ')}).`);
say();
if (missing.length) {
  say('**Inventory entries whose oracle case did not pass in this run:**');
  for (const m of missing) say(`- ${m}`);
  say();
}

say('## How each case reached the target');
say();
const kinds = (name: string) => new Set((usage[name] ?? []).map((u) => u.kind));
const promiseCases = [...results.keys()].filter((n) => PROMISES.some((p) => n.startsWith(`${p.promise}/`)));
const using = (kind: string) => promiseCases.filter((n) => kinds(n).has(kind as never)).length;
say(`Of ${promiseCases.length} promise cases: ${using('crossing')} call published crossings, ${using('view')} read views, ` +
  `${using('governed-write')} use at least one governed table write (no named crossing, SG-CORE-02), ${using('adversary')} use the adversary port, ` +
  `${using('operator')} use the operator port (every fixture creates its workspaces through it, SG-CORE-01).`);
say();

say('## Spec gaps');
say();
const gaps: (SpecGap & { promise: string; cases: number })[] = PROMISES.flatMap((p) =>
  p.gaps.map((g) => ({ ...g, promise: p.promise, cases: Object.values(p.cases).filter((c) => c.gap === g.id).length })),
);
say('| Id | Promise | Kind | Cases | What is missing | What the successor contract would need |');
say('| --- | --- | --- | ---: | --- | --- |');
for (const g of gaps) say(`| ${g.id} | ${g.promise} | ${g.kind} | ${g.cases} | ${g.summary.replaceAll('|', '\\|')} | ${g.needs.replaceAll('|', '\\|')} |`);
say();
say('“Cases” counts legacy cases whose status is `gap` with that id; a gap with 0 is referenced by narrowed cases or by every fixture.');
say();

say('## Deferred cases');
say();
for (const p of PROMISES) {
  for (const [name, c] of Object.entries(p.cases)) if (c.status === 'deferred') say(`- \`${name}\`: ${c.note}`);
}
say();

say('## Behaviour oracle');
say();
const behaviour = [...results].filter(([name]) => name.startsWith('behaviour/'));
const areaOf = (name: string) => {
  const [, area, file] = name.split(' > ')[0]?.split('/') ?? [];
  return area === 'scenes' ? `scenes/${(file ?? '').replace(/\.test\.ts$/, '')}` : (area ?? '?');
};
const areas = [...new Set(behaviour.map(([n]) => areaOf(n)))].sort();
say('| Area | Cases | Passed | Failed | Known legacy deviations (expected failures) |');
say('| --- | ---: | ---: | ---: | ---: |');
let bAll = 0;
let bPassed = 0;
for (const area of areas) {
  const mine = behaviour.filter(([n]) => areaOf(n) === area);
  const passed = mine.filter(([, st]) => st === 'passed').length;
  const deviations = mine.filter(([n]) => /known legacy/.test(n)).length;
  bAll += mine.length;
  bPassed += passed;
  say(`| ${area} | ${mine.length} | ${passed} | ${mine.length - passed} | ${deviations} |`);
}
say(`| **all** | ${bAll} | ${bPassed} | ${bAll - bPassed} | ${behaviour.filter(([n]) => /known legacy/.test(n)).length} |`);
say();
const deviating = behaviour.filter(([n]) => /known legacy/.test(n)).map(([n]) => n);
if (deviating.length) {
  say('Known legacy deviations, run as expected failures:');
  for (const n of deviating) say(`- \`${n}\``);
  say();
}
const bUsage = Object.entries(usage).filter(([n]) => n.startsWith('behaviour/'));
const bKinds = (kind: string) => bUsage.filter(([, u]) => u.some((x) => (x.kind as string) === kind)).length;
say(`Of ${bUsage.length} behaviour cases with recorded usage: ${bKinds('api')} act through the service's API, ${bKinds('process')} start, stop or run a process, ` +
  `${bKinds('crossing')} call a crossing, ${bKinds('governed-write')} use a governed table write, ${bKinds('observer')} are judged with a read-only observer, ` +
  `${bKinds('clock')} move time, ${bKinds('operator')} use the operator port, ${bKinds('adversary')} the adversary port.`);
say();

say('### Behaviour spec gaps');
say();
say('| Id | Area | Kind | What is missing | What the successor contract would need |');
say('| --- | --- | --- | --- | --- |');
for (const [area, gaps] of [
  ['scenes', scenes.gaps],
  ['lifecycle', lifecycle.gaps],
  ['journey', journey.gaps],
] as const) {
  for (const g of gaps) say(`| ${g.id} | ${area} | ${g.kind} | ${g.summary.replaceAll('|', '\\|')} | ${g.needs.replaceAll('|', '\\|')} |`);
}
say();

say('## Lessons register');
say();
say('Each core lesson case passes on the correct stub, fails on an assertion with its flaw switched on, and runs against the target.');
say();
say('| Lesson | Case | Correct stub | Flawed stub | Target |');
say('| --- | --- | --- | --- | --- |');
for (const l of LESSONS) {
  const correct = results.get(`lessons/failing-first.test.ts > every lesson case fails on a deliberately wrong stub, and only because of its flaw > ${l.id}: passes on the correct stub`);
  const flawed = results.get(`lessons/failing-first.test.ts > every lesson case fails on a deliberately wrong stub, and only because of its flaw > ${l.id}: fails on the stub with ${l.flaw}`);
  const onTarget = results.get(
    `lessons/register.test.ts > the lessons register, against the target > ${l.id} ${l.title}${l.legacyDeviation ? ' (known legacy deviation)' : ''}`,
  );
  const verdict = onTarget !== 'passed' ? `**${onTarget ?? 'not run'}**` : l.legacyDeviation ? `deviates: ${l.legacyDeviation}` : 'holds';
  say(`| ${l.lesson} | ${l.id} ${l.title} | ${correct === 'passed' ? 'passes' : `**${correct}**`} | ${flawed === 'passed' ? `fails (${l.flaw})` : `**did not fail**`} | ${verdict} |`);
}
say();
say('| Lesson | Enforced in | Where |');
say('| ---: | --- | --- |');
for (const r of REGISTER) say(`| ${r.lesson} | ${r.home} | ${r.where} |`);
say();

// The frozen legacy record stays RESULTS.md; any other target writes its own page beside it.
await writeFile(here(target === 'legacy' ? './RESULTS.md' : `./RESULTS.${target}.md`), `${lines.join('\n')}\n`);
console.log(lines.slice(0, 20).join('\n'));
