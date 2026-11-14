import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from './docker-context.mjs';
import { dockerignoreText } from './lib/docker-context.mjs';

const repo = join(import.meta.dirname, '..');

test('Docker check catches missing package copies and stale context', () => {
  const root = mkdtempSync(join(tmpdir(), 'docker-check-'));
  try {
    // A clean tracked copy keeps the generator's git index and pnpm workspace discovery realistic.
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', '--local', repo, root]);
    for (const file of ['.dockerignore', 'deploy/docker/Dockerfile']) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      cpSync(join(repo, file), join(root, file));
    }
    // The clone has HEAD's files, while the caller may have new indexed source files.
    // Its initial allowlist must describe its own index before the deliberate mutations below.
    writeFileSync(join(root, '.dockerignore'), dockerignoreText(root));
    assert.deepEqual(check(root), []);
    const dockerfile = join(root, 'deploy/docker/Dockerfile');
    writeFileSync(dockerfile, readFileSync(dockerfile, 'utf8').replace('COPY packages/surfaces/channels packages/surfaces/channels\n', ''));
    assert.match(check(root).join('\n'), /Dockerfile must copy packages\/surfaces\/channels/);
    const ignore = join(root, '.dockerignore');
    writeFileSync(ignore, readFileSync(ignore, 'utf8').replace('!packages/surfaces/channels/package.json\n', ''));
    const failures = check(root).join('\n');
    assert.match(failures, /\.dockerignore is stale/);
    assert.match(failures, /channels\/package.json is missing from the Docker context/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
