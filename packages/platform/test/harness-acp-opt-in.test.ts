import { acceptAcpTestConfiguration } from '../src/testing/acp.ts';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { acpStorageDir } from '../src/composition/harnesses.ts';
import { freshHome, idle, open, settings, value } from './helpers.ts';
const fixture = fileURLToPath(new URL('../../modules/harness-acp/test/fake-agent.mjs', import.meta.url));
for (const acceptsProcessVisibility of [undefined, false, 'true', 1, null, {}, [true], true]) test(`Host ACP selection requires explicit process visibility acceptance: ${JSON.stringify(acceptsProcessVisibility)}`, async () => {
  const home = freshHome();
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ harness: 'harness-acp', harnesses: { 'harness-acp': (acceptsProcessVisibility === true ? acceptAcpTestConfiguration(home, { acceptsProcessVisibility, agent: 'owned-fake', command: process.execPath, args: [fixture], environment: process.platform === 'darwin' ? 'restricted-writes' : 'person-rights' } as never) : { acceptsProcessVisibility, agent: 'owned-fake', command: process.execPath, args: [fixture], environment: process.platform === 'darwin' ? 'restricted-writes' : 'person-rights' }) } }));
  // A previous API route must not become a fallback for a disabled agent-owned engine.
  writeFileSync(join(home, 'model-route.json'), JSON.stringify({ local: { provider: 'ollama', model: 'owned-unused', baseUrl: 'http://127.0.0.1:1/v1' } }));
  const { host } = open(home);
  const project = value(await host.call('projects.create', { name: 'ACP risk acceptance', kind: 'folder' }));
  const model = await host.call('settings.model.get', {}), models = await host.call('models.list', {});
  const selection = await host.call('solutions.options', { needs: ['model', 'files'], network: true, spend: 'metered' });
  const inventory = [...selection.feasible, ...selection.excluded].map(entry => entry.route);
  const sent = await host.call('turns.send', { projectId: project.id, text: 'ready', settings, attachments: [], clientKey: 'opt-in' });
  if (acceptsProcessVisibility === true) {
    assert.equal(model.active?.kind, 'agent'); assert.ok(models.some(m => m.id === 'chosen-by-agent')); assert.ok(inventory.some(route => route.kind === 'agent-engine'));
    for (const text of [model.harness, model.active!.label, model.hint, models[0].label, inventory.find(route => route.kind === 'agent-engine')!.label]) {
      assert.match(text ?? '', /An ACP agent runs as you/); assert.match(text ?? '', /environment variables and command lines.*API keys/); assert.match(text ?? '', /unrestricted outbound IP network/); assert.match(text ?? '', /writing outside its own folders.*signalling other processes.*starting system background services/);
    }
    const turn = (await idle(host, value(sent).threadId)).turns[0]; assert.equal(turn.status, 'done'); assert.equal(turn.answer?.text, 'ready');
  } else {
    assert.equal(model.active, null); assert.deepEqual(models, []); assert.ok(inventory.every(route => route.kind !== 'agent-engine'));
    assert.equal(sent.ok, false); if (sent.ok) return assert.fail('ACP must not start');
    assert.equal(sent.reason, 'NOT_AVAILABLE'); assert.match(sent.detail, /harnesses.harness-acp.acceptsProcessVisibility: true/); assert.match(sent.detail, /environment variables and command lines.*API keys/);
    assert.match(model.hint ?? '', /acceptsProcessVisibility/); assert.equal(existsSync(acpStorageDir(home)), false, 'the ACP factory created no session state or agent process');
    assert.deepEqual(await host.call('threads.list', {}), []);
  }
});
