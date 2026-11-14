import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { workspaceMcpGmailSendPreset } from '@backbone-next/connector-mail';
import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
import { assertHomeWriteAdmission, withHomeLock } from '../src/composition/home-lock.ts';
import { McpSession } from '../src/connectors/client.ts';
import { launchFor } from '../src/connectors/discover.ts';
import { value } from './helpers.ts';
import { statementOf } from '../src/connectors/service.ts';
import { approvalFixture, approvalServer } from './connector-approval-fixture.ts';

async function gmailApprovalFixture(t: TestContext) {
  return approvalFixture(t, ['send_gmail_message'], (person, entry) => {
    const preset = workspaceMcpGmailSendPreset({ email: 'person@example.com', home: person }).entry;
    if (!('command' in preset)) throw new Error('Expected stdio Gmail.');
    const shim = join(person, 'uvx');
    writeFileSync(shim, `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(entry.args[0]).href)});\n`, { mode: 0o700 });
    return { ...preset, command: shim, env: { ...preset.env, ...entry.env } };
  });
}

// Simulate an older writer's genuine Core proposal, not a fabricated grant. The new call
// boundary cannot create this record; release must still refuse it after an upgrade.
test('historical Gmail proposals with indirect content or the implicit signature default cannot be released', { timeout: TEST_HANG_MS * 2 }, async t => {
  const f = await gmailApprovalFixture(t);
  const tool = f.service.offered()[0];
  for (const extra of [{ forward_message_id: 'unseen', include_signature: false }, {}]) {
    const args = { user_google_email: 'person@example.com', to: 'to@example.com', subject: 'Old proposal', body: 'Reviewed note.', ...extra };
    const run = await f.link.startRun(await f.link.createTask('Historical Gmail proposal'));
    const statement = statementOf('records', tool.tool, args);
    const proposed = await f.link.proposeConnectorEffect(run, `mcp.${tool.connection.slug}.${tool.tool}`, args, statement, `gmail-history-${randomUUID()}`);
    await f.link.finishRun(run, 'succeeded');
    assert.equal(proposed.status, 'awaiting_checker');
    await withHomeLock(f.home, async () => {
      const state = f.read(); state.held.push({ effect: proposed.effect, serverId: approvalServer, serverName: 'records', tool: tool.tool,
        definition: tool.definition, launch: tool.launch, args, argsHash: proposed.argsHash, statement, state: 'waiting', at: new Date().toISOString(), detail: 'Historical proposal.' });
      state.ver = (state.ver ?? 0) + 1;
      assertHomeWriteAdmission(f.home, dirname(f.file)); writeFileSync(f.file, JSON.stringify(state));
    });
    const result = await f.service.decide(proposed.effect, proposed.argsHash, 'release');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.outcome, 'REFUSED');
    assert.deepEqual(f.calls(), []);
    assert.equal(f.service.list().held.find(held => held.effect === proposed.effect)?.state, 'waiting');
  }
});

// The released key used caller arguments. A policy-added false control may change the
// dispatch payload, but cannot give a replay of that old request a fresh effect identity.
test('an old successful Gmail request keeps its receipt identity after dispatch defaults are fixed', { timeout: TEST_HANG_MS * 2 }, async t => {
  const f = await gmailApprovalFixture(t);
  const tool = f.service.offered()[0], turnId = `historical-${randomUUID()}`;
  const args = { user_google_email: 'person@example.com', to: 'to@example.com', subject: 'Historical', body: 'One original send.' };
  const key = `${turnId}:mcp:${createHash('sha256').update(JSON.stringify([approvalServer, tool.tool, args])).digest('hex').slice(0, 32)}`;
  const statement = statementOf('records', tool.tool, args);
  const run = await f.link.startRun(await f.link.createTask('Historical completed Gmail request'));
  const proposed = await f.link.proposeConnectorEffect(run, `mcp.${tool.connection.slug}.${tool.tool}`, args, statement, key);
  await f.link.finishRun(run, 'succeeded');
  const decision = await f.link.read<{ decision_id: string }>(f.link.person(), 'SELECT decision_id FROM app.effects WHERE id = $1', [proposed.effect]);
  await f.link.call(f.link.person(), 'SELECT gov.answer_decision_with_basis($1::uuid, $2::text, $3::text, $4::text, $5::jsonb)',
    [decision.rows[0].decision_id, proposed.argsHash, 'approved', 'Historical person permission.', JSON.stringify({ method: 'person' })]);
  const session = await McpSession.open(launchFor(f.home, f.options.env(), approvalServer)!.launch);
  t.after(() => session.close());
  const claim = await f.link.call<string>(f.link.system(), 'SELECT gov.claim_effect($1, $2)', [proposed.effect, 60_000]);
  assert.equal(await f.link.beginDispatch(proposed.effect, claim, false), true);
  const answer = await session.call(tool.tool, args, new AbortController().signal, 3_000);
  assert.ok(answer.observed); assert.equal(answer.status, 'complete');
  await f.link.observe(proposed.effect, claim, 'succeeded', createHash('sha256').update(answer.text).digest('hex'), 'The local legacy stand-in answered.');
  await withHomeLock(f.home, async () => {
    const state = f.read(); state.held.push({ key, effect: proposed.effect, serverId: approvalServer, serverName: 'records', tool: tool.tool,
      definition: tool.definition, launch: tool.launch, args, argsHash: proposed.argsHash, statement, state: 'sent',
      turnId, at: new Date().toISOString(), detail: 'Historical successful fake send.' });
    state.ver = (state.ver ?? 0) + 1;
    assertHomeWriteAdmission(f.home, dirname(f.file)); writeFileSync(f.file, JSON.stringify(state));
  });
  value(await f.sign(tool.tool)); // Without identity preservation this would automatically send a second call.
  const replay = await f.call(tool.tool, args, turnId);
  assert.equal(replay.outcome, 'SENT');
  assert.equal(replay.outcome === 'SENT' && replay.effect, proposed.effect);
  assert.equal(replay.outcome === 'SENT' && replay.state, 'sent');
  const explicitReplay = await f.call(tool.tool, { include_signature: false, ...args }, turnId);
  assert.equal(explicitReplay.outcome === 'SENT' && explicitReplay.effect, proposed.effect);
  assert.equal(f.calls().length, 1, 'replaying an old successful request cannot invoke the server again');
  assert.equal(f.service.list().held.length, 1);
  assert.deepEqual(f.service.list().held[0].args, args, 'history is never rewritten with a new control');
});
