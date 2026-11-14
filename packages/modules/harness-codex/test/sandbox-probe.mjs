// Explicit real-client OS qualification: synthetic owned HOME/CODEX_HOME, no account or model call.
// Run on either supported OS; fake transport tests are intentionally separate.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, link, lstat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { CODEX_VERSION, parseFeatures, bareForcedOffFrom, NativeClient, nativePlatform, capture, overrides, configValue, verifyConfig } from '../src/native.ts';
import { writeBareCatalog } from '../src/index.ts';
import { verifySandbox } from '../src/staging.ts';
import { SNAPSHOT_PROGRAM } from '../src/snapshot.ts';

nativePlatform();
const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-os-probe-')));
const saved = { ...process.env };
// The pinned Linux client refuses helper aliases under std::env::temp_dir().
// Keep only its synthetic support home outside temp; staged data and adverse canaries stay in temp.
const support = await mkdtemp(join(await realpath(homedir()), '.backbone-codex-probe-'));
const home = join(support, 'home'); await mkdir(home); await mkdir(join(home, '.codex'));
await writeFile(join(home, '.codex', 'config.toml'), 'cli_auth_credentials_store = "file"\n');
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, { HOME: home, CODEX_HOME: join(home, '.codex'), PATH: saved.PATH, LANG: 'C.UTF-8' });
const signal = new AbortController().signal;
let passed = 0; const failures = [];
const ok = name => { passed++; console.log('PASS ' + name); };
try {
  for (const environment of ['full', 'contained', 'bare', 'readOnly']) {
    try {
    const work = join(root, environment), stage = join(work, 'workspace');
    await mkdir(stage, { recursive: true }); await mkdir(join(stage, '.backbone-tmp'));
    const dataHome = join(work, 'data-home'), arrangement = join(work, 'arrangement');
    await mkdir(dataHome); await mkdir(arrangement);
    const options = { environment, extraDenies: [dataHome, arrangement], requestTimeoutMs: 15000 };
    assert.equal((await capture(options, ['--version'], stage, signal)).trim(), `codex-cli ${CODEX_VERSION}`);
    await verifySandbox(async (args, observe) => { const raw = await capture(options, args, stage, signal, 1_000_000, false, observe); console.log('OBSERVED ' + environment + ' ' + raw.trim()); if (raw.includes('\"outside_write\":\"allowed\"')) { let hostPath; try { await lstat(join(work, 'outside-write-canary')); hostPath = 'present'; } catch (error) { hostPath = error.code === 'ENOENT' ? 'absent' : 'unknown'; } console.log('HOST OUTSIDE WRITE ' + JSON.stringify({ environment, hostPath })); } return raw; }, work, stage, environment, process.execPath, process.platform, options.extraDenies);
    if (process.platform === 'linux' && environment === 'readOnly') console.log('PROVEN readOnly: Host outside trees unchanged; concurrent distinct namespace and later invocation lack private writes');
    ok(`${environment}: physical admission (inside/outside writes, protected direct/symlink/child/proc reads, loopback)`);
    const bare = environment === 'bare' || environment === 'readOnly' ? await writeBareCatalog(work, await capture(options, ['debug', 'models'], stage, signal, 16000000)) : undefined;
    const forcedOff = bare ? bareForcedOffFrom(parseFeatures(await capture(options, ['features', 'list'], stage, signal))) : [];
    const client = new NativeClient(options, stage, [], [], forcedOff, bare);
    try {
      await client.initialize();
      verifyConfig(configValue(await client.request('config/read', { cwd: stage, includeLayers: false })), [], environment, options.extraDenies, bare?.catalog, stage);
      ok(`${environment}: actual OS and effective permission/feature/environment readback`);
    } finally { await client.close(); }
    const sandbox = program => capture(options, ['sandbox', '-C', stage, '-P', 'backbone-native-staged', ...overrides([], environment, [], options.extraDenies, [], undefined, stage), '--', process.execPath, '--openssl-config=/dev/null', '-e', program], stage, signal, 16000000);
    await writeFile(join(stage, 'note.md'), 'source');
    const original = JSON.parse(await sandbox(SNAPSHOT_PROGRAM));
    assert.deepEqual(original.files, [{ name: 'note.md', base64: Buffer.from('source').toString('base64') }]);
    ok(`${environment}: immutable snapshot uses the same native route`);
    for (const adverse of ['symlink', 'hardlink', 'binary']) {
      const target = join(stage, 'bad.md');
      if (adverse === 'symlink') await symlink(join(work, 'outside-canary'), target);
      if (adverse === 'hardlink') await link(join(stage, 'note.md'), target);
      if (adverse === 'binary') await writeFile(target, Buffer.from([0, 255]));
      await assert.rejects(sandbox(SNAPSHOT_PROGRAM));
      await rm(target);
      ok(`${environment}: snapshot refuses ${adverse}`);
    }
    if (environment !== 'readOnly') {
      const text = await sandbox("const c=require('node:child_process'); const r=c.spawnSync('/bin/sh',['-c','cat <<EOF\\nheredoc works\\nEOF'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',TMPDIR:process.cwd()+'/.backbone-tmp'}}); if(r.status!==0)process.exit(1); require('node:fs').writeSync(1,r.stdout);");
      assert.equal(text, 'heredoc works\n'); ok(`${environment}: child shell heredoc scratch`);
    }
    } catch (error) { failures.push({ environment, error: error.message }); console.log('FAIL ' + environment + ': ' + error.message); }
  }
  console.log(JSON.stringify({ platform: process.platform, passed, failed: failures.length, failures, account: false, model: false }));
  assert.equal(failures.length, 0, 'Every native environment must pass; no property is waived.');
} finally {
  for (const name of Object.keys(process.env)) delete process.env[name]; Object.assign(process.env, saved);
  try { await rm(root, { recursive: true, force: true }); } finally { await rm(support, { recursive: true, force: true }); }
}
