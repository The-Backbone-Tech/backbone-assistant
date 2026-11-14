import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { INSTALLED_TEST_ARGS, runInstalledJourney, type InstalledJourneyActions } from '../scripts/installed-journey.ts';

function fixture(t: TestContext, overrides: Partial<InstalledJourneyActions> = {}) {
  let target = '', runs = 0, prepared = 0;
  let seenEnv: NodeJS.ProcessEnv | undefined;
  t.after(() => { if (target) rmSync(dirname(target), { recursive: true, force: true }); });
  const actions: InstalledJourneyActions = {
    prepare() { prepared++; },
    buildInfo: () => ({ productName: 'White label Assistant' }),
    install(path) {
      target = path;
      const executable = join(path, 'White label Assistant.app', 'Contents', 'MacOS', 'White label Assistant');
      mkdirSync(dirname(executable), { recursive: true }); writeFileSync(executable, 'inert fixture; never executed');
      return `copy complete\n${executable}\n`;
    },
    test(_executable, env) { runs++; seenEnv = env; return { status: 0 }; },
    env: { PATH: '/fixture', BACKBONE_HARNESS: 'harness-codex', BACKBONE_CODEX_MODEL: 'must-not-run', BACKBONE_HOME: '/person/home', BACKBONE_MODEL_ENDPOINT: 'http://localhost:9999', BACKBONE_MODEL_ID: 'must-not-run' },
    ...overrides,
  };
  return { actions, target: () => target, runs: () => runs, prepared: () => prepared, env: () => seenEnv };
}

test('installed verification uses one explicit owned target and its own scripted route, then removes only that copy', async (t) => {
  const f = fixture(t); const result = await runInstalledJourney(f.actions);
  assert.equal(result.exitCode, 0); assert.equal(result.childStatus, 0); assert.equal(f.prepared(), 1); assert.equal(f.runs(), 1);
  assert.equal(f.env()?.BACKBONE_HARNESS, 'harness-pi');
  for (const key of ['BACKBONE_CODEX_MODEL', 'BACKBONE_HOME', 'BACKBONE_MODEL_ENDPOINT', 'BACKBONE_MODEL_ID']) assert.equal(f.env()?.[key], undefined);
  assert.equal(f.actions.env.BACKBONE_HARNESS, 'harness-codex', 'do not mutate the operator environment');
  assert.equal(existsSync(dirname(f.target())), false);
});
test('installed filter retains installed-capable J-01 and triage, leaving development-only fixtures separate', () => {
  const filter = new RegExp(INSTALLED_TEST_ARGS.at(-1)!);
  assert.ok(filter.test('/repo/e2e/electron.spec.ts'));
  assert.ok(filter.test('/repo/e2e/agent-roles.electron.spec.ts'));
  assert.ok(filter.test('/repo/e2e/triage.electron.spec.ts'));
  assert.ok(filter.test('/repo/e2e/now.electron.spec.ts'));
  assert.ok(filter.test('/repo/e2e/demos.electron.spec.ts'));
  assert.ok(filter.test('/repo/e2e/thread-search.electron.spec.ts'));
  assert.equal(filter.test('/repo/e2e/tools.electron.spec.ts'), false);
});
test('installed verification includes document continuity and version exports', () => {
  const filter = new RegExp(INSTALLED_TEST_ARGS.at(-1)!);
  for (const file of ['continuity.electron.spec.ts', 'export.electron.spec.ts']) assert.ok(filter.test(`/repo/e2e/${file}`), file);
});
test('installed verification selects the goals project and its installed-capable proving spec', () => {
  assert.ok(INSTALLED_TEST_ARGS.includes('--project=goals'));
  assert.ok(new RegExp(INSTALLED_TEST_ARGS.at(-1)!).test('/repo/e2e/goals.spec.ts'));
});
test('installed verification includes the keyless local-model desktop journey', () => {
  assert.ok(INSTALLED_TEST_ARGS.includes('--project=electron'));
  assert.ok(new RegExp(INSTALLED_TEST_ARGS.at(-1)!).test('/repo/e2e/local-models.electron.spec.ts'));
});
test('installer stdout never grants cleanup ownership over another directory', async (t) => {
  const foreign = mkdtempSync(join(tmpdir(), 'installed-foreign-'));
  t.after(() => rmSync(foreign, { recursive: true, force: true }));
  writeFileSync(join(foreign, 'keep.txt'), 'keep');
  const f = fixture(t); const install = f.actions.install;
  f.actions.install = async path => { await install(path); return join(foreign, 'Keep.app', 'Contents', 'MacOS', 'Keep'); };
  const result = await runInstalledJourney(f.actions);
  assert.equal(result.exitCode, 1); assert.match(result.error?.message ?? '', /owned application/); assert.equal(f.runs(), 0);
  assert.equal(existsSync(join(foreign, 'keep.txt')), true); assert.equal(existsSync(dirname(f.target())), false);
});
test('an executable symlink escaping the owned application refuses before any launch', async (t) => {
  const foreign = mkdtempSync(join(tmpdir(), 'installed-symlink-')); const binary = join(foreign, 'binary'); writeFileSync(binary, 'keep');
  t.after(() => rmSync(foreign, { recursive: true, force: true }));
  const f = fixture(t); const install = f.actions.install;
  f.actions.install = async path => { const printed = await install(path); const executable = printed.trim().split('\n').at(-1)!; rmSync(executable); symlinkSync(binary, executable); return printed; };
  const result = await runInstalledJourney(f.actions);
  assert.equal(result.exitCode, 1); assert.equal(f.runs(), 0); assert.equal(existsSync(binary), true); assert.equal(existsSync(dirname(f.target())), false);
});
test('failed installation still cleans its owned partial copy and preserves the original error', async (t) => {
  const f = fixture(t); const install = f.actions.install; const error = new Error('controlled copy failure');
  f.actions.install = async path => { await install(path); throw error; };
  const result = await runInstalledJourney(f.actions);
  assert.equal(result.error, error); assert.equal(f.runs(), 0); assert.equal(existsSync(dirname(f.target())), false);
});
for (const status of [1, 23]) test(`failed test exit ${status} is retained while the temporary copy is removed`, async (t) => {
  const f = fixture(t, { test: () => ({ status }) }); const result = await runInstalledJourney(f.actions);
  assert.equal(result.exitCode, status); assert.equal(result.childStatus, status); assert.equal(existsSync(dirname(f.target())), false);
});
test('a killed or failed-to-spawn child cannot become success', async (t) => {
  for (const child of [{ status: null, signal: 'SIGTERM' }, { status: null, error: new Error('spawn failed') }]) {
    const f = fixture(t, { test: () => child }); const result = await runInstalledJourney(f.actions);
    assert.equal(result.exitCode, 1); assert.equal(result.childStatus, null); assert.ok(result.error); assert.equal(existsSync(dirname(f.target())), false);
  }
});
test('cleanup failure cannot hide a failed test or turn a passed test into a green run', async (t) => {
  for (const status of [0, 23]) {
    const error = new Error('controlled cleanup failure'); const f = fixture(t, { test: () => ({ status }), remove() { throw error; } });
    const result = await runInstalledJourney(f.actions);
    assert.equal(result.childStatus, status); assert.equal(result.exitCode, status || 1); assert.equal(result.cleanupError, error);
    assert.equal(result.cleanupRoot, dirname(f.target()));
  }
});
test('preparation failure never reaches installation or test execution', async (t) => {
  const error = new Error('controlled preparation failure');
  const f = fixture(t, { prepare() { throw error; } });
  const result = await runInstalledJourney(f.actions);
  assert.equal(result.error, error); assert.equal(f.target(), ''); assert.equal(f.runs(), 0); assert.equal(result.exitCode, 1);
});
test('a thrown test error retains its cause and cleans only the owned application copy', async (t) => {
  const error = new Error('controlled test failure');
  const f = fixture(t, { test() { throw error; } });
  const result = await runInstalledJourney(f.actions);
  assert.equal(result.error, error); assert.equal(result.exitCode, 1); assert.equal(existsSync(dirname(f.target())), false);
});
for (const productName of ['../Person', '/Applications', 'bad\\name', '.', '..', 'line\nbreak', '']) test(`unsafe bundle name ${JSON.stringify(productName)} refuses before install`, async (t) => {
  let installed = false; const f = fixture(t, { buildInfo: () => ({ productName }), install() { installed = true; return ''; } });
  const result = await runInstalledJourney(f.actions); assert.equal(result.exitCode, 1); assert.equal(installed, false); assert.equal(f.runs(), 0);
});

test('installed verification includes both memory trust and scanner journeys', () => {
  assert.ok(new RegExp(INSTALLED_TEST_ARGS.at(-1)!).test('/repo/e2e/memory.electron.spec.ts'));
});

test('installed verification includes the bundled notices reader and package coverage', () => {
  assert.ok(new RegExp(INSTALLED_TEST_ARGS.at(-1)!).test('/repo/e2e/notices.electron.spec.ts'));
});

test('installed verification includes both away-work desktop journeys', () => {
  assert.ok(new RegExp(INSTALLED_TEST_ARGS.at(-1)!).test('/repo/e2e/away-work.electron.spec.ts'));
});

test('installed verification includes steering and interrupted conversation recovery', () => {
  assert.ok(INSTALLED_TEST_ARGS.includes('--project=electron'));
  assert.ok(new RegExp(INSTALLED_TEST_ARGS.at(-1)!).test('/repo/e2e/thread-control.electron.spec.ts'));
  assert.ok(new RegExp(INSTALLED_TEST_ARGS.at(-1)!).test('/repo/e2e/rewind.electron.spec.ts'));
});

test('installed verification includes the two-person identity journey',()=>{
  assert.ok(new RegExp(INSTALLED_TEST_ARGS.at(-1)!).test('/repo/e2e/identity.electron.spec.ts'));
});
