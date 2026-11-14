// Ship this checkout to this Mac: package the app, install it in /Applications and install the
// `backbone` command under .local in the user folder. A change is finished when the build that contains it is
// installed (GOAL.md, completion bar 1); this is the one command that does it.
//
//   node scripts/ship-mac.mjs            package, then install the app and the command
//   node scripts/ship-mac.mjs --no-cli   the app only
//   node scripts/ship-mac.mjs --dry-run  print what would happen
//
// The app's data folder (in the user's Application Support) is never touched: only
// the bundle is replaced. A running copy is asked to quit first, through its own quit path, so
// open work is flushed; if it does not quit within the wait, nothing is replaced.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceIdentity } from '../packages/surfaces/app/scripts/build-identity.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'packages/surfaces/app');

/** The steps for one run, as data, so the plan can be printed and tested without running it. */
export function plan({ args = [], home = homedir(), distribution = 'distributions/backbone/distribution.json', applications = '/Applications' } = {}) {
  const cli = !args.includes('--no-cli');
  return {
    dryRun: args.includes('--dry-run'),
    distribution,
    applications,
    cliPrefix: cli ? join(home, '.local') : null,
    steps: ['package the app', 'ask a running copy to quit', `install the app in ${applications}`, ...(cli ? [`install the backbone command under ${join(home, '.local')}`] : []), 'open the app'],
  };
}

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const running = (bundle) => spawnSync('pgrep', ['-f', join(bundle, 'Contents/MacOS/')], { encoding: 'utf8' }).status === 0;

/**
 * Put a new bundle in place and keep the previous one until the new one is there. The new bundle is
 * copied beside the target first; the old one is moved to "<target>.previous", the new one moved in,
 * and only then is the old one removed. If the move fails the old bundle is put back. An interrupted
 * run leaves either the old app in place or "<target>.previous" next to it, which the next run restores.
 */
export function replaceBundle(source, target, { copy = (from, to) => run('ditto', [from, to]), move = renameSync } = {}) {
  const staged = `${target}.new`, previous = `${target}.previous`;
  if (!existsSync(target) && existsSync(previous)) move(previous, target);
  rmSync(staged, { recursive: true, force: true });
  copy(source, staged);
  const had = existsSync(target);
  if (had) { rmSync(previous, { recursive: true, force: true }); move(target, previous); }
  try { move(staged, target); }
  catch (error) { if (had) move(previous, target); throw error; }
  rmSync(previous, { recursive: true, force: true });
}

/** Both artifacts must come from one source: the one the app was compiled from. */
export function sameSource(compiled, current) {
  return compiled.revision === current.revision && compiled.gitSourceHash === current.gitSourceHash;
}

async function quit(name, bundle, waitMs = 60_000) {
  if (!running(bundle)) return true;
  spawnSync('osascript', ['-e', `tell application "${name}" to quit`], { stdio: 'ignore' });
  for (const end = Date.now() + waitMs; Date.now() < end;) {
    if (!running(bundle)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('ship-mac installs on macOS only.');
  const p = plan({ args: process.argv.slice(2) });
  if (p.dryRun) { console.log(JSON.stringify(p, null, 2)); return; }
  const env = { ...process.env, BACKBONE_DISTRIBUTION: join(root, p.distribution) };
  run('pnpm', ['--dir', appDir, 'package'], { env });
  const build = JSON.parse(readFileSync(join(appDir, 'dist/package/build.json'), 'utf8'));
  const source = join(appDir, build.app);
  const target = join(p.applications, `${build.productName}.app`);
  const label = `${build.productName} ${build.version} (${build.compiled.revision.slice(0, 8)}${build.compiled.dirty ? ', with uncommitted changes' : ''})`;
  // Pack the command before anything installed is touched, then check that the checkout is still the
  // source the app was compiled from. If it moved, nothing is replaced.
  const out = p.cliPrefix ? mkdtempSync(join(tmpdir(), 'backbone-ship-')) : null;
  try {
    let tarball;
    if (out) {
      run('node', [join(root, 'scripts/pack-cli.mjs'), out], { cwd: root });
      tarball = readdirSync(out).find((f) => f.endsWith('.tgz'));
      if (!tarball) throw new Error('pack-cli produced no tarball; nothing was replaced.');
    }
    if (build.sourceChangedAfterBuild || !sameSource(build.compiled, sourceIdentity(appDir))) throw new Error('The checkout changed while it was being packaged, so the app and the command would come from different sources. Nothing was replaced; run this again.');
    if (!(await quit(build.productName, target))) throw new Error(`${build.productName} is still running and did not quit; nothing was replaced. If it is showing a question (for example about an update), answer it, then quit the app and run this again.`);
    replaceBundle(source, target);
    if (out) {
      try { run('npm', ['install', '-g', '--prefix', p.cliPrefix, join(out, tarball)]); }
      catch (error) {
        run('open', ['-g', target]);
        console.error(`Installed ${label} in ${target}, but the backbone command was NOT updated: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
        return;
      }
    }
  } finally { if (out) rmSync(out, { recursive: true, force: true }); }
  run('open', ['-g', target]);
  console.log(`Installed ${label} in ${target}${p.cliPrefix ? ` and the backbone command, from the same source, in ${join(p.cliPrefix, 'bin')}` : ''}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
