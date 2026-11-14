// Check the daemon's build inputs against the CLI's workspace dependency closure.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockerignoreText, excluded, workspaceClosure } from './lib/docker-context.mjs';

export function check(root) {
  const problems = [];
  try {
    const ignore = readFileSync(join(root, '.dockerignore'), 'utf8');
    const dockerfile = readFileSync(join(root, 'deploy/docker/Dockerfile'), 'utf8');
    if (ignore !== dockerignoreText(root)) problems.push('.dockerignore is stale: run node scripts/lib/docker-context.mjs --write.');
    const beforeInstall = dockerfile.split('RUN pnpm install')[0];
    if (beforeInstall === dockerfile) problems.push('Dockerfile has no pnpm install step.');
    for (const path of workspaceClosure(root)) {
      const manifest = `${path}/package.json`;
      if (!existsSync(join(root, manifest)) || excluded(manifest, ignore)) problems.push(`${manifest} is missing from the Docker context.`);
      if (!beforeInstall.split('\n').includes(`COPY ${path} ${path}`)) problems.push(`Dockerfile must copy ${path} with COPY ${path} ${path}.`);
    }
  } catch (error) { problems.push(`Cannot check Docker context: ${error.message}`); }
  return problems;
}
