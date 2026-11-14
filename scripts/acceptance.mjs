// Adopted from backbone-way scripts/acceptance.mjs; source commit is in the import manifest.
// Jobs and conformance now share this checkout. Shape checks do not claim a passing job.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

const localPath = path => typeof path === 'string' && path.length > 0 &&
  !isAbsolute(path) && !path.split('/').includes('..') && !path.includes(':');

export function jobProblems(root, id, job) {
  const at = `acceptance/${id}/job.json`;
  if (!job || typeof job !== 'object' || Array.isArray(job)) return [`${at}: needs a job object.`];
  const problems = [];
  if (typeof job.title !== 'string' || !job.title) problems.push(`${at}: needs a title.`);
  if (typeof job.conformance !== 'string' || !/^conformance\/[^/]+$/.test(job.conformance)) {
    problems.push(`${at}: name the local conformance job it extends, as "conformance": "conformance/<id>".`);
  } else if (!localPath(job.conformance) || !existsSync(join(root, job.conformance, 'job.json'))) {
    problems.push(`${at}: ${job.conformance} is not a local conformance job.`);
  }
  if (!Array.isArray(job.owns) || !job.owns.length) problems.push(`${at}: owns must list existing local paths.`);
  else for (const path of job.owns) {
    if (!localPath(path) || !existsSync(join(root, path))) problems.push(`${at}: owns ${path}, which is not an existing local path.`);
  }
  return problems;
}

export function check(root) {
  const dir = join(root, 'acceptance');
  const problems = [];
  const jobs = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() : [];
  for (const id of jobs) {
    const file = join(dir, id, 'job.json');
    if (!existsSync(file)) { problems.push(`acceptance/${id}: needs a job.json.`); continue; }
    try { problems.push(...jobProblems(root, id, JSON.parse(readFileSync(file, 'utf8')))); }
    catch { problems.push(`acceptance/${id}/job.json: invalid job JSON.`); }
  }
  return problems;
}
