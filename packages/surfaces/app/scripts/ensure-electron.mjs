// Install scripts stay off for the whole workspace (.npmrc), so Electron's binary is fetched here,
// explicitly, by Electron's own installer (which verifies the download against Electron's SHASUMS).
// Idempotent: it does nothing when the pinned version is already in place.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkg = require.resolve('electron/package.json');
const dir = dirname(pkg);
const want = JSON.parse(readFileSync(pkg, 'utf8')).version;
const versionFile = join(dir, 'dist', 'version');
const have = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim().replace(/^v/, '') : null;
if (have === want && existsSync(join(dir, 'path.txt'))) {
  console.log(`electron ${want}: binary present`);
} else {
  console.log(`electron ${want}: fetching binary (had ${have ?? 'none'})`);
  execFileSync(process.execPath, [join(dir, 'install.js')], { stdio: 'inherit' });
}
