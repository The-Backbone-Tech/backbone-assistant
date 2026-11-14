import test from 'node:test';
import assert from 'node:assert/strict';
import { stateProblems } from './test-state.mjs';
import { check } from './test-state.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

test('fixed temporary state, shared sweeps and hand-made locks are rejected', () => {
  const cases = [
    "const home = '/tmp/shared-home';",
    "const home = path.join(os.tmpdir(), 'shared-home');",
    "const home = join(tmpdir(), 'shared-home'); await mkdir(home);",
    'await readdir(tmpdir());',
    "const root = tmpdir(); await rm(join(root, 'backbone-*'), {recursive:true});",
    "const lock = join(home, 'keys', '.lock'); await writeFile(lock, '');",
    "await rm(join(home, '.lock'));",
    "await symlink(join(home, 'target'), join(home, '.lock'));",
    'await sweepAuditTemporary();',
    'const globalRoot = auditTemporaryRoot();',
    "await mkdir(auditScratchParent(), {recursive:true});",
  ];
  for (const source of cases) assert.ok(stateProblems(source).length, source);
});

test('per-test random state and product-owned locks are allowed, including import aliases', () => {
  const source = `import { mkdtemp as fresh } from 'node:fs/promises';
    import { tmpdir as temporary } from 'node:os';
    const home = await fresh(join(temporary(), 'own-'));
    await readdir(home); await rm(home, { recursive: true });
    await withHomeLock(home, async () => {});`;
  assert.deepEqual(stateProblems(source), []);
  assert.ok(stateProblems("import { tmpdir as temp } from 'node:os'; const home = join(temp(), 'fixed');").length);
});

test('exceptions cover only the recorded expression count and stale exceptions fail', t => {
  const root = mkdtempSync(join(tmpdir(), 'test-state-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]); mkdirSync(join(root, 'scripts'));
  const source = "'/tmp/existing'";
  writeFileSync(join(root, 'fixture.test.mjs'), `const existing = ${source};`);
  writeFileSync(join(root, 'scripts/test-state-exceptions.json'), JSON.stringify({ note: 'Known-offender burn-down list; remove repaired entries.', exceptions: [{ file: 'fixture.test.mjs', owner: 'backbone-next', rule: 'fixed-temp', source, count: 1, reason: 'A pre-existing fixture.' }] }));
  assert.deepEqual(check(root), []);
  writeFileSync(join(root, 'fixture.test.mjs'), `const existing = ${source}; const additional = ${source};`);
  assert.equal(check(root).length, 1);
  writeFileSync(join(root, 'fixture.test.mjs'), 'const existing = 0;');
  assert.equal(check(root).length, 1);
});

test('a later test with the same local name cannot hide a shared sweep', () => {
  const source = `test('shared', () => { const root = tmpdir(); readdirSync(root); });
    test('isolated', () => { const root = mkdtempSync(join(tmpdir(), 'own-')); readdirSync(root); });`;
  assert.equal(stateProblems(source).filter(p => p.rule === 'shared-sweep').length, 1);
});

test('a repaired exception fails with its owner and exact expression so the burn-down entry is removed', t => {
  const root = mkdtempSync(join(tmpdir(), 'test-state-burn-down-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]); mkdirSync(join(root, 'scripts'));
  const entry = { file: 'repaired.test.mjs', owner: 'backbone-next', rule: 'fixed-temp', source: "'/tmp/repaired'", count: 1, reason: 'Known fixture awaiting repair.' };
  writeFileSync(join(root, entry.file), 'const state = 0;');
  writeFileSync(join(root, 'scripts/test-state-exceptions.json'), JSON.stringify({ note: 'Known-offender burn-down list; remove repaired entries.', exceptions: [entry] }));
  const problems = check(root);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes(entry.file));
  assert.ok(problems[0].includes(entry.owner));
  assert.ok(problems[0].includes(entry.source));
  assert.match(problems[0], /burn-down|shrink/i);
});

test('a matching exception without an owner cannot allow an offender', t => {
  const root = mkdtempSync(join(tmpdir(), 'test-state-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]); mkdirSync(join(root, 'scripts'));
  const entry = { file: 'fixture.test.mjs', rule: 'fixed-temp', source: "'/tmp/unowned'", count: 1, reason: 'Known fixture.' };
  writeFileSync(join(root, entry.file), `const state = ${entry.source};`);
  writeFileSync(join(root, 'scripts/test-state-exceptions.json'), JSON.stringify({ note: 'Known-offender burn-down list; remove repaired entries.', exceptions: [entry] }));
  assert.ok(check(root).some(problem => /owning package|owner/i.test(problem)));
});

test('the burn-down catalogue names the package owning each exact test expression', () => {
  const root = new URL('../', import.meta.url).pathname;
  const { note, exceptions } = JSON.parse(readFileSync(join(root, 'scripts/test-state-exceptions.json'), 'utf8'));
  assert.ok(typeof note === 'string' && note.trim());
  for (const entry of exceptions) {
    let dir = dirname(join(root, entry.file));
    while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir);
    assert.equal(entry.owner, JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name);
    assert.ok(entry.file && entry.source && entry.reason && entry.count > 0);
  }
});
