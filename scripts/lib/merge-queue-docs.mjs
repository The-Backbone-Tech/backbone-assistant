// Carry human documentation without changing gated code or duplicating remote history.
import { spawnSync } from 'node:child_process';
import { git } from './merge-queue.mjs';

const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
// These Markdown files are executable/graded oracle inputs, not a harmless tail.
export const docsOnlyPath = file => (/^docs\/.+\.md$/.test(file) || /^(?:GOAL|README|AGENTS|CLAUDE)\.md$/.test(file))
  && !file.startsWith('docs/how-to/') && !['docs/distributions.md', 'docs/architecture.md'].includes(file);

/** Check paths, both modes and Git's binary classification even for renamed/deleted blobs. */
export function assertDocsDelta(root, from, to) {
  const files = git(root, ['diff', '--no-renames', '--name-only', '-z', from, to]).split('\0').filter(Boolean);
  const rejected = files.filter(file => !docsOnlyPath(file));
  for (const file of files.filter(docsOnlyPath)) for (const head of [from, to]) {
    const row = git(root, ['ls-tree', head, '--', file]);
    if (row && !/^100644 blob /.test(row)) rejected.push(file);
  }
  const stats = git(root, ['diff', '--no-renames', '--numstat', '-z', from, to]).split('\0');
  for (const row of stats) if (row.startsWith('-\t-\t')) rejected.push(row.slice(4));
  if (rejected.length) throw new Error(`Integration delta is not docs-only at ${to}: ${[...new Set(rejected)].join(', ')}`);
  return files;
}

/** Inspect each commit, not its net diff: a code edit followed by a revert is ungated. */
export function inspectDocsTail(root, qualifiedHead, remoteBase) {
  if (!sha.test(qualifiedHead || '')) throw new Error('qualifiedHead must be the exact qualified code commit SHA');
  if (!sha.test(remoteBase || '')) throw new Error('Remote integration needs an exact commit SHA');
  git(root, ['merge-base', '--is-ancestor', qualifiedHead, remoteBase]);
  const commits = git(root, ['rev-list', '--reverse', '--topo-order', `${qualifiedHead}..${remoteBase}`]).split('\n').filter(Boolean);
  for (const commit of commits) {
    const parents = git(root, ['rev-list', '--parents', '-n', '1', commit]).split(' ').slice(1);
    if (parents.length !== 1) throw new Error(`Integration docs-only tail needs a linear history; use the previous published head as qualifiedHead or inspect ${commit}`);
    assertDocsDelta(root, parents[0], commit);
  }
  return { qualifiedHead, remoteBase, commits };
}

/** Merge the gated candidate into the remote line once; refuse conflicts or changed code. */
export function carryDocsTail(root, { qualifiedHead, remoteBase, gatedHead }) {
  const tail = inspectDocsTail(root, qualifiedHead, remoteBase);
  if (git(root, ['rev-parse', 'HEAD']) !== gatedHead || git(root, ['status', '--porcelain'])) throw new Error('Docs carry needs the clean, unchanged gated candidate');
  if (!tail.commits.length) return { ...tail, head: gatedHead };
  try {
    git(root, ['checkout', '--detach', remoteBase]);
    git(root, ['-c', 'rerere.enabled=false', 'merge', '--no-ff', '--no-commit', '--no-autostash', gatedHead]);
    if (spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: root, stdio: 'ignore' }).status === 0) {
      git(root, ['-c', 'core.hooksPath=scripts/hooks', 'commit', '-s', '-m', 'Join gated code to the docs-only integration line', '--trailer', 'Agent: merge-queue']);
    }
    const head = git(root, ['rev-parse', 'HEAD']);
    assertDocsDelta(root, gatedHead, head);
    git(root, ['merge-base', '--is-ancestor', remoteBase, head]);
    git(root, ['merge-base', '--is-ancestor', gatedHead, head]);
    return { ...tail, head };
  } catch (error) {
    const conflicts = spawnSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
    spawnSync('git', ['merge', '--abort'], { cwd: root, stdio: 'ignore' });
    try { git(root, ['reset', '--hard', gatedHead]); }
    catch (rollback) { error.rollbackError = rollback.message; }
    error.code = 'DOCS_CARRY_REFUSED'; error.docsConflicts = conflicts ? conflicts.split('\n') : [];
    error.message = `Docs-only merge refused${conflicts ? ` (${conflicts})` : ''}; return to the integrator: ${error.message}`;
    throw error;
  }
}
