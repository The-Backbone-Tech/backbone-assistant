// Build only GNU's unmodified shared library targets; no package manager or source patches.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { availableParallelism } from 'node:os';
import { defaultBuildRoot, digest, libraryFiles, nativeSources, validateBuild, verifyArchive, fingerprints, recipeDigest } from './payload.mjs';
import { buildEnvironment, inspectMachO, signatureRecord } from './build-support.mjs';
const root = dirname(defaultBuildRoot), output = defaultBuildRoot;
if (process.platform !== 'darwin') throw new Error('The pinned LGPL build currently supports macOS only.');
const recipeSha256 = recipeDigest();
if (existsSync(join(output, 'build.json'))) {
  const cached = JSON.parse(readFileSync(join(output, 'build.json')));
  if (cached.recipeSha256 === recipeSha256 && Object.values(cached.libraries ?? {}).every(item => item.signature?.verified)) {
    validateBuild(output, { required: true });
    console.log(`Matching LGPL build: ${output} (binary checks only; no network or compilation)`); process.exit(0);
  }
}
for (const tool of ['xcrun', 'make', 'tar', 'curl', 'install_name_tool', 'otool', 'lipo', 'codesign']) {
  if (spawnSync('/usr/bin/which', [tool]).status !== 0) throw new Error(`Required tool is absent: ${tool}`);
}
const toolEnvironment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', TZ: 'UTC' };
const run = (cmd, args, cwd, env = toolEnvironment) => execFileSync(cmd, args, { cwd, env, stdio: 'inherit' });
const capture = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', env: toolEnvironment }).trim();
const compiler = capture('xcrun', ['--find', 'clang']);
const sdk = capture('xcrun', ['--show-sdk-path']);
const compilerVersion = capture(compiler, ['--version']);
const downloads = join(root, 'downloads'), work = join(root, 'work'), stage = join(root, 'next');
mkdirSync(downloads, { recursive: true }); rmSync(work, { recursive: true, force: true }); mkdirSync(work);
rmSync(stage, { recursive: true, force: true }); mkdirSync(join(stage, 'lib'), { recursive: true });
const fetch = (url, target) => {
  const partial = `${target}.partial`;
  run('curl', ['--fail', '--location', '--retry', '3', '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2', url, '-o', partial]);
  cpSync(partial, target); rmSync(partial);
};
const gpg = spawnSync('/usr/bin/which', ['gpg'], { encoding: 'utf8' }).stdout.trim();
const hasGpg = Boolean(gpg);
const keyring = join(downloads, 'gnu-keyring.gpg'), gpgHome = join(work, 'gnupg');
if (hasGpg) {
  mkdirSync(gpgHome, { mode: 0o700 });
  if (!existsSync(keyring)) fetch('https://ftp.gnu.org/gnu/gnu-keyring.gpg', keyring);
}
const signatures = {};
for (const [name, file] of Object.entries(libraryFiles)) {
  const pin = nativeSources[name], archive = join(downloads, basename(pin.archiveUrl));
  if (!existsSync(archive)) fetch(pin.archiveUrl, archive);
  verifyArchive(readFileSync(archive), pin);
  if (hasGpg) {
    if (!existsSync(`${archive}.sig`)) fetch(`${pin.archiveUrl}.sig`, `${archive}.sig`);
    const result = execFileSync(gpg, ['--batch', '--homedir', gpgHome, '--no-default-keyring', '--keyring', keyring, '--status-fd', '1', '--verify', `${archive}.sig`, archive], { encoding: 'utf8', env: toolEnvironment });
    signatures[name] = signatureRecord(result, fingerprints[name]);
  } else signatures[name] = { verified: false, reason: 'gpg is not installed; committed SHA-256 verified' };
  run('tar', ['-xzf', archive, '-C', work]);
  console.log(`Verified source: ${name} ${pin.version}; shared target ${file}`);
}
const prefix = resolve(join(work, 'prefix'));
const env = buildEnvironment({ compiler, cxx: capture('xcrun', ['--find', 'clang++']), sdk, work });
const flags = {};
flags.libiconv = [`--prefix=${prefix}`, '--enable-shared', '--disable-static', '--disable-nls'];
const iconv = join(work, 'libiconv-1.18');
run('./configure', flags.libiconv, iconv, env);
run('make', ['-C', 'lib', '-j', String(Math.min(availableParallelism(), 8))], iconv, env);
mkdirSync(join(prefix, 'include'), { recursive: true });
cpSync(join(iconv, 'include/iconv.h.inst'), join(prefix, 'include/iconv.h'));
run('make', ['-C', 'lib', 'install'], iconv, env);
flags.libintl = [`--prefix=${prefix}`, '--enable-shared', '--disable-static', `--with-libiconv-prefix=${prefix}`, '--localedir=/Library/PostgreSQL/18/share/locale', '--disable-java', '--disable-csharp', '--disable-libasprintf', '--disable-openmp'];
const intl = join(work, 'gettext-0.26/gettext-runtime');
run('./configure', flags.libintl, intl, env);
run('make', ['-C', 'intl', '-j', String(Math.min(availableParallelism(), 8))], intl, env);
run('make', ['-C', 'intl', 'install'], intl, env);
const neutral = value => value.replaceAll(work, '<work>').replaceAll(stage, '<stage>');
const libraries = {};
for (const [name, file] of Object.entries(libraryFiles)) {
  const target = join(stage, 'lib', file); cpSync(join(prefix, 'lib', file), target, { dereference: true });
  // Mach-O relocation changes metadata, not source. Keep the provider's IDs and loader-relative link.
  run('install_name_tool', ['-id', `/Library/PostgreSQL/18/lib/${file}`, target]);
  if (name === 'libintl') run('install_name_tool', ['-change', join(prefix, 'lib/libiconv.2.dylib'), '@loader_path/../lib/libiconv.2.dylib', target]);
  run('codesign', ['--force', '--sign', '-', target]);
  const linkage = capture('otool', ['-L', target]); console.log(linkage);
  const minimum = name === 'libiconv' ? 10 : 13;
  if (!linkage.includes(`compatibility version ${minimum}.0.0`) || (name === 'libintl' && !linkage.includes('@loader_path/../lib/libiconv.2.dylib'))) throw new Error(`Unexpected ${name} ABI or linkage.`);
  if (linkage.includes(prefix)) throw new Error(`Non-relocatable ${name}.`);
  libraries[name] = { ...nativeSources[name], file, dylibSha256: digest(readFileSync(target)), signature: signatures[name], linkage: neutral(linkage), ...inspectMachO(target) };
}
writeFileSync(join(stage, 'build.json'), JSON.stringify({ schema: 1, platform: process.platform, arch: libraries.libiconv.architectures.length === 1 ? libraries.libiconv.architectures[0] : 'universal', architectures: libraries.libiconv.architectures, recipeSha256,
  compiler: neutral(compilerVersion), flags: JSON.parse(neutral(JSON.stringify(flags))), toolEnvironment, environment: JSON.parse(neutral(JSON.stringify(env))), libraries }, null, 2) + '\n');
validateBuild(stage); rmSync(output, { recursive: true, force: true }); cpSync(stage, output, { recursive: true }); rmSync(stage, { recursive: true, force: true });
console.log(`Built verified LGPL libraries: ${output}`);
