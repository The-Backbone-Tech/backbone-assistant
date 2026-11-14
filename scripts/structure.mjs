// Layer direction, file size and SQL hygiene (docs/architecture.md, day-one rules).
// Each package declares `backbone.layer` in its package.json; edges may only point down.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listFiles, read } from './lib/repo.mjs';
import { checkCoreSources } from '../packages/core/scripts/closed-version.mjs';

export const LAYERS = ['core', 'platform', 'modules', 'surfaces', 'distribution'];
// What each layer may depend on. Modules implement platform ports; surfaces use the platform API only.
// A distribution assembles pieces through public plugs; nothing may depend on a distribution.
const ALLOWED = { core: [], platform: ['core'], modules: ['platform'], surfaces: ['platform'], distribution: ['platform', 'modules', 'surfaces'] };
export const FILE_LINE_LIMIT = 1500;

export function packagesOf(root, files) {
  return files
    .filter((f) => f.endsWith('package.json') && (f.startsWith('packages/') || f.startsWith('distributions/')))
    .map((f) => {
      const manifest = JSON.parse(read(root, f));
      return { dir: dirname(f), name: manifest.name, layer: manifest.backbone?.layer, manifest };
    });
}

export function edgeProblems(pkgs, exceptions = []) {
  const problems = [];
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  for (const p of pkgs) {
    if (!LAYERS.includes(p.layer)) {
      problems.push(`${p.dir}/package.json: set "backbone": { "layer": one of ${LAYERS.join(', ')} }`);
      continue;
    }
    const deps = Object.keys({ ...p.manifest.dependencies, ...p.manifest.devDependencies, ...p.manifest.peerDependencies });
    for (const dep of deps) {
      const target = byName.get(dep);
      if (!target) continue;
      const allowedEdge = ALLOWED[p.layer].includes(target.layer);
      const excepted = exceptions.some((e) => e.from === p.name && e.to === dep && e.reason && e.owner);
      if (!allowedEdge && !excepted) {
        problems.push(
          `${p.name} (${p.layer}) depends on ${dep} (${target.layer}): ${p.layer} may only depend on ${ALLOWED[p.layer].join(', ') || 'nothing'}. Move the shared code down a layer, or add an exception with a reason and an owner in scripts/structure-exceptions.json.`,
        );
      }
    }
  }
  return problems;
}

export function sizeProblems(root, files) {
  const problems = [];
  for (const f of files) {
    if (!/\.(ts|tsx|js|mjs|cjs|sql)$/.test(f) || !existsSync(join(root, f))) continue;
    const lines = read(root, f).split('\n').length;
    if (lines > FILE_LINE_LIMIT) problems.push(`${f}: ${lines} lines (limit ${FILE_LINE_LIMIT}); split it by responsibility.`);
  }
  return problems;
}

export function sqlProblems(root, files) {
  const problems = [];
  const defined = new Map();
  const coreSchema = 'packages/core/schema/';
  // Core versions own a closed inventory, exact signatures and current-definition map. This
  // is not an exclusion: that checker inspects every on-disk Core SQL file, even an unlisted one.
  if (files.some(f => f.startsWith(coreSchema) && f.endsWith('.sql'))) problems.push(...checkCoreSources(root));
  const packageDirs = files.filter((x) => x.endsWith('/package.json')).map((x) => dirname(x));
  for (const f of files.filter((x) => x.endsWith('.sql') && existsSync(join(root, x)))) {
    const text = read(root, f);
    if (/pg_get_functiondef|regexp_replace\s*\(\s*[^)]*prosrc/i.test(text)) {
      problems.push(`${f}: patches function text; write the whole function in its own source file instead.`);
    }
    // The text-patching ban above applies to EVERY source, including all closed versions.
    if (f.startsWith(coreSchema)) continue; // already checked by exact closed-version ownership
    // Other packages each own one database and keep their one-definition rule.
    const pkg = packageDirs.filter((d) => f.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0] ?? '';
    for (const m of text.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)/gi)) {
      const name = `${pkg}:${m[1].toLowerCase()}`;
      if (defined.has(name) && defined.get(name) !== f) {
        problems.push(`${f}: function ${name.slice(pkg.length + 1)} is already defined in ${defined.get(name)}; keep one definition per function.`);
      } else defined.set(name, f);
    }
  }
  return problems;
}

export function check(root) {
  const files = listFiles(root);
  const exceptionsFile = join(root, 'scripts/structure-exceptions.json');
  const exceptions = existsSync(exceptionsFile) ? JSON.parse(readFileSync(exceptionsFile, 'utf8')) : [];
  const malformed = exceptions.filter((e) => !e.reason || !e.owner).map((e) => `structure exception ${e.from} -> ${e.to} needs a reason and an owner.`);
  return [...malformed, ...edgeProblems(packagesOf(root, files), exceptions), ...sizeProblems(root, files), ...sqlProblems(root, files)];
}
