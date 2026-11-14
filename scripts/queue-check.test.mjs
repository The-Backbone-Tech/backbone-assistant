import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectQueue, queueTable } from './queue-check.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'queue-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null');
  mkdirSync(join(root, 'packages/example'), { recursive: true });
  writeFileSync(join(root, 'packages/example/package.json'), JSON.stringify({ name: '@example/work', scripts: { test: 'node --test' } }));
  writeFileSync(join(root, 'packages/example/host.ts'), 'base\n');
  git('add', '.'); git('commit', '-m', 'base'); git('update-ref', 'refs/remotes/origin/claude/integration', 'HEAD');
  for (const branch of ['first', 'second']) {
    git('checkout', '-b', branch, 'main');
    writeFileSync(join(root, 'packages/example/host.ts'), `${branch}\n`);
    git('commit', '-am', branch);
  }
  git('checkout', 'main');
  return { root, git };
}

test('queue uses immutable branch snapshots, reports packages, hotspots and pair conflicts', t => {
  const { root, git } = fixture(t);
  const before = git('status', '--porcelain'); const seen = [];
  const result = inspectQueue(root, ['first', 'second'], { regeneration: snapshot => { seen.push(snapshot); return []; } });
  assert.equal(result.failed, true);
  assert.ok(result.rows.every(row => row.conflicts.length === 1 && !row.stale));
  assert.deepEqual(result.rows[0].packages, ['@example/work']);
  assert.deepEqual(result.rows[0].hotspots, ['packages/example/host.ts']);
  assert.ok(result.commands.includes('pnpm --filter @example/work test'));
  assert.equal(new Set(seen).size, 2);
  assert.equal(git('status', '--porcelain'), before);
  assert.equal(git('branch', '--show-current'), 'main');
});

test('stale bases and regeneration failures are visible and fail the queue', t => {
  const { root, git } = fixture(t);
  writeFileSync(join(root, 'integrated'), 'new head'); git('add', '.'); git('commit', '-m', 'advance');
  git('update-ref', 'refs/remotes/origin/claude/integration', 'HEAD');
  const result = inspectQueue(root, ['first'], { regeneration: () => ['stale generated artifact'] });
  assert.equal(result.rows[0].stale, true);
  assert.equal(result.rows[0].regen.length, 1);
  assert.equal(result.failed, true);
});

test('a branch uses its own regeneration checker without executing its heavy suite', t => {
  const { root, git } = fixture(t);
  git('checkout', 'first'); mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/regen.mjs'), "if (!process.argv.includes('--check')) process.exit(5); process.exit(0);");
  git('add', '.'); git('commit', '-m', 'branch generator');
  assert.equal(inspectQueue(root, ['first']).failed, false);
  writeFileSync(join(root, 'scripts/regen.mjs'), "console.error('stale generated file'); process.exit(1);");
  git('commit', '-am', 'stale generator');
  const result = inspectQueue(root, ['first']);
  assert.equal(result.failed, true);
  assert.ok(result.rows[0].regen.length);
});

test('author commands select changed packages while dependents remain gate coverage', t => {
  const { root, git } = fixture(t);
  for (const [dir, dependencies] of [['consumer', { '@example/work': 'workspace:*' }], ['surface', { '@example/consumer': 'workspace:*' }], ['unrelated', {}]]) {
    mkdirSync(join(root, 'packages', dir));
    writeFileSync(join(root, 'packages', dir, 'package.json'), JSON.stringify({ name: `@example/${dir}`, dependencies, scripts: { test: 'node --test' } }));
  }
  git('add', '.'); git('commit', '-m', 'dependent graph');
  git('update-ref', 'refs/remotes/origin/claude/integration', 'HEAD'); git('checkout', '-b', 'affected');
  writeFileSync(join(root, 'packages/example/host.ts'), 'affected'); git('commit', '-am', 'work');
  const inspect = () => inspectQueue(root, ['affected'], { regeneration: () => [] });
  const result = inspect();
  assert.ok(result.commands.includes('pnpm --filter @example/work test'));
  for (const name of ['consumer', 'surface']) assert.equal(result.commands.includes(`pnpm --filter @example/${name} test`), false);
  assert.deepEqual(new Set(result.rows[0].dependents), new Set(['@example/consumer', '@example/surface']));
  const output = queueTable(result);
  assert.match(output, /run:.*@example\/work/); assert.match(output, /gate covers:.*@example\/consumer.*@example\/surface/);
  assert.equal(result.commands.some(c => c.includes('unrelated')), false);
  assert.equal(result.commands.includes('pnpm check'), false);
  mkdirSync(join(root, 'docs')); writeFileSync(join(root, 'docs/change.md'), 'changed'); git('add', '.'); git('commit', '-m', 'docs');
  assert.ok(inspect().commands.includes('pnpm check'));
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lock changed'); git('add', '.'); git('commit', '-m', 'lock');
  const locked = inspect();
  assert.deepEqual(locked.rows[0].packages, ['@example/work']);
  assert.ok(locked.rows[0].dependents.includes('@example/unrelated'));
  assert.equal(locked.commands.some(c => /@example\/(consumer|surface|unrelated)/.test(c)), false);
});
