// Tests are the grader: no skipped or focused tests, and no deleted test without a reviewed reason.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTest, listFiles, read } from './lib/repo.mjs';

const SKIP = /\b(?:it|test|describe)\.(?:skip|only|todo)\s*\(|\bx(?:it|describe)\s*\(/;

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// Compare with the merge base of the default branch when it exists, otherwise with HEAD.
export function base(root) {
  for (const ref of ['origin/main', 'main']) {
    const mb = git(root, ['merge-base', 'HEAD', ref]);
    if (mb && mb !== git(root, ['rev-parse', 'HEAD'])) return mb;
  }
  return git(root, ['rev-parse', '--verify', 'HEAD']);
}

export function check(root) {
  const problems = [];
  for (const f of listFiles(root).filter(isTest)) {
    if (existsSync(join(root, f)) && SKIP.test(read(root, f))) {
      problems.push(`${f}: skipped or focused test; fix or delete it through review instead of skipping.`);
    }
  }
  const from = base(root);
  if (from) {
    const allowFile = join(root, 'scripts/test-edit-allow.json');
    const allowed = existsSync(allowFile) ? JSON.parse(readFileSync(allowFile, 'utf8')) : [];
    const deleted = (git(root, ['diff', '--name-only', '--diff-filter=D', from]) ?? '').split('\n').filter(isTest);
    for (const f of deleted) {
      if (!allowed.some((a) => a.file === f && a.reason && a.reviewer)) {
        problems.push(`${f}: test deleted; add it to scripts/test-edit-allow.json with a reason and a reviewer, or restore it.`);
      }
    }
  }
  return problems;
}
