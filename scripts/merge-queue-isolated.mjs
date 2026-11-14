// One installed diagnostic uses the app's existing fresh-install lifecycle, never a development executable.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function runInstalledDiagnostic(root, file, title, { lifecycle, execCommand = execFileSync, spawnCommand = spawnSync, project = 'electron', env = process.env } = {}) {
  root = resolve(root);
  if (typeof file !== 'string' || typeof title !== 'string' || !title || isAbsolute(file) || file.split('/').includes('..') || !file.startsWith('packages/surfaces/app/e2e/') || !file.endsWith('.spec.ts') || !['electron', 'goals'].includes(project)) throw new Error('Installed diagnostic needs one app e2e file, installed project and test title');
  const app = join(root, 'packages/surfaces/app');
  const run = (command, args) => execCommand(command, args, { cwd: app, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  const execute = lifecycle || (await import(pathToFileURL(join(app, 'scripts/installed-journey.ts')).href)).runInstalledJourney;
  return execute({
    prepare() { for (const file of ['ensure-electron.mjs', 'build.mjs', 'package.mjs']) run(process.execPath, [`scripts/${file}`]); },
    buildInfo: () => JSON.parse(readFileSync(join(app, 'dist/package/build.json'), 'utf8')),
    install: target => run(process.execPath, ['scripts/install-dmg.mjs', target]),
    test: (executable, installedEnv) => spawnCommand('pnpm', ['exec', 'playwright', 'test', `--project=${project}`, '--workers=1', relative('packages/surfaces/app', file), '--grep', title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], { cwd: app, stdio: 'inherit', env: installedEnv }),
    env,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, file, title, project = 'electron'] = process.argv.slice(2);
  runInstalledDiagnostic(root, file, title, { project }).then(result => { if (result.error) console.error(result.error.message); if (result.cleanupError) console.error(result.cleanupError.message); process.exitCode = result.exitCode; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
