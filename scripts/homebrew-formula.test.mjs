import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('local Homebrew formula has valid Ruby syntax when Homebrew is available', (t) => {
  if (spawnSync('brew', ['--version'], { stdio: 'ignore' }).status !== 0) {
    t.diagnostic('Homebrew is not installed; formula syntax check was not run.');
    return;
  }
  const result = spawnSync('ruby', ['-c', fileURLToPath(new URL('../deploy/homebrew/backbone-cli-local.rb', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Syntax OK/);
});
