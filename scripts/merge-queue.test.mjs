import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unionJourneys, mergeUnit, attributeFailure, integrationLine, validateQueue } from './lib/merge-queue.mjs';
import { runQueue, runCommand, publishCandidate, isolatedTestPlan, needsInstallProof } from './merge-queue.mjs';
import { ownPatchId } from './lib/merge-queue-policy.mjs';
import { inspectDocsTail, carryDocsTail } from './lib/merge-queue-docs.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'merge-queue-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  for (const [key, value] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': '/dev/null' })) git('config', key, value);
  const put = (file, value) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n'); };
  put('.gitignore', '.gate/\nnode_modules/\n');
  put('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
  put('package.json', { name: 'queue-fixture', scripts: {} });
  put('docs/execution.md', '# Execution\n\n## Integration record\n');
  put('docs/journeys.json', [{ id: 1, name: 'Work', journeys: [{ id: 'base', sentence: 'Base' }] }]);
  for (const name of ['a', 'b']) {
    put(`packages/${name}/package.json`, { name: `@test/${name}`, scripts: { test: 'node --test' } });
    put(`packages/${name}/src.mjs`, 'base\n');
    put(`packages/${name}/test.test.mjs`, `import './src.mjs';\nimport test from 'node:test';\ntest('${name} refuses broken input', () => {});\n`);
  }
  put('scripts/shared.test.mjs', "import test from 'node:test';\ntest('shared fixture', () => {});\n");
  git('add', '.'); git('commit', '-qm', 'base', '--trailer', 'Agent: human');
  const base = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/claude/integration', base);
  const unit = (name, change, start = base) => { git('checkout', '-qb', name, start); change(put); git('add', '.'); git('commit', '-qm', name, '--trailer', 'Agent: human'); const head = git('rev-parse', 'HEAD'); git('checkout', '-q', 'main'); return { name, head, note: 'Light checks passed; reviewed.', session: `author-${name}` }; };
  return { root, git, put, base, unit };
}

// Scripted cross-family receipts exist only inside this disposable fixture.
function bindFixtureReview(f, unit) {
  unit.authorFamily = 'openai'; unit.review = `.gate/reviews/${unit.name}.binding.json`;
  const headers = { verdict: 'ACCEPT', family: 'anthropic', session: 'fixture-reviewer', reviewedSha: unit.head,
    base: f.base, patchId: ownPatchId(f.root, f.base, unit.head) };
  const bytes = JSON.stringify(headers) + '\n', path = `.gate/reviews/${unit.name}.receipt.json`; f.put(path, bytes);
  f.put(unit.review, { version: 1, unit: unit.name, authorSession: unit.session, authorFamily: unit.authorFamily,
    review: { ...headers, artifact: { path, sha256: createHash('sha256').update(bytes).digest('hex') } } });
}

const families = journeys => [{ id: 1, name: 'Work', journeys }];
test('journeys union keeps every field, merges nested additions and is independent of unit order', () => {
  const proofFile = 'packages/surfaces/app/e2e/work.electron.spec.ts';
  const base = families([{ id: 'a', provingTest: { file: proofFile } }]);
  const one = families([{ id: 'a', provingTest: { file: proofFile, name: 'works', suite: 'app-e2e', level: 'installed' }, requiresInstalled: true }, { id: 'c', sentence: 'C' }]);
  const two = families([{ id: 'a', provingTest: { file: proofFile } }, { id: 'b', sentence: 'B' }]);
  const result = unionJourneys(base, [one, two]);
  assert.deepEqual(result, unionJourneys(base, [two, one]));
  assert.equal(result[0].journeys.length, 3);
  assert.deepEqual(result[0].journeys[0], { id: 'a', provingTest: { file: proofFile, name: 'works', suite: 'app-e2e', level: 'installed' }, requiresInstalled: true });
  assert.throws(() => unionJourneys(base, [one, families([{ id: 'a', requiresInstalled: false }])]), error => Array.isArray(error.judgement));
  assert.throws(() => unionJourneys([], [families([{ id: 'a' }, { id: 'a' }])]), /duplicate/i);
});

test('journeys three-way merge permits one scalar update and field deletion but refuses competing edits', () => {
  const base = families([{ id: 'a', sentence: 'Before', extra: { kept: true } }]);
  const next = families([{ id: 'a', sentence: 'After' }]);
  const merged = unionJourneys(base, [next, base]);
  assert.equal(merged[0].journeys[0].sentence, 'After');
  assert.equal(Object.hasOwn(merged[0].journeys[0], 'extra'), false);
  assert.throws(() => unionJourneys(base, [next, families([{ id: 'a', sentence: 'Different' }])]), /conflict/i);
});

test('merger accepts independent files and returns exact code conflicts without changing the author checkout', t => {
  const f = fixture(t);
  const a = f.unit('a', put => put('packages/a/src.mjs', 'a\n'));
  const b = f.unit('b', put => put('packages/b/src.mjs', 'b\n'));
  const clash = f.unit('clash', put => put('packages/a/src.mjs', 'clash\n'));
  const first = mergeUnit(f.root, f.base, a);
  const second = mergeUnit(f.root, first.head, b);
  assert.ok(second.head);
  assert.equal(f.git('show', `${second.head}:packages/a/src.mjs`), 'a');
  assert.equal(f.git('show', `${second.head}:packages/b/src.mjs`), 'b');
  const rejected = mergeUnit(f.root, second.head, clash);
  assert.deepEqual(rejected.conflicts, ['packages/a/src.mjs']);
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('merger unions conflicting journey additions and preserves authored manifest fields', t => {
  const f = fixture(t);
  const a = f.unit('a', put => { put('docs/journeys.json', families([{ id: 'base', sentence: 'Base' }, { id: 'a', requiresInstalled: true, provingTest: { file: 'packages/surfaces/app/e2e/work.electron.spec.ts', suite: 'app-e2e', name: 'works', level: 'installed' } }])); put('packages/a/backbone.module.json', { id: 'a', digest: 'a', capabilities: ['a'] }); });
  const b = f.unit('b', put => put('docs/journeys.json', families([{ id: 'base', sentence: 'Base' }, { id: 'b', provingTest: { name: 'B' } }])));
  const merged = mergeUnit(f.root, mergeUnit(f.root, f.base, a).head, b);
  assert.ok(merged.head);
  const doc = JSON.parse(f.git('show', `${merged.head}:docs/journeys.json`));
  assert.deepEqual(new Set(doc[0].journeys.map(j => j.id)), new Set(['base', 'a', 'b']));
  assert.equal(doc[0].journeys.find(j => j.id === 'a').requiresInstalled, true);
});

// The owner replaced package-wide suspicion with failing-file and driven-code mappings.
test('attribution uses the failing file and its driven code and refuses suite-only blame', t => {
  const f = fixture(t);
  const a = { name: 'a', files: ['packages/a/src.mjs'] }, b = { name: 'b', files: ['packages/b/src.mjs'] };
  const failure = { files: ['packages/a/test.test.mjs'] };
  assert.deepEqual(attributeFailure(f.root, failure, [a, b]).units, ['a']);
  f.put('packages/a/src.mjs', "import '../b/src.mjs';\n");
  assert.deepEqual(attributeFailure(f.root, failure, [a, b]).units, ['a', 'b']);
  assert.deepEqual(attributeFailure(f.root, 'unknown', [a, b]).units, []);
  assert.deepEqual(attributeFailure(f.root, failure, [a, { name: 'lock', files: ['pnpm-lock.yaml'] }]).units, ['a']);
});

test('queue validates immutable heads and author notes before any operation', () => {
  assert.throws(() => validateQueue({ units: [{ name: 'a', head: 'HEAD', note: 'ready' }] }), /head/i);
  assert.throws(() => validateQueue({ units: [{ name: '-a', head: 'a'.repeat(40), note: 'ready' }] }), /name/i);
  assert.throws(() => validateQueue({ units: [{ name: 'a', head: 'a'.repeat(40), note: '' }] }), /note/i);
  assert.throws(() => validateQueue({ units: Array(2).fill({ name: 'a', head: 'a'.repeat(40), note: 'ready', session: 'author-a' }) }), /duplicate/i);
  assert.throws(() => validateQueue({ units: [{ name: 'a', head: 'a'.repeat(40), note: 'ready' }] }), /session/i);
});

test('record is generated from a completed summary and retains unknown counts honestly', () => {
  const head = 'a'.repeat(40);
  const line = integrationLine(`commit ${head}\n== a: pnpm test :: completed :: exit 0 :: 12 passed, 0 failed :: 1s\n== b: pnpm test :: completed :: exit 0 :: unknown passed, unknown failed :: 1s\noverall: passed\n`, [{ name: 'unit', head: 'b'.repeat(40) }], head);
  assert.ok(line.includes(head)); assert.ok(line.includes('12 passed')); assert.ok(line.includes('unknown passed'));
  assert.throws(() => integrationLine(`commit ${head}\noverall: running\n`, [], head), /passed/i);
  assert.throws(() => integrationLine(`commit ${head}\noverall: passed\n`, [], 'b'.repeat(40)), /commit/i);
});

function harness(f, outcomes = []) {
  const calls = [], events = [], published = [], notifications = [];
  let remote = f.base, latest = {}, leaseDepth = 0;
  const harness = { calls, events, published, notifications, options: {
    qualifiedHead: f.base, // The disposable integrator explicitly attests this fixture base.
    expectedSuites: ['a', 'b'], // The fake gate implements exactly these package suites.
    runtime: { nativeCollector: ['fake-native', 'collector'], restoredNative: ['fake-native', 'restored'], colimaRoot: join(f.root, '.gate/colima') },
    inspect: (root, branches) => ({ head: remote, rows: branches.map(branch => ({ branch, sha: f.git('rev-parse', branch), stale: false, regen: [], conflicts: [] })) }),
    remoteHead: () => remote,
    freeBytes: () => 30 * 1024 ** 3,
    load: () => [0, 0, 0],
    preflight: async (root, options) => {
      const freeBytes = (options.freeBytes || (() => 30 * 1024 ** 3))(root), environment = { freeBytes, load: [0, 0, 0] };
      events.push({ phase: 'preflight', ...environment });
      if (freeBytes < 20 * 1024 ** 3) { const error = new Error('Merge queue requires at least 20 GiB free'); error.environment = environment; throw error; }
      return environment;
    },
    observe: root => { const environment = { freeBytes: harness.options.freeBytes(root), load: [0, 0, 0] }; events.push({ phase: 'observe df/load', ...environment }); return environment; },
    withLease: async callback => {
      leaseDepth++;
      try { return await callback({ env: { BACKBONE_HEAVY_LEASE: 'fixture-owned-slot-A' }, assertValid() { assert.equal(leaseDepth, 1); } }); }
      finally { leaseDepth--; }
    },
    notify: async envelope => { notifications.push(envelope); events.push({ phase: 'notify', session: envelope.authorSession }); },
    command: async (cwd, command, args, context = {}) => {
      calls.push([command, ...args]); events.push({ cwd, command, args, phase: context.phase, env: context.env });
      if (context.phase === 'gate' || context.phase === 'isolated retry' || ['native collector', 'restored native', 'Docker smoke', 'CLI install', 'pre-gate CLI install'].includes(context.phase)) {
        assert.equal(leaseDepth, 1); assert.equal(context.env.BACKBONE_HEAVY_LEASE, 'fixture-owned-slot-A');
      }
      const output = (code, text = '') => { if (context.log) { mkdirSync(join(context.log, '..'), { recursive: true }); writeFileSync(context.log, text); } return { code, output: text }; };
      if (context.phase === 'isolated retry') return output(latest.isolatedExit ?? 1, latest.isolatedOutput || (latest.isolatedExit === 0 ? '# pass 1\n# fail 0\n' : '# pass 0\n# fail 1\n'));
      if (command !== 'pnpm' || args[0] !== 'gate') return output(0);
      assert.equal(args.includes('--only'), false, 'diagnostic retries name one test file, never an entire suite');
      const out = args[args.indexOf('--out') + 1]; mkdirSync(out, { recursive: true });
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
      const outcome = outcomes.shift() || { failed: [] }; latest = outcome;
      const suites = ['a', 'b'].map(name => ({ name, status: 'completed', exitCode: outcome.failed?.includes(name) ? 1 : 0, passed: 1, failed: outcome.failed?.includes(name) ? 1 : 0 }));
      for (const suite of suites) {
        const file = outcome.file || (outcome.unassigned ? 'scripts/shared.test.mjs' : `packages/${suite.name}/test.test.mjs`);
        const title = outcome.test || (outcome.unassigned ? 'shared fixture' : `${suite.name} refuses broken input`);
        const text = suite.exitCode ? `not ok 1 - ${title}\n  at ${file}:1\n${outcome.causeText || ''}\n` : 'ok 1 - works\n';
        writeFileSync(join(out, `${suite.name}.log`), text);
      }
      const overall = suites.every(suite => suite.exitCode === 0) ? 'passed' : 'failed';
      writeFileSync(join(out, 'gate.json'), JSON.stringify({ kind: 'gate', dirty: false, commit, end: 'done', overall, suites }));
      writeFileSync(join(out, 'gate-summary.txt'), `commit ${commit}\n${suites.map(suite => `== ${suite.name}: fake :: completed :: exit ${suite.exitCode} :: ${suite.passed} passed, ${suite.failed} failed :: 1s`).join('\n')}\noverall: ${overall}\n`);
      return output(overall === 'passed' ? 0 : 1);
    },
    publish: async value => { published.push(value); events.push({ phase: 'publish', head: value.head }); remote = value.head; return { status: 'published' }; },
  } };
  return harness;
}

test('dry run prints the plan without commits, checkout changes, gate or publication', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n')), h = harness(f);
  const refs = f.git('show-ref');
  const result = await runQueue(f.root, { units: [a] }, { ...h.options, dryRun: true });
  assert.equal(result.status, 'planned'); assert.equal(result.units[0].head, a.head);
  assert.equal(f.git('show-ref'), refs); assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(h.calls.length, 0); assert.equal(h.published.length, 0);
});

test('queue gates a candidate, commits only its record after qualification and publishes once', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n')), h = harness(f);
  const result = await runQueue(f.root, { units: [a] }, h.options);
  assert.equal(result.status, 'published'); assert.equal(h.published.length, 1);
  assert.equal(f.git('rev-parse', `${result.head}^`), result.gateHead);
  assert.equal(f.git('diff', '--name-only', result.gateHead, result.head), 'docs/execution.md');
  assert.match(f.git('show', '-s', '--format=%B', result.head), /Agent: merge-queue$/);
  assert.equal(f.git('for-each-ref', '--format=%(refname)', 'refs/heads/merge-queue/'), '');
  const recordCheck = h.events.find(event => event.phase === 'record static checks');
  assert.equal(recordCheck.env.BACKBONE_GUIDE_STEP, '1');
  assert.ok(f.git('show', `${result.head}:docs/execution.md`).includes(result.gateHead));
  assert.deepEqual(result.successes.map(success => success.units), [['a']]);
  assert.equal(h.notifications.length, 0);
  const phases = h.events.filter(event => event.command || event.phase === 'publish').map(event => event.phase);
  assert.deepEqual(phases, ['install', 'prune', 'regenerate', 'static checks', 'gate', 'restore oracle results', 'native collector', 'restored native', 'Colima start', 'Docker smoke', 'Colima stop', 'Colima delete', 'CLI install', 'restore oracle results', 'record static checks', 'publish']);
  assert.equal(h.events.find(event => event.phase === 'static checks').env.BACKBONE_GUIDE_STEP, '1');
  assert.ok(h.published[0].stackBranch.startsWith('claude/queue-stack-'));
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  assert.equal(f.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
});

// Serial selection replaces batch removal/bisection; independent units still get their own gate.
test('a mapped failing unit returns to its author while the next serial unit qualifies independently', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n')), b = f.unit('b', put => put('packages/b/src.mjs', 'b\n'));
  const h = harness(f, [{ failed: ['a'] }, { failed: [] }]);
  const result = await runQueue(f.root, { units: [a, b] }, h.options);
  assert.equal(result.status, 'published'); assert.deepEqual(result.successes.map(success => success.units), [['b']]);
  assert.equal(result.returned[0].name, 'a'); assert.equal(result.returned[0].authorSession, a.session);
  assert.ok(result.returned[0].test.includes('refuses broken input')); assert.ok(existsSync(result.returned[0].log));
  assert.equal(result.returned[0].causeClass, 'product defect'); assert.ok(Object.hasOwn(result.returned[0], 'reviewedSha')); assert.ok(result.returned[0].testedSha);
  assert.deepEqual(result.returned[0].mapping.units, ['a']); assert.equal(h.notifications[0].deliveredTo, a.session);
  assert.equal(f.git('show', `${result.head}:packages/a/src.mjs`), 'base');
  assert.equal(h.calls.filter(call => call[1] === 'gate').length, 2);
});

// The owner permits retries only for a positive flake/environment classification.
test('an unmapped unknown product failure gets no automatic retry and no arbitrary unit drop', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n')), b = f.unit('b', put => put('packages/b/src.mjs', 'b\n'));
  const h = harness(f, [{ failed: ['a'], unassigned: true, causeText: 'AssertionError: wrong result' }]);
  const result = await runQueue(f.root, { units: [a, b] }, h.options);
  assert.equal(result.status, 'needs-review'); assert.equal(result.returned.length, 0); assert.equal(h.published.length, 0);
  assert.equal(h.calls.filter(call => call[1] === 'gate').length, 1); assert.equal(h.events.filter(event => event.phase === 'isolated retry').length, 0);
  assert.deepEqual(result.deferred.map(unit => unit.name), ['a', 'b']);
  assert.equal(h.notifications.length, 1); assert.equal(h.notifications[0].causeClass, 'product defect'); assert.equal(h.notifications[0].authorSession, a.session);
  assert.deepEqual(h.notifications[0].mapping.units, []);
});

test('low disk, moved unit heads and stale remote prevent gate and publication', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n')), h = harness(f);
  await assert.rejects(runQueue(f.root, { units: [a] }, { ...h.options, freeBytes: () => 19 * 1024 ** 3 }), /20 GiB/);
  assert.equal(h.notifications[0].authorSession, a.session); assert.equal(h.notifications[0].causeClass, 'environment');
  await assert.rejects(runQueue(f.root, { units: [{ ...a, head: f.base }] }, h.options), /head/i);
  await assert.rejects(runQueue(f.root, { units: [a] }, { ...h.options, remoteHead: () => 'f'.repeat(40) }), /integration.*moved/i);
  assert.equal(h.calls.length, 0); assert.equal(h.published.length, 0);
});

test('digest-only manifest conflicts are regenerated while authored declaration conflicts return to the author', t => {
  const f = fixture(t);
  f.put('packages/a/backbone.module.json', { id: 'a', digest: 'base', capabilities: ['base'] });
  f.git('add', '.'); f.git('commit', '-qm', 'manifest', '--trailer', 'Agent: human');
  const base = f.git('rev-parse', 'HEAD');
  const branch = (name, manifest) => {
    f.git('checkout', '-qb', name, base); f.put('packages/a/backbone.module.json', manifest); f.git('commit', '-qam', name, '--trailer', 'Agent: human');
    const head = f.git('rev-parse', 'HEAD'); f.git('checkout', '-q', 'main'); return { name, head };
  };
  const a = branch('a', { id: 'a', digest: 'a', capabilities: ['base'] });
  const b = branch('b', { id: 'a', digest: 'b', capabilities: ['base'] });
  const authored = branch('authored', { id: 'different', digest: 'different', capabilities: ['other'] });
  const first = mergeUnit(f.root, base, a);
  assert.ok(mergeUnit(f.root, first.head, b).head);
  assert.deepEqual(mergeUnit(f.root, first.head, authored).conflicts, ['packages/a/backbone.module.json']);
});

// The single diagnostic retry consumes the budget; fresh full qualification is a new run.
test('an isolated retry pass consumes its budget and cannot publish without fresh full qualification', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n'));
  const h = harness(f, [{ failed: ['a'], unassigned: true, causeText: 'classification: flake', isolatedExit: 0 }]);
  const result = await runQueue(f.root, { units: [a] }, h.options);
  assert.equal(result.status, 'needs-review'); assert.equal(result.returned.length, 0); assert.equal(h.published.length, 0);
  const gates = h.events.filter(event => event.phase === 'gate'), isolated = h.events.filter(event => event.phase === 'isolated retry');
  assert.equal(gates.length, 1); assert.equal(isolated.length, 1);
  assert.ok(isolated[0].args.includes('scripts/shared.test.mjs')); assert.ok(isolated[0].args.includes('shared fixture'));
  assert.equal(isolated[0].args.includes('--only'), false);
  assert.equal(h.notifications[0].causeClass, 'test-state/flake'); assert.equal(h.notifications[0].isolated.exitCode, 0);
  assert.equal(h.notifications[0].isolated.passed, 1); assert.equal(h.notifications[0].isolated.failed, 0);
  assert.ok(h.notifications[0].reason.includes('fresh complete gate'));
});

test('incomplete gate evidence and a modified candidate cannot publish', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n'));
  for (const kind of ['missing-suite', 'dirty-candidate']) {
    const h = harness(f), original = h.options.command;
    h.options.command = async (cwd, command, args) => {
      const result = await original(cwd, command, args);
      if (args[0] === 'gate') {
        if (kind === 'dirty-candidate') writeFileSync(join(cwd, 'packages/a/src.mjs'), 'changed after tests\n');
        else {
          const file = join(args[args.indexOf('--out') + 1], 'gate.json'), record = JSON.parse(readFileSync(file));
          record.suites.pop(); writeFileSync(file, JSON.stringify(record));
        }
      }
      return result;
    };
    await assert.rejects(runQueue(f.root, { units: [a] }, h.options), /evidence|changed during gate/i);
    assert.equal(h.published.length, 0);
  }
});

test('conflicting units return paths while independent serial units still land', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n')), clash = f.unit('clash', put => put('packages/a/src.mjs', 'clash\n')), b = f.unit('b', put => put('packages/b/src.mjs', 'b\n'));
  const h = harness(f), result = await runQueue(f.root, { units: [a, clash, b] }, h.options);
  assert.equal(result.status, 'published'); assert.deepEqual(result.successes.map(success => success.units), [['a'], ['b']]);
  assert.equal(h.published.length, 2); assert.deepEqual(result.returned.find(unit => unit.name === 'clash').conflicts, ['packages/a/src.mjs']);
  assert.equal(result.returned.find(unit => unit.name === 'clash').authorSession, clash.session);
  assert.equal(f.git('show', `${result.head}:packages/a/src.mjs`), 'a'); assert.equal(f.git('show', `${result.head}:packages/b/src.mjs`), 'b');
});

test('record append preserves existing integration entries as separate lines', async t => {
  const f = fixture(t), a = f.unit('a', put => put('docs/execution.md', '# Execution\n\n## Integration record\n\n- Older gate.\n'));
  const h = harness(f), result = await runQueue(f.root, { units: [a] }, h.options);
  const text = f.git('show', `${result.head}:docs/execution.md`);
  assert.ok(text.includes('\n- Older gate.')); assert.equal(text.split('\n').filter(line => line.startsWith('- ')).length, 2);
  assert.ok(text.indexOf('- Older gate.') < text.indexOf(`- Gate ${result.gateHead}`));
});

test('journey objects cannot be replaced with null or arrays and lose their fields', () => {
  const base = families([{ id: 'a', provingTest: { file: 'test.mjs', name: 'works' } }]);
  for (const provingTest of [null, []]) assert.throws(() => unionJourneys(base, [families([{ id: 'a', provingTest }])]), /conflict/i);
});

test('publication uses a fast-forward remote lease, delegates guarded synchronization and verifies an uncertain command', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n'));
  f.git('branch', 'claude/integration', f.base);
  const out = join(f.root, '.gate/publish'); mkdirSync(out, { recursive: true });
  const calls = [], synchronizations = []; let reads = 0;
  const result = await publishCandidate({ root: f.root, base: f.base, head: a.head, out, stackBranch: 'claude/test-stack' }, {
    remoteHead: () => ++reads === 1 ? f.base : a.head,
    command: async (root, command, args) => { calls.push({ root, command, args }); return { code: 1, output: 'connection lost' }; },
    syncIntegration: async value => { synchronizations.push(value); return { head: value.head, stackBranch: value.stackBranch }; },
  });
  assert.equal(result.status, 'published'); assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes(`--force-with-lease=refs/heads/claude/integration:${f.base}`));
  assert.equal(f.git('rev-parse', 'claude/integration'), f.base);
  assert.equal(synchronizations.length, 1); assert.equal(synchronizations[0].repository, f.root); assert.equal(synchronizations[0].head, a.head); assert.equal(synchronizations[0].stackBranch, 'claude/test-stack');
  assert.equal(JSON.parse(readFileSync(join(out, 'publication.json'))).observed, a.head);
  assert.equal(existsSync(join(f.root, '.git/merge-queue-pending.json')), false);
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
});

test('unknown publication keeps an intent receipt and refuses a blind resend', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n'));
  const out = join(f.root, '.gate/publish'); mkdirSync(out, { recursive: true });
  let reads = 0, pushes = 0;
  const options = {
    remoteHead: () => { if (++reads === 1) return f.base; throw new Error('remote unavailable'); },
    command: async () => { pushes++; throw new Error('connection lost'); },
  };
  const value = { root: f.root, base: f.base, head: a.head, out };
  assert.equal((await publishCandidate(value, options)).status, 'needs-review');
  assert.equal(JSON.parse(readFileSync(join(f.root, '.git/merge-queue-pending.json'))).head, a.head);
  await assert.rejects(publishCandidate(value, options), /reconciliation/i);
  assert.equal(pushes, 1);
});

test('real bare remote accepts the leased fast-forward and rejects a racing push without pending intent', async t => {
  const f = fixture(t), origin = join(f.root, '.gate/origin.git'); mkdirSync(join(f.root, '.gate'));
  f.git('init', '--bare', origin); f.git('remote', 'add', 'origin', origin);
  f.git('push', 'origin', `${f.base}:refs/heads/claude/integration`);
  const a = f.unit('publish-a', put => put('packages/a/src.mjs', 'candidate-a\n'));
  const out = join(f.root, '.gate/publication'); mkdirSync(out);
  const syncIntegration = async value => ({ head: value.head });
  assert.equal((await publishCandidate({ root: f.root, base: f.base, head: a.head, out }, { syncIntegration })).status, 'published');
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/claude/integration').split(/\s+/)[0], a.head);

  f.git('checkout', '-qb', 'publish-b', a.head); f.put('packages/b/src.mjs', 'candidate-b\n');
  f.git('commit', '-qam', 'candidate-b', '--trailer', 'Agent: human'); const b = f.git('rev-parse', 'HEAD');
  f.git('checkout', '-qb', 'racer', a.head); f.put('racing', 'other integrator\n');
  f.git('add', 'racing'); f.git('commit', '-qm', 'race', '--trailer', 'Agent: human'); const racer = f.git('rev-parse', 'HEAD');
  f.git('checkout', '-q', 'main');
  let pushes = 0;
  const result = await publishCandidate({ root: f.root, base: a.head, head: b, out }, {
    syncIntegration: async () => assert.fail('a rejected push must not synchronize'),
    command: async (cwd, command, args) => {
      pushes++; f.git('push', 'origin', `${racer}:refs/heads/claude/integration`);
      return runCommand(cwd, command, args);
    },
  });
  assert.equal(result.status, 'remote-moved'); assert.equal(result.observed, racer); assert.equal(pushes, 1);
  assert.equal(existsSync(join(f.root, '.git/merge-queue-pending.json')), false);
  assert.equal(JSON.parse(readFileSync(join(out, 'publication.json'))).phase, 'rejected-not-published');
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/claude/integration').split(/\s+/)[0], racer);
  // Rebuilding at the new remote head needs no manual receipt deletion.
  f.git('checkout', '-qb', 'after-race', racer); f.put('rebuilt', 'qualified again\n');
  f.git('add', 'rebuilt'); f.git('commit', '-qm', 'rebuilt', '--trailer', 'Agent: human'); const rebuilt = f.git('rev-parse', 'HEAD');
  f.git('checkout', '-q', 'main');
  assert.equal((await publishCandidate({ root: f.root, base: racer, head: rebuilt, out }, { syncIntegration })).status, 'published');
});

test('a rejected record static check prevents publication of the post-gate record commit', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n')), h = harness(f);
  const command = h.options.command;
  h.options.command = async (cwd, executable, args, context) => context.phase === 'record static checks'
    ? { code: 1, output: 'record violates documentation rules' } : command(cwd, executable, args, context);
  await assert.rejects(runQueue(f.root, { units: [a] }, h.options), /record static checks/i);
  assert.equal(h.published.length, 0);
});

test('regeneration refuses unrelated created files and authored edits rather than staging them', async t => {
  for (const file of ['unexpected.txt', 'packages/a/src.mjs']) {
    const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n')), h = harness(f);
    const command = h.options.command;
    h.options.command = async (cwd, executable, args, context) => {
      if (context.phase === 'regenerate') writeFileSync(join(cwd, file), 'unreviewed generated output\n');
      return command(cwd, executable, args, context);
    };
    await assert.rejects(runQueue(f.root, { units: [a] }, h.options), /unexpected.*(?:output|path)|unintended/i);
    assert.equal(h.published.length, 0);
    const out = h.events.find(event => event.phase === 'regenerate').cwd.split('/candidate-')[0];
    const failure = JSON.parse(readFileSync(join(out, 'queue.json')));
    assert.ok(failure.failedTree.ref); assert.equal(f.git('show', `${failure.failedTree.ref}:packages/a/src.mjs`), 'a');
    assert.ok(failure.failedTree.status.includes(file));
    assert.ok(existsSync(failure.failedTree.patch));
  }
});

test('failed Git snapshot preserves the original failure, saved state and author notice', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n')), h = harness(f);
  h.options.failureSnapshot = () => { throw new Error('git diff failed: snapshot unavailable'); };
  const command = h.options.command;
  h.options.command = async (cwd, executable, args, context) => {
    const result = await command(cwd, executable, args, context);
    return context.phase === 'install' ? { code: 1, output: 'ENOSPC: original install failure' } : result;
  };
  await assert.rejects(runQueue(f.root, { units: [a] }, h.options), /install failed/);
  const out = h.events.find(event => event.phase === 'install').cwd.split('/candidate-')[0];
  const saved = JSON.parse(readFileSync(join(out, 'queue.json')));
  assert.equal(saved.status, 'failed'); assert.match(saved.reason, /install failed/);
  assert.match(saved.failedTree.error, /snapshot unavailable/);
  assert.equal(h.notifications.length, 1); assert.equal(h.notifications[0].authorSession, a.session);
  assert.equal(h.notifications[0].causeClass, 'environment');
});

test('known lease rejection remains remote-moved in the queue result without a reconciliation receipt', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n')), h = harness(f);
  h.options.publish = async () => ({ status: 'remote-moved', reason: 'Lease rejected; nothing published' });
  const result = await runQueue(f.root, { units: [a] }, h.options);
  assert.equal(result.status, 'remote-moved'); assert.equal(result.successes.length, 0);
  assert.deepEqual(result.deferred.map(unit => unit.name), [a.name]);
  assert.equal(existsSync(join(f.root, '.git/merge-queue-pending.json')), false);
});

test('moved remotes and non-fast-forward candidates never reach push', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n'));
  const out = join(f.root, '.gate/publish'); mkdirSync(out, { recursive: true }); let pushes = 0;
  const options = { remoteHead: () => f.base, command: async () => { pushes++; return { code: 0 }; } };
  assert.equal((await publishCandidate({ root: f.root, base: f.base, head: a.head, out }, { ...options, remoteHead: () => a.head })).status, 'remote-moved');
  await assert.rejects(publishCandidate({ root: f.root, base: a.head, head: f.base, out }, { ...options, remoteHead: () => a.head }), /merge-base/);
  assert.equal(pushes, 0);
});

test('the integration ancestor guard runs before any leased push that could rewrite a real remote', async t => {
  const f = fixture(t), origin = join(f.root, '.gate/ancestor-origin.git'); mkdirSync(join(f.root, '.gate'));
  f.git('init', '--bare', origin); f.git('remote', 'add', 'origin', origin);
  const current = f.unit('remote-code', put => put('packages/a/src.mjs', 'already integrated\n'));
  f.git('push', 'origin', `${current.head}:refs/heads/claude/integration`);
  const out = join(f.root, '.gate/ancestor-publication'); mkdirSync(out);
  let pushes = 0;
  await assert.rejects(publishCandidate({ root: f.root, base: current.head, head: f.base, out }, {
    command: async () => { pushes++; assert.fail('ancestor refusal must precede push'); },
  }), /merge-base/);
  assert.equal(pushes, 0); assert.equal(existsSync(join(f.root, '.git/merge-queue-pending.json')), false);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/claude/integration').split(/\s+/)[0], current.head);
});

for (const late of [false, true]) test(`a real bare remote docs tail is replayed after the gated code without losing fast-forward ancestry${late ? ' with a late docs writer' : ''}`, async t => {
  const f = fixture(t), origin = join(f.root, '.gate/docs-origin.git'); mkdirSync(join(f.root, '.gate'));
  f.git('init', '--bare', origin); f.git('remote', 'add', 'origin', origin);
  f.put('docs/tail.md', 'Integrator prose\n'); f.put('GOAL.md', 'Human goal\n'); f.git('add', '.');
  f.git('commit', '-qm', 'human docs', '--trailer', 'Agent: human');
  f.put('docs/execution.md', '# Execution\n\n## Now\nHuman status\n\n## Integration record\nExisting record\n');
  f.git('commit', '-qam', 'integration record', '--trailer', 'Agent: human'); const docsHead = f.git('rev-parse', 'HEAD');
  f.git('push', 'origin', `${docsHead}:refs/heads/claude/integration`); f.git('update-ref', 'refs/remotes/origin/claude/integration', docsHead);
  f.git('branch', 'human-doc-tip', docsHead); f.git('config', 'rebase.updateRefs', 'true');
  const a = f.unit('unit-on-docs', put => put('packages/a/src.mjs', 'new gated code\n'), docsHead);
  const local = join(f.root, '.gate/integration'); f.git('worktree', 'add', '-qb', 'claude/integration', local, docsHead);
  const h = harness(f), command = h.options.command;
  delete h.options.remoteHead; delete h.options.publish; h.options.runtime.integrationWorktree = local;
  let pushes = 0, leaseHead = docsHead;
  h.options.command = async (cwd, executable, args, context = {}) => {
    if (context.phase === 'gate') {
      assert.equal(existsSync(join(cwd, 'docs/tail.md')), false, 'gate starts from the qualified code head');
      assert.equal(readFileSync(join(cwd, 'packages/a/src.mjs'), 'utf8'), 'new gated code\n');
      if (late) {
        const writer = join(f.root, '.gate/docs-writer'); f.git('clone', '--no-checkout', origin, writer);
        const writerGit = (...argv) => execFileSync('git', argv, { cwd: writer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        for (const [key, value] of Object.entries({ 'user.name': 'Writer', 'user.email': 'writer@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': '/dev/null' })) writerGit('config', key, value);
        writerGit('checkout', '-qb', 'docs-writer', docsHead);
        writeFileSync(join(writer, 'docs/late.md'), 'Arrived during the gate\n');
        writerGit('add', 'docs/late.md'); writerGit('commit', '-qm', 'late docs', '--trailer', 'Agent: human');
        leaseHead = writerGit('rev-parse', 'HEAD'); writerGit('push', 'origin', 'HEAD:refs/heads/claude/integration');
      }
    }
    if (executable === 'git' && args[0] === 'fetch') return runCommand(cwd, executable, args, context);
    if (executable === 'git' && args[0] === 'push') {
      pushes++;
      const head = args.at(-1).split(':')[0]; f.git('merge-base', '--is-ancestor', leaseHead, head);
      assert.ok(args.includes(`--force-with-lease=refs/heads/claude/integration:${leaseHead}`));
      return runCommand(cwd, executable, args, context);
    }
    return command(cwd, executable, args, context);
  };
  const result = await runQueue(f.root, { qualifiedHead: f.base, units: [a] }, h.options);
  assert.equal(result.status, 'published'); assert.equal(pushes, 1); assert.equal(result.base, f.base);
  assert.equal(result.docsTail.remoteBase, leaseHead); assert.equal(result.docsTail.commits.length, late ? 3 : 2);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/claude/integration').split(/\s+/)[0], result.head);
  assert.equal(f.git('rev-parse', 'claude/integration'), result.head);
  assert.equal(f.git('rev-parse', 'human-doc-tip'), docsHead);
  assert.equal(f.git('show', `${result.head}:docs/tail.md`), 'Integrator prose');
  assert.equal(f.git('show', `${result.head}:GOAL.md`), 'Human goal');
  if (late) assert.equal(f.git('show', `${result.head}:docs/late.md`), 'Arrived during the gate');
  assert.match(f.git('show', `${result.head}:docs/execution.md`), /Human status[\s\S]*Existing record[\s\S]*unit-on-docs/);
  assert.equal(f.git('show', `${result.head}:packages/a/src.mjs`), 'new gated code');
  assert.equal(f.git('rev-parse', `${result.docsTail.head}^1`), leaseHead);
  assert.equal(f.git('rev-parse', `${result.docsTail.head}^2`), result.gateHead);
  assert.equal(f.git('log', '--format=%s', '--grep=^human docs$', result.head).split('\n').length, 1);
  const receipt = JSON.parse(readFileSync(join(result.publicationAttempts.at(-1).out, 'publication.json')));
  assert.equal(receipt.testedSha, result.gateHead); assert.equal(receipt.head, result.head);
  assert.equal(receipt.codeUnchanged, true);
  f.git('merge-base', '--is-ancestor', result.gateHead, result.head);
  assert.deepEqual(result.units[0].files, ['packages/a/src.mjs']);
  assert.equal(f.git('diff', '--name-only', result.gateHead, result.head, '--', 'packages', 'scripts'), '');
});

test('docs replay with no new code preserves an already-ancestral remote without manufacturing a merge', t => {
  const f = fixture(t); f.put('docs/tail.md', 'Human text\n'); f.git('add', '.');
  f.git('commit', '-qm', 'docs', '--trailer', 'Agent: human'); const remote = f.git('rev-parse', 'HEAD');
  f.git('checkout', '--detach', f.base);
  const result = carryDocsTail(f.root, { qualifiedHead: f.base, remoteBase: remote, gatedHead: f.base });
  f.git('merge-base', '--is-ancestor', remote, result.head);
  assert.equal(f.git('rev-list', '--min-parents=2', `${f.base}..${result.head}`), '');
  assert.equal(f.git('show', `${result.head}:docs/tail.md`), 'Human text');
});

test('docs tail admission rejects non-Markdown docs, root files outside the allowlist and nonlinear history', t => {
  const f = fixture(t);
  for (const [index, file] of ['docs/claim.json', 'CONTRIBUTING.md', 'packages/a/README.md'].entries()) {
    const unit = f.unit(`bad-tail-${index}`, put => put(file, 'not an allowed tail\n'));
    assert.throws(() => inspectDocsTail(f.root, f.base, unit.head), /not docs-only/);
  }
  const one = f.unit('docs-one', put => put('docs/one.md', 'one\n'));
  const two = f.unit('docs-two', put => put('docs/two.md', 'two\n'));
  f.git('checkout', '-qb', 'docs-merge', one.head); f.git('merge', '--no-ff', '-m', 'nonlinear docs', two.head);
  const merge = f.git('rev-parse', 'HEAD'); f.git('checkout', '-q', 'main');
  assert.throws(() => inspectDocsTail(f.root, f.base, merge), /linear history/);
});

test('docs-only admission excludes executable or graded Markdown, executable modes and binary blobs', t => {
  const f = fixture(t);
  const cases = [
    ['docs/how-to/unsafe.md', '```bash test\nexit 1\n```\n'],
    ['docs/distributions.md', '```bash test\nexit 1\n```\n'],
    ['docs/architecture.md', '| I-999 | changed invariant |\n'],
    ['docs/binary.md', Buffer.from([0, 1, 2, 127, 255, 0])],
  ];
  for (const [index, [file, content]] of cases.entries()) {
    const unit = f.unit(`graded-doc-${index}`, put => put(file, content));
    assert.throws(() => inspectDocsTail(f.root, f.base, unit.head), /not docs-only/, file);
  }
  const executable = f.unit('executable-doc', put => { put('docs/executable.md', 'Text\n'); chmodSync(join(f.root, 'docs/executable.md'), 0o755); });
  assert.throws(() => inspectDocsTail(f.root, f.base, executable.head), /not docs-only/);
});

test('a conflicting docs replay returns without pushing or changing the gated tree', async t => {
  const f = fixture(t), a = f.unit('unit-docs', put => put('docs/tail.md', 'Unit text\n'));
  f.put('docs/tail.md', 'Integrator text\n'); f.git('add', '.'); f.git('commit', '-qm', 'docs tail', '--trailer', 'Agent: human');
  const remote = f.git('rev-parse', 'HEAD'); f.git('update-ref', 'refs/remotes/origin/claude/integration', remote);
  const h = harness(f); h.options.remoteHead = () => remote;
  await assert.rejects(runQueue(f.root, { qualifiedHead: f.base, units: [a] }, h.options), error =>
    error.code === 'DOCS_CARRY_REFUSED' && error.docsConflicts.includes('docs/tail.md'));
  assert.equal(h.published.length, 0);
  const out = h.events.find(event => event.phase === 'gate').args.at(-1), state = JSON.parse(readFileSync(join(out, '..', 'queue.json')));
  assert.equal(f.git('show', `${state.gateHead}:docs/tail.md`), 'Unit text');
  assert.equal(f.git('show', `${remote}:docs/tail.md`), 'Integrator text');
  assert.equal(h.notifications[0].authorSession, a.session);
});

test('the qualified head is explicit and a non-doc commit hidden by a later revert refuses before the gate', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n')), h = harness(f);
  await assert.rejects(runQueue(f.root, { units: [a] }, { ...h.options, qualifiedHead: undefined }), /qualifiedHead/);
  f.put('packages/b/src.mjs', 'ungated code\n'); f.git('commit', '-qam', 'ungated code', '--trailer', 'Agent: human');
  f.put('packages/b/src.mjs', 'base\n'); f.git('commit', '-qam', 'revert ungated code', '--trailer', 'Agent: human');
  const remote = f.git('rev-parse', 'HEAD'); f.git('update-ref', 'refs/remotes/origin/claude/integration', remote);
  await assert.rejects(runQueue(f.root, { qualifiedHead: f.base, units: [a] }, { ...h.options, remoteHead: () => remote }), /docs-only.*packages\/b\/src\.mjs/i);
  assert.equal(h.calls.length, 0);
});

for (const race of ['precheck', 'lease', 'budget', 'code']) test(`a real bare remote publication ${race} race reuses its one gate within a fixed docs budget`, async t => {
  const f = fixture(t), origin = join(f.root, '.gate/race-origin.git'); mkdirSync(join(f.root, '.gate'));
  f.git('init', '--bare', origin); f.git('remote', 'add', 'origin', origin);
  f.git('push', 'origin', `${f.base}:refs/heads/claude/integration`);
  const local = join(f.root, '.gate/race-integration'); f.git('worktree', 'add', '-qb', 'claude/integration', local, f.base);
  const a = f.unit('race-unit', put => put('packages/a/src.mjs', 'tested code\n')), h = harness(f), command = h.options.command;
  delete h.options.remoteHead; delete h.options.publish; h.options.runtime.integrationWorktree = local;
  let remote = f.base, writes = 0, pushes = 0, records = 0;
  const advance = () => {
    writes++; f.git('checkout', '-qb', `writer-${writes}`, remote);
    f.put(race === 'code' ? 'packages/b/src.mjs' : `docs/race-${writes}.md`, `Writer ${writes}\n`);
    f.git('add', '.'); f.git('commit', '-qm', `writer-${writes}`, '--trailer', 'Agent: human'); remote = f.git('rev-parse', 'HEAD');
    f.git('push', 'origin', 'HEAD:refs/heads/claude/integration'); f.git('checkout', '-q', 'main');
  };
  h.options.command = async (cwd, executable, args, context = {}) => {
    if (context.phase === 'record static checks') {
      records++;
      if (race === 'budget' || (['precheck', 'code'].includes(race) && writes === 0)) advance();
    }
    if (executable === 'git' && args[0] === 'push') {
      pushes++; if (race === 'lease' && writes === 0) advance();
      return runCommand(cwd, executable, args, context);
    }
    return command(cwd, executable, args, context);
  };
  const run = () => runQueue(f.root, { qualifiedHead: f.base, units: [a] }, h.options);
  if (race === 'code') {
    await assert.rejects(run(), /not docs-only/); assert.equal(pushes, 0);
  } else {
    const result = await run();
    assert.equal(result.status, race === 'budget' ? 'remote-moved' : 'published');
    assert.equal(result.publicationAttempts.length, race === 'budget' ? 3 : 2);
    assert.ok(result.publicationAttempts.every(attempt => attempt.testedSha === result.gateHead));
    if (race !== 'budget') {
      assert.equal(f.git('show', `${result.head}:docs/race-1.md`), 'Writer 1');
      assert.equal(f.git('show', `${result.head}:packages/a/src.mjs`), 'tested code');
      const record = f.git('show', `${result.head}:docs/execution.md`);
      assert.equal(record.split(`${a.name}@${a.head}`).length - 1, 1, 'discarded records never accumulate');
    }
  }
  assert.equal(h.calls.filter(call => call[1] === 'gate').length, 1);
  assert.equal(h.events.filter(event => event.phase === 'native collector').length, 1);
  assert.equal(records, race === 'budget' ? 3 : race === 'code' ? 1 : 2);
  assert.equal(existsSync(join(f.root, '.git/merge-queue-pending.json')), false);
});

test('unknown publication never enters the docs-race retry loop', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n')), h = harness(f); let calls = 0;
  h.options.publish = async () => { calls++; return { status: 'needs-review', reason: 'Publication unknown; reconcile' }; };
  const result = await runQueue(f.root, { units: [a] }, h.options);
  assert.equal(result.status, 'needs-review'); assert.equal(calls, 1);
  assert.equal(h.calls.filter(call => call[1] === 'gate').length, 1);
});

test('a publication receipt cannot attest code changed after the tested SHA', async t => {
  const f = fixture(t), a = f.unit('tested', put => put('packages/a/src.mjs', 'tested\n'));
  f.git('checkout', '-qb', 'ungated', a.head); f.put('packages/b/src.mjs', 'not tested\n');
  f.git('commit', '-qam', 'ungated', '--trailer', 'Agent: human'); const head = f.git('rev-parse', 'HEAD'); f.git('checkout', '-q', 'main');
  const out = join(f.root, '.gate/bad-binding'); mkdirSync(out, { recursive: true }); let pushes = 0;
  await assert.rejects(publishCandidate({ root: f.root, base: f.base, head, gateHead: a.head, qualifiedHead: f.base, out }, {
    remoteHead: () => f.base, command: async () => { pushes++; assert.fail('unverified code cannot be published'); },
  }), /not docs-only/);
  assert.equal(pushes, 0); assert.equal(existsSync(join(f.root, '.git/merge-queue-pending.json')), false);
});

test('core external fixtures are attributed only when the failing test actually drives them', t => {
  const f = fixture(t);
  f.put('packages/core/package.json', { name: '@backbone/core' }); f.put('packages/core/src.mjs', 'export const value = 1;\n');
  f.put('packages/core/test.test.mjs', "import './src.mjs';\nimport '../platform/test/fixtures/material-guard-legacy.json';\n");
  f.put('packages/platform/test/fixtures/material-guard-legacy.json', {});
  f.put('packages/platform/test/fixtures/unrelated.json', {});
  f.git('add', '.'); f.git('commit', '-qm', 'cross-package audit input', '--trailer', 'Agent: human');
  const result = attributeFailure(f.root, { files: ['packages/core/test.test.mjs'] }, [{ name: 'core', files: ['packages/core/src.mjs'] }, { name: 'fixture', files: ['packages/platform/test/fixtures/material-guard-legacy.json'] }, { name: 'unrelated', files: ['packages/platform/test/fixtures/unrelated.json'] }]);
  assert.deepEqual(result.units, ['core', 'fixture']); assert.equal(result.complete, true);
});

test('checkout changes during publication cannot advance an author branch', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n'));
  f.git('checkout', '-qb', 'claude/integration', f.base);
  const out = join(f.root, '.gate/publish'); mkdirSync(out, { recursive: true }); let reads = 0;
  const result = await publishCandidate({ root: f.root, base: f.base, head: a.head, out }, {
    remoteHead: () => ++reads === 1 ? f.base : a.head,
    command: async () => { f.git('checkout', '-q', 'main'); return { code: 0 }; },
    syncIntegration: async value => ({ head: value.head }),
  });
  assert.equal(result.status, 'published');
  assert.equal(f.git('rev-parse', 'main'), f.base);
  assert.equal(f.git('rev-parse', 'claude/integration'), f.base);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('a mapped setup infrastructure failure retries the full gate once without dropping its unit', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n'));
  const outcome = { failed: ['a'], causeText: 'error: could not create shared memory segment: Cannot allocate memory' };
  const h = harness(f, [outcome, outcome]);
  const result = await runQueue(f.root, { units: [a] }, h.options);
  assert.equal(result.status, 'needs-review'); assert.equal(result.returned.length, 0); assert.equal(h.published.length, 0);
  assert.equal(h.calls.filter(call => call[1] === 'gate').length, 2); assert.equal(h.events.filter(event => event.phase === 'isolated retry').length, 0);
  assert.equal(h.notifications.length, 2); assert.ok(h.notifications.every(failure => failure.authorSession === a.session && failure.causeClass === 'environment'));
  assert.equal(new Set(h.notifications.map(failure => failure.testedSha)).size, 1);
  const phases = h.events.map(event => event.phase);
  assert.ok(phases.indexOf('observe df/load') < phases.indexOf('notify'));
});

test('publication delegates the named integration worktree to its guarded synchronization component', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n'));
  const other = join(f.root, '.gate/integration'), out = join(f.root, '.gate/publish');
  f.git('worktree', 'add', '-qb', 'claude/integration', other, f.base); mkdirSync(out, { recursive: true }); let reads = 0;
  const synchronization = [];
  const result = await publishCandidate({ root: f.root, base: f.base, head: a.head, out, integrationWorktree: other, stackBranch: 'claude/test-stack' }, {
    remoteHead: () => ++reads === 1 ? f.base : a.head,
    command: async () => ({ code: 0 }),
    syncIntegration: async value => { synchronization.push(value); return { head: value.head }; },
  });
  assert.equal(result.status, 'published'); assert.equal(f.git('rev-parse', 'claude/integration'), f.base);
  assert.equal(synchronization.length, 1); assert.equal(synchronization[0].integrationWorktree, other);
  assert.equal(readFileSync(join(other, 'packages/a/src.mjs'), 'utf8'), 'base\n');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: other, encoding: 'utf8' }), '');
});

test('queue refuses a missing execution record instead of creating a replacement', async t => {
  const f = fixture(t), a = f.unit('a', put => { rmSync(join(f.root, 'docs/execution.md')); put('packages/a/src.mjs', 'a\n'); }), h = harness(f);
  await assert.rejects(runQueue(f.root, { units: [a] }, h.options), error => /docs\/execution\.md/.test(error.message) && /missing|record/i.test(error.message));
  assert.equal(h.published.length, 0);
  assert.equal(h.calls.filter(call => call[1] === 'gate').length, 0);
});

test('queue names the real record target when its Integration record section is absent', async t => {
  const f = fixture(t), a = f.unit('a', put => put('docs/execution.md', '# Real execution\n\n## Now\nPreserve this.\n')), h = harness(f);
  await assert.rejects(runQueue(f.root, { units: [a] }, h.options), /docs\/execution\.md.*Integration record/i);
  assert.equal(h.published.length, 0);
});

test('serial success gives each unit its own gate and never batches or bisects candidates', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n')), b = f.unit('b', put => put('packages/b/src.mjs', 'b\n'));
  const h = harness(f), result = await runQueue(f.root, { units: [a, b] }, h.options);
  assert.equal(result.status, 'published'); assert.deepEqual(result.successes.map(success => success.units), [['a'], ['b']]);
  assert.equal(h.calls.filter(call => call[1] === 'gate').length, 2); assert.equal(h.published.length, 2);
  assert.equal(h.published[1].base, h.published[0].head);
  assert.equal(f.git('show', `${result.head}:packages/a/src.mjs`), 'a'); assert.equal(f.git('show', `${result.head}:packages/b/src.mjs`), 'b');
});

test('packaging changes prove CLI installation before the gate and again after native and Docker proof', async t => {
  const f = fixture(t), a = f.unit('a', put => put('package.json', { name: 'queue-fixture', scripts: { test: 'node --test' } }));
  bindFixtureReview(f, a);
  const h = harness(f), result = await runQueue(f.root, { units: [a] }, h.options);
  assert.equal(result.status, 'published');
  const phases = h.events.map(event => event.phase);
  assert.ok(phases.indexOf('pre-gate CLI install') < phases.indexOf('gate'));
  assert.ok(phases.indexOf('CLI install') > phases.indexOf('Docker smoke'));
  const install = h.events.find(event => event.phase === 'install');
  assert.ok(install.args.includes('--no-frozen-lockfile'));
  assert.equal(h.calls.filter(call => call[0] === 'pnpm' && call[1] === 'test:install').length, 2);
});

test('an unreviewed gate redefinition returns to its author before executing any candidate command', async t => {
  const f = fixture(t), a = f.unit('a', put => put('package.json', { name: 'queue-fixture', scripts: { gate: 'true' } })), h = harness(f);
  h.options.inspect = () => assert.fail('snapshot regeneration must not execute before review admission');
  const result = await runQueue(f.root, { units: [a] }, h.options);
  assert.equal(result.status, 'returned'); assert.equal(result.returned[0].authorSession, a.session);
  assert.equal(h.calls.length, 0); assert.equal(h.published.length, 0);
});

test('known generated output is committed with queue attribution and successful refs are pruned', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n')), h = harness(f), command = h.options.command;
  h.options.command = async (cwd, executable, args, context) => {
    if (context.phase === 'regenerate') writeFileSync(join(cwd, '.dockerignore'), 'generated fixture\n');
    return command(cwd, executable, args, context);
  };
  const result = await runQueue(f.root, { units: [a] }, h.options);
  assert.equal(result.status, 'published');
  assert.equal(f.git('show', `${result.gateHead}:.dockerignore`), 'generated fixture');
  assert.match(f.git('show', '-s', '--format=%B', result.gateHead), /Agent: merge-queue$/);
  assert.equal(f.git('for-each-ref', '--format=%(refname)', 'refs/heads/merge-queue/'), '');
});

test('a failure receipt preserves the exact cross-family reviewed SHA and candidate tested SHA', async t => {
  const f = fixture(t), a = f.unit('a', put => { put('packages/a/src.mjs', "import './authority.mjs';\n"); put('packages/a/authority.mjs', 'export const value = 1;\n'); });
  f.git('checkout', '-q', 'a'); f.git('commit', '--amend', '-qm', 'reviewed authority change', '--trailer', 'Agent: gpt-6'); a.head = f.git('rev-parse', 'HEAD'); f.git('checkout', '-q', 'main');
  a.authorFamily = 'openai'; a.review = '.gate/reviews/a-binding.json';
  const artifact = { verdict: 'ACCEPT', family: 'claude', session: 'security-review', reviewedSha: a.head, base: f.base, patchId: ownPatchId(f.root, f.base, a.head) };
  const text = JSON.stringify(artifact) + '\n', path = '.gate/reviews/a-artifact.json'; f.put(path, text);
  f.put(a.review, { version: 1, unit: a.name, authorSession: a.session, authorFamily: 'openai', review: { ...artifact, artifact: { path, sha256: createHash('sha256').update(text).digest('hex') } } });
  const h = harness(f, [{ failed: ['a'] }]), result = await runQueue(f.root, { units: [a] }, h.options);
  assert.equal(result.returned.length, 1); assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].reviewedSha, a.head); assert.equal(h.notifications[0].testedSha, result.gateHead);
  assert.equal(h.notifications[0].authorSession, a.session); assert.equal(h.notifications[0].causeClass, 'product defect');
});

test('an unknown author-session delivery retains its receipt and is never sent twice', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n'));
  const h = harness(f, [{ failed: ['a'] }]); let deliveries = 0;
  h.options.notify = async () => { deliveries++; throw new Error('relay disconnected after possible delivery'); };
  const result = await runQueue(f.root, { units: [a] }, h.options);
  assert.equal(deliveries, 1); assert.equal(result.status, 'needs-review'); assert.equal(h.published.length, 0);
  assert.equal(result.failures[0].delivery, 'needs-reconciliation'); assert.equal(result.failures[0].authorSession, a.session);
  assert.equal(JSON.parse(readFileSync(join(result.out, 'return-1.json'))).delivery, 'needs-reconciliation');
});

test('a confirmed push followed by local-sync failure retains the known remote outcome without resending', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n'));
  const out = join(f.root, '.gate/publish'); mkdirSync(out, { recursive: true }); let reads = 0, pushes = 0;
  const value = { root: f.root, base: f.base, head: a.head, out }, options = {
    remoteHead: () => ++reads === 1 ? f.base : a.head,
    command: async () => { pushes++; return { code: 0 }; },
    syncIntegration: async () => { throw new Error('integration checkout changed'); },
  };
  assert.equal((await publishCandidate(value, options)).status, 'published-needs-local-sync');
  const receipt = JSON.parse(readFileSync(join(f.root, '.git/merge-queue-pending.json')));
  assert.equal(receipt.phase, 'published-needs-local-sync'); assert.equal(receipt.observed, a.head);
  await assert.rejects(publishCandidate(value, options), /reconciliation/i); assert.equal(pushes, 1);
});

test('isolated plans target one named test and packaging classifiers include runtime closure changes', t => {
  const f = fixture(t);
  const plan = isolatedTestPlan(f.root, { suite: 'a', files: ['packages/a/test.test.mjs'], test: 'a refuses broken input' });
  assert.ok(plan.includes('packages/a/test.test.mjs')); assert.ok(plan.includes('a refuses broken input')); assert.equal(plan.includes('--only'), false);
  assert.equal(isolatedTestPlan(f.root, { files: ['../outside.test.mjs'], test: 'unsafe' }), null);
  for (const file of ['package.json', 'pnpm-lock.yaml', '.dockerignore', 'packages/surfaces/app/scripts/workspace-runtime.mjs']) assert.equal(needsInstallProof([file]), true, file);
  assert.equal(needsInstallProof(['packages/a/src.mjs']), false);
});

test('a zero-match isolated command is not positive test evidence despite exit zero', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n'));
  const h = harness(f, [{ failed: ['a'], unassigned: true, causeText: 'classification: flake', isolatedExit: 0, isolatedOutput: '# pass 0\n# fail 0\n' }]);
  const result = await runQueue(f.root, { units: [a] }, h.options);
  assert.equal(result.status, 'needs-review'); assert.equal(result.successes.length, 0); assert.equal(h.published.length, 0);
  assert.equal(h.notifications[0].isolated.exitCode, 0); assert.equal(h.notifications[0].isolated.passed, 0);
  assert.equal(h.events.filter(event => event.phase === 'isolated retry').length, 1);
  assert.equal(h.events.filter(event => event.phase === 'gate').length, 1);
});

test('a later serial admission failure never borrows the previous unit tested SHA', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n')), b = f.unit('b', put => put('packages/b/src.mjs', 'b\n'));
  const h = harness(f), original = h.options.preflight; let admissions = 0;
  h.options.preflight = async (root, options) => {
    if (++admissions <= 2) return original(root, options);
    const error = new Error('Heavy priority marker is held'); error.environment = { freeBytes: 30 * 1024 ** 3, load: [0, 0, 0] }; throw error;
  };
  await assert.rejects(runQueue(f.root, { units: [a, b] }, h.options), /priority marker/i);
  assert.equal(h.published.length, 1);
  const receipt = h.notifications.find(value => value.authorSession === b.session);
  assert.ok(receipt); assert.equal(receipt.causeClass, 'environment'); assert.equal(receipt.testedSha, null);
});

test('a missing Agent trailer returns to its author without turning a code repair into schema judgement', async t => {
  const f = fixture(t), a = f.unit('a', put => put('packages/a/src.mjs', 'a\n')), b = f.unit('b', put => put('packages/b/src.mjs', 'b\n'));
  f.git('checkout', '-q', 'a');
  execFileSync('git', ['commit', '--amend', '-qm', 'missing provenance'], { cwd: f.root, stdio: 'ignore' }); a.head = f.git('rev-parse', 'HEAD'); f.git('checkout', '-q', 'main');
  const h = harness(f), result = await runQueue(f.root, { units: [a, b] }, h.options);
  assert.equal(result.status, 'published'); assert.deepEqual(result.successes.flatMap(value => value.units), ['b']);
  assert.equal(result.returned[0].authorSession, a.session); assert.equal(result.returned[0].causeClass, 'integration');
  assert.equal(result.returned[0].action, 'return to author'); assert.equal(result.returned[0].testedSha, null);
});

test('legacy journey schema stops qualification for a person and preserves later queued units', async t => {
  const f = fixture(t), a = f.unit('a', put => put('docs/journeys.json', families([{ id: 'legacy', level: 'package-test', supportingTests: [] }]))), b = f.unit('b', put => put('packages/b/src.mjs', 'b\n'));
  const h = harness(f), result = await runQueue(f.root, { units: [a, b] }, h.options);
  assert.equal(result.status, 'needs-judgement'); assert.equal(h.published.length, 0); assert.equal(h.events.some(event => event.phase === 'gate'), false);
  assert.equal(result.returned[0].action, 'person must align these entries'); assert.equal(result.returned[0].judgement[0].entry.id, 'legacy');
  assert.deepEqual(result.deferred.map(unit => unit.name), ['b']); assert.equal(h.notifications[0].authorSession, a.session);
});
