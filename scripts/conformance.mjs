// Conformance jobs (conformance/README.md) are neutral: each job.json names a title, the paths it
// owns, the invariants it proves (defined in docs/architecture.md) and the contracts it exercises,
// all of which exist; and no job carries a product requirement ID, which belongs to a distribution.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUIREMENT_ID = /\bR-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/;

export function invariantsIn(architecture) {
  return new Set([...architecture.matchAll(/^\|\s*(I-\d+)\s*\|/gm)].map((m) => m[1]));
}

export function jobProblems(root, id, job, texts, invariants) {
  const problems = [];
  const at = `conformance/${id}/job.json`;
  if (typeof job.title !== 'string' || !job.title) problems.push(`${at}: needs a title.`);
  for (const key of ['owns', 'invariants', 'contracts']) if (!Array.isArray(job[key]) || !job[key].length) problems.push(`${at}: needs a non-empty "${key}" list.`);
  for (const p of [...(job.owns ?? []), ...(job.contracts ?? [])]) if (!existsSync(join(root, p))) problems.push(`${at}: ${p} does not exist.`);
  for (const i of job.invariants ?? []) if (!invariants.has(i)) problems.push(`${at}: ${i} is not an invariant in docs/architecture.md.`);
  for (const [file, text] of texts) {
    const m = REQUIREMENT_ID.exec(text);
    if (m) problems.push(`conformance/${id}/${file}: names product requirement ${m[0]}; a conformance job cites invariants and contracts, and a distribution's acceptance job adds its requirements.`);
  }
  return problems;
}

export function check(root) {
  const dir = join(root, 'conformance');
  if (!existsSync(dir)) return [];
  const invariants = invariantsIn(readFileSync(join(root, 'docs/architecture.md'), 'utf8'));
  const problems = [];
  for (const id of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const files = readdirSync(join(dir, id));
    if (!files.includes('job.json') || !files.includes('job.md')) {
      problems.push(`conformance/${id}: needs job.json and job.md.`);
      continue;
    }
    const texts = files.filter((f) => /\.(md|json)$/.test(f)).map((f) => [f, readFileSync(join(dir, id, f), 'utf8')]);
    let job;
    try {
      job = JSON.parse(readFileSync(join(dir, id, 'job.json'), 'utf8'));
    } catch (error) {
      problems.push(`conformance/${id}/job.json: not JSON (${error.message}).`);
      continue;
    }
    problems.push(...jobProblems(root, id, job, texts, invariants));
  }
  return problems;
}
