// Packages, installs the DMG into a temporary folder, then runs the Electron journey on the installed app.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { INSTALLED_TEST_ARGS, runInstalledJourney } from './installed-journey.ts';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts });
const result = await runInstalledJourney({
  prepare() {
    run(process.execPath, ['scripts/ensure-electron.mjs']);
    run(process.execPath, ['scripts/build.mjs']);
    run(process.execPath, ['scripts/package.mjs']);
  },
  buildInfo: () => JSON.parse(readFileSync('dist/package/build.json', 'utf8')),
  install: (target) => run(process.execPath, ['scripts/install-dmg.mjs', target]),
  test: (executable, env) => {
    console.log(`installed: ${executable}`);
    // Optional Playwright filters narrow a repair run; the gate's default selection is unchanged.
    return spawnSync('npx', [...INSTALLED_TEST_ARGS, ...process.argv.slice(2)], { stdio: 'inherit', env });
  },
  env: process.env,
});
if (result.error) console.error(result.error.message);
if (result.cleanupError) console.error(`Temporary application cleanup failed at ${result.cleanupRoot}: ${result.cleanupError.message}`);
process.exitCode = result.exitCode;
