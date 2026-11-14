// Build-time inventory: bundler output and copied trees identify the shipped packages.
// Quantco reads local licence/NOTICE text; the existing policy judges the same metadata.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { generateDisclaimer, getLicenseText } from '@quantco/pnpm-licenses';
import { declaredLicence, licenceProblems } from '../licences.mjs';
import { libraryFiles, validateBuild, assertLibraryFolder } from '../native-lgpl/payload.mjs';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const supplements = fileURLToPath(new URL('../notices/', import.meta.url));
const prebundled = read(join(supplements, 'prebundled.json'));
const nativeSources = read(join(supplements, 'native.json'));
const supplementSources = read(join(supplements, 'sources.json'));
const licenceFile = /^(?:licen[cs]e|unlicen[cs]e|copying|copyright|notice)(?:[._-].*)?$/i;
export function filesBelow(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(e => {
    const path = join(root, e.name);
    return e.isDirectory() ? filesBelow(path) : e.isFile() ? [path] : [];
  }).sort();
}
export function packageAt(file) {
  if (!file || file.startsWith('\0')) return;
  let at = resolve(file.split('?')[0]);
  if (!existsSync(at)) return;
  if (!lstatSync(at).isDirectory()) at = dirname(at);
  for (;;) {
    if (existsSync(join(at, 'package.json')) && read(join(at, 'package.json')).name) return realpathSync(at);
    const parent = dirname(at); if (parent === at) return; at = parent;
  }
}
export function installedPackage(name, from) {
  for (let at = resolve(from);; at = dirname(at)) {
    const found = join(at, 'node_modules', name);
    if (existsSync(join(found, 'package.json'))) return realpathSync(found);
    if (dirname(at) === at) return;
  }
}

export function createNoticeInventory({ repository } = {}) {
  if (repository) repository = resolve(repository);
  const packages = new Map(), artifacts = new Map(), extras = new Map();
  function includePackage(path) {
    path = realpathSync(path);
    const metadata = read(join(path, 'package.json'));
    if (path === repository && !metadata.version) metadata.version = 'source';
    const problems = licenceProblems([metadata]);
    if (problems.length) throw new Error(problems.join('\n'));
    const id = `${metadata.name}@${metadata.version}`;
    if (metadata.name === prebundled.package.slice(0, prebundled.package.lastIndexOf('@')) && id !== prebundled.package) throw new Error('Review notices for an unreviewed Pi version.');
    if (id === prebundled.package && hash(filesBelow(join(path, 'dist/bundle')).map(file => `${relative(join(path, 'dist/bundle'), file)}\0${hash(readFileSync(file))}\n`).join('')) !== prebundled.payloadSha256) throw new Error('Review notices for changed Pi prebundle.');
    if (!metadata.version) throw new Error(`Missing notice version for ${metadata.name}.`);
    packages.set(id, { path, metadata });
    return id;
  }
  function cover(file, roots) {
    const ids = roots.map(root => includePackage(root));
    artifacts.set(file, [...new Set([...(artifacts.get(file) ?? []), ...ids])].sort());
  }
  function closure(root, seen = new Set()) {
    root = realpathSync(root); if (seen.has(root)) return; seen.add(root); includePackage(root);
    const pkg = read(join(root, 'package.json'));
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      const found = installedPackage(name, root);
      if (found) closure(found, seen);
      else if (name in (pkg.dependencies ?? {}) && !(name in (pkg.optionalDependencies ?? {}))) throw new Error(`Missing notice dependency ${name}.`);
    }
  }
  return {
    includePackage, cover, closure,
    extra(id, name, version, license, text, format = 'text') {
      if (!text.trim()) throw new Error(`Empty notice for ${name}.`);
      extras.set(id, { id, name, version, license, text, format });
      return id;
    },
    coverIds(file, ids) { artifacts.set(file, [...new Set(ids)].sort()); },
    coverTree(tree, prefix, roots) {
      for (const path of filesBelow(tree)) cover(join(prefix, relative(tree, path)).split('\\').join('/'), roots);
    },
    plugin(outputPrefix = '') {
      return {
        name: 'bundled-notices',
        generateBundle(_options, bundle) {
          const allRoots = new Set();
          for (const item of Object.values(bundle)) if (item.type === 'chunk') {
            const roots = [...new Set(Object.entries(item.modules).map(([id]) => packageAt(id)).filter(Boolean))];
            roots.forEach(root => allRoots.add(root));
            cover(join(outputPrefix, item.fileName), roots);
          }
          // CSS/font assets can be emitted by transform plugins. Retain their imported
          // package obligations even when they have no rendered JavaScript module.
          for (const id of this.getModuleIds()) {
            if (this.getModuleInfo(id)?.isIncluded) { const root = packageAt(id); if (root) allRoots.add(root); }
          }
          for (const root of allRoots) {
            includePackage(root);
            if (read(join(root, 'package.json')).name?.startsWith('@earendil-works/')) closure(root);
          }
          for (const item of Object.values(bundle)) if (item.type === 'chunk' && !artifacts.get(join(outputPrefix, item.fileName))?.length) cover(join(outputPrefix, item.fileName), [...allRoots]);
          for (const item of Object.values(bundle)) if (item.type === 'asset') cover(join(outputPrefix, item.fileName), [...allRoots]);
        },
      };
    },
    async write(output) {
      const destination = join(output, 'notices'); rmSync(destination, { recursive: true, force: true }); mkdirSync(destination, { recursive: true });
      const entries = [];
      // Only a record inventoried from this output describes libraries actually staged here.
      const buildPaths = [...artifacts.keys()].filter(path => path.endsWith('/lgpl-build.json'));
      if (buildPaths.length > 1) throw new Error('Ambiguous staged LGPL build records.');
      const stagedSources = buildPaths.length ? read(join(output, buildPaths[0])).libraries : {};

      for (const [id, { path, metadata }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
        const license = declaredLicence(metadata);
        let source = path;
        // Workspace packages inherit the repository's licence and attribution.
        if (repository && !path.includes('/node_modules/') && !readdirSync(path).some(f => licenceFile.test(f))) source = repository;
        const dependency = { name: metadata.name, version: metadata.version, license, path: source,
          author: typeof metadata.author === 'string' ? metadata.author : metadata.author?.name,
          homepage: metadata.homepage };
        let resolved = await getLicenseText(dependency);
        const supplement = supplementSources[id];
        if (supplement) {
          const text = readFileSync(join(supplements, supplement.file), 'utf8');
          if (hash(text) !== supplement.sha256) throw new Error(`Changed licence source for ${id}.`);
          resolved = { licenseText: text, additionalText: `Licence source: ${supplement.source}`, resolvedBy: 'retained-source' };
        } else if (!['license-file', 'readme-search'].includes(resolved.resolvedBy)) {
          const readmes = readdirSync(source).filter(f => /^readme(?:\..*)?$/i.test(f));
          const text = readmes.map(f => readFileSync(join(source, f), 'utf8')).join('\n');
          if (/ermission is hereby granted|Redistribution and use in source and binary/.test(text)) resolved = { licenseText: text, resolvedBy: 'publisher-readme' };
          else if (!dependency.author) throw new Error(`Missing licence attribution for ${id}.`);
        }
        const texts = filesBelow(source).filter(f => !relative(source, f).startsWith('node_modules/') && (licenceFile.test(f.split('/').at(-1)) || /[._-](?:licen[cs]e|notice)(?:[._-].*)?$/i.test(f.split('/').at(-1)))).sort()
          .map(f => `\n${relative(source, f)}\n${readFileSync(f, 'utf8')}`).join('\n');
        const text = generateDisclaimer([{ ...dependency, ...resolved }]) + texts;
        entries.push({ id, name: metadata.name, version: metadata.version, license, text, resolvedBy: resolved.resolvedBy, format: 'text' });
      }
      if ([...packages.values()].some(({ metadata }) => metadata.name?.startsWith('@embedded-postgres/'))) {
        for (const { metadata } of packages.values()) if (metadata.name?.startsWith('@embedded-postgres/') && metadata.version !== nativeSources.packageVersion) throw new Error(`Review native notices for ${metadata.name}@${metadata.version}.`);
        for (const [name, pin] of Object.entries(nativeSources.components)) {
          // From the staged build record take only what describes the source; its `file` is the library, not this notice text.
          const staged = stagedSources[name] ?? {};
          const record = pin.license.startsWith('LGPL-') ? { ...pin, version: staged.version, archiveUrl: staged.archiveUrl, archiveSha256: staged.archiveSha256, unmodified: staged.unmodified } : pin;
          const text = readFileSync(join(supplements, record.file), 'utf8');
          if (hash(text) !== record.sha256) throw new Error(`Changed native notice ${name}.`);
          entries.push({ id: `postgres-native:${name}`, name: `${name} (PostgreSQL native distribution)`, version: record.version ?? (record.license.startsWith('LGPL-') ? 'unknown' : nativeSources.packageVersion), license: record.license, text: `Licence text source: ${record.source}\n${record.license.startsWith('LGPL-') ? `Corresponding source: ${record.archiveUrl ?? 'unknown'}\nSource SHA-256: ${record.archiveSha256 ?? 'unknown'}\nSource version: ${record.version ?? 'unknown'}\nUnmodified source: ${record.unmodified === true ? 'true' : 'unknown'}\nApp replacement file: ${record.replacementPath ?? 'unknown'}\nCLI replacement file: node_modules/@embedded-postgres/${process.platform}-${process.arch}/native/lib/${libraryFiles[name]}\n` : ''}\n${text}`, format: 'text' });
        }
      }
      if (packages.has(prebundled.package)) {
        for (const notice of prebundled.notices) if (!packages.has(notice.id)) {
          const text = readFileSync(join(supplements, notice.file), 'utf8');
          if (hash(text) !== notice.sha256) throw new Error(`Changed embedded notice ${notice.id}.`);
          const problems = licenceProblems([notice]); if (problems.length) throw new Error(problems.join('\n'));
          entries.push({ id: notice.id, name: notice.name, version: notice.version, license: notice.license, format: 'text', text: `Embedded contributor; source: ${notice.source}\n\n${text}` });
        }
        for (const name of prebundled.contributors) if (!entries.some(entry => entry.name === name)) throw new Error(`Missing embedded Pi contributor notice ${name}.`);
      }
      entries.push(...[...extras.values()].filter(extra => !entries.some(entry => entry.id === extra.id))); entries.sort((a, b) => a.id.localeCompare(b.id));
      const index = entries.map(({ text, ...entry }, n) => {
        const file = `${n}.${entry.format === 'html' ? 'html' : 'txt'}`;
        writeFileSync(join(destination, file), text);
        return { ...entry, file, sha256: hash(text) };
      });
      const shipped = [...artifacts].sort(([a], [b]) => a.localeCompare(b)).map(([path, packages]) => {
        if (!packages.length) throw new Error(`No notice package for shipped artifact ${path}.`);
        for (const id of packages) if (!index.some(entry => entry.id === id)) throw new Error(`Missing notice ${id}.`);
        return { path, packages, sha256: hash(readFileSync(join(output, path))) };
      });
      writeFileSync(join(destination, 'index.json'), JSON.stringify({ schema: 1, entries: index, artifacts: shipped }, null, 2) + '\n');
      return index;
    },
  };
}

/** Test the real staged/extracted tree, including minified chunks and native payloads. */
/**
 * `requireLgplSources`: a build handed to people outside the owner must carry a complete source record
 * for each LGPL native library (ADR 0005). It is required when BACKBONE_PUBLIC_DISTRIBUTION=1; an
 * ordinary local build reports the same gaps on stderr and goes on, so the owner's own installs are
 * not blocked by a record that only publication needs.
 */
export function verifyNoticeCoverage(output, { roots, files = [], nativeRecords = nativeSources.components, requireLgplSources = process.env.BACKBONE_PUBLIC_DISTRIBUTION === '1', inspectNative } = {}) {
  const inventory = read(join(output, 'notices/index.json')), problems = [];
  const ids = new Set(inventory.entries.map(entry => entry.id));
  for (const entry of inventory.entries) {
    if (hash(readFileSync(join(output, 'notices', entry.file))) !== entry.sha256) problems.push(`Changed notice ${entry.id}.`);
    // Composite upstream notices retain their individual terms verbatim. npm metadata
    // was checked through licenceProblems when admitted to the build inventory.

  }
  const recorded = new Map(inventory.artifacts.map(entry => [entry.path, entry]));
  const lgpl = [];
  for (const artifact of inventory.artifacts) {
    for (const id of artifact.packages) {
      const entry = inventory.entries.find(item => item.id === id);
      if (!entry?.license?.startsWith('LGPL-')) continue;
      const name = id.startsWith('postgres-native:') ? id.slice('postgres-native:'.length) : '';
      const record = nativeRecords[name];
      if (artifact.path.split('/').at(-1) === libraryFiles[name]) {
        if (artifact.path.split('/').at(-2) !== 'lib') lgpl.push(`Invalid LGPL library path ${artifact.path}.`);
        const nativeRoot = join(output, dirname(dirname(artifact.path)));
        try { validateBuild(nativeRoot, { recordFile: 'lgpl-build.json', records: nativeRecords, names: [name], required: requireLgplSources, inspect: inspectNative }); }
        catch (error) { lgpl.push(`LGPL build record or library digest mismatch for ${artifact.path}: ${error.message}`); }
      }
      let url;
      try { url = new URL(record?.archiveUrl); } catch { /* Missing or invalid source. */ }
      if (!name || !record || record.license !== entry.license || !record.version || !url || url.protocol !== 'https:' || !/^[a-f0-9]{64}$/.test(record.archiveSha256 ?? '') || record.unmodified !== true || !record.replacementPath?.startsWith('Contents/Resources/postgres/native/lib/')) {
        lgpl.push(`Incomplete LGPL native source record for ${id}.`);
      } else if (entry.version !== record.version || !readFileSync(join(output, 'notices', entry.file), 'utf8').includes(record.archiveUrl) || !readFileSync(join(output, 'notices', entry.file), 'utf8').includes(record.archiveSha256)) {
        lgpl.push(`Stale LGPL native notice for ${id}.`);
      }
    }
  }
  const shippedFiles = roots ? [...roots.flatMap(root => filesBelow(join(output, root))), ...files.map(file => join(output, file))] : filesBelow(output);
  for (const file of shippedFiles) {
    const path = relative(output, file).split('\\').join('/');
    if (path.startsWith('notices/')) continue;
    if (/^(libiconv|libintl)/.test(file.split('/').at(-1)) && file.split('/').at(-2) === 'lib') {
      try { assertLibraryFolder(dirname(dirname(file))); }
      catch (error) { problems.push(error.message); }
    }
    const artifact = recorded.get(path);
    const nativeName = path.match(/(?:^|\/)lib(iconv|intl)(?:\.|$)/)?.[1];
    if (nativeName && path.includes('postgres/') && !artifact?.packages.includes(`postgres-native:lib${nativeName}`)) problems.push(`Missing LGPL native notice for ${path}.`);
    if (!artifact) problems.push(`No notice coverage for ${path}.`);
    else if (!artifact.packages.length || artifact.packages.some(id => !ids.has(id))) problems.push(`Missing notice entry for ${path}.`);
    else if (hash(readFileSync(file)) !== artifact.sha256) problems.push(`Changed shipped artifact ${path}.`);
  }
  for (const entry of inventory.artifacts) {
    if (isAbsolute(entry.path) || entry.path.split('/').includes('..') || !existsSync(join(output, entry.path))) problems.push(`Missing shipped artifact ${entry.path}.`);
  }
  const gaps = [...new Set(lgpl)];
  if (requireLgplSources) problems.push(...gaps);
  else if (gaps.length) process.stderr.write(`notices: not ready for public distribution (set BACKBONE_PUBLIC_DISTRIBUTION=1 to enforce):\n${gaps.map(gap => `  ${gap}`).join('\n')}\n`);
  return problems;
}

/** Every frozen optional target needs an identity in the report even when npm omits it locally. */
export function frozenPackageNoticeProblems(lock, entries) {
  const ids = new Set(entries.map(entry => entry.id));
  return Object.entries(lock.packages ?? {}).flatMap(([path, metadata]) => {
    if (!path) return [];
    const name = metadata.name ?? path.split('node_modules/').at(-1);
    return name && metadata.version && !ids.has(`${name}@${metadata.version}`)
      ? [`Frozen package has no notice: ${name}@${metadata.version}.`] : [];
  });
}
