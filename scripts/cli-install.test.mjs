import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Ajv } from 'ajv';
import { startScriptedModel } from '../packages/platform/src/testing/scripted-model.ts';
import { validateBuild } from './native-lgpl/payload.mjs';
import { releaseSnapshots } from '../packages/platform/src/composition/snapshot.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
test('npm installs the CLI away from its checkout', { timeout: 180_000, skip: process.env.BACKBONE_INSTALL_TEST === '1' ? false : 'Opt in with pnpm test:install; this test installs npm packages.' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'backbone-install-'));
  try {
    const npmrc = join(dir, 'npmrc'); writeFileSync(npmrc, '');
    const tarball = execFileSync(process.execPath, [join(root, 'scripts/pack-cli.mjs'), dir], { cwd: dir, encoding: 'utf8' }).trim();
    const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    t.diagnostic(`CLI tarball mode: ${process.env.BACKBONE_PUBLIC_DISTRIBUTION === '1' ? 'public native bundle' : 'portable npm resolution'}.`);
    assert.doesNotMatch(listing, /\/(?:test|tests|testing|fixtures|__tests__)\//);
    const prefix = join(dir, 'prefix');
    const args = ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', '--userconfig', npmrc, tarball];
    let install = spawnSync('npm', [...args, '--offline'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    let method = 'offline';
    if (install.status !== 0) {
      method = 'network';
      install = spawnSync('npm', args, { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    }
    assert.equal(install.status, 0, install.stderr);
    t.diagnostic(`npm install succeeded using ${method}.`);
    const bin = join(prefix, 'bin/backbone');
    const person = join(dir, 'person'); mkdirSync(person);
    const env = { ...process.env, HOME: person, BACKBONE_USER_HOME: person, BACKBONE_KEYS: 'plaintext', CODEX_HOME: join(dir, 'codex-client'), BACKBONE_SYSTEM_STORE_UNAVAILABLE: '1' };
    delete env.BACKBONE_POSTGRES_NATIVE; delete env.BACKBONE_HARNESS;
    delete env.OPENAI_API_KEY; delete env.ANTHROPIC_API_KEY; delete env.CODEX_API_KEY;
    delete env.BACKBONE_MODEL_ENDPOINT; delete env.BACKBONE_MODEL_ID; delete env.BACKBONE_CODEX_MODEL;
    function run(command, args, home) {
      const r = spawnSync(command, args, { cwd: dir, env: { ...env, BACKBONE_HOME: home }, encoding: 'utf8', timeout: 90_000 });
      assert.equal(r.status, 0, `${command} ${args.join(' ')}: ${r.stdout}\n${r.stderr}`);
      return r.stdout;
    }
    assert.match(run(bin, ['--version'], join(dir, 'installed-home')), /^0\.2\.0 \([0-9a-f]{12}(, uncommitted changes)?\)\s*$/);
    // The one warning about Node's TypeScript stripping API stays away from the person; anything else would still show.
    const versionRun = spawnSync(bin, ['--version'], { cwd: dir, env: { ...env, BACKBONE_HOME: join(dir, 'installed-home') }, encoding: 'utf8', timeout: 90_000 });
    assert.equal(versionRun.status, 0, versionRun.stderr);
    assert.equal(versionRun.stderr, '', 'the installed command prints nothing on stderr for --version');
    // Inventory membership is checked against npm's actual installed tree, not the
    // dependency declarations or the list the notice generator was asked to read.
    const noticeHome = join(dir, 'notice-home');
    const denyNetwork = join(dir, 'deny-network.cjs');
    writeFileSync(denyNetwork, `const fail = () => { throw new Error('Notices attempted network access'); }; global.fetch = fail; require('node:net').Socket.prototype.connect = fail; require('node:http').request = fail; require('node:https').request = fail;`);
    const noticeEnv = { ...env, BACKBONE_HOME: noticeHome, NODE_OPTIONS: `--require ${denyNetwork}` };
    const notices = spawnSync(bin, ['notices', '--json'], { cwd: dir, env: noticeEnv, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(notices.status, 0, notices.stderr);
    assert.equal(existsSync(noticeHome), false);
    const noticeEntries = JSON.parse(notices.stdout).entries;
    const noticeIds = new Set(noticeEntries.map(entry => entry.id));
    const installedRoot = join(prefix, 'lib/node_modules/backbone-cli-local');
    const manifest = JSON.parse(readFileSync(join(installedRoot, 'package.json')));
    const publicBuild = process.env.BACKBONE_PUBLIC_DISTRIBUTION === '1';
    assert.deepEqual(manifest.os, publicBuild ? [process.platform] : undefined);
    assert.deepEqual(manifest.cpu, publicBuild ? [process.arch] : undefined);
    if (!publicBuild) for (const name of ['libiconv', 'libintl']) {
      const notice = noticeEntries.find(entry => entry.id === `postgres-native:${name}`);
      assert.equal(notice.version, 'unknown');
      assert.match(notice.text, /Corresponding source: unknown/);
      assert.match(notice.text, /Source version: unknown/);
    }
    if (process.env.BACKBONE_PUBLIC_DISTRIBUTION === '1') {
      const native = join(installedRoot, `node_modules/@embedded-postgres/${process.platform}-${process.arch}/native`);
      const build = validateBuild(native, { recordFile: 'lgpl-build.json' });
      for (const [name, item] of Object.entries(build.libraries)) {
        const notice = noticeEntries.find(entry => entry.id === `postgres-native:${name}`);
        assert.equal(notice?.version, item.version);
        assert.ok(notice.text.includes(item.archiveUrl));
        assert.ok(notice.text.includes(item.archiveSha256));
        assert.ok(notice.text.includes('Unmodified source: true'));
      }
      t.diagnostic('npm retained both rebuilt LGPL dylibs and their exact corresponding source notices.');
    }
    function covered(directory) {
      for (const child of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, child.name);
        if (child.isDirectory()) covered(file);
        else if (child.name === 'package.json' && /node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(file)) {
          const pkg = JSON.parse(readFileSync(file, 'utf8'));
          assert.ok(noticeIds.has(`${pkg.name}@${pkg.version}`), `Installed package has no notice: ${pkg.name}@${pkg.version}`);
        }
      }
    }
    covered(join(installedRoot, 'node_modules'));
    assert.ok(noticeEntries.every(entry => entry.text.trim().length > 0));
    assert.ok(noticeEntries.some(entry => entry.name === '@earendil-works/pi-coding-agent'));
    const noticeText = spawnSync(bin, ['notices'], { cwd: dir, env: noticeEnv, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(noticeText.status, 0, noticeText.stderr);
    assert.equal(existsSync(noticeHome), false);
    assert.match(noticeText.stdout, /Permission is hereby granted/);

    const oldNode = spawnSync(process.execPath, ['--input-type=module', '-e',
      `Object.defineProperty(process.versions, 'node', { value: '22.17.0' }); await import(${JSON.stringify(new URL('file://' + bin).href)});`],
    { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(oldNode.status, 1, oldNode.stderr);
    assert.match(oldNode.stderr, /needs Node\.js 22\.18 or newer; found 22\.17\.0/);
    const source = join(root, 'packages/surfaces/cli/src/main.ts');
    const installedHome = join(dir, 'installed-home'); const checkoutHome = join(dir, 'checkout-home');
    const first = spawnSync(bin, ['doctor'], { cwd: dir, env: { ...env, BACKBONE_HOME: installedHome }, encoding: 'utf8', timeout: 90_000 });
    assert.equal(first.status, 1, first.stderr);
    assert.match(first.stdout, /BACKBONE_KEYS=plaintext backbone projects create "My project"/);
    assert.match(first.stdout, /open the app and create a project there/);
    assert.match(first.stdout, /keys are stored in plain text; protect the folder/);
    assert.ok(first.stdout.indexOf('open the app') < first.stdout.indexOf('BACKBONE_KEYS=plaintext'));
    run(bin, ['projects', 'create', 'Install test'], installedHome);
    const reopened = spawnSync(bin, ['projects', 'list'], { cwd: dir, env: { ...env, BACKBONE_HOME: installedHome }, encoding: 'utf8', timeout: 90_000 });
    assert.equal(reopened.status, 0, `${reopened.stdout}\n${reopened.stderr}`);
    assert.match(reopened.stdout, /Install test/);
    assert.doesNotMatch(reopened.stdout + reopened.stderr, /grant|not a registered piece|upgrade/i);
    run(process.execPath, [source, 'projects', 'create', 'Install test'], checkoutHome);
    const installed = JSON.parse(run(bin, ['doctor', '--json'], installedHome));
    const checkout = JSON.parse(run(process.execPath, [source, 'doctor', '--json'], checkoutHome));
    assert.equal(installed.ok, true);
    for (const item of installed.checks.filter((c) => c.status !== 'ok')) {
      assert.ok(checkout.checks.some((c) => c.name === item.name && c.status !== 'ok'), `install-only warning: ${JSON.stringify(item)}`);
    }
    // Run the installed bin against a loopback model, from outside the checkout. No account or key.
    const server = await startScriptedModel('small', () => ({ text: '{"ready":true}' }));
    try {
      run(bin, ['engine', 'pi'], installedHome);
      run(bin, ['model', 'local', '--endpoint', server.url, '--model', server.model], installedHome);
      const schema = join(dir, 'answer.schema.json');
      writeFileSync(schema, JSON.stringify({ type: 'object', properties: { ready: { const: true } }, required: ['ready'], additionalProperties: false }));
      const job = await new Promise((resolve, reject) => {
        const child = spawn(bin, ['exec', 'Check readiness', '--json', '--output-schema', schema], {
          cwd: dir, env: { ...env, BACKBONE_HOME: installedHome }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000,
        });
        let out = '', err = '';
        child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
        child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
      });
      assert.equal(job.code, 0, job.out + job.err);
      const events = job.out.trim().split('\n').map(line => JSON.parse(line));
      const shippedSchema = JSON.parse(readFileSync(join(prefix, 'lib/node_modules/backbone-cli-local/packages/surfaces/cli/src/exec-events.schema.json'), 'utf8'));
      const validate = new Ajv().compile(shippedSchema);
      for (const event of events) assert.equal(validate(event), true, JSON.stringify(validate.errors));
      assert.ok(events.some(e => e.type === 'thread.started'));
      assert.equal(events.at(-1).type, 'turn.completed');
      assert.deepEqual(events.at(-1).structured_output, { ready: true });
      assert.ok(server.requests.length > 0);
      const ready = JSON.parse(run(bin, ['doctor', '--json'], installedHome));
      assert.equal(ready.ok, true);
      assert.ok(ready.checks.some(c => c.name === 'route' && c.status === 'ok'));
      t.diagnostic('Installed CLI completed a schema-checked JSONL job against a local scripted model; doctor is ready.');
    } finally { await server.close(); }
    const codexHome = join(dir, 'codex-home');
    const codex = spawnSync(bin, ['projects', 'create', 'Codex engine'], {
      cwd: dir, env: { ...env, BACKBONE_HOME: codexHome, BACKBONE_HARNESS: 'harness-codex' }, encoding: 'utf8', timeout: 90_000,
    });
    const output = codex.stdout + codex.stderr;
    assert.doesNotMatch(output, /(?:ENOENT|no such file)[^\n]*(?:backbone\.module\.json|harness-codex|packages\/modules)|not the content its manifest declares|cannot find (?:module|package)/i);
    if (codex.status === 0) {
      assert.match(output, /Created Codex engine/);
      t.diagnostic('Codex engine project created.');
    } else {
      const reason = output.match(/(?:codex[^\n]*(?:not installed|not found|not signed in|signed out|ENOENT)|spawn codex ENOENT|requires Codex[^\n]*|(?:not signed in|signed out)[^\n]*codex)/i);
      assert.ok(reason, `Unexpected Codex engine failure: ${output}`);
      t.diagnostic(`Codex engine unavailable: ${reason[0]}`);
    }
  } finally {
    releaseSnapshots(join(dir, 'installed-home'));
    releaseSnapshots(join(dir, 'checkout-home'));
    releaseSnapshots(join(dir, 'codex-home'));
    rmSync(dir, { recursive: true, force: true });
  }
});
