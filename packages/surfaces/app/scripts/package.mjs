// Packages the built app as an unsigned macOS .app and DMG under dist/package.
// Only the bundled output ships: main and preload already include the platform and the core, so no
// general node_modules; the native lock's closed loader closure ships under dist/node_modules. The baseline sits beside main, the pieces under dist/pieces (checked
// against their registration at start), and PostgreSQL's binaries are a resource.
import { packager } from '@electron/packager';
import { productVersion } from '../../../../scripts/lib/product-version.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertBuildConfiguration, buildConfiguration, sourceIdentity } from './build-identity.ts';
import { loadBrand } from '../../../../scripts/lib/brand.mjs';
import {verifyNoticeCoverage} from '../../../../scripts/lib/notices.mjs';
import {verifyHomeLockRuntime} from './home-lock-runtime.mjs';

if (process.platform !== 'darwin') throw new Error('Packaging is macOS-only for now.');
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const electronVersion = manifest.devDependencies.electron;
verifyHomeLockRuntime();
const noticeProblems = verifyNoticeCoverage('dist', { roots: ['electron', 'renderer', 'pieces', 'node_modules', 'postgres', 'bin'], files: ['build.json', 'home-lock-runtime.json'] });
if (noticeProblems.length) throw new Error(noticeProblems.join('\n'));
for (const d of ['dist/electron/main.cjs', 'dist/electron/preload.cjs', 'dist/electron/baseline.sql', 'dist/postgres/native/bin/postgres', 'dist/renderer/index.html', 'dist/pieces/harness-pi/backbone.module.json', 'dist/pieces/connector-mail/backbone.module.json', 'dist/pieces/mcp/backbone.module.json', 'dist/bin/backbone-mcp']) {
  if (!existsSync(d)) throw new Error(`${d} is missing; run the build first.`);
}

const stage = 'dist/stage';
rmSync(stage, { recursive: true, force: true });
cpSync('dist/electron', join(stage, 'dist/electron'), { recursive: true });
cpSync('dist/renderer', join(stage, 'dist/renderer'), { recursive: true });
const compiled = JSON.parse(readFileSync('dist/build.json', 'utf8'));
cpSync('dist/build.json', join(stage, 'dist/build.json'));
cpSync('dist/notices', join(stage, 'dist/notices'), { recursive: true });
cpSync('third_party', join(stage, 'third_party'), { recursive: true });
cpSync('dist/pieces', join(stage, 'dist/pieces'), { recursive: true });
cpSync('dist/node_modules',join(stage,'dist/node_modules'),{recursive:true});
cpSync('dist/home-lock-runtime.json',join(stage,'dist/home-lock-runtime.json'));
const version = productVersion();
// The bundle's name and id come from the brand profile, like everything the person sees.
const brand = loadBrand();
assertBuildConfiguration(compiled, buildConfiguration(brand, version));
const slug = brand.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify({ name: slug, productName: brand.name, version, license: 'Apache-2.0', main: 'dist/electron/main.cjs' }, null, 2),
);

// A brand's icon, a square PNG, becomes the bundle's .icns with macOS's own sips and iconutil.
let icon;
if (brand.icon) {
  const set = join(stage, 'icon.iconset');
  mkdirSync(set, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = String(size * scale);
      execFileSync('sips', ['-z', px, px, brand.icon, '--out', join(set, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
    }
  }
  icon = join(stage, 'icon.icns');
  execFileSync('iconutil', ['-c', 'icns', set, '-o', icon]);
}

const [appDir] = await packager({
  dir: stage,
  out: 'dist/package',
  name: brand.name,
  platform: 'darwin',
  arch: process.arch,
  electronVersion,
  appVersion: version,
  appBundleId: brand.appId,
  extendInfo: {
    NSDesktopFolderUsageDescription: `Allowing Desktop lets ${brand.name} and the engines and tools it starts read that folder.`,
    NSDocumentsFolderUsageDescription: `Allowing Documents lets ${brand.name} and the engines and tools it starts read that folder.`,
    NSDownloadsFolderUsageDescription: `Allowing Downloads lets ${brand.name} and the engines and tools it starts read that folder.`,
  },
  ...(icon ? { icon } : {}),
  // The door runs as its own process from its own files and reads the core's baseline, so both ship outside the archive.
  asar: { unpackDir: 'dist/{pieces/mcp,node_modules}', unpack: '*.sql' },
  extraResource: ['dist/postgres', 'dist/bin'],
  prune: false,
  overwrite: true,
  quiet: true,
});
const app = join(appDir, `${brand.name}.app`);
const dmg = join('dist/package', `${slug}-${version}-${process.arch}.dmg`);
rmSync(dmg, { force: true });
execFileSync('hdiutil', ['create', '-quiet', '-volname', brand.name, '-srcfolder', app, '-ov', '-format', 'UDZO', dmg]);
const sha = createHash('sha256').update(readFileSync(dmg)).digest('hex');
const currentSource = sourceIdentity();
const sourceChangedAfterBuild = compiled.gitSourceHash && currentSource.gitSourceHash ? compiled.gitSourceHash !== currentSource.gitSourceHash || compiled.revision !== currentSource.revision : null;
const info = { compiled, sourceChangedAfterBuild, app, productName: brand.name, dmg, version, electron: electronVersion, arch: process.arch, signed: false, sha256: sha };
writeFileSync('dist/package/build.json', `${JSON.stringify(info, null, 2)}\n`);
console.log(JSON.stringify(info, null, 2));
