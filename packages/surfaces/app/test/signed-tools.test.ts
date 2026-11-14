import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectorsView, HeldCall } from '@backbone-next/platform';
import { endSignature, signedTools } from '../src/lib/signed-tools.ts';

function fixture(): ConnectorsView {
  return { egress: 'per-server', held: [], servers: [{ id: 'notes', name: 'Notes', source: 'App', config: 'fixture',
    transport: 'http', shown: 'http://127.0.0.1:1/mcp', envNames: [], enabled: true, egress: true, tools: [
      { name: 'draft_note', description: 'Write a note draft.', kind: 'effect', annotated: 'effect', enabled: true, standing: { at: '2026-11-10T10:00:00Z' } },
      { name: 'lookup', description: 'Read a note.', kind: 'read', annotated: 'read', enabled: true },
    ] }] };
}

test('the list uses only active signatures, and sent tool history includes failed and UNKNOWN outcomes', () => {
  const view = fixture();
  const held = (effect: string, state: HeldCall['state'], at: string, standing?: true): HeldCall => ({ effect, state, at, standing,
    serverId: 'notes', serverName: 'Notes', tool: 'draft_note', args: {}, argsHash: 'hash', statement: 'Write', detail: state });
  view.held = [held('old-signature', 'sent', '2026-11-09', true), held('latest', 'unknown', '2026-11-11', true),
    held('failed', 'failed', '2026-11-10', true), held('not-sent', 'released', '2026-11-12', true),
    held('manual', 'sent', '2026-11-13'), held('waiting', 'waiting', '2026-11-14', true)];
  view.held.push(view.held[0], { ...view.held[1], serverId: 'other' });
  const rows = signedTools(view);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calls, 3, 'a tool total across signatures, not an invented per-signature count');
  assert.equal(rows[0].last?.effect, 'latest');
  assert.equal(rows[0].last?.state, 'unknown');
});

test('end sends only local authority reduction, preserves refusal and never reports an unconfirmed end', async () => {
  const row = signedTools(fixture())[0];
  const server = { ...row.server, tools: row.server.tools.map((t) => ({ ...t, standing: undefined })) };
  const result = await endSignature(async (method, args) => {
    assert.equal(method, 'connectors.set');
    assert.deepEqual(args, { serverId: 'notes', tool: { name: 'draft_note', standing: false } });
    return { ok: true, value: server };
  }, row);
  assert.equal(result.ok, true);
  const refusal = { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'Unavailable' } as const;
  assert.deepEqual(await endSignature(async () => refusal, row), refusal);
  await assert.rejects(endSignature(async () => { throw new Error('Lost response'); }, row), /Lost response/);
  await assert.rejects(endSignature(async () => ({ ...refusal, outcome: 'UNKNOWN' }), row), /Unavailable/);
  await assert.rejects(endSignature(async () => ({ ok: true, value: row.server }), row), /still reports a permission/);
});

test('several servers sort by server then tool, independently of discovery order', () => {
  const view = fixture(), server = view.servers[0];
  view.servers = ['Zulu', 'Alpha', 'Middle'].map((name) => ({ ...server, id: name, name,
    tools: ['z_tool', 'a_tool'].map((name) => ({ ...server.tools[0], name })) }));
  assert.deepEqual(signedTools(view).map(r => `${r.server.name}/${r.tool.name}`),
    ['Alpha/a_tool', 'Alpha/z_tool', 'Middle/a_tool', 'Middle/z_tool', 'Zulu/a_tool', 'Zulu/z_tool']);
});

test('a re-signed tool has a new row after its earlier signature ended', () => {
  const view = fixture(), ended = signedTools(view)[0];
  view.servers[0].tools[0].standing = { at: '2026-11-10T11:00:00Z' };
  const resigned = signedTools(view)[0];
  assert.notEqual(resigned.key, ended.key);
  assert.equal(signedTools(view).filter(r => r.key !== ended.key).length, 1);
});

test('Core ending states never infer a confirmed end from missing listing fields', async () => {
  const { signatureEndState } = await import('../src/lib/signed-tools.ts');
  const view = fixture(), row = { ...signedTools(view)[0], id: 'signature-one' };
  assert.equal(signatureEndState(view, row), 'unavailable');
  assert.equal(signatureEndState({ ...view, signatureEndings: { pending: [row.id], conflicts: [] } }, row), 'pending');
  assert.equal(signatureEndState({ ...view, signatureEndings: { pending: [], conflicts: [row.id] } }, row), 'conflict');
  assert.equal(signatureEndState({ ...view, signatureEndings: { pending: [], conflicts: [] } }, row), 'ended');
  assert.equal(signatureEndState({ ...view, signatureEndings: { pending: [], conflicts: [] } }, { ...row, id: undefined }), 'unavailable');
});

test('fixed signature diagnostics pass through unchanged without interpreting their words', async () => {
  const { signatureFailureMessage } = await import('../src/lib/signed-tools.ts');
  const diagnostic = 'The signature end could not be confirmed. Local authority stays closed and its receipt will be retried. Run backbone doctor.';
  assert.equal(signatureFailureMessage(new Error(diagnostic), 'Unconfirmed'), diagnostic);
  assert.equal(signatureFailureMessage(new TypeError('Failed to fetch'), 'Unconfirmed'), 'Unconfirmed');
  assert.equal(signatureFailureMessage(null, 'Unconfirmed'), 'Unconfirmed');
});

test('blocked or newly withheld servers expose no active or retained tool rows', async () => {
  const { visibleRetainedTools } = await import('../src/lib/signed-tools.ts');
  const view = fixture(), row = signedTools(view)[0];
  assert.deepEqual(visibleRetainedTools(view, [row]), [row]);
  assert.deepEqual(visibleRetainedTools(undefined, [row]), []);
  view.servers[0] = { ...view.servers[0], blocked: 'This plugin contains a credential.', tools: [] };
  assert.deepEqual(signedTools(view), []);
  assert.deepEqual(visibleRetainedTools(view, [row]), []);
  view.servers[0].id = 'claude-plugin:withheld-id';
  assert.deepEqual(visibleRetainedTools(view, [row]), []);
});

test('exact Core identities exclude calls from an earlier signature even when signing times coincide', () => {
  const view = fixture(), tool = view.servers[0].tools[0]; tool.standing!.id = 'current';
  view.held = [{ effect: 'old', serverId: 'notes', tool: 'draft_note', standing: true, standingSignatureId: 'earlier', state: 'unknown', at: '2026-11-10T12:00:00Z' },
    { effect: 'new', serverId: 'notes', tool: 'draft_note', standing: true, standingSignatureId: 'current', state: 'sent', at: '2026-11-10T11:00:00Z' }] as HeldCall[];
  const row = signedTools(view)[0]; assert.equal(row.calls, 1); assert.equal(row.last?.effect, 'new'); assert.equal(row.unknowns, 1, 'an unknown under an earlier signature still pauses this tool');
});
