// Builds the renderer, then the Electron main and preload bundles (CommonJS, electron external).
import { build } from 'vite';
import { productVersion } from '../../../../scripts/lib/product-version.mjs';
import { buildConfiguration, buildIdentity, sourceIdentity } from './build-identity.ts';
import { loadBuildBrand } from '../../../../scripts/lib/brand.mjs';
import { stageWorkspaceRuntime } from './workspace-runtime.mjs';
import {stageHomeLockRuntime} from './home-lock-runtime.mjs';

const { createNoticeInventory, installedPackage } = await import('../../../../scripts/lib/notices.mjs');
const notices = createNoticeInventory({ repository: new URL('../../../../', import.meta.url).pathname });
const brand = loadBuildBrand();
const { rmSync: removeOldIdentity } = await import('node:fs');
removeOldIdentity('dist/build.json', { force: true });
const source = sourceIdentity();
const identity = buildIdentity(source, buildConfiguration(brand, productVersion()));
console.log(`brand: ${brand.name} (${brand.appId})`);

// The workbook reader incorporates openpyxl; preserve its additional MIT notice.
notices.extra('office-kit-xlsx-third-parties', 'Office workbook reader third parties', '0.27.0', 'MIT',
  (await import('node:fs')).readFileSync((await import('node:path')).join(installedPackage('@office-kit/xlsx', process.cwd()), 'THIRD_PARTY_NOTICES.md'), 'utf8'));
// Preview workers have their own module graph and bundled licence inventory.
await build({ worker: { format: 'es', plugins: () => [notices.plugin('renderer')] }, plugins: [notices.plugin('renderer')], configFile: 'vite.config.ts', define: { __BUILD__: JSON.stringify(identity) } });
for (const entry of ['main', 'preload']) {
  await build({
    configFile: false,
    plugins: [notices.plugin('electron')],
    build: {
      ssr: `electron/${entry}.ts`,
      outDir: 'dist/electron',
      emptyOutDir: entry === 'main',
      target: 'node22',
      rollupOptions: { external: ['electron','fs-native-extensions'], output: { format: 'cjs', entryFileNames: `${entry}.cjs` } },
    },
    ssr: { noExternal: true },
    // The icon is the bundle's (package.mjs); its local path stays out of what ships to the window.
    define: { __BUILD__: JSON.stringify(identity), __BRAND__: JSON.stringify({ ...brand, icon: undefined }) },
  });
}
stageHomeLockRuntime();
stageWorkspaceRuntime();

// The core's one baseline and the embedded PostgreSQL 18 binaries the app starts in personal mode,
// copied with their library links resolved so nothing is written into the app at run time.
const { buildBaseline } = await import('../../../core/src/db/baseline.ts');
const { binaries } = await import('../../../kernel/src/cluster.ts');
const { cpSync, rmSync, writeFileSync } = await import('node:fs');
const { dirname, join } = await import('node:path');
writeFileSync('dist/electron/baseline.sql', buildBaseline().sql);
const native = dirname(dirname(binaries().postgres));
rmSync('dist/postgres', { recursive: true, force: true });
cpSync(native, join('dist/postgres/native'), { recursive: true, dereference: true });

// The pieces the app loads ship as their own files (exactly what their digest covers), which the
// platform checks against their registration and then imports from that folder. Their runtime
// dependencies sit beside them in node_modules (outside the digest, as in a checkout), bundled
// here once per package entry the piece imports.
const { pieceFiles } = await import('../../../platform/src/pieces/digest.ts');
const { readFileSync, mkdirSync } = await import('node:fs');
const { relative, resolve } = await import('node:path');
rmSync('dist/pieces', { recursive: true, force: true });
for (const [name, dir] of Object.entries({ 'harness-pi': '../../modules/harness-pi', 'harness-codex': '../../modules/harness-codex', 'harness-acp': '../../modules/harness-acp', 'connector-mail': '../../modules/connector-mail', mcp: '../mcp' })) {
  const out = join('dist/pieces', name);
  const files = pieceFiles(dir);
  for (const f of files) cpSync(join(dir, f), join(out, f));
  const specifiers = new Set();
  for (const f of files.filter((x) => x.startsWith('src/') && /\.[cm]?[jt]s$/.test(x))) {
    const text = readFileSync(join(dir, f), 'utf8');
    // Static imports, and dynamic ones named by a literal (the door loads a command's modules only when it runs).
    for (const m of [...text.matchAll(/^\s*import\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?'([^'.][^']*)'/gm), ...text.matchAll(/\bimport\(\s*'([^'.][^']*)'\s*\)/g)]) {
      if (!m[1].startsWith('node:')) specifiers.add(m[1]);
    }
  }
  const entries = [...specifiers];
  // A piece that imports only Node's own modules (the mail connector) has nothing to bundle.
  if (!entries.length) continue;
  const vendor = resolve(out, 'node_modules/.vendor');
  await build({
    configFile: false,
    plugins: [notices.plugin(relative(resolve('dist'), vendor))],
    root: resolve(dir),
    logLevel: 'warn',
    build: {
      ssr: true,
      outDir: vendor,
      emptyOutDir: true,
      target: 'node22',
      rollupOptions: {
        external:['fs-native-extensions'],
        input: Object.fromEntries(entries.map((s, i) => [`entry-${i}`, s])),
        output: { format: 'es', entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' },
        preserveEntrySignatures: 'strict',
      },
    },
    ssr: { noExternal: true },
  });
  const packages = new Map();
  entries.forEach((s, i) => {
    const parts = s.split('/');
    const pkg = s.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const sub = s.slice(pkg.length);
    const file = sub ? `.${sub}.mjs` : './index.mjs';
    const target = resolve(out, 'node_modules', pkg, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `export * from '${relative(dirname(target), join(vendor, `entry-${i}.mjs`))}';\n`);
    packages.set(pkg, { ...packages.get(pkg), [sub ? `.${sub}` : '.']: file });
  });
  for (const [pkg, exports] of packages) {
    writeFileSync(resolve(out, 'node_modules', pkg, 'package.json'), `${JSON.stringify({ name: pkg, version: JSON.parse(readFileSync(join(installedPackage(pkg, resolve(dir)), 'package.json'), 'utf8')).version, type: 'module', exports }, null, 2)}\n`);
  }
}

// The door inside the app, the command every AI tool's entry starts (as VS Code's `code` command and
// Docker Desktop's MCP entries are): it runs the door's own shipped files with the app's runtime as
// Node, found from the script's own place, in the packaged app (Contents/Resources/bin) or in this
// build (dist/bin). The entry names only the data home, and the door holds no secret and opens no
// database: it relays to the running app over the home's socket (platform's composition/doors.ts).
// It needs the app's runtime as Node (the RunAsNode fuse), which also lets any process of the person's
// user run code the Keychain takes for the app; moving it to its own runtime comes before that fuse
// goes (packages/platform/README.md, Secrets at rest).
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const door = `#!/bin/sh
# ${brand.name}'s MCP door, started by the AI tools connected in Settings.
here=$(cd "$(dirname "$0")" && pwd -P)
if [ -d "$here/../app.asar.unpacked" ]; then
  run="$here/../../MacOS/"${sh(brand.name)}
  shipped="$here/../app.asar.unpacked/dist"
else
  run="$here/../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  [ -x "$run" ] || run="$here/../../node_modules/electron/dist/electron"
  shipped="$here/.."
fi
ELECTRON_RUN_AS_NODE=1 BACKBONE_BASELINE_FILE="$shipped/electron/baseline.sql" BACKBONE_POSTGRES_NATIVE="$here/../postgres/native" exec "$run" "$shipped/pieces/mcp/src/main.ts" "$@"
`;
mkdirSync('dist/bin', { recursive: true });
writeFileSync('dist/bin/backbone-mcp', door, { mode: 0o755 });
const { chmodSync } = await import('node:fs');
chmodSync('dist/bin/backbone-mcp', 0o755);

// Do not seal a mixture of sources if another writer changed the checkout during compilation.
if (JSON.stringify(buildConfiguration(loadBuildBrand(), productVersion())) !== JSON.stringify(identity.configuration) || JSON.stringify(sourceIdentity()) !== JSON.stringify(source)) throw new Error('Source changed during compilation; build again from a stable checkout.');
writeFileSync('dist/build.json', JSON.stringify(identity, null, 2) + '\n');

// Copied payloads have no bundler module graph; record the bytes from their actual staging trees.
const { finishAppNotices } = await import('./notices.mjs');
await finishAppNotices(notices);
