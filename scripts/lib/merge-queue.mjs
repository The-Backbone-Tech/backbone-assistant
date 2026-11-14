// Shared queue input and Git helpers. Source admission lives in merge-queue-policy.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cherryPickUnit } from './merge-queue-mechanical.mjs';
import { attributeFailingFiles } from './merge-queue-policy.mjs';
export { unionJourneys } from './merge-queue-mechanical.mjs';

export function git(root, args, options = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2, ...options });
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout.trim();
}
export function validateQueue(queue) {
  if (!queue || typeof queue !== 'object' || !Array.isArray(queue.units)) throw new Error('Queue must contain a units array');
  const names = new Set(), heads = new Set();
  for (const unit of queue.units) {
    if (!unit || typeof unit.name !== 'string' || unit.name.startsWith('-') || /[\s\x00-\x1f]/.test(unit.name) || /^(?:origin\/)?claude\/integration$/.test(unit.name) || spawnSync('git', ['check-ref-format', '--branch', unit.name], { stdio: 'ignore' }).status !== 0) throw new Error('Invalid unit name');
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(unit.head || '')) throw new Error(`Invalid immutable head for ${unit.name}`);
    if (typeof unit.note !== 'string' || !unit.note.trim() || /[\x00-\x08\x0b-\x1f]/.test(unit.note)) throw new Error(`Missing author note for ${unit.name}`);
    if (names.has(unit.name) || heads.has(unit.head)) throw new Error(`Duplicate queued unit: ${unit.name}`);
    if (typeof unit.session !== 'string' || !unit.session.trim() || /[\x00-\x1f]/.test(unit.session)) throw new Error(`Missing authoring session for ${unit.name}`);
    if (unit.review !== undefined && typeof unit.review !== 'string') throw new Error(`Review binding for ${unit.name} must name a local file`);
    names.add(unit.name); heads.add(unit.head);
  }
  return queue.units.map(({ name, head, note, session, authorFamily, review }) => ({ name, head, note, session, ...(authorFamily ? { authorFamily } : {}), ...(review ? { review } : {}) }));
}

/** Kept for snapshot consumers: this now cherry-picks the range in an owned checkout. */
export function mergeUnit(root, left, unit) {
  const parent = join(root, '.gate'); mkdirSync(parent, { recursive: true });
  const candidate = join(parent, `unit-pick-${randomUUID()}`);
  git(root, ['worktree', 'add', '--detach', candidate, left]);
  try { return cherryPickUnit(candidate, unit, { base: left }); }
  finally { git(root, ['worktree', 'remove', '--force', candidate]); }
}
/** A suite name alone is not attribution; callers need the actual failing file. */
export function attributeFailure(root, failure, units) {
  return attributeFailingFiles(root, typeof failure === 'object' ? failure : { files: [] }, units);
}
export function integrationLine(summary, units, head) {
  if (!summary.split('\n').includes(`commit ${head}`)) throw new Error('Gate summary commit differs from candidate');
  if (!summary.split('\n').includes('overall: passed')) throw new Error('Gate summary is not passed');
  const suites = summary.split('\n').filter(line => line.startsWith('== '));
  if (!suites.length || suites.some(line => !line.includes(' :: completed :: '))) throw new Error('Gate summary has no completed suites');
  const counts = suites.map(line => line.replace(/^== ([^:]+):.*? :: completed :: exit .*? :: (.*?) :: .*$/, '$1: $2'));
  const escape = value => value.replace(/[|\r\n`]/g, ' ');
  return `- Gate ${head}; units ${units.map(unit => `${escape(unit.name)}@${unit.head}`).join(', ')}; suites ${counts.map(escape).join('; ')}.\n`;
}
