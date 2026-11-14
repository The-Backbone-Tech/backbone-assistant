// Installs the packaged DMG the way a person would (mount, copy the .app, eject) into a target
// folder, and prints the installed executable. Journeys install into a temporary folder, never
// into the person's /Applications.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const target = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), 'backbone-install-')));
const { dmg, productName } = JSON.parse(readFileSync('dist/package/build.json', 'utf8'));
const bundle = `${productName}.app`;
const mount = mkdtempSync(join(tmpdir(), 'backbone-dmg-'));
execFileSync('hdiutil', ['attach', '-quiet', '-nobrowse', '-readonly', '-mountpoint', mount, dmg]);
try {
  mkdirSync(target, { recursive: true });
  rmSync(join(target, bundle), { recursive: true, force: true });
  execFileSync('ditto', [join(mount, bundle), join(target, bundle)]);
} finally {
  execFileSync('hdiutil', ['detach', '-quiet', mount]);
  rmSync(mount, { recursive: true, force: true });
}
console.log(join(target, bundle, 'Contents', 'MacOS', productName));
