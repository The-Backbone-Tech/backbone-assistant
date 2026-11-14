// Licence policy (docs/adr/0001): our packages are Apache-2.0; installed dependencies use allowed licences.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listFiles, read } from './lib/repo.mjs';

export const ALLOWED = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'PostgreSQL', 'MPL-2.0', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense', 'Python-2.0'];

/** Fonts may also use OFL-1.1 (ADR 0001). Only font packages count as fonts: Fontsource's own scopes. */
export const FONT_ONLY = ['OFL-1.1'];
export const isFontPackage = (name) => /^@fontsource(-variable)?\//.test(name ?? '');

export function licenceOk(expr, { font = false } = {}) {
  if (!expr) return false;
  const allowed = font ? [...ALLOWED, ...FONT_ONLY] : ALLOWED;
  return expr
    .replace(/[()]/g, ' ')
    .split(/\s+OR\s+/i)
    .some((alt) => alt.split(/\s+AND\s+/i).every((id) => allowed.includes(id.trim())));
}

/** The same metadata interpretation feeds policy checks and shipped notice generation. */
export function declaredLicence(m) {
  if (m.license !== undefined) return typeof m.license === 'string' ? m.license : m.license?.type;
  return Array.isArray(m.licenses) && m.licenses.length && m.licenses.every(x => x && typeof x.type === 'string')
    ? m.licenses.map(x => `(${x.type})`).join(' AND ') : undefined;
}
export function licenceProblems(entries) {
  return entries.flatMap(m => (m.license === undefined && declaredLicence(m)
    ? m.licenses.every(x => licenceOk(x.type, { font: isFontPackage(m.name) }))
    : licenceOk(declaredLicence(m), { font: isFontPackage(m.name) })) ? []
    : [`${m.name}@${m.version}: licence "${declaredLicence(m) ?? 'none'}" is outside the policy; replace the dependency or record an ADR.`]);
}

function installed(root) {
  const store = join(root, 'node_modules/.pnpm');
  if (!existsSync(store)) return [];
  const out = [];
  for (const entry of readdirSync(store)) {
    const nm = join(store, entry, 'node_modules');
    if (!existsSync(nm)) continue;
    for (const scope of readdirSync(nm)) {
      const dirs = scope.startsWith('@') ? readdirSync(join(nm, scope)).map((d) => join(scope, d)) : [scope];
      for (const d of dirs) {
        const pj = join(nm, d, 'package.json');
        if (existsSync(pj)) out.push(JSON.parse(readFileSync(pj, 'utf8')));
      }
    }
  }
  return out;
}

export function check(root) {
  const problems = [];
  for (const f of listFiles(root).filter((x) => x === 'package.json' || (x.startsWith('packages/') && x.endsWith('/package.json')))) {
    const m = JSON.parse(read(root, f));
    if (m.license !== 'Apache-2.0') problems.push(`${f}: set "license": "Apache-2.0".`);
  }
  const seen = new Set();
  for (const m of installed(root)) {
    const key = `${m.name}@${m.version}`;
    if (seen.has(key) || m.name?.startsWith('backbone-next')) continue;
    seen.add(key);
    problems.push(...licenceProblems([m]));
  }
  return problems;
}
