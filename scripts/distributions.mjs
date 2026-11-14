// Distributions are configuration only (docs/repo-design.md): every distribution.json, the Base's
// examples and any repository's own distributions, is valid against schemas/distribution.schema.json
// and names only modules the Base has. `baseRoot` is where the modules live (the linked Base, for a
// repository that runs this check from it).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { distributionProblems } from './lib/brand.mjs';
import { listFiles, read } from './lib/repo.mjs';

const DISTRIBUTION = /^(?:examples|distributions)\/[^/]+\/distribution\.json$/;

export function check(root, { baseRoot = root } = {}) {
  const problems = [];
  for (const f of listFiles(root).filter((x) => DISTRIBUTION.test(x) && existsSync(join(root, x)))) {
    let d;
    try {
      d = JSON.parse(read(root, f));
    } catch (error) {
      problems.push(`${f}: not JSON (${error.message}).`);
      continue;
    }
    for (const p of distributionProblems(d)) problems.push(`${f}: ${p}; see schemas/distribution.schema.json.`);
    for (const m of d.modules ?? []) {
      if (!existsSync(join(baseRoot, 'packages/modules', m, 'package.json'))) problems.push(`${f}: module ${m} is not in packages/modules.`);
    }
    if (d.defaults?.harness && !(d.modules ?? []).includes(d.defaults.harness)) problems.push(`${f}: the default harness ${d.defaults.harness} is not one of its modules.`);
  }
  return problems;
}
