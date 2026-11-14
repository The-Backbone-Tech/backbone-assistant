// Explicit Linux-only extended qualification. Never a model/account or an existing socket target.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessLinuxAudit, refuseVisibleHostDatagrams } from '../src/linux-audit.ts';
import { overrides, CODEX_VERSION, capture } from '../src/native.ts';
if (process.platform !== 'linux') throw Error('Extended native Linux security probes have not run on this OS.');
const helper = process.env.BACKBONE_CODEX_SECURITY_PROBE;
const runParent = process.env.BACKBONE_CODEX_AUDIT_RUN_ROOT;
assert.ok(helper?.startsWith('/usr/'), 'Install the owned probe helper in the minimal runtime view.');
assert.ok(runParent?.startsWith('/run/'), 'Supply the owned /run probe directory.');
const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-linux-security-')));
const support = await mkdtemp(join(await realpath(homedir()), '.backbone-linux-security-'));
const runRoot = await mkdtemp(join(runParent, 'probe-'));
const savedEnvironment = { ...process.env };
const env = { PATH: process.env.PATH, HOME: support, CODEX_HOME: join(support, '.codex'), LANG: 'C.UTF-8' };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);
try {
  await mkdir(env.CODEX_HOME); await writeFile(join(env.CODEX_HOME, 'config.toml'), 'cli_auth_credentials_store="file"\n');
  const version = spawnSync('codex', ['--version'], { env, encoding: 'utf8' });
  assert.equal(version.status, 0); assert.equal(version.stdout.trim(), 'codex-cli ' + CODEX_VERSION);
  for (const environment of ['full', 'contained', 'bare', 'readOnly']) {
    const work = join(root, environment), stage = join(work, 'workspace'); await mkdir(stage, { recursive: true });
    const token = 'owned-security-' + environment;
    const single = join(work, 'denied-file'), late = join(work, 'late-denied');
    const data_home = join(work, 'data-home'), arrangement = join(work, 'arrangement');
    for (const path of [data_home, arrangement]) { await mkdir(path); await writeFile(join(path, 'canary'), token); }
    await writeFile(single, token);
    // Same extraDenies option/map as production, including this synthetic Host's real data home.
    const options = { environment, extraDenies: [data_home, arrangement, single, late] };
    const command = ['codex', 'sandbox', '-C', stage, '-P', 'backbone-native-staged', ...overrides([], environment, [], options.extraDenies, [], undefined, stage)];
    const spec = { command, token, single, late, data_home, arrangement, release: join(stage, '.probe-release'),
      stream: join(runRoot, environment + '-stream'), abstract: 'backbone-owned-' + process.pid + '-' + environment,
      abstract_datagram: 'backbone-owned-dgram-' + process.pid + '-' + environment,
      datagram: join(runRoot, environment + '-datagram'), run_root: runRoot };
    const child = spawnSync('/usr/bin/python3', [helper, '--host', JSON.stringify(spec)], { env, encoding: 'utf8', timeout: 35000, maxBuffer: 1000000 });
    assert.equal(child.signal, null, 'extended security probe timed out');
    assert.equal(child.status, 0, child.stderr);
    const observed = JSON.parse(child.stdout);
    console.log(JSON.stringify({ environment, observed, account: false, model: false }));
    const assessment = assessLinuxAudit(environment, observed);
    const guard = () => refuseVisibleHostDatagrams(args => capture(options, args, stage, new AbortController().signal), stage, environment, process.execPath, options.extraDenies);
    if (observed.host_datagram_visible) await assert.rejects(guard(), /Host datagram socket is visible/);
    else await guard();
    console.log(JSON.stringify({ environment, assessment, account: false, model: false }));
  }
} finally {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
  await rm(root, { recursive: true, force: true }); await rm(support, { recursive: true, force: true }); await rm(runRoot, { recursive: true, force: true });
}
