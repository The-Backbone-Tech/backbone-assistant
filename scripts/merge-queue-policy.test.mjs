import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectUnitBinding, ownPatchId, coreDiffHash, classifyFailure, attributeFailingFiles, chooseBatch, failureEnvelope } from './lib/merge-queue-policy.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-policy-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (file, contents) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), contents); };
  git('init', '-b', 'main');
  for (const [key, value] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': '/dev/null' })) git('config', key, value);
  put('.gitignore', '.gate/\nevidence/\n'); put('README.md', 'base\n'); put('packages/platform/src/authority.ts', 'export const allowed = false;\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  function unit(name, file, contents) {
    git('checkout', '-qb', name, base); put(file, contents); git('add', '.'); git('commit', '-qm', name);
    const head = git('rev-parse', 'HEAD'); git('checkout', '-q', 'main');
    return { name, head, session: `${name}-author`, authorFamily: 'openai', files: [file] };
  }
  return { root, git, put, base, unit };
}
function binding(f, unit, overrides = {}) {
  const review = { verdict: 'ACCEPT', family: 'anthropic', session: 'independent-review', reviewedSha: unit.head, base: f.base, patchId: ownPatchId(f.root, f.base, unit.head) };
  review.artifact = receipt(f, review, unit.name);
  return { version: 1, unit: unit.name, authorSession: unit.session, authorFamily: unit.authorFamily, review, ...overrides };
}
function receipt(f, review, name) {
  const path = `.gate/reviews/${name}.json`, text = JSON.stringify(review) + '\n';
  f.put(path, text);
  return { path, sha256: createHash('sha256').update(text).digest('hex') };
}

test('queue and qualification definitions always need review even without sensitive keywords', t => {
  const f = fixture(t);
  const files = ['scripts/lib/merge-queue-runtime.mjs', 'scripts/lib/merge-queue-mechanical.mjs', 'scripts/merge-queue.mjs',
    'package.json', 'scripts/check.mjs', 'scripts/regen.mjs', 'scripts/docker-smoke.sh', 'scripts/hooks/commit-msg',
    'scripts/no-leftovers.mjs', 'scripts/with-test-cluster.mjs', 'scripts/gate.mjs', '.github/workflows/check.yml', 'deploy/Dockerfile',
    'scripts/test-edit.mjs', 'scripts/test-results.mjs', 'scripts/lib/repo.mjs', '.npmrc', 'pnpm-workspace.yaml', '.pnpmfile.cjs',
    'packages/modules/example/package.json', 'packages/surfaces/example/package.json'];
  for (const [index, file] of files.entries()) {
    const unit = f.unit(`runner-${index}`, file, 'ordinary change\n');
    const result = inspectUnitBinding(f.root, unit, f.base);
    assert.equal(result.accepted, false, file); assert.equal(result.sensitive, true, file);
  }
  for (const word of ['token', 'oauth', 'password', 'encrypt', 'apiKey', 'privateKey', 'signingKey', 'secretKey', 'api_key']) {
    const unit = f.unit(`word-${word}`, 'ordinary.js', `const ${word} = value;\n`);
    assert.equal(inspectUnitBinding(f.root, unit, f.base).accepted, false, word);
  }
});

test('ordinary object and map keys do not require security review', t => {
  const f = fixture(t);
  const unit = f.unit('ordinary-key', 'ordinary.js', 'export const values = items.map(key => ({ key }));\n');
  const result = inspectUnitBinding(f.root, unit, f.base);
  assert.equal(result.sensitive, false); assert.equal(result.accepted, true);
});

test('Core attestation cannot be rewritten in the unhashed binding, including a delta', t => {
  const f = fixture(t), unit = f.unit('core-attested', 'packages/core/source.sql', 'select 1;\n');
  const valid = binding(f, unit), firstHash = coreDiffHash(f.root, f.base, unit.head);
  assert.equal(inspectUnitBinding(f.root, unit, f.base, { ...valid, coreDiffHash: firstHash }).accepted, false);
  valid.review.coreDiffHash = firstHash;
  valid.review.artifact = receipt(f, valid.review, 'core-original');
  assert.equal(inspectUnitBinding(f.root, unit, f.base, valid).accepted, true);
  f.git('checkout', '-q', unit.name); f.put('packages/core/source.sql', 'select 2;\n'); f.git('commit', '-qam', 'delta');
  const previous = unit.head; unit.head = f.git('rev-parse', 'HEAD'); f.git('checkout', '-q', 'main');
  const delta = { verdict: 'ACCEPT', family: 'anthropic', session: 'delta-review', fromSha: previous,
    fromPatchId: valid.review.patchId, reviewedSha: unit.head, patchId: ownPatchId(f.root, f.base, unit.head) };
  delta.artifact = receipt(f, delta, 'core-delta');
  const live = coreDiffHash(f.root, f.base, unit.head);
  assert.equal(inspectUnitBinding(f.root, unit, f.base, { ...valid, delta, coreDiffHash: live }).accepted, false);
  delta.coreDiffHash = live; delta.artifact = receipt(f, delta, 'core-delta-attested');
  assert.equal(inspectUnitBinding(f.root, unit, f.base, { ...valid, delta }).accepted, true);
  delta.coreDiffHash = firstHash;
  assert.equal(inspectUnitBinding(f.root, unit, f.base, { ...valid, delta, coreDiffHash: live }).accepted, false);
});

test('sensitive units require an exact cross-family ACCEPT bound to their author session', t => {
  const f = fixture(t), unit = f.unit('authority', 'packages/platform/src/authority.ts', 'export const allowed = true;\n');
  assert.equal(inspectUnitBinding(f.root, unit, f.base).accepted, false);
  const valid = binding(f, unit);
  assert.equal(inspectUnitBinding(f.root, unit, f.base, valid).accepted, true);
  for (const change of [ { verdict: 'accept with fixes' }, { family: 'openai' }, { reviewedSha: f.base }, { session: unit.session }, { patchId: '0'.repeat(40) } ]) {
    const result = inspectUnitBinding(f.root, unit, f.base, { ...valid, review: { ...valid.review, ...change } });
    assert.equal(result.accepted, false, JSON.stringify(change));
  }
  assert.equal(inspectUnitBinding(f.root, unit, f.base, { ...valid, authorSession: 'another-author' }).accepted, false);
});

test('a review survives a rebase only while the unit own stable patch-id is unchanged', t => {
  const f = fixture(t), unit = f.unit('authority', 'packages/platform/src/authority.ts', 'export const allowed = true;\n');
  const valid = binding(f, unit), reviewedSha = unit.head;
  f.put('other.txt', 'advanced integration\n'); f.git('add', '.'); f.git('commit', '-qm', 'advance base');
  const nextBase = f.git('rev-parse', 'HEAD'); f.git('checkout', '-q', unit.name); f.git('rebase', nextBase);
  unit.head = f.git('rev-parse', 'HEAD'); f.git('checkout', '-q', 'main');
  assert.notEqual(unit.head, reviewedSha);
  const held = inspectUnitBinding(f.root, unit, nextBase, valid);
  assert.equal(held.accepted, true); assert.equal(held.reviewedSha, reviewedSha); assert.equal(held.bindingMode, 'unchanged-patch');
  f.git('checkout', '-q', unit.name); f.put('packages/platform/src/authority.ts', 'export const allowed = "expanded";\n'); f.git('commit', '-qam', 'change reviewed patch');
  unit.head = f.git('rev-parse', 'HEAD'); f.git('checkout', '-q', 'main');
  assert.equal(inspectUnitBinding(f.root, unit, nextBase, valid).accepted, false);
  const delta = { verdict: 'ACCEPT', family: 'anthropic', session: 'delta-review', fromSha: reviewedSha, fromPatchId: valid.review.patchId, reviewedSha: unit.head, patchId: ownPatchId(f.root, nextBase, unit.head) };
  delta.artifact = receipt(f, delta, 'delta');
  assert.equal(inspectUnitBinding(f.root, unit, nextBase, { ...valid, delta }).accepted, true);
  assert.equal(inspectUnitBinding(f.root, unit, nextBase, { ...valid, delta: { ...delta, fromSha: f.base } }).accepted, false);
});

test('Core requires the frozen raw base-to-head Core diff hash as well as review binding', t => {
  const f = fixture(t), unit = f.unit('core', 'packages/core/schema/source.sql', 'select 1;\n');
  const valid = binding(f, unit);
  assert.equal(inspectUnitBinding(f.root, unit, f.base, valid).accepted, false);
  const raw = execFileSync('git', ['diff', f.base, unit.head, '--', 'packages/core', 'packages/platform/src/composition/core.ts'], { cwd: f.root });
  const expected = createHash('sha256').update(raw).digest('hex');
  assert.equal(coreDiffHash(f.root, f.base, unit.head), expected);
  valid.review.coreDiffHash = expected; valid.review.artifact = receipt(f, valid.review, 'frozen-core');
  const frozen = valid;
  assert.equal(inspectUnitBinding(f.root, unit, f.base, frozen).accepted, true);
  assert.equal(inspectUnitBinding(f.root, unit, f.base, { ...frozen, review: { ...frozen.review, coreDiffHash: '0'.repeat(64) } }).accepted, false);
});

test('non-sensitive changes still require an author session and cannot hide sensitive changed files', t => {
  const f = fixture(t), doc = f.unit('doc', 'notes.md', 'A harmless formatting note.\n');
  assert.equal(inspectUnitBinding(f.root, doc, f.base).accepted, true);
  assert.equal(inspectUnitBinding(f.root, { ...doc, session: undefined }, f.base).accepted, false);
  const sensitive = f.unit('hidden', 'packages/platform/src/authority.ts', 'export const allowed = true;\n');
  assert.equal(inspectUnitBinding(f.root, { ...sensitive, files: ['notes.md'] }, f.base).accepted, false);
});

test('failure classification retries only positively classified environment or test-state failures', () => {
  assert.deepEqual(classifyFailure('not ok 1 - writes remain gated\nAssertionError: wrong result').causeClass, 'product defect');
  assert.equal(classifyFailure('not ok 1 - expected result').retryable, false);
  for (const text of ['ENOSPC: no space left on device', 'could not create shared memory segment: Cannot allocate memory']) {
    const result = classifyFailure(text); assert.equal(result.causeClass, 'environment'); assert.equal(result.retryable, true);
  }
  const flake = classifyFailure('classification: test-state/flake\nnot ok 1 - isolated state');
  assert.equal(flake.causeClass, 'test-state/flake'); assert.equal(flake.retryable, true);
  assert.equal(classifyFailure('CONFLICT (content): Merge conflict in code.ts').causeClass, 'integration');
  assert.equal(classifyFailure('test timed out', { timedOut: true }).retryable, false);
});

test('each failing file maps only to exact changes or the source imported by that test', t => {
  const f = fixture(t);
  f.put('packages/a/test/work.test.ts', "import { execute } from '../src/work.js';\n");
  f.put('packages/a/src/work.ts', "export { execute } from './worker.js';\n");
  f.put('packages/a/src/worker.ts', 'export const execute = () => 1;\n');
  f.put('packages/a/src/unrelated.ts', 'export const unrelated = 1;\n');
  f.git('add', '.'); f.git('commit', '-qm', 'source graph');
  const units = [{ name: 'driven', files: ['packages/a/src/worker.ts'] }, { name: 'unrelated', files: ['packages/a/src/unrelated.ts'] }, { name: 'test', files: ['packages/a/test/work.test.ts'] }];
  const result = attributeFailingFiles(f.root, { files: ['packages/a/test/work.test.ts'] }, units);
  assert.deepEqual(result.units, ['driven', 'test']);
  assert.deepEqual(result.mappings[0].units, ['driven', 'test']); assert.equal(result.complete, true);
  assert.ok(result.mappings[0].drives.includes('packages/a/src/worker.ts'));
  assert.deepEqual(attributeFailingFiles(f.root, { files: ['packages/a/test/missing.test.ts'] }, units).units, []);
});

test('unresolved dynamic imports and unknown failing files prevent confident unit drops', t => {
  const f = fixture(t);
  f.put('packages/a/test/dynamic.test.ts', "const driver = await import(selectedDriver);\n");
  f.git('add', '.'); f.git('commit', '-qm', 'dynamic source');
  const result = attributeFailingFiles(f.root, { files: ['packages/a/test/dynamic.test.ts'] }, [{ name: 'test', files: ['packages/a/test/dynamic.test.ts'] }]);
  assert.equal(result.complete, false); assert.deepEqual(result.units, []); assert.deepEqual(result.candidates, ['test']);
  assert.deepEqual(attributeFailingFiles(f.root, { log: 'runner failed without a source location' }, [{ name: 'x', files: ['packages/a/src/a.ts'] }]).units, []);
});

test('queue selection is serial by default and optional batches contain only small disjoint packages', () => {
  const units = [{ name: 'a', files: ['packages/modules/a/src/a.ts'] }, { name: 'b', files: ['packages/modules/b/src/b.ts'] }, { name: 'overlap', files: ['packages/modules/a/src/other.ts'] }, { name: 'shared', files: ['scripts/shared.mjs'] }];
  assert.deepEqual(chooseBatch(units).map(u => u.name), ['a']);
  assert.deepEqual(chooseBatch(units, { mode: 'disjoint', maxBatch: 3 }).map(u => u.name), ['a', 'b']);
  assert.deepEqual(chooseBatch([units[3], units[1]], { mode: 'disjoint' }).map(u => u.name), ['shared']);
  assert.throws(() => chooseBatch(units, { mode: 'batch-and-bisect' }), /mode/i);
});

test('returned failure envelopes keep the author session, cause and both reviewed and tested SHAs', () => {
  const unit = { name: 'unit', head: 'a'.repeat(40), session: 'author-session', reviewedSha: 'b'.repeat(40) };
  const result = failureEnvelope(unit, { causeClass: 'product defect', log: '/disposable/test.log', test: 'refuses the write' }, 'c'.repeat(40));
  assert.equal(result.authorSession, 'author-session'); assert.equal(result.reviewedSha, 'b'.repeat(40)); assert.equal(result.testedSha, 'c'.repeat(40)); assert.equal(result.causeClass, 'product defect');
  assert.equal(result.name, unit.name); assert.equal(result.log, '/disposable/test.log');
});

test('review artifact bytes and binding headers cannot be changed or replaced by a source file', t => {
  const f = fixture(t), unit = f.unit('authority', 'packages/platform/src/authority.ts', 'export const allowed = true;\n');
  const valid = binding(f, unit);
  f.put(valid.review.artifact.path, JSON.stringify({ verdict: 'REJECT' }) + '\n');
  assert.equal(inspectUnitBinding(f.root, unit, f.base, valid).accepted, false);
  const other = binding(f, unit);
  const body = { verdict: 'ACCEPT', family: 'anthropic', session: 'independent-review', reviewedSha: f.base, base: f.base, patchId: other.review.patchId };
  other.review.artifact = receipt(f, body, 'wrong-head');
  assert.equal(inspectUnitBinding(f.root, unit, f.base, other).accepted, false);
  const source = 'source-review.json', contents = JSON.stringify({ ...other.review, artifact: undefined }); f.put(source, contents);
  other.review.artifact = { path: source, sha256: createHash('sha256').update(contents).digest('hex') };
  assert.equal(inspectUnitBinding(f.root, unit, f.base, other).accepted, false);
});

test('renaming an authority boundary still requires review of the removed original file', t => {
  const f = fixture(t);
  f.git('checkout', '-qb', 'move', f.base); f.git('mv', 'packages/platform/src/authority.ts', 'packages/platform/src/plain.ts'); f.git('commit', '-qm', 'rename boundary');
  const unit = { name: 'move', head: f.git('rev-parse', 'HEAD'), session: 'move-author', authorFamily: 'openai' }; f.git('checkout', '-q', 'main');
  const result = inspectUnitBinding(f.root, unit, f.base);
  assert.equal(result.accepted, false); assert.equal(result.sensitive, true);
});

test('comments and unrelated from text cannot manufacture a driven-file attribution edge', t => {
  const f = fixture(t);
  f.put('packages/a/test/work.test.ts', "// import { run } from '../src/unrelated.js';\nexport const note = 'from';\nimport {\n run\n} from '../src/work.js';\n");
  f.put('packages/a/src/work.ts', "export { run } from './worker.js';\n");
  f.put('packages/a/src/worker.ts', 'export const run = () => true;\n');
  f.put('packages/a/src/unrelated.ts', 'export const unrelated = true;\n'); f.git('add', '.'); f.git('commit', '-qm', 'source graph');
  const units = [{ name: 'real', files: ['packages/a/src/worker.ts'] }, { name: 'comment', files: ['packages/a/src/unrelated.ts'] }];
  const result = attributeFailingFiles(f.root, { files: ['packages/a/test/work.test.ts'] }, units);
  assert.deepEqual(result.units, ['real']); assert.equal(result.complete, true);
  const asserted = attributeFailingFiles(f.root, { files: ['packages/a/test/work.test.ts'], drivenFiles: { 'packages/a/test/work.test.ts': ['packages/a/src/unrelated.ts'] } }, units);
  assert.equal(asserted.complete, false); assert.deepEqual(asserted.units, []); assert.deepEqual(asserted.candidates, ['real']);
});

test('Vitest package-relative failures identify the real file and full matching title', t => {
  const f = fixture(t);
  f.put('packages/core/package.json', JSON.stringify({ name: '@backbone/core' }));
  f.put('packages/core/test/grants.test.ts', "import { permitted } from '../src/grants.js';\n");
  f.put('packages/core/src/grants.ts', 'export const permitted = false;\n');
  f.git('add', '.'); f.git('commit', '-qm', 'Vitest sources');
  const log = '\u001b[31m FAIL \u001b[39m test/grants.test.ts > Core grants > refuses an unsigned write\nAssertionError: wrong result\n ❯ src/grants.ts:8:7\n';
  const result = classifyFailure(log, { root: f.root, suite: 'core' });
  assert.deepEqual(result.files, ['packages/core/test/grants.test.ts', 'packages/core/src/grants.ts']);
  assert.equal(result.test, 'Core grants refuses an unsigned write');
  assert.equal(result.title, 'refuses an unsigned write'); assert.equal(result.project, null);
  assert.deepEqual(result.cases[0], { file: 'packages/core/test/grants.test.ts', runner: 'vitest', test: 'Core grants refuses an unsigned write', title: 'refuses an unsigned write', project: null });
  const attribution = attributeFailingFiles(f.root, { ...result, log, suite: 'core' }, [{ name: 'grant', files: ['packages/core/src/grants.ts'] }, { name: 'unrelated', files: ['packages/core/src/other.ts'] }]);
  assert.deepEqual(attribution.units, ['grant']);
});

test('Playwright app failures preserve the project and actual test title for exact diagnostics', t => {
  const f = fixture(t);
  f.put('packages/surfaces/app/package.json', JSON.stringify({ name: '@backbone-next/app' }));
  f.put('packages/surfaces/app/e2e/connectors.spec.ts', 'export const marker = true;\n');
  f.git('add', '.'); f.git('commit', '-qm', 'Playwright sources');
  const log = '  1) [electron] › e2e/connectors.spec.ts:18:3 › connectors › a person releases one write ──────\n\nError: expected a receipt\n';
  for (const suite of ['app-e2e', 'app-installed']) {
    const result = classifyFailure(log, { root: f.root, suite });
    assert.deepEqual(result.files, ['packages/surfaces/app/e2e/connectors.spec.ts']);
    assert.equal(result.project, 'electron'); assert.equal(result.test, 'connectors a person releases one write');
    assert.equal(result.title, 'a person releases one write'); assert.equal(result.cases[0].runner, 'playwright');
  }
});

test('relative failure paths never resolve to another package and missing headers prevent blame', t => {
  const f = fixture(t);
  for (const name of ['core', 'platform']) f.put(`packages/${name}/package.json`, JSON.stringify({ name: `@test/${name}` }));
  f.put('packages/platform/test/same.test.ts', 'export const exists = true;\n');
  f.put('packages/core/test/known.test.ts', 'export const known = true;\n');
  f.git('add', '.'); f.git('commit', '-qm', 'ambiguous names');
  const log = ' FAIL test/same.test.ts > missing case\n at TestContext.run (test/known.test.ts:2:1)\n';
  const result = classifyFailure(log, { root: f.root, suite: 'core' });
  assert.deepEqual(result.files, ['packages/core/test/known.test.ts']);
  assert.deepEqual(result.unresolvedFiles, ['test/same.test.ts']);
  const attribution = attributeFailingFiles(f.root, { ...result, log, suite: 'core' }, [{ name: 'known', files: ['packages/core/test/known.test.ts'] }, { name: 'other-package', files: ['packages/platform/test/same.test.ts'] }]);
  assert.equal(attribution.complete, false); assert.deepEqual(attribution.units, []); assert.deepEqual(attribution.candidates, ['known']);
});

test('external runner frames do not masquerade as missing authored source files', t => {
  const f = fixture(t);
  f.put('packages/core/package.json', JSON.stringify({ name: '@backbone/core' }));
  f.put('packages/core/test/refusal.test.ts', 'export const marker = true;\n');
  f.git('add', '.'); f.git('commit', '-qm', 'runner frame source');
  const log = ' FAIL test/refusal.test.ts > refuses the operation\n ❯ ../../node_modules/.pnpm/@vitest+runner@5.0.2/node_modules/@vitest/runner/dist/index.js:90:5\n';
  const result = classifyFailure(log, { root: f.root, suite: 'core' });
  assert.deepEqual(result.files, ['packages/core/test/refusal.test.ts']); assert.deepEqual(result.unresolvedFiles, []);
  assert.deepEqual(attributeFailingFiles(f.root, { ...result, log, suite: 'core' }, [{ name: 'test', files: ['packages/core/test/refusal.test.ts'] }]).units, ['test']);
});

function twoCommitUnit(f) {
  const unit = f.unit('multi-commit', 'packages/platform/src/authority.ts', 'export const allowed = true;\n');
  const penultimate = unit.head;
  f.git('checkout', '-q', unit.name); f.put('packages/platform/src/format.ts', 'export const format = "first";\n'); f.git('add', '.'); f.git('commit', '-qm', 'later harmless commit');
  unit.head = f.git('rev-parse', 'HEAD'); f.git('checkout', '-q', 'main');
  return { unit, penultimate };
}
function rebindReviewRange(f, bound, base, name) {
  const { artifact, ...headers } = bound.review;
  const review = { ...headers, base, patchId: ownPatchId(f.root, base, headers.reviewedSha) };
  review.artifact = receipt(f, review, name);
  return { ...bound, review };
}

test('an exact head receipt cannot narrow review to only the last unit commit', t => {
  const f = fixture(t), { unit, penultimate } = twoCommitUnit(f), complete = binding(f, unit);
  assert.equal(inspectUnitBinding(f.root, unit, f.base, complete).accepted, true);
  const narrowed = rebindReviewRange(f, complete, penultimate, 'narrow-exact-head');
  const result = inspectUnitBinding(f.root, unit, f.base, narrowed);
  assert.equal(result.accepted, false); assert.match(result.reasons.join('; '), /complete.*own.*diff|own.*coverage|review.*range/i);
});

test('an exact head receipt cannot claim an empty review range over a nonempty unit', t => {
  const f = fixture(t), { unit } = twoCommitUnit(f), complete = binding(f, unit);
  const empty = rebindReviewRange(f, complete, unit.head, 'empty-exact-head');
  const result = inspectUnitBinding(f.root, unit, f.base, empty);
  assert.equal(result.accepted, false); assert.match(result.reasons.join('; '), /complete.*own.*diff|own.*coverage|review.*range/i);
});

test('a valid delta cannot inherit an original receipt that omitted earlier sensitive commits', t => {
  const f = fixture(t), { unit, penultimate } = twoCommitUnit(f), reviewedSha = unit.head;
  const original = rebindReviewRange(f, binding(f, unit), penultimate, 'narrow-original-before-delta');
  f.git('checkout', '-q', unit.name); f.put('packages/platform/src/format.ts', 'export const format = "second";\n'); f.git('commit', '-qam', 'later reviewed delta');
  unit.head = f.git('rev-parse', 'HEAD'); f.git('checkout', '-q', 'main');
  const delta = { verdict: 'ACCEPT', family: 'anthropic', session: 'complete-delta-review', fromSha: reviewedSha, fromPatchId: original.review.patchId, reviewedSha: unit.head, patchId: ownPatchId(f.root, f.base, unit.head) };
  delta.artifact = receipt(f, delta, 'delta-after-narrow-original');
  const result = inspectUnitBinding(f.root, unit, f.base, { ...original, delta });
  assert.equal(result.accepted, false); assert.match(result.reasons.join('; '), /complete.*own.*diff|own.*coverage|review.*range/i);
});
