// One command for every day-one rule. Exits non-zero with an actionable message per problem.
// Optional legacy references are checked only when their checkout is supplied.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as acceptance from './acceptance.mjs';
import * as conformance from './conformance.mjs';
import * as contamination from './contamination.mjs';
import * as distributions from './distributions.mjs';
import * as dockerContext from './docker-context.mjs';
import * as docs from './docs.mjs';
import * as guideSteps from './guide-steps.mjs';
import * as licences from './licences.mjs';
import * as manifests from './manifests.mjs';
import * as moduleReadme from './module-readme.mjs';
import * as paths from './paths.mjs';
import * as radar from './radar.mjs';
import * as structure from './structure.mjs';
import * as testEdit from './test-edit.mjs';
import * as journeys from './journeys.mjs';
import * as regen from './regen.mjs';
import * as testState from './test-state.mjs';
import * as vocabulary from './vocabulary.mjs';

export function repositoryChecks(root, env = process.env) {
  // No sibling is needed here. Optional legacy roots verify only material still outside.
  const repos = { 'backbone-way': env.BACKBONE_WAY, 'backbone-owner': env.BACKBONE_OWNER };
  return {
    structure: () => structure.check(root),
    paths: () => paths.check(root),
    'test-edit': () => testEdit.check(root),
    'test-state': () => testState.check(root),
    journeys: () => journeys.check(root),
    regen: () => regen.check(root),
    licences: () => licences.check(root),
    'module-readme': () => moduleReadme.check(root),
    contamination: () => contamination.check(root),
    manifests: () => manifests.check(root),
    distributions: () => distributions.check(root),
    'docker-context': () => dockerContext.check(root),
    conformance: () => conformance.check(root),
    acceptance: () => acceptance.check(root),
    radar: () => radar.check(root),
    docs: () => docs.check(root, { repos }),
    vocabulary: () => vocabulary.check(root),
    'guide-steps': () => guideSteps.check(root),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const checks = repositoryChecks(process.cwd());
  let failed = 0;
  for (const [name, run] of Object.entries(checks)) {
    const problems = run();
    if (problems.length === 0) {
      console.log(`ok    ${name}`);
    } else {
      failed += problems.length;
      console.log(`FAIL  ${name}`);
      for (const p of problems) console.log(`      - ${p}`);
    }
  }
  if (failed) {
    console.log(`\n${failed} problem(s).`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}
