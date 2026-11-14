// Module manifests (docs/repo-design.md, Manifests): every backbone.module.json is valid against
// schemas/backbone.module.schema.json, agrees with its package.json, names suites that exist, and
// carries the sha256 of its package's whole content. `--write` rebuilds source-derived fields and
// digests. pnpm regen orders those fields before README generation and the final digest. The digest is
// the platform's algorithm (packages/platform/src/pieces/digest.ts), the one the platform recomputes when
// it loads a piece; this check also proves that algorithm sees exactly the files git does.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { MANIFEST, pieceDigest, pieceFiles } from '../packages/platform/src/pieces/digest.ts';
import { isFontPackage, licenceOk } from './licences.mjs';
import { listFiles, read } from './lib/repo.mjs';

export { MANIFEST };
const SCHEMA = 'schemas/backbone.module.schema.json';

/** The digest of the package in `dir`, from its files on disk. `files` is not consulted: the file set is the algorithm's. */
export function digestOf(root, dir, _files) {
  return pieceDigest(join(root, dir));
}

let validator;
function validate(root, manifest) {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    validator = ajv.compile(JSON.parse(readFileSync(join(root, SCHEMA), 'utf8')));
  }
  return validator(manifest) ? [] : validator.errors.map((e) => `${e.instancePath || '/'} ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(', ')})` : ''}`);
}

export function manifestProblems(root, files, { write = false, fieldsOnly = false } = {}) {
  const problems = [];
  for (const f of files.filter((x) => x.endsWith(`/${MANIFEST}`) && existsSync(join(root, x)))) {
    const dir = dirname(f);
    const walked = pieceFiles(join(root, dir)); // Refuse links before any source-derived write.
    let manifest;
    try {
      manifest = JSON.parse(read(root, f));
    } catch (error) {
      problems.push(`${f}: not JSON (${error.message}).`);
      continue;
    }
    const pkgPath = join(root, dir, 'package.json');
    const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : null;
    if (!pkg) problems.push(`${f}: no package.json beside it; a manifest describes a package.`);
    else {
      const previous = Array.isArray(manifest.dependsOn) ? manifest.dependsOn : [];
      const derived = {
        version: pkg.version, licence: pkg.license,
        kind: { core: 'core', platform: 'platform', modules: 'module', surfaces: 'surface' }[pkg.backbone?.layer] ?? manifest.kind,
        dependsOn: Object.entries(pkg.dependencies ?? {}).map(([name, pinned]) => {
          const version = pinned.startsWith('workspace:') ? 'workspace' : pinned;
          // Licence annotations are reviewed declarations, not inferred facts about a new version.
          const reviewed = previous.find(d => d?.name === name && d.version === version)?.licence;
          return { name, version, ...(reviewed === undefined ? {} : { licence: reviewed }) };
        }),
      };
      const changed = Object.keys(derived).filter(key => JSON.stringify(manifest[key]) !== JSON.stringify(derived[key]));
      if (write && changed.length) {
        manifest = { ...manifest, ...derived };
        writeFileSync(join(root, f), JSON.stringify(manifest, null, 2) + '\n');
      } else if (!write) {
        for (const key of changed) problems.push(`${f}: generated ${key} differs from package.json; run pnpm regen.`);
      }
    }
    if (fieldsOnly) continue;
    if (pkg) {
      if (pkg.version !== manifest.version) problems.push(`${f}: version ${manifest.version} differs from package.json's ${pkg.version}.`);
      if (pkg.license !== manifest.licence) problems.push(`${f}: licence ${manifest.licence} differs from package.json's ${pkg.license}.`);
      const dependencies = Array.isArray(manifest.dependsOn) ? manifest.dependsOn : [];
      const declared = new Set(dependencies.map((d) => d.name));
      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        if (!declared.has(dep)) problems.push(`${f}: depends on ${dep} without listing it in dependsOn; nothing is pulled in implicitly.`);
      }
      for (const d of dependencies) {
        const pinned = pkg.dependencies?.[d.name];
        if (pinned === undefined) problems.push(`${f}: dependsOn names ${d.name}, which package.json does not depend on.`);
        else if (d.version === 'workspace' ? !pinned.startsWith('workspace:') : pinned !== d.version) {
          problems.push(`${f}: dependsOn ${d.name} ${d.version} differs from package.json's ${pinned}.`);
        }
        if (d.licence && !licenceOk(d.licence, { font: isFontPackage(d.name) })) problems.push(`${f}: ${d.name}'s licence ${d.licence} is outside docs/adr/0001.`);
      }
      const layer = pkg.backbone?.layer;
      const expected = { core: 'core', platform: 'platform', module: 'modules', surface: 'surfaces' }[manifest.kind];
      if (expected && layer !== expected) problems.push(`${f}: kind ${manifest.kind} sits in layer ${layer}; expected ${expected}.`);
    }
    if (manifest.publisher?.namespace && manifest.id && !manifest.id.startsWith(`${manifest.publisher.namespace}/`)) {
      problems.push(`${f}: id ${manifest.id} is outside its publisher's namespace ${manifest.publisher.namespace}.`);
    }
    for (const s of manifest.conformance?.suite ?? []) {
      if (!existsSync(join(root, s))) problems.push(`${f}: conformance suite ${s} does not exist.`);
    }
    const listed = files.filter((x) => x.startsWith(`${dir}/`) && existsSync(join(root, x))).map((x) => x.slice(dir.length + 1)).sort();
    const unlisted = walked.filter((x) => !listed.includes(x));
    const unwalked = listed.filter((x) => !walked.includes(x));
    if (unlisted.length || unwalked.length) {
      problems.push(`${f}: the digest covers ${unlisted.join(', ') || 'nothing'} beyond the tracked files and misses ${unwalked.join(', ') || 'nothing'}; keep packages/platform/src/pieces/digest.ts in step with .gitignore.`);
    }
    const actual = digestOf(root, dir, files);
    if (manifest.digest !== actual) {
      if (write) {
        manifest = { ...manifest, digest: actual };
        writeFileSync(join(root, f), JSON.stringify(manifest, null, 2) + '\n');
      } else {
        problems.push(`${f}: digest ${manifest.digest ?? '(none)'} is not the package's content (${actual}). Resolve all rule failures, including neutrality, before reviewing the change and running node scripts/manifests.mjs --write. Never regenerate a digest over a failed neutrality check.`);
      }
    }
    for (const e of validate(root, manifest)) problems.push(`${f}: ${e}; see ${SCHEMA}.`);
  }
  return problems;
}

export function check(root) {
  return manifestProblems(root, listFiles(root));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const problems = manifestProblems(root, listFiles(root), { write: process.argv.includes('--write') });
  for (const p of problems) console.log(`- ${p}`);
  process.exit(problems.length ? 1 : 0);
}
