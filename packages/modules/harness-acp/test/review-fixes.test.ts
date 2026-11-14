// Protocol-only controls use an explicit person-rights, owned local fake; OS controls have separate real-profile tests.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TurnContext, TurnRequest } from '@backbone-next/platform/ports';
import { createAcpHarness } from '../src/index.ts';
const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const request: TurnRequest = { threadId: 'review', turnId: 'one', text: 'ready', history: [], attachments: [], effort: 3, resumed: false };
const context: TurnContext = { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'no grant' }) }, route: { kind: 'agent', provider: 'acp:fake', model: 'chosen-by-agent', label: 'fake', baseUrl: '', credential: null }, credential: async () => { throw new Error('No credential.'); } };

test('session/load historical replay is ignored until the new prompt begins', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'acp-load-review-'));
  const options = { acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: 'person-rights' as const, env: { ACP_FAKE_MODE: 'load' }, storageDir };
  const firstHarness = createAcpHarness(options), secondHarness = createAcpHarness(options);
  try {
    const first = await firstHarness.start(request, context).outcome;
    assert.equal(first.status, 'done'); await firstHarness.close();
    const second = secondHarness.start({ ...request, turnId: 'two', history: [{ role: 'user', text: request.text }, { role: 'assistant', text: first.answer }] }, context);
    const deltas: string[] = []; const events = (async () => { for await (const event of second.events) if (event.type === 'text') deltas.push(event.delta); })();
    const outcome = await second.outcome; await events;
    assert.equal(outcome.status, 'done'); assert.equal(outcome.answer, first.answer.replace('loaded-false', 'loaded-true'));
    assert.ok(deltas.every(delta => !delta.includes('HISTORICAL-REPLAY')));
  } finally { await firstHarness.close(); await secondHarness.close(); await rm(storageDir, { recursive: true, force: true }); }
});

test('client file methods refuse a wrong session and a stopped turn', async () => {
  for (const mode of ['file-wrong-session', 'file-after-stop']) {
    const h = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: 'person-rights', env: { ACP_FAKE_MODE: mode }, stopTimeoutMs: 1000 });
    try {
      const turn = h.start(request, context);
      const events = (async () => { for await (const e of turn.events) if (e.type === 'text' && e.delta === 'rea' && mode === 'file-after-stop') turn.stop(); })();
      const result = await turn.outcome; await events;
      assert.equal(result.status, mode === 'file-after-stop' ? 'interrupted' : 'done');
      assert.match(result.answer, /refused:This turn no longer grants client access/);
    } finally { await h.close(); }
  }
});
test('safe platform refusal reasons survive the Harness outcome', async () => {
  const { writeRestrictionCommand } = await import('../src/write-restrictions.ts');
  const options = { acceptsProcessVisibility: true, command: '/bin/true', args: [], work: '/', state: '/' };
  assert.throws(() => writeRestrictionCommand(options, 'linux'), /Linux restricted-writes execution is unavailable/);
  assert.throws(() => writeRestrictionCommand(options, 'darwin', false), /sandbox-exec is missing/);
  const h = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fixture] });
  try {
    const result = await h.start(request, context).outcome;
    if (process.platform === 'darwin') assert.equal(result.status, 'done');
    else assert.match(result.error ?? '', /unavailable|missing|refused/);
  } finally { await h.close(); }
});
test('credential environment names are refused rather than misdeclared as surrogate credentials', async () => {
  const h = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: 'person-rights', env: { PROVIDER_API_KEY: 'owned-fake-canary' } });
  try { const result = await h.start(request, context).outcome; assert.equal(result.status, 'failed'); assert.match(result.error ?? '', /non-secret environment/); } finally { await h.close(); }
});
test('idle sessions release their process and bridge and load when used again', async () => {
  const h = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: 'person-rights', env: { ACP_FAKE_MODE: 'load' }, idleTimeoutMs: 10 });
  try {
    const first = await h.start(request, context).outcome; await new Promise(resolve => setTimeout(resolve, 50));
    const second = await h.start({ ...request, turnId: 'next', history: [{ role: 'user', text: request.text }, { role: 'assistant', text: first.answer }] }, context).outcome;
    assert.equal(second.status, 'done'); assert.match(second.answer, /loaded-true/);
  } finally { await h.close(); }
});
test('Stop deliberately discards combined native authentication/session state', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'acp-stop-state-'));
  const h = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: 'person-rights', storageDir, env: { ACP_FAKE_MODE: 'wait' } });
  try {
    const turn = h.start(request, context);
    const events = (async () => { for await (const e of turn.events) if (e.type === 'text' && e.delta === 'rea') {
      const [session] = await readdir(storageDir); const current = JSON.parse(await readFile(join(storageDir, session, 'current.json'), 'utf8')); await writeFile(join(storageDir, session, current, 'agent', 'authentication-canary'), 'not a real credential'); turn.stop();
    } })();
    assert.equal((await turn.outcome).status, 'interrupted'); await events;
    const [session] = await readdir(storageDir); const current = JSON.parse(await readFile(join(storageDir, session, 'current.json'), 'utf8')); assert.deepEqual(await readdir(join(storageDir, session, current, 'agent')), []);
  } finally { await h.close(); await rm(storageDir, { recursive: true, force: true }); }
});

test('the agent launcher does not inherit Host-issued environment credentials', async () => {
  const previousToken = process.env.BACKBONE_TURN_TOKEN, previousUrl = process.env.BACKBONE_TURN_URL;
  process.env.BACKBONE_TURN_TOKEN = 'owned-host-secret-canary'; process.env.BACKBONE_TURN_URL = 'http://127.0.0.1:1/host-canary';
  const h = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: 'person-rights', env: { ACP_FAKE_MODE: 'environment' } });
  try {
    const outcome = await h.start(request, context).outcome; assert.equal(outcome.status, 'done');
    const data = JSON.parse(outcome.answer);
    assert.equal(data.env.BACKBONE_TURN_TOKEN, undefined); assert.equal(data.env.BACKBONE_TURN_URL, undefined);
    assert.ok(!JSON.stringify(data).includes('owned-host-secret-canary')); assert.ok(!JSON.stringify(data).includes('host-canary'));
  } finally {
    await h.close();
    if (previousToken === undefined) delete process.env.BACKBONE_TURN_TOKEN; else process.env.BACKBONE_TURN_TOKEN = previousToken;
    if (previousUrl === undefined) delete process.env.BACKBONE_TURN_URL; else process.env.BACKBONE_TURN_URL = previousUrl;
  }
});
