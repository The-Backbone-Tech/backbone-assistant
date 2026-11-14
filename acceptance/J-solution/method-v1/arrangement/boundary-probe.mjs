// J-solution boundary check (method revision 3, "Inputs and isolation"): through an arm's actual
// operating-system sandbox, not a model's report, show that the arm reads its inputs and cannot read
// the method, the scoring checker, the labels, Backbone's source, finished outputs or the other arm's
// work. One unique sentinel is planted in each denied folder for the probe and removed after it.
// Only booleans and the profile's digest are recorded.
//
//   node boundary-probe.mjs --arm backbone --native <backbone-next>/packages/modules/harness-codex/src/native.ts \
//        --inputs <task fixture folder> --deny <folder> [--deny <folder> ...] --out <result.json>
//   node boundary-probe.mjs --arm codex-cli --inputs <task fixture folder> --deny <folder> ... --out <result.json>
//
// backbone: the full profile the Backbone engine applies with settings.json deniedFolders, built by
// the engine's own overrides(). codex-cli: the profile the P1 baseline is run with, Codex CLI's
// maintained permissions profile with the same denies.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const one = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const many = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const arm = one('--arm');
const inputs = one('--inputs') && resolve(one('--inputs'));
const denied = many('--deny').map((d) => resolve(d));
const out = one('--out');
if (!['backbone', 'codex-cli'].includes(arm) || !inputs || !denied.length || !out) {
  console.error('usage: see the header'); process.exit(2);
}
const checker = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scoring', 'verify-t3.mjs');

const PROFILE = 'j-solution-arm';
let profileArgs;
if (arm === 'backbone') {
  const native = one('--native');
  if (!native) { console.error('--native is required for the backbone arm'); process.exit(2); }
  const mod = await import(pathToFileURL(resolve(native)).href);
  profileArgs = { args: mod.overrides([], 'full', [], denied), name: mod.PROFILE };
} else {
  const map = { ':root': 'read', ':minimal': 'read', ':workspace_roots': 'write', ...Object.fromEntries(denied.map((d) => [d, 'deny'])) };
  const table = `{ ${Object.entries(map).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(', ')} }`;
  profileArgs = { args: ['-c', `permissions.${PROFILE}.filesystem=${table}`, '-c', `permissions.${PROFILE}.network.enabled=false`, '-c', `default_permissions="${PROFILE}"`], name: PROFILE };
}

const stage = mkdtempSync(join(tmpdir(), 'j-boundary-'));
const token = randomBytes(8).toString('hex');
const sentinels = denied.map((d) => join(d, `.j-boundary-sentinel-${token}`));
const result = { arm, at: new Date().toISOString(), codex: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(), denied: denied.length };
try {
  cpSync(inputs, join(stage, 'inputs'), { recursive: true });
  const input = join(stage, 'inputs', readdirSync(join(stage, 'inputs')).find((n) => !n.startsWith('.')));
  for (const s of sentinels) writeFileSync(s, 'sentinel\n', { flag: 'wx' });
  const script = 'r() { /bin/cat "$1" >/dev/null 2>&1 && printf allowed || printf denied; }; i="$1"; c="$2"; shift 2; printf "%s %s" "$(r "$i")" "$(r "$c")"; for s in "$@"; do printf " %s" "$(r "$s")"; done';
  const raw = execFileSync('codex', ['sandbox', '-C', stage, '-P', profileArgs.name, ...profileArgs.args, '--', '/bin/sh', '-c', script, 'probe', input, checker, ...sentinels],
    { cwd: stage, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } }).trim().split(' ');
  const [inputRead, checkerRead, ...sentinelReads] = raw;
  Object.assign(result, {
    profileDigest: `sha256:${createHash('sha256').update(JSON.stringify(profileArgs.args)).digest('hex')}`,
    inputRead: inputRead === 'allowed',
    checkerDenied: checkerRead === 'denied',
    sentinelsDenied: sentinelReads.filter((r) => r === 'denied').length,
  });
  result.pass = result.inputRead && result.checkerDenied && result.sentinelsDenied === denied.length;
} finally {
  for (const s of sentinels) rmSync(s, { force: true });
  rmSync(stage, { recursive: true, force: true });
  result.sentinelsRemoved = sentinels.every((s) => !existsSync(s));
}
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
process.exit(result.pass && result.sentinelsRemoved ? 0 : 1);
