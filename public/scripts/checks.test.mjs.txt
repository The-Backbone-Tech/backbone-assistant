import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFontPackage, licenceOk } from './licences.mjs';
import { mkdirSync, mkdtempSync, writeFileSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { edgeProblems, sqlProblems } from './structure.mjs';

const pkg = (name, layer, deps = {}) => ({ dir: `packages/${name}`, name, layer, manifest: { dependencies: deps } });

test('layers depend only downward; an exception needs a reason and an owner', () => {
  const core = pkg('core', 'core');
  const platform = pkg('platform', 'platform', { core: '1' });
  assert.deepEqual(edgeProblems([core, platform]), []);
  const bad = pkg('core', 'core', { platform: '1' });
  assert.match(edgeProblems([bad, platform]).join(), /core \(core\) depends on platform/);
  const modA = pkg('a', 'modules', { b: '1' });
  const modB = pkg('b', 'modules');
  assert.match(edgeProblems([modA, modB]).join(), /modules may only depend on platform/);
  assert.deepEqual(edgeProblems([modA, modB], [{ from: 'a', to: 'b', reason: 'r', owner: 'o' }]), []);
  assert.match(edgeProblems([pkg('x', undefined)]).join(), /set "backbone"/);
});

test('licence expressions follow the policy', () => {
  assert.ok(licenceOk('MIT'));
  assert.ok(licenceOk('(MIT OR GPL-3.0)'));
  assert.ok(!licenceOk('AGPL-3.0'));
  assert.ok(!licenceOk(undefined));
});

test('OFL-1.1 is allowed for font packages only (ADR 0001)', () => {
  assert.ok(isFontPackage('@fontsource-variable/ibm-plex-sans'));
  assert.ok(isFontPackage('@fontsource/jetbrains-mono'));
  assert.ok(!isFontPackage('fontsource-lookalike'));
  assert.ok(licenceOk('OFL-1.1', { font: true }));
  assert.ok(!licenceOk('OFL-1.1'));
  assert.ok(!licenceOk('GPL-3.0', { font: true }));
});

test('home paths are caught only where an absolute path starts', async () => {
  const { HOME_PATH } = await import('./paths.mjs');
  assert.ok(HOME_PATH.test('see /' + 'Users/alice/repo')); // public-tree: synthetic
  assert.ok(HOME_PATH.test('"/' + 'home/bob/x"')); // public-tree: synthetic
  assert.ok(!HOME_PATH.test('packages/web/src/components/home/Composer.tsx'));
});

test('pointers into the owner private notes are refused', async () => {
  const { PRIVATE_REF } = await import('./paths.mjs');
  assert.ok(PRIVATE_REF.test('see alberto/' + 'lanes/03-backbone-os/X.md'));
  assert.ok(!PRIVATE_REF.test('see owner-private:lane-03/X.md')); // public-tree: synthetic
});

test('SQL: a function defined twice, or a migration that patches function text, fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'sql-check-'));
  writeFileSync(join(root, 'a.sql'), 'CREATE FUNCTION gov.one() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;');
  writeFileSync(join(root, 'b.sql'), 'CREATE OR REPLACE FUNCTION gov.one() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;');
  writeFileSync(join(root, 'c.sql'), "SELECT regexp_replace(prosrc, 'x', 'y') FROM pg_proc;");
  writeFileSync(join(root, 'd.sql'), 'CREATE FUNCTION gov.two() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;');
  const problems = sqlProblems(root, ['a.sql', 'b.sql', 'c.sql', 'd.sql']);
  assert.ok(problems.some((p) => p.includes('gov.one is already defined in a.sql')));
  assert.ok(problems.some((p) => p.startsWith('c.sql: patches function text')));
  assert.equal(problems.length, 2);
});

test('SQL: one function name in two packages is two databases, not a duplicate', () => {
  const root = mkdtempSync(join(tmpdir(), 'sql-check-'));
  for (const p of ['packages/a', 'packages/b']) {
    mkdirSync(join(root, p), { recursive: true });
    writeFileSync(join(root, p, 'package.json'), '{}');
    writeFileSync(join(root, p, 'x.sql'), 'CREATE FUNCTION gov.one() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;');
  }
  writeFileSync(join(root, 'packages/b/y.sql'), 'CREATE FUNCTION gov.one() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;');
  const problems = sqlProblems(root, ['packages/a/package.json', 'packages/a/x.sql', 'packages/b/package.json', 'packages/b/x.sql', 'packages/b/y.sql']);
  assert.deepEqual(problems, ['packages/b/y.sql: function gov.one is already defined in packages/b/x.sql; keep one definition per function.']);
});

test('a run that leaves a backbone-* home behind fails; a clean run passes and leaves nothing', async () => {
  const { spawnSync } = await import('node:child_process');
  const wrapper = new URL('./no-leftovers.mjs', import.meta.url).pathname;
  const dirty = spawnSync(process.execPath, [wrapper, process.execPath, '-e', "require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'backbone-home-'))"], { encoding: 'utf8' });
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /left behind: backbone-home-/);
  const { rmSync } = await import('node:fs');
  rmSync(/\(in (.+)\)/.exec(dirty.stderr)?.[1] ?? '/nonexistent', { recursive: true, force: true });
  const clean = spawnSync(process.execPath, [wrapper, process.execPath, '-e', 'process.exit(0)'], { encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
  const failing = spawnSync(process.execPath, [wrapper, process.execPath, '-e', 'process.exit(3)'], { encoding: 'utf8' });
  assert.equal(failing.status, 3);
});

test('Ctrl-C reaches the command and the wrapper still checks what it left', async () => {
  const { spawn } = await import('node:child_process');
  const { rmSync } = await import('node:fs');
  const wrapper = new URL('./no-leftovers.mjs', import.meta.url).pathname;
  const make = "require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'backbone-home-')); console.log('up'); setInterval(() => {}, 1000)";
  // A group of its own stands in for the terminal's foreground group, which Ctrl-C signals as a whole.
  const run = spawn(process.execPath, [wrapper, process.execPath, '-e', make], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  run.stderr.on('data', (d) => (err += d));
  await new Promise((resolve) => run.stdout.once('data', resolve));
  const ended = new Promise((resolve) => run.once('exit', (code, signal) => resolve({ code, signal })));
  process.kill(-run.pid, 'SIGINT');
  assert.deepEqual(await ended, { code: 130, signal: null });
  assert.match(err, /left behind: backbone-home-/);
  rmSync(/\(in (.+)\)/.exec(err)?.[1] ?? '/nonexistent', { recursive: true, force: true });
});

test('nothing may depend on a distribution; a distribution uses public layers only', () => {
  const dist = pkg('dist', 'distribution', { platform: '1', mod: '1' });
  const platform = pkg('platform', 'platform');
  const mod = pkg('mod', 'modules', { platform: '1' });
  assert.deepEqual(edgeProblems([dist, platform, mod]), []);
  const leaky = pkg('platform', 'platform', { dist: '1' });
  assert.match(edgeProblems([dist, leaky, mod]).join(), /platform \(platform\) depends on dist/);
  const deep = pkg('dist', 'distribution', { core: '1' });
  assert.match(edgeProblems([deep, pkg('core', 'core')]).join(), /distribution may only depend on platform, modules, surfaces/);
});

test('docs: dead relative links fail, case included; URLs, anchors and code are ignored', async () => {
  const { linkProblems } = await import('./docs.mjs');
  const root = mkdtempSync(join(tmpdir(), 'docs-links-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/real.md'), '#');
  const text = '[ok](real.md#x) [up](../docs/real.md) [web](https://x.y) [a](#here)\n[dead](missing.md) [case](REAL.md)\n```\n[in code](nope.md)\n```\n`[span](nope.md)`';
  const problems = linkProblems(root, 'docs/index.md', text);
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems[0], /docs\/index.md:2: link to missing.md/);
  assert.match(problems[1], /REAL.md/);
});

test('docs: backticked repository paths must exist; old-repo markers, globs and placeholders are prose', async () => {
  const { pathProblems, repoPath } = await import('./docs.mjs');
  assert.equal(repoPath('docs/plan.md,'), 'docs/plan.md');
  assert.equal(repoPath('scripts/x.mjs:12'), 'scripts/x.mjs');
  assert.equal(repoPath('docs/contracts/<piece>.md'), null);
  assert.equal(repoPath('scripts/*.test.mjs'), null);
  assert.equal(repoPath('backbone-oss:packages/db/x.ts'), null);
  assert.equal(repoPath('server/src/index.ts'), null);
  const root = mkdtempSync(join(tmpdir(), 'docs-paths-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/plan.md'), '#');
  const problems = pathProblems(root, 'README.md', 'See `docs/plan.md` and `docs/gone.md`.');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /README.md:1: `docs\/gone.md` does not exist/);
});

test('docs: pnpm and node commands must name real scripts, packages and files', async () => {
  const { commandProblems } = await import('./docs.mjs');
  const root = mkdtempSync(join(tmpdir(), 'docs-cmds-'));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/real.mjs'), '');
  const packages = [
    { dir: '.', name: 'root', scripts: { check: 'x' } },
    { dir: 'packages/app', name: '@x/app', scripts: { build: 'x' } },
  ];
  const text = [
    '`pnpm check` `pnpm install` `pnpm --filter @x/app build` `pnpm --filter @x/app exec vitest`',
    '```bash',
    'pnpm run check',
    'node scripts/real.mjs --flag',
    '```',
    '`pnpm lint` `pnpm --filter @x/app start` `pnpm --filter @x/nope test` `node scripts/gone.mjs`',
  ].join('\n');
  assert.deepEqual(commandProblems('README.md', '`pnpm --dir packages/app build`', packages, root), []);
  assert.match(commandProblems('README.md', '`pnpm --dir packages/app absent`', packages, root).join(), /has no \"absent\" script/);
  const problems = commandProblems('docs/distributions.md', text, packages, root);
  assert.equal(problems.length, 4, problems.join('\n'));
  assert.ok(problems.every((p) => p.startsWith('docs/distributions.md:6:')));
  assert.match(problems.join(), /pnpm lint` is not a script/);
  assert.match(problems.join(), /@x\/app has no "start" script/);
  assert.match(problems.join(), /@x\/nope` names no workspace package/);
  assert.match(problems.join(), /node scripts\/gone.mjs/);
});

test('instruction files: root AGENTS.md stays short, CLAUDE.md only imports, nested files neither repeat nor redefine', async () => {
  const { instructionProblems, AGENTS_MAX_LINES } = await import('./docs.mjs');
  const root = mkdtempSync(join(tmpdir(), 'docs-instr-'));
  writeFileSync(join(root, 'AGENTS.md'), '');
  const rule = 'Evidence and build output are never committed to the repository.';
  const rootAgents = { root, file: 'AGENTS.md', text: `# Root\n${rule}\n| \`pnpm check\` | Runs every check. |` };
  const ok = [rootAgents, { root, file: 'CLAUDE.md', text: '@AGENTS.md\n' }, { root, file: 'packages/a/AGENTS.md', text: '# A\nOnly A-specific rules live here, said once.' }];
  assert.deepEqual(instructionProblems(ok), []);
  const long = { ...rootAgents, text: 'x\n'.repeat(AGENTS_MAX_LINES + 1) };
  assert.match(instructionProblems([long]).join(), /AGENTS.md: 101 lines/);
  const drift = { root, file: 'CLAUDE.md', text: '@AGENTS.md\nAlso: never push.' };
  assert.match(instructionProblems([rootAgents, drift]).join(), /must be exactly "@AGENTS.md"/);
  const nested = { root, file: 'packages/a/AGENTS.md', text: `# A\n- ${rule}\n| \`pnpm check\` | Runs only lint. |` };
  const problems = instructionProblems([rootAgents, nested]);
  assert.match(problems.join(), /packages\/a\/AGENTS.md:2: repeats a line from AGENTS.md/);
  assert.match(problems.join(), /describes `pnpm check` differently/);
  assert.match(instructionProblems([{ root, file: 'CLAUDE.md', text: '@MISSING.md' }]).join(), /imports @MISSING.md/);
});

test('guide steps: only bash/sh blocks tagged test run; a failing step is reported with its line; nesting is skipped', async () => {
  const { extractSteps, guideFiles, runStep, check, NESTED } = await import('./guide-steps.mjs');
  assert.deepEqual(guideFiles(['docs/distributions.md', 'README.md', 'docs/how-to/run-the-daemon.md']), ['docs/distributions.md', 'docs/how-to/run-the-daemon.md']);
  const text = ['```bash test', 'echo one', '```', '```bash', 'echo shown-not-run; exit 9', '```', '```sh test', 'exit 3', '```', '```js test', 'x', '```'].join('\n');
  const steps = extractSteps(text);
  assert.deepEqual(steps, [{ line: 1, code: 'echo one' }, { line: 7, code: 'exit 3' }]);
  const root = mkdtempSync(join(tmpdir(), 'guide-steps-'));
  assert.equal(runStep(root, steps[0]), null);
  assert.match(runStep(root, steps[1]), /^exit 3/);
  assert.match(runStep(root, { line: 1, code: 'false | true; false' }), /^exit 1/);
  assert.match(runStep(root, { line: 1, code: 'echo "$BACKBONE_GUIDE_STEP"; exit 1' }), /exit 1: 1/);
  assert.deepEqual(check(root, { env: { [NESTED]: '1' } }), []);
});

test('a nested guide failure retains the failing check before a long passing summary', async () => {
  const { runStep } = await import('./guide-steps.mjs');
  const failure = runStep(process.cwd(), { line: 13, code: "echo 'not ok - stalled child cleanup'; for i in {1..30}; do echo 'ok - later check'; done; exit 1" });
  assert.match(failure, /^exit 1/);
  assert.match(failure, /not ok - stalled child cleanup/);
  assert.match(failure, /ok - later check/);
});

test('a manifest must match the schema, its package and its content digest; never a git reference', async () => {
  const { manifestProblems, digestOf } = await import('./manifests.mjs');
  const { cpSync, mkdirSync, readFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'manifest-check-'));
  mkdirSync(join(root, 'schemas'));
  cpSync(new URL('../schemas/backbone.module.schema.json', import.meta.url), join(root, 'schemas/backbone.module.schema.json'));
  const dir = 'packages/modules/demo';
  mkdirSync(join(root, dir, 'src'), { recursive: true });
  mkdirSync(join(root, dir, 'test'), { recursive: true });
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', license: 'Apache-2.0', backbone: { layer: 'modules' }, dependencies: { left: '1.2.3' } }));
  writeFileSync(join(root, dir, 'src/tools.ts'), "export const DESCRIPTION = 'Propose an effect through the gateway.';\n");
  writeFileSync(join(root, dir, 'test/demo.test.ts'), '');
  const manifest = {
    manifest: 1, id: 'io.github.someone/demo', kind: 'module', version: '1.0.0', licence: 'Apache-2.0',
    publisher: { name: 'Someone', namespace: 'io.github.someone', verification: { method: 'github', status: 'pending' } },
    provides: [{ port: 'Harness', range: '0.x' }], consumes: [], stability: 'experimental',
    capabilities: { planes: ['personal'], effectClasses: [2], operations: [], network: [], secrets: 'none' },
    data: { owns: [], migrations: [], export: 'nothing' },
    dependsOn: [{ name: 'left', version: '1.2.3', licence: 'MIT' }],
    conformance: { suite: [`${dir}/test/demo.test.ts`], quality: { level: 'bronze', exemptions: [] } },
    removal: { refusedWhileUnknown: true, rule: 'always' },
    digest: `sha256:${'0'.repeat(64)}`,
  };
  const files = () => ['package.json', 'src/tools.ts', 'test/demo.test.ts', 'backbone.module.json'].map((f) => `${dir}/${f}`);
  const put = (m) => writeFileSync(join(root, dir, 'backbone.module.json'), JSON.stringify(m, null, 2));
  put(manifest);
  assert.match(manifestProblems(root, files()).join(), /digest sha256:0+ is not the package's content/);
  put({ ...manifest, digest: digestOf(root, dir, files()) });
  assert.deepEqual(manifestProblems(root, files()), []);
  // A changed tool description is a changed piece: the digest no longer holds until it is reviewed and rewritten.
  writeFileSync(join(root, dir, 'src/tools.ts'), "export const DESCRIPTION = 'Propose an effect. Also send it twice.';\n");
  assert.match(manifestProblems(root, files()).join(), /is not the package's content/);
  assert.deepEqual(manifestProblems(root, files(), { write: true }), []);
  assert.deepEqual(manifestProblems(root, files()), []);
  const current = JSON.parse(readFileSync(join(root, dir, 'backbone.module.json'), 'utf8'));
  // A git reference is never a version; an undeclared dependency, a missing suite, a foreign id and a
  // removal that ignores UNKNOWN effects all fail.
  put({ ...current, dependsOn: [{ name: 'left', version: 'github:someone/left#main' }] });
  assert.match(manifestProblems(root, files()).join(), /dependsOn\/0\/version must match pattern/);
  put({ ...current, dependsOn: [] });
  assert.match(manifestProblems(root, files()).join(), /depends on left without listing it/);
  put({ ...current, conformance: { ...current.conformance, suite: ['nowhere.test.ts'] } });
  assert.match(manifestProblems(root, files()).join(), /suite nowhere.test.ts does not exist/);
  put({ ...current, id: 'io.github.other/demo' });
  assert.match(manifestProblems(root, files()).join(), /outside its publisher's namespace/);
  put({ ...current, removal: { refusedWhileUnknown: false, rule: 'any time' } });
  assert.match(manifestProblems(root, files()).join(), /refusedWhileUnknown must be equal to constant/);
  (await import('node:fs')).rmSync(root, { recursive: true, force: true });
});

test('a manifest kind names its layer: the core and the platform describe themselves too, each only in its own layer', async () => {
  const { manifestProblems, digestOf } = await import('./manifests.mjs');
  const { cpSync, mkdirSync, rmSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'manifest-kind-'));
  mkdirSync(join(root, 'schemas'));
  cpSync(new URL('../schemas/backbone.module.schema.json', import.meta.url), join(root, 'schemas/backbone.module.schema.json'));
  const dir = 'packages/core';
  mkdirSync(join(root, dir, 'test'), { recursive: true });
  writeFileSync(join(root, dir, 'test/core.test.ts'), '');
  const files = ['package.json', 'test/core.test.ts', 'backbone.module.json'].map((f) => `${dir}/${f}`);
  const pkgAt = (layer) => writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name: 'core', version: '1.0.0', license: 'Apache-2.0', backbone: { layer } }));
  const put = (kind) => {
    const m = {
      manifest: 1, id: 'io.github.someone/core', kind, version: '1.0.0', licence: 'Apache-2.0',
      publisher: { name: 'Someone', namespace: 'io.github.someone', verification: { method: 'github', status: 'pending' } },
      provides: [{ port: 'Crossings', range: '0.x' }], consumes: [], stability: 'experimental',
      capabilities: { planes: ['personal'], effectClasses: [], operations: [], network: [], secrets: 'none' },
      data: { owns: ['ledger'], migrations: [], export: 'not built' }, dependsOn: [],
      conformance: { suite: [`${dir}/test/core.test.ts`], quality: { level: 'bronze', exemptions: [] } },
      removal: { refusedWhileUnknown: true, rule: 'never removed; replaced whole' },
      digest: `sha256:${'0'.repeat(64)}`,
    };
    writeFileSync(join(root, dir, 'backbone.module.json'), JSON.stringify(m));
    writeFileSync(join(root, dir, 'backbone.module.json'), JSON.stringify({ ...m, digest: digestOf(root, dir, files) }));
  };
  pkgAt('core');
  put('core');
  assert.deepEqual(manifestProblems(root, files), []);
  put('platform');
  assert.match(manifestProblems(root, files).join(), /kind platform sits in layer core; expected platform/);
  pkgAt('modules');
  put('core');
  assert.match(manifestProblems(root, files).join(), /kind core sits in layer modules; expected core/);
  put('kernel');
  assert.match(manifestProblems(root, files).join(), /\/kind must be equal to one of the allowed values \(core, platform, module, surface\)/);
  rmSync(root, { recursive: true, force: true });
});

test('a manifest follows the licence policy: OFL-1.1 only for a font package', async () => {
  const { manifestProblems } = await import('./manifests.mjs');
  const { cpSync, mkdirSync, rmSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'manifest-font-'));
  mkdirSync(join(root, 'schemas'));
  cpSync(new URL('../schemas/backbone.module.schema.json', import.meta.url), join(root, 'schemas/backbone.module.schema.json'));
  const dir = 'packages/surfaces/demo';
  mkdirSync(join(root, dir), { recursive: true });
  const files = [`${dir}/package.json`, `${dir}/backbone.module.json`];
  const put = (dep) => {
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', license: 'Apache-2.0', backbone: { layer: 'surfaces' }, dependencies: { [dep]: '5.3.0' } }));
    writeFileSync(join(root, dir, 'backbone.module.json'), JSON.stringify({
      manifest: 1, id: 'io.github.someone/demo', kind: 'surface', version: '1.0.0', licence: 'Apache-2.0',
      publisher: { name: 'Someone', namespace: 'io.github.someone', verification: { method: 'github', status: 'pending' } },
      provides: [], consumes: [], stability: 'experimental',
      capabilities: { planes: ['personal'], effectClasses: [], operations: [], network: [], secrets: 'none' },
      data: { owns: [], migrations: [], export: 'nothing' },
      dependsOn: [{ name: dep, version: '5.3.0', licence: 'OFL-1.1' }],
      conformance: { suite: [`${dir}/package.json`], quality: { level: 'bronze', exemptions: [] } },
      removal: { refusedWhileUnknown: true, rule: 'always' },
      digest: `sha256:${'0'.repeat(64)}`,
    }));
  };
  put('@fontsource-variable/ibm-plex-sans');
  assert.doesNotMatch(manifestProblems(root, files).join(), /licence/);
  put('not-a-font');
  assert.match(manifestProblems(root, files).join(), /not-a-font's licence OFL-1.1 is outside docs\/adr\/0001/);
  rmSync(root, { recursive: true, force: true });
});

test('a piece README carries a generated block that follows its manifest', async () => {
  const { BEGIN, END, readmeProblems } = await import('./module-readme.mjs');
  const root = mkdtempSync(join(tmpdir(), 'readme-check-'));
  const dir = 'packages/surfaces/demo';
  mkdirSync(join(root, dir), { recursive: true });
  const manifest = {
    id: 'io.github.someone/demo', kind: 'surface', version: '1.0.0', licence: 'Apache-2.0',
    publisher: { name: 'Someone', namespace: 'io.github.someone', verification: { method: 'github', status: 'pending' } },
    provides: [], consumes: [{ port: 'Gateway', range: '0.x' }], stability: 'experimental',
    capabilities: { planes: ['personal'], effectClasses: [3], operations: ['outbox.write'], network: [], secrets: 'none' },
    data: { owns: [], migrations: [], export: 'nothing' }, dependsOn: [],
    conformance: { suite: ['x.test.ts'], quality: { level: 'bronze', exemptions: [] } },
    removal: { refusedWhileUnknown: true, rule: 'revoke first' },
  };
  writeFileSync(join(root, dir, 'backbone.module.json'), JSON.stringify(manifest));
  const files = [`${dir}/backbone.module.json`];
  const readme = join(root, dir, 'README.md');
  writeFileSync(readme, '# Demo\n');
  assert.match(readmeProblems(root, files).join(), /add the generated block/);
  writeFileSync(readme, `# Demo\n\n${BEGIN}\n${END}\n`);
  assert.match(readmeProblems(root, files).join(), /out of date/);
  assert.deepEqual(readmeProblems(root, files, { write: true }), []);
  assert.deepEqual(readmeProblems(root, files), []);
  writeFileSync(join(root, dir, 'backbone.module.json'), JSON.stringify({ ...manifest, stability: 'stable' }));
  assert.match(readmeProblems(root, files).join(), /out of date/);  (await import('node:fs')).rmSync(root, { recursive: true, force: true });
});

test('docs: a reference into the other repository is checked there when it is at hand, and never a link', async () => {
  const { linkProblems, markerProblems } = await import('./docs.mjs');
  const way = mkdtempSync(join(tmpdir(), 'docs-way-'));
  mkdirSync(join(way, 'docs'));
  writeFileSync(join(way, 'docs/plan.md'), '#');
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q'], { cwd: way });
  writeFileSync(join(way, '.gitignore'), 'dist/\n');
  const text = 'See `backbone-way:docs/plan.md` and backbone-way:docs/gone.md.\n```\nbackbone-way:docs/in-code.md\n```\nBuilt into `backbone-way:dist/app/`.';
  assert.deepEqual(markerProblems('README.md', text, {}), []);
  assert.match(markerProblems('README.md', 'See `backbone-way:distributions/backbone/distribution.json`.', {}).join(), /now in this repository/);
  const problems = markerProblems('README.md', text, { 'backbone-way': way });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /README.md:1: backbone-way:docs\/gone.md names nothing in backbone-way/);
  const base = mkdtempSync(join(tmpdir(), 'docs-base-'));
  assert.match(linkProblems(base, 'README.md', '[plan](backbone-way:docs/plan.md)').join(), /plain reference/);
});

test('contamination: configuration may live here; package/build dependencies, vision citations, core requirement IDs and shipped brand literals fail', async () => {
  const { fileProblems, shippedStrings } = await import('./contamination.mjs');
  // Owner decision, 10 November 2026: configuration may live beside packages.
  assert.deepEqual(fileProblems('distributions/backbone/x.json', '{}'), []);
  assert.deepEqual(fileProblems('docs/map.md', 'see `distributions/backbone`'), []);
  for (const [file, text] of [
    ['packages/platform/src/x.ts', "import d from '../../../distributions/backbone/distribution.json';"],
    ['packages/platform/src/x.ts', "readFileSync(new URL('../../../distributions/backbone/distribution.json', import.meta.url));"],
    ['packages/platform/package.json', '{"dependencies":{"brand":"file:../../distributions/backbone"}}'],
    ['packages/platform/test/x.test.ts', "import d from '../../../distributions/backbone/distribution.json';"],
    ['scripts/lib/brand.mjs', "const fallback = 'distributions/backbone/distribution.json';"],
    ['scripts/build.mjs', "const fallback = join(root, 'distributions', 'backbone', 'distribution.json');"],
    ['package.json', '{"scripts":{"build":"BACKBONE_DISTRIBUTION=distributions/backbone/distribution.json pnpm build"}}'],
  ]) assert.match(fileProblems(file, text).join(), /depends on the Backbone distribution/);

  assert.match(fileProblems('README.md', 'Purpose: [vision](docs/vis' + 'ion.md)').join(), /cites vis\x69on.md/);
  assert.match(fileProblems('packages/core/schema/gov/x.sql', '-- the rule (R-GOV-MAND-01)').join(), /product requirement R-GOV-MAND-01/);
  assert.deepEqual(fileProblems('packages/platform/src/x.ts', '// the rule (R-GOV-MAND-01)'), []);
  assert.deepEqual(fileProblems('docs/adr/0001-x.md', 'Backbone history: docs/vis' + 'ion.md'), []);
  const app = "// As the old Backbone app had it.\nimport x from '@backbone-next/platform';\nexport const T = () => <p title={'Backbone'}>Ask Backbone</p>;\nconst t = `Hi ${n} from Backbone`;\nprocess.env.BACKBONE_HOME;";
  assert.deepEqual(shippedStrings('packages/surfaces/app/src/x.tsx', app).filter((v) => /Backbone/.test(v)), ['Backbone', 'Ask Backbone', ' from Backbone']);
  assert.equal(fileProblems('packages/surfaces/app/src/x.tsx', app).length, 3);
  assert.deepEqual(fileProblems('packages/surfaces/app/test/x.test.ts', "const t = 'Backbone';"), []);
  assert.match(fileProblems('packages/core/schema/gov/y.sql', "-- Backbone's own state\nSELECT 'Backbone';").join(), /reserved brand/);
  assert.equal(fileProblems('packages/core/schema/gov/y.sql', "-- Backbone's own state\nSELECT 'System';").length, 0);
  assert.match(fileProblems('packages/surfaces/app/scripts/package.mjs', "const id = 'ai.thebackbone.next';").join(), /reserved brand/);
});

test('distributions: the schema, real modules and the brand profile; a build never guesses a brand', async () => {
  const { DEFAULT_BRAND, distributionProblems, loadBrand } = await import('./lib/brand.mjs');
  const { check } = await import('./distributions.mjs');
  const ok = { name: 'acme', brand: { name: 'Acme Helper', appId: 'com.acme.helper' }, modules: ['harness-pi'], defaults: { harness: 'harness-pi' } };
  assert.deepEqual(distributionProblems(ok), []);
  assert.match(distributionProblems({ ...ok, brand: { ...ok.brand, logoScript: 'x.js' } }).join(), /additional properties \(logoScript\)/);
  assert.match(distributionProblems({ ...ok, core: { allowAll: true } }).join(), /additional properties \(core\)/);
  assert.deepEqual(loadBrand({}), { ...DEFAULT_BRAND });
  const root = mkdtempSync(join(tmpdir(), 'dist-check-'));
  mkdirSync(join(root, 'examples/acme'), { recursive: true });
  mkdirSync(join(root, 'packages/modules/harness-pi'), { recursive: true });
  writeFileSync(join(root, 'packages/modules/harness-pi/package.json'), '{}');
  writeFileSync(join(root, 'examples/acme/distribution.json'), JSON.stringify(ok));
  assert.equal(loadBrand({ BACKBONE_DISTRIBUTION: 'examples/acme/distribution.json' }, root).name, 'Acme Helper');
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q'], { cwd: root });
  assert.deepEqual(check(root), []);
  writeFileSync(join(root, 'examples/acme/distribution.json'), JSON.stringify({ ...ok, modules: ['harness-pi', 'nowhere'], brand: { name: '' } }));
  const problems = check(root).join('\n');
  assert.match(problems, /module nowhere is not in packages\/modules/);
  assert.match(problems, /\/brand\/name must NOT have fewer than 1 characters/);
  assert.throws(() => loadBrand({ BACKBONE_DISTRIBUTION: 'examples/acme/distribution.json' }, root), /not a valid distribution/);
});

test('a brand icon is a PNG beside its distribution, resolved to its path; a missing one stops the build', async () => {
  const { distributionProblems, loadBrand } = await import('./lib/brand.mjs');
  const ok = { name: 'harbor', brand: { name: 'Harbor', icon: 'icon.png' }, modules: ['harness-pi'], defaults: { harness: 'harness-pi' } };
  assert.deepEqual(distributionProblems(ok), []);
  assert.match(distributionProblems({ ...ok, brand: { name: 'Harbor', icon: '../elsewhere/icon.png' } }).join(), /pattern/);
  assert.match(distributionProblems({ ...ok, brand: { name: 'Harbor', icon: 'icon.svg' } }).join(), /pattern/);
  const root = mkdtempSync(join(tmpdir(), 'brand-icon-'));
  writeFileSync(join(root, 'distribution.json'), JSON.stringify(ok));
  assert.throws(() => loadBrand({ BACKBONE_DISTRIBUTION: 'distribution.json' }, root), /icon\.png is not there/);
  writeFileSync(join(root, 'icon.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.equal(loadBrand({ BACKBONE_DISTRIBUTION: 'distribution.json' }, root).icon, join(root, 'icon.png'));
});

test('radar: entries follow the format, are named after their capability and cite listed sources', async () => {
  const { entryProblems } = await import('./radar.mjs');
  const entry = {
    schema: 'backbone-radar/1', capability: 'cap-x', family: 'X', decision: { status: 'open' }, leader: null, challenger: null,
    ring: 'assess', evidenceStrength: 'weak', evidenceDate: '2026-10-25', revalidateBy: '2026-11-25', exit: 'swap it', licence: {}, nextReview: {},
    why: [{ claim: 'c', label: 'docs', sources: ['s1'], checked: 'read 2026-10-25' }],
    sources: [{ id: 's1', url: 'https://example.org', date: '2026-10-25', what: 'w' }],
  };
  assert.deepEqual(entryProblems('radar/cap-x.json', entry), []);
  assert.match(entryProblems('radar/cap-y.json', entry).join(), /differs from the file name/);
  assert.match(entryProblems('radar/cap-x.json', { ...entry, ring: 'maybe' }).join(), /\/ring must be equal to one of the allowed values/);
  const orphan = { ...entry, components: [{ ring: 'trial', why: [{ label: 'source', sources: ['s9'], checked: 'x' }] }] };
  assert.match(entryProblems('radar/cap-x.json', orphan).join(), /cites source s9/);
});

test('conformance: jobs cite real invariants, contracts and paths, and no requirement IDs', async () => {
  const { invariantsIn, jobProblems } = await import('./conformance.mjs');
  const invariants = invariantsIn('| I-3 | Authority only narrows. |\n| I-6 | UNKNOWN is never resent. |');
  assert.deepEqual([...invariants], ['I-3', 'I-6']);
  const root = mkdtempSync(join(tmpdir(), 'conformance-'));
  mkdirSync(join(root, 'docs/contracts'), { recursive: true });
  writeFileSync(join(root, 'docs/contracts/effect-gateway.md'), '#');
  const job = { title: 't', owns: ['docs'], invariants: ['I-6'], contracts: ['docs/contracts/effect-gateway.md'] };
  assert.deepEqual(jobProblems(root, 'C-x', job, [['job.md', 'Stop: UNKNOWN (I-6).']], invariants), []);
  const bad = jobProblems(root, 'C-x', { ...job, invariants: ['I-99'], contracts: ['docs/contracts/gone.md'] }, [['job.md', 'covers R-BASE-04']], invariants).join('\n');
  assert.match(bad, /I-99 is not an invariant/);
  assert.match(bad, /gone.md does not exist/);
  assert.match(bad, /names product requirement R-BASE-04/);
});

test('the image\'s build context is current, and holds no credentials, data home or evidence beside the sources', async () => {
  const { contextFiles, dockerignoreText } = await import('./lib/docker-context.mjs');
  const { readFileSync, rmSync } = await import('node:fs');
  const repo = join(import.meta.dirname, '..');
  const text = dockerignoreText(repo);
  assert.equal(readFileSync(join(repo, '.dockerignore'), 'utf8'), text, '.dockerignore is stale: run node scripts/lib/docker-context.mjs --write');
  const root = mkdtempSync(join(tmpdir(), 'context-'));
  try {
    const put = (path, body = 'x') => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), body); };
    for (const f of ['package.json', 'pnpm-lock.yaml', 'packages/platform/package.json', 'packages/platform/src/api.ts', 'packages/core/schema/app/channel_accounts.sql', 'packages/modules/harness-pi/README.md']) put(f);
    // What must never be sent, placed where the sources are.
    const never = ['packages/platform/credentials.json', 'packages/platform/src/credentials.json', 'packages/platform/src/home/keys/vault.json',
      'packages/platform/home/pg/data/PG_VERSION', 'packages/modules/harness-pi/credentials.json', 'packages/modules/harness-pi/home/kernel.json',
      'packages/platform/src/.env', 'packages/surfaces/cli/src/token.txt', 'evidence/shot.png', '.env', 'packages/platform/node_modules/x/index.ts'];
    for (const f of never) put(f);
    const sent = contextFiles(root, text);
    for (const f of never) assert.ok(!sent.includes(f), `${f} is not in the context`);
    for (const f of ['package.json', 'pnpm-lock.yaml', 'packages/platform/package.json', 'packages/platform/src/api.ts', 'packages/core/schema/app/channel_accounts.sql', 'packages/modules/harness-pi/README.md']) assert.ok(sent.includes(f), `${f} is in the context`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function closedCoreFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'sql-version-check-'));
  try {
    const core = join(root, 'packages/core'); mkdirSync(join(core, 'src/db'), {recursive:true});
    cpSync(new URL('../packages/core/schema/', import.meta.url), join(core, 'schema'), {recursive:true});
    cpSync(new URL('../packages/core/src/db/material-closure-release.generated.ts', import.meta.url), join(core, 'src/db/material-closure-release.generated.ts'));
    cpSync(new URL('../packages/core/src/db/material-closure-hardening-release.generated.ts', import.meta.url), join(core, 'src/db/material-closure-hardening-release.generated.ts'));
    // Explicit identity releases are independent files, just like the material releases.
    for (const file of ['identity-release.generated.ts','identity-work-release.generated.ts','identity-role-revocation-release.generated.ts','identity-resource-release.generated.ts','identity-admission-release.generated.ts','identity-guarantees-release.generated.ts','identity-platform-release.generated.ts','identity-role-closure-release.generated.ts','identity-piece-admission-release.generated.ts','identity-lookup-closure-release.generated.ts','identity-invitation-closure-release.generated.ts']) cpSync(new URL('../packages/core/src/db/'+file, import.meta.url),join(core,'src/db',file));
    const files = ['packages/core/package.json', 'packages/core/schema/gov/_material_source_state.sql',
      'packages/core/schema/versions/material-closure-foundation-v1/gov/_material_source_state.sql'];
    run(root, files);
  } finally { rmSync(root, {recursive:true, force:true}); }
}

test('SQL: an explicitly released whole-definition replacement is checked as a version, not a duplicate', () => {
  closedCoreFixture((root, files) => assert.deepEqual(sqlProblems(root, files), []));
});

test('SQL: Core versions are not a directory exclusion; unlisted SQL and stale current maps fail', () => {
  closedCoreFixture((root, files) => {
    writeFileSync(join(root, 'packages/core/schema/versions/extra.sql'), 'SELECT 1;');
    assert.match(sqlProblems(root, files).join('\n'), /unlisted or missing Core SQL source/);
    rmSync(join(root, 'packages/core/schema/versions/extra.sql'));
    writeFileSync(join(root, 'packages/core/schema/current.json'), '{}');
    assert.match(sqlProblems(root, files).join('\n'), /current definition index differs/);
  });
});

test('SQL: function-text patching remains forbidden in a closed Core source and every other package', () => {
  closedCoreFixture((root, files) => {
    const file = files.at(-1), path = join(root, file);
    writeFileSync(path, readFileSync(path, 'utf8') + '\nSELECT pg_get_functiondef(1);\n');
    assert.ok(sqlProblems(root, files).some(p => p.startsWith(file + ': patches function text')));
    writeFileSync(join(root, 'outside.sql'), "SELECT regexp_replace(prosrc, 'x', 'y');");
    assert.ok(sqlProblems(root, [...files, 'outside.sql']).some(p => p.startsWith('outside.sql: patches function text')));
  });
});


test('docs: moved acceptance references are local while remaining external references stay optional', async () => {
  const { markerProblems } = await import('./docs.mjs');
  const root = mkdtempSync(join(tmpdir(), 'docs-local-'));
  try {
    mkdirSync(join(root, 'acceptance/J-triage'), { recursive: true });
    writeFileSync(join(root, 'acceptance/J-triage/job.md'), '# Job');
    assert.ok(markerProblems('README.md', 'backbone-way:acceptance/J-triage/job.md', {}, root).length > 0);
    mkdirSync(join(root, 'radar'));
    writeFileSync(join(root, 'radar/README.md'), '# Local format, distinct from Way choices');
    assert.deepEqual(markerProblems('README.md', 'backbone-way:radar/README.md', {}, root), []);
    assert.ok(markerProblems('README.md', '[job](backbone-way:acceptance/J-triage/job.md)', {}, root).length > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('docs: deferred owner records remain optional and encoded external paths are checked when supplied', async () => {
  const { markerProblems } = await import('./docs.mjs');
  const root = mkdtempSync(join(tmpdir(), 'docs-owner-'));
  try {
    mkdirSync(join(root, 'research notes'));
    writeFileSync(join(root, 'research notes/report.md'), '# Report');
    assert.deepEqual(markerProblems('README.md', 'backbone-owner:docs/execution.md'), []); // public-tree: synthetic
    assert.deepEqual(markerProblems('README.md', 'backbone-owner:research%20notes/report.md', { 'backbone-owner': root }), []); // public-tree: synthetic
    assert.ok(markerProblems('README.md', 'backbone-owner:docs/missing.md', { 'backbone-owner': root }).length > 0); // public-tree: synthetic
    assert.ok(markerProblems('README.md', 'backbone-owner:bad%ZZ/path', { 'backbone-owner': root }).length > 0); // public-tree: synthetic
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('docs: handed-over execution records use local links while uncopied owner evidence stays external', async () => {
  const { markerProblems } = await import('./docs.mjs');
  const root = mkdtempSync(join(tmpdir(), 'docs-records-'));
  try {
    mkdirSync(join(root, 'docs/history'), { recursive: true });
    for (const path of ['docs/execution.md', 'docs/history/execution-through-2026-11-10.md', 'docs/history/integration-record-through-2026-11-10.md']) {
      writeFileSync(join(root, path), '# Record');
      assert.ok(markerProblems('README.md', `backbone-owner:${path}`, {}, root).length > 0); // public-tree: synthetic
    }
    assert.deepEqual(markerProblems('README.md', 'backbone-owner:evidence/retained-run.json', {}, root), []); // public-tree: synthetic
    assert.deepEqual(markerProblems('README.md', 'backbone-owner:docs/history/execution-not-copied.md', {}, root), []); // public-tree: synthetic
  } finally { rmSync(root, { recursive: true, force: true }); }
});
