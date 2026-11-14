import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstalledJourney } from '../packages/surfaces/app/scripts/installed-journey.ts';
import { runInstalledDiagnostic } from './merge-queue-isolated.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-installed-diagnostic-'))), app = join(root, 'packages/surfaces/app');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(app, 'dist/package'), { recursive: true });
  writeFileSync(join(app, 'dist/package/build.json'), JSON.stringify({ productName: 'Fixture' }));
  const prepared = []; let executable;
  const execCommand = (command, args, options) => {
    assert.equal(options.cwd, app); prepared.push(args[0]);
    if (args[0] !== 'scripts/install-dmg.mjs') return '';
    executable = join(args[1], 'Fixture.app/Contents/MacOS/Fixture');
    mkdirSync(join(executable, '..'), { recursive: true }); writeFileSync(executable, 'fake executable'); return executable + '\n';
  };
  return { root, app, prepared, execCommand, executable: () => executable };
}

test('one installed diagnostic reuses fresh installation, filters one title and cleans its application', async t => {
  const f = fixture(t), file = 'packages/surfaces/app/e2e/goals.spec.ts', title = 'a goal [with.* literal characters]'; let invocation;
  const result = await runInstalledDiagnostic(f.root, file, title, { lifecycle: runInstalledJourney, execCommand: f.execCommand, project: 'goals', env: { BACKBONE_HARNESS: 'native', BACKBONE_CODEX_MODEL: 'ambient', BACKBONE_HOME: 'ambient' }, spawnCommand: (command, args, options) => {
    invocation = { command, args, options };
    assert.equal(options.env.BACKBONE_HARNESS, 'harness-pi'); assert.equal(options.env.BACKBONE_CODEX_MODEL, undefined); assert.equal(options.env.BACKBONE_HOME, undefined);
    assert.equal(options.env.BACKBONE_APP_EXECUTABLE, f.executable()); assert.ok(existsSync(f.executable())); return { status: 0 };
  } });
  assert.equal(result.exitCode, 0); assert.deepEqual(f.prepared, ['scripts/ensure-electron.mjs', 'scripts/build.mjs', 'scripts/package.mjs', 'scripts/install-dmg.mjs']);
  assert.equal(invocation.command, 'pnpm'); assert.ok(invocation.args.includes('e2e/goals.spec.ts')); assert.ok(invocation.args.includes('--project=goals')); assert.equal(invocation.args.filter(arg => arg.endsWith('.spec.ts')).length, 1);
  const pattern = new RegExp(invocation.args[invocation.args.indexOf('--grep') + 1]); assert.ok(pattern.test(title)); assert.equal(pattern.test('a goal with other characters'), false);
  assert.equal(existsSync(f.executable()), false);
});

test('a diagnostic child spawn error cannot become success and still removes its installed copy', async t => {
  const f = fixture(t);
  const result = await runInstalledDiagnostic(f.root, 'packages/surfaces/app/e2e/example.spec.ts', 'works', { lifecycle: runInstalledJourney, execCommand: f.execCommand, spawnCommand: () => ({ status: 0, error: new Error('spawn failed') }) });
  assert.equal(result.exitCode, 1); assert.ok(result.error); assert.equal(existsSync(f.executable()), false);
});

test('an installed diagnostic refuses escaped files and non-installed projects before commands', async t => {
  const f = fixture(t); let called = false;
  for (const [file, project] of [['../other.spec.ts', 'electron'], ['packages/surfaces/app/e2e/example.spec.ts', 'browser-work']]) await assert.rejects(runInstalledDiagnostic(f.root, file, 'works', { project, execCommand: () => { called = true; }, lifecycle: runInstalledJourney }), /one app e2e/i);
  assert.equal(called, false);
});
