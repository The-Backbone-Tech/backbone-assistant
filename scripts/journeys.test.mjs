import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectJourneys, tapResults, journeyTable } from './journeys.mjs';
import { readFileSync } from 'node:fs';
import { testNames, syntax, walk } from './lib/test-source.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'journey-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'evidence'));
  writeFileSync(join(root, 'proof.test.mjs'), "test('finishes the job', () => {}); // test('imaginary', () => {})\n");
  const families = [{ id: 1, name: 'Work', journeys: [{ id: 'work', sentence: 'A person finishes the job.', provingTest: { file: 'proof.test.mjs', name: 'finishes the job', suite: 'work' } }, { id: 'future', sentence: 'An admin invites a person.', provingTest: null }] }];
  writeFileSync(join(root, 'docs/journeys.json'), JSON.stringify(families));
  return { root, families };
}

test('only a completed matching gate and an individual pass make a journey green', t => {
  const { root } = fixture(t);
  const gate = { commit: 'abc', dirty: false, suites: [{ name: 'work', status: 'completed', exitCode: 0 }] };
  writeFileSync(join(root, 'evidence/gate.json'), JSON.stringify(gate));
  writeFileSync(join(root, 'evidence/work.log'), 'ok 1 - finishes the job\n');
  const inspect = commit => inspectJourneys(root, { evidence: join(root, 'evidence'), commit });
  assert.equal(inspect('abc').families[0].journeys[0].status, 'green');
  assert.equal(inspect('abc').families[0].journeys[1].status, 'unproven');
  assert.notEqual(inspect('other').families[0].journeys[0].status, 'green');
  gate.suites[0].exitCode = 1;
  writeFileSync(join(root, 'evidence/gate.json'), JSON.stringify(gate));
  assert.notEqual(inspect('abc').families[0].journeys[0].status, 'green');
  assert.deepEqual(inspect('abc').problems, []);
});

test('a missing or commented-out proving test fails while absent evidence does not', t => {
  const { root, families } = fixture(t);
  assert.deepEqual(inspectJourneys(root).problems, []);
  families[0].journeys[0].provingTest.name = 'imaginary';
  writeFileSync(join(root, 'docs/journeys.json'), JSON.stringify(families));
  assert.equal(inspectJourneys(root).problems.length, 1);
});

test('TAP skips, todos, duplicates and failed children never count as a green proof', () => {
  const results = tapResults('ok 1 - skipped # SKIP\nok 2 - future # TODO\nnot ok 3 - fails\nok 4 - duplicate\nnot ok 5 - duplicate\n    not ok 1 - child\nnot ok 6 - parent\nok 7 - passes\n');
  assert.equal(results.get('passes'), true);
  for (const name of ['skipped', 'future', 'fails', 'duplicate', 'child', 'parent']) assert.notEqual(results.get(name), true);
});

test('Playwright source identity and each project result are required for a green journey', t => {
  const { root, families } = fixture(t);
  mkdirSync(join(root, 'e2e'));
  writeFileSync(join(root, 'e2e/work.spec.ts'), "test('finishes the job', () => {});");
  families[0].journeys[0].provingTest = { file: 'e2e/work.spec.ts', name: 'finishes the job', suite: 'browser' };
  // Use the same source shape as a workspace e2e package.
  mkdirSync(join(root, 'app')); mkdirSync(join(root, 'app/e2e'));
  writeFileSync(join(root, 'app/e2e/work.spec.ts'), "test('finishes the job', () => {});");
  families[0].journeys[0].provingTest.file = 'app/e2e/work.spec.ts';
  writeFileSync(join(root, 'docs/journeys.json'), JSON.stringify(families));
  writeFileSync(join(root, 'evidence/gate.json'), JSON.stringify({ commit: 'abc', dirty: false, suites: [{ name: 'browser', status: 'completed', exitCode: 0 }] }));
  const status = log => {
    writeFileSync(join(root, 'evidence/browser.log'), log);
    return inspectJourneys(root, { evidence: join(root, 'evidence'), commit: 'abc' }).families[0].journeys[0].status;
  };
  assert.equal(status('  ✓  1 [browser] › e2e/work.spec.ts:1:1 › finishes the job (1.5s)'), 'green');
  assert.notEqual(status('  ✓  1 [browser] › e2e/other.spec.ts:1:1 › finishes the job (1.5s)'), 'green');
  assert.notEqual(status('  ✓  1 [browser] › e2e/work.spec.ts:1:1 › finishes the job (1.5s)\n  ✘  2 [desktop] › e2e/work.spec.ts:1:1 › finishes the job (1.5s)'), 'green');
});

test('finite parameterized test names are discovered from code without executing tests', () => {
  assert.deepEqual(testNames("for (const provider of ['a','b'] as const) test(`${provider} finishes`, () => {});"), ['a finishes', 'b finishes']);
});

test('the plan covers every scorecard family without storing editable status', () => {
  const families = JSON.parse(readFileSync(new URL('../docs/journeys.json', import.meta.url), 'utf8'));
  assert.equal(families.length, 19);
  assert.equal(new Set(families.map(f => f.id)).size, 19);
  const ids = new Set();
  for (const family of families) {
    assert.ok(family.id >= 1 && family.id <= 19 && family.name && family.journeys.length);
    for (const journey of family.journeys) {
      assert.ok(journey.id && journey.sentence && !ids.has(journey.id)); ids.add(journey.id);
      assert.equal(Object.hasOwn(journey, 'status'), false);
      if (journey.provingTest?.suite === 'app-e2e') assert.equal(journey.requiresInstalled, true);
    }
  }
});

test('installed journeys stay pending for browser passes or unrelated, reused and unbound installed evidence', t => {
  const { root, families } = fixture(t);
  mkdirSync(join(root, 'app/e2e'), { recursive: true });
  writeFileSync(join(root, 'app/e2e/work.spec.ts'), "test('finishes the job', () => {});");
  const journey = families[0].journeys[0];
  journey.requiresInstalled = true;
  journey.provingTest = { file: 'app/e2e/work.spec.ts', name: 'finishes the job', suite: 'browser' };
  writeFileSync(join(root, 'docs/journeys.json'), JSON.stringify(families));
  const gate = { kind: 'gate', commit: 'abc', dirty: false, suites: [
    { name: 'browser', status: 'completed', exitCode: 0 },
  ] };
  const pass = project => `  ✓  1 [${project}] › e2e/work.spec.ts:1:1 › finishes the job (1.5s)`;
  writeFileSync(join(root, 'evidence/browser.log'), pass('browser'));
  const inspect = () => {
    writeFileSync(join(root, 'evidence/gate.json'), JSON.stringify(gate));
    return inspectJourneys(root, { evidence: join(root, 'evidence'), commit: 'abc' });
  };
  const pending = () => {
    const result = inspect();
    assert.equal(result.families[0].journeys[0].status, 'installed evidence pending');
    assert.ok(journeyTable(result).toLowerCase().includes('installed evidence pending'));
  };
  pending();
  assert.equal(inspectJourneys(root).families[0].journeys[0].status, 'installed evidence pending');
  const installed = { name: 'app-installed', command: 'pnpm --filter @backbone-next/app e2e:installed', status: 'completed', exitCode: 0,
    packagedApp: { commit: 'abc', sha256: 'a'.repeat(64) } };
  gate.suites.push(installed);
  for (const log of [pass('browser'), 'ok 1 - finishes the job', pass('electron').replace('finishes the job', 'another journey')]) {
    writeFileSync(join(root, 'evidence/app-installed.log'), log); pending();
  }
  writeFileSync(join(root, 'evidence/app-installed.log'), pass('electron'));
  assert.equal(inspect().families[0].journeys[0].status, 'green');
  for (const [key, value] of [['exitCode', 1], ['timedOut', true], ['reusedFrom', 'old'], ['packagedApp', { commit: 'other', sha256: 'a'.repeat(64) }], ['packagedApp', { commit: 'abc' }]]) {
    const before = installed[key]; installed[key] = value; pending(); installed[key] = before;
  }
  gate.commit = 'other'; pending(); gate.commit = 'abc';
  gate.dirty = true; pending(); gate.dirty = false;
  gate.kind = 'author'; pending();
});

test('coverage counts each family, kind and activated configuration without treating scope as a failure', t => {
  const { root, families } = fixture(t);
  Object.assign(families[0].journeys[0], { kind: 'platform', evidenceRequired: 'test' });
  Object.assign(families[0].journeys[1], { kind: 'configuration', configuration: ['team', 'company'], evidenceRequired: 'installed' });
  families[0].journeys.push({ id: 'enhancement', sentence: 'A person reruns a saved workflow.', kind: 'optional', evidenceRequired: 'installed', provingTest: null });
  families.push({ id: 2, name: 'Other', journeys: [{ id: 'partial', sentence: 'A person finishes on a real engine.', kind: 'platform', evidenceRequired: 'real engine', provingTest: { file: 'proof.test.mjs', name: 'finishes the job', suite: 'work', level: 'test' } }] });
  writeFileSync(join(root, 'docs/journeys.json'), JSON.stringify(families));
  const result = inspectJourneys(root);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.counts.total, { total: 4, present: 1, partial: 1, missing: 2, green: 0 });
  assert.deepEqual(result.counts.byKind.platform, { total: 2, present: 1, partial: 1, missing: 0, green: 0 });
  assert.equal(result.counts.byKind.configuration.missing, 1);
  assert.equal(result.counts.byKind.optional.missing, 1);
  assert.equal(result.counts.byFamily[1].byKind.platform.present, 1);
  assert.equal(result.counts.byFamily[2].partial, 1);
  assert.equal(result.counts.byFamily[2].byKind.optional.total, 0);
  assert.equal(result.counts.byConfiguration.team.missing, 1);
  assert.equal(result.counts.byConfiguration.company.missing, 1);
  assert.match(journeyTable(result), /Platform/);
  assert.match(journeyTable(result), /Configuration/);
  assert.match(journeyTable(result), /Optional/);
});

test('a lower-level or partial proof cannot turn a broader journey green', t => {
  const { root, families } = fixture(t);
  const journey = families[0].journeys[0];
  journey.kind = 'platform';
  journey.provingTest.level = 'test';
  writeFileSync(join(root, 'evidence/gate.json'), JSON.stringify({ commit: 'abc', dirty: false, suites: [{ name: 'work', status: 'completed', exitCode: 0 }] }));
  writeFileSync(join(root, 'evidence/work.log'), 'ok 1 - finishes the job\n');
  for (const level of ['installed', 'real engine', 'real use']) {
    journey.evidenceRequired = level;
    writeFileSync(join(root, 'docs/journeys.json'), JSON.stringify(families));
    const result = inspectJourneys(root, { evidence: join(root, 'evidence'), commit: 'abc' });
    assert.notEqual(result.families[0].journeys[0].status, 'green');
    assert.equal(result.families[0].journeys[0].coverage, 'partial');
  }
  journey.evidenceRequired = 'test'; journey.provingTest.scope = 'partial';
  writeFileSync(join(root, 'docs/journeys.json'), JSON.stringify(families));
  const result = inspectJourneys(root, { evidence: join(root, 'evidence'), commit: 'abc' });
  assert.notEqual(result.families[0].journeys[0].status, 'green');
  assert.equal(result.families[0].journeys[0].coverage, 'partial');
});

test('catalog metadata distinguishes required configurations and retains source-only status', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = inspectJourneys(root);
  let installedFilter;
  walk(syntax(readFileSync(new URL('../packages/surfaces/app/scripts/installed-journey.ts', import.meta.url), 'utf8')), node => {
    if (node.type === 'VariableDeclarator' && node.id.name === 'INSTALLED_TEST_ARGS') installedFilter = new RegExp((node.init.expression || node.init).elements.at(-1).value);
  });
  assert.ok(installedFilter);
  const ids = new Map(result.families.flatMap(f => f.journeys.map(j => [j.id, j])));
  for (const family of result.families) for (const journey of family.journeys) {
    assert.ok(['platform', 'configuration', 'optional'].includes(journey.kind), journey.id);
    assert.ok(['test', 'installed', 'real engine', 'real use'].includes(journey.evidenceRequired), journey.id);
    if (journey.kind === 'configuration') assert.ok(journey.configuration?.length, journey.id);
    assert.ok(journey.kindReason, journey.id);
    assert.ok(!Object.hasOwn(journey, 'backboneToday'), journey.id);
    if (journey.provingTest?.file.includes('/e2e/')) {
      assert.equal(journey.requiresInstalled, true, journey.id);
      assert.ok(installedFilter.test(journey.provingTest.file), journey.id);
    }
  }
  for (const id of ['invite-role', 'channel-team-group', 'per-person-vault', 'company-sign-in', 'fleet-upgrade']) assert.equal(ids.get(id).kind, 'configuration', id);
  assert.equal(ids.get('cli-headless-json').kind, 'platform');
  assert.equal(ids.get('rerunnable-workflow').kind, 'optional');
  assert.equal(ids.get('memory-scope-off').kind, 'platform');
  assert.equal(ids.get('memory-role-off').kind, 'configuration');
  for (const journey of ids.values()) if (journey.coverage === 'present') {
    assert.ok(journey.provingTest, journey.id);
    assert.equal(journey.provingTest.level, journey.evidenceRequired, journey.id);
    assert.notEqual(journey.provingTest.scope, 'partial', journey.id);
  }
  assert.deepEqual(result.problems, []);
});

test('finite tuple test names retain each real pair without inventing cross products', () => {
  assert.deepEqual(testNames("for (const [first, second] of [['pi','acp'], ['acp','pi']] as const) test(`${first} to ${second}`, () => {});"), ['pi to acp', 'acp to pi']);
});

test('the installed goals project qualifies only its packaged Electron fixture and never a browser or another file', t => {
  const { root, families } = fixture(t);
  mkdirSync(join(root, 'app/e2e'), { recursive: true });
  writeFileSync(join(root, 'app/e2e/goals.spec.ts'), "test('finishes the job', () => {});");
  writeFileSync(join(root, 'app/e2e/work.spec.ts'), "test('finishes the job', () => {});");
  Object.assign(families[0].journeys[0], { evidenceRequired: 'installed', requiresInstalled: true });
  families[0].journeys[0].provingTest = { file: 'app/e2e/goals.spec.ts', name: 'finishes the job', suite: 'app-installed', level: 'installed' };
  writeFileSync(join(root, 'evidence/gate.json'), JSON.stringify({ kind: 'gate', commit: 'abc', dirty: false, suites: [{ name: 'app-installed', command: 'pnpm --filter @backbone-next/app e2e:installed', status: 'completed', exitCode: 0, packagedApp: { commit: 'abc', sha256: 'a'.repeat(64) } }] }));
  const status = (file, project) => {
    families[0].journeys[0].provingTest.file = `app/e2e/${file}`;
    writeFileSync(join(root, 'docs/journeys.json'), JSON.stringify(families));
    writeFileSync(join(root, 'evidence/app-installed.log'), `  ✓  1 [${project}] › e2e/${file}:1:1 › finishes the job (1.5s)`);
    return inspectJourneys(root, { evidence: join(root, 'evidence'), commit: 'abc' }).families[0].journeys[0].status;
  };
  assert.equal(status('goals.spec.ts', 'goals'), 'green');
  assert.notEqual(status('goals.spec.ts', 'browser'), 'green');
  assert.notEqual(status('work.spec.ts', 'goals'), 'green');
});
