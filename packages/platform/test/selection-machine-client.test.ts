import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inventory } from '../src/selection/inventory.ts';
import { choose } from '../src/selection/choose.ts';

test('a configured Claude machine client requires its maintained signed-in state before selection', () => {
  for (const state of ['checking', 'signed-out', 'different-auth', 'absent', 'error', undefined] as const) {
    const observed = state ?? 'unobserved';
    const routes = inventory({
      codex: { status: 'warn', detail: 'absent' }, claude: { status: 'ok', detail: 'version observed' },
      settings: { own: null, gateway: null, active: { kind: 'agent', label: 'Configured Claude ACP' }, harness: 'ACP', hint: null,
        machineClient: 'claude', ...(state ? { machineClientState: { client: 'claude', state, source: 'claude auth status --json' } } : {}) },
      local: { runtimes: [] },
    });
    const route = routes.find(route => route.id === 'acp')!;
    assert.equal(route.eligible, false, observed);
    assert.equal(route.availability?.state, 'setup', observed);
    assert.ok(route.availability?.detail, observed);
    assert.equal(choose(routes, { needs: ['model', 'code'], network: true, spend: 'metered' }).choice, null, observed);
  }
});

test('Claude machine sign-in permits its configured route without inventing plan billing', () => {
  const routes = inventory({
    codex: { status: 'warn', detail: 'absent' }, claude: { status: 'ok', detail: 'version observed' },
    settings: { own: null, gateway: null, active: { kind: 'agent', label: 'Configured Claude ACP' }, harness: 'ACP', hint: null,
      machineClient: 'claude', machineClientState: { client: 'claude', state: 'signed-in', source: 'claude auth status --json' } },
    local: { runtimes: [] },
  });
  const route = routes.find(route => route.id === 'acp')!;
  assert.equal(route.availability?.state, 'now');
  assert.equal(route.spends, 'metered');
  assert.equal(choose(routes, { needs: ['model', 'code'], network: true, spend: 'metered' }).choice?.route.id, 'acp');
  assert.equal(choose(routes, { needs: ['model', 'code'], network: true, spend: 'plan' }).choice, null);
});

test('the confirmed spend class cannot change at admission even within the caller ceiling', () => {
  const route = { id: 'codex', kind: 'native-engine' as const, label: 'Codex', model: 'chat-model', fingerprint: '0'.repeat(64), capabilities: ['model' as const], network: true, spends: 'metered' as const, eligible: true };
  const selection = choose([route], { needs: ['model'], network: true, spend: 'metered', approvedRoute: { routeId: route.id, model: route.model, fingerprint: route.fingerprint, spend: 'plan' } });
  assert.equal(selection.choice, null);
});
