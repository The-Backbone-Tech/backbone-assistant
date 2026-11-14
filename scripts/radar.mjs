// The radar format (radar/README.md): every radar/*.json entry is valid against
// schemas/radar.schema.json, is named after its capability, and cites only sources it lists.
// The format and this check are the Base's; the dated entries belong to whoever makes the choices.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { listFiles, read } from './lib/repo.mjs';

const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), '../schemas/radar.schema.json');
let validator;

export function entryProblems(file, entry) {
  if (!validator) validator = new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(SCHEMA, 'utf8')));
  const problems = validator(entry) ? [] : validator.errors.map((e) => `${file}: ${e.instancePath || '/'} ${e.message}; see schemas/radar.schema.json.`);
  if (typeof entry.capability === 'string' && entry.capability !== basename(file, '.json')) {
    problems.push(`${file}: capability "${entry.capability}" differs from the file name; one file per capability, named after it.`);
  }
  const ids = new Set((entry.sources ?? []).map((s) => s.id));
  const claims = [...(entry.why ?? []), ...(entry.components ?? []).flatMap((c) => c.why ?? [])];
  for (const id of new Set(claims.flatMap((w) => w.sources ?? []))) {
    if (!ids.has(id)) problems.push(`${file}: a claim cites source ${id}, which "sources" does not list.`);
  }
  return problems;
}

export function check(root) {
  const problems = [];
  for (const f of listFiles(root).filter((x) => /^radar\/[^/]+\.json$/.test(x) && existsSync(join(root, x)))) {
    let entry;
    try {
      entry = JSON.parse(read(root, f));
    } catch (error) {
      problems.push(`${f}: not JSON (${error.message}).`);
      continue;
    }
    problems.push(...entryProblems(f, entry));
  }
  return problems;
}
