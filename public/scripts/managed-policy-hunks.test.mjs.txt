// The handoff is retired: these checks pin its integration boundaries, alongside live consumer tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('reserved policy hooks are applied and no implemented requirement remains deferred', async () => {
  const { ENFORCEMENT_GAPS } = await import('../packages/platform/src/policy/enforcement.ts');
  assert.deepEqual(Object.keys(ENFORCEMENT_GAPS), []);
  for (const [path, pattern] of [
    ['packages/platform/src/composition/host.ts', /await admission.ready\(\)/],
    ['packages/platform/src/composition/engine-settings.ts', /harnessDecision\(governedPolicy\(home\)/],
    ['packages/platform/src/keys/vault.ts', /keyDecision\(governedPolicy\(this.home\), this.holder\)/],
    ['packages/platform/src/connectors/service.ts', /standingDecision\(governedPolicy\(this.options.home\), server\)/],
    ['packages/platform/src/composition/harness-turn.ts', /try \{ checkPolicy\(\)/],
    ['packages/surfaces/app/electron/main.ts', /Managed policy refused/],
    ['packages/surfaces/app/src/components/SettingsDialog.tsx', /<ManagedPolicy \/>/],
  ]) assert.match(read(path), pattern, path);
  assert.match(read('docs/contracts/managed-policy.md'), /^# Managed policy\n/);
});
test('the policy Settings read moves with its method catalogue, line validator and authority record', () => {
  for (const path of ['packages/platform/src/api.ts', 'packages/platform/src/composition/host-reads.ts', 'packages/platform/src/doors/api-line.ts', 'packages/platform/src/composition/api-line.ts', 'docs/adr/0002-api-line.md'])
    assert.ok(read(path).includes('settings.policy.get'), path);
  assert.match(read('packages/platform/src/policy/visibility.ts'), /descriptions: Object.fromEntries/);
});
