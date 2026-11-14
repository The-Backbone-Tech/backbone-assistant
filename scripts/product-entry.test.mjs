import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distributionProblems, loadBrand } from './lib/brand.mjs';
import { listFiles } from './lib/repo.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const distribution = 'distributions/backbone/distribution.json';

function inBuildCopy(run) {
  // The real build replaces dist/. Isolate it from parallel Docker-context scans.
  // Copy current sources (including staged changes); reuse installed dependencies only.
  const work = mkdtempSync(join(tmpdir(), 'product-entry-'));
  try {
    const files = [...new Set(listFiles(root))].filter(file => existsSync(join(root, file)));
    for (const file of files) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      cpSync(join(root, file), join(work, file));
    }
    for (const dir of ['.', ...files.filter(file => file.startsWith('packages/') && file.endsWith('/package.json')).map(dirname)]) {
      if (existsSync(join(root, dir, 'node_modules'))) symlinkSync(join(root, dir, 'node_modules'), join(work, dir, 'node_modules'), 'dir');
    }
    const env = { ...process.env, INIT_CWD: work };
    delete env.BACKBONE_DISTRIBUTION;
    run(work, env);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

test('the shipped Backbone configuration validates and a configured build reports its name; the default stays neutral', () => {
  const config = JSON.parse(readFileSync(join(root, distribution), 'utf8'));
  assert.deepEqual(distributionProblems(config), []);
  assert.equal(loadBrand({ BACKBONE_DISTRIBUTION: distribution }, root).name, 'Backbone');
  assert.equal(loadBrand({ BACKBONE_DISTRIBUTION: distribution }, root).appId, 'ai.thebackbone.app');
  assert.equal(loadBrand({}, root).appId, 'org.example.assistant');
  // The build's notices read Electron's own licence file. Install scripts are off, so a new checkout has no
  // unpacked Electron until this runs; without it this test failed in every gate on a fresh worktree.
  execFileSync(process.execPath, [join(root, 'packages/surfaces/app/scripts/ensure-electron.mjs')], { cwd: root, stdio: 'pipe' });
  inBuildCopy((work, env) => {
    for (const [input, name] of [[undefined, 'Assistant'], [distribution, 'Backbone']]) {
      const buildEnv = { ...env, ...(input ? { BACKBONE_DISTRIBUTION: input } : {}) };
      execFileSync('pnpm', ['--filter', '@backbone-next/app', 'build'], { cwd: work, env: buildEnv, stdio: 'pipe' });
      const html = readFileSync(join(work, 'packages/surfaces/app/dist/renderer/index.html'), 'utf8');
      assert.ok(html.includes(`<title>${name}</title>`), `built title must be ${name}`);
    }
  });
});

test('mutation: a joined-path fallback to a distribution is refused by the default build before output, even with the default name', () => {
  inBuildCopy((work, env) => {
    const loader = join(work, 'scripts/lib/brand.mjs');
    const original = readFileSync(loader, 'utf8');
    const mutated = original.replace('const file = env.BACKBONE_DISTRIBUTION;', "const file = env.BACKBONE_DISTRIBUTION ?? join('distributions', '.', 'backbone', 'distribution.json');");
    assert.notEqual(mutated, original, 'mutation must change the loader');
    writeFileSync(loader, mutated);
    const config = JSON.parse(readFileSync(join(work, distribution), 'utf8'));
    config.brand.name = 'Assistant';
    writeFileSync(join(work, distribution), JSON.stringify(config));
    assert.throws(() => execFileSync('pnpm', ['--dir', 'packages/surfaces/app', 'build'], { cwd: work, env, stdio: 'pipe' }),
      error => /Default build selected a distribution/.test(String(error.stderr)), 'a default build must refuse any distribution, not merely another name');
    assert.equal(existsSync(join(work, 'packages/surfaces/app/dist/renderer/index.html')), false);
  });
});
