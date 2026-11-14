// Reproducible build outputs only. Native catalogue pins are qualification evidence.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { coreSourceState, runtimeReleaseArtifacts, checkCoreSources } from '../packages/core/scripts/closed-version.mjs';
import { listFiles } from './lib/repo.mjs';
import { readmeProblems } from './module-readme.mjs';
import { manifestProblems } from './manifests.mjs';
import { dockerignoreText } from './lib/docker-context.mjs';

export const generators = [
  { name: 'core-sources', run(root) {
    const state = coreSourceState(root);
    const artifacts = runtimeReleaseArtifacts(state.versions);
    writeFileSync(join(root, 'packages/core/schema/current.json'), JSON.stringify(state.current, null, 2) + '\n');
    for (const { file, artifact } of artifacts) writeFileSync(join(root, file), artifact);
    return [];
  }, check: checkCoreSources },
  { name: 'manifest-fields', run: root => manifestProblems(root, listFiles(root), { write: true, fieldsOnly: true }), check: root => manifestProblems(root, listFiles(root), { fieldsOnly: true }) },
  { name: 'module-readme', run: root => readmeProblems(root, listFiles(root), { write: true }), check: root => readmeProblems(root, listFiles(root)) },
  { name: 'manifests', run: root => manifestProblems(root, listFiles(root), { write: true }), check: root => manifestProblems(root, listFiles(root)) },
  { name: 'docker-context', run: root => { writeFileSync(join(root, '.dockerignore'), dockerignoreText(root)); return []; }, check: root => readFileSync(join(root, '.dockerignore'), 'utf8') === dockerignoreText(root) ? [] : ['.dockerignore differs'] },
];

export function regenerate(root, steps = generators) {
  for (const step of steps) {
    const problems = step.run(root) || [];
    if (problems.length) throw new Error(`${step.name}: ${problems.join('\n')}`);
  }
}

export function regenerationProblems(root, steps = generators) {
  return steps.flatMap(step => {
    try { return step.check(root).map(problem => `${step.name}: ${problem}; run pnpm regen`); }
    catch (error) { return [`${step.name}: ${error.message}`]; }
  });
}

export const check = regenerationProblems;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--check'].includes(arg))) throw new Error('usage: node scripts/regen.mjs [--check]');
    if (args.includes('--check')) {
      const problems = check(process.cwd());
      for (const problem of problems) console.error(problem);
      process.exitCode = problems.length ? 1 : 0;
    } else { regenerate(process.cwd()); console.log('Regenerated Core source artifacts, README blocks, manifests and Docker context.'); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
