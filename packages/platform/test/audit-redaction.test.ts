import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import { enableConnector } from '../src/testing/connectors.ts';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readAudit } from '../src/audit.ts';
import { coreAuditSource, exportAudit } from './fixtures/audit-collect.ts';
import { CoreLink } from '../src/composition/core.ts';
import { hostClosed } from '../src/composition/host.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { b64, freshDir, idle, open, settings, value } from './helpers.ts';
import { AUDIT_PERIOD } from './fixtures/audit-activity.ts';

const MARKER = 'AUDIT_PRIVATE_72c9a51e';
test('prompt, answer, file name, document title, connector arguments and result stay out; content opt-in adds only Core receipt statements', { timeout: TEST_HANG_MS * 2 }, async () => {
  const person = freshDir('backbone-audit-redaction-');
  writeFileSync(join(person, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: process.execPath,
    args: [join(import.meta.dirname, 'fake-mcp-server.ts')] } } }));
  const model = await startScriptedModel('audit-redaction', messages => {
    const last = messages.findLastIndex(m => m.role === 'user'), tools = messages.slice(last + 1).filter(m => m.role === 'tool').length;
    if (tools === 0) return { calls: [{ name: 'mcp__notes__search', args: { q: `${MARKER}-connector-result` } }] };
    if (tools === 1) return { calls: [{ name: 'mcp__notes__draft_note', args: { text: `${MARKER}-receipt-statement` } }] };
    return { text: `${MARKER}-answer` };
  });
  const old = { endpoint: process.env.BACKBONE_MODEL_ENDPOINT, model: process.env.BACKBONE_MODEL_ID };
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  let opened:ReturnType<typeof open>|undefined;
  let link: CoreLink | undefined;
  try {
  const { home, host } = opened = open(undefined, { harness: 'harness-pi', connectors: { env: defaultToolEnv({ HOME: person, PATH: process.env.PATH }), sources: ['claude-code'] } });
    const serverId = 'claude-code:notes';
    value(await host.call('connectors.refresh', { serverId })); value(await enableConnector(host, serverId));
    for (const name of ['search', 'draft_note']) value(await enableConnector(host, serverId, name));
    const project = value(await host.call('projects.create', { name: 'Audit redaction', kind: 'folder' }));
    const file = value(await host.call('material.attach', { projectId: project.id, name: `${MARKER}-file-name.md`, base64: b64(`${MARKER}-document-text`), mediaType: 'text/markdown' }));
    link = await CoreLink.open({ home });
    await link.call(link.person(), 'SELECT gov.create_document(NULL, $1, $2, $3)', [`${MARKER}-document-title`, `${MARKER}-document-text`, link.id.person]);
    const sent = value(await host.call('turns.send', { projectId: project.id, text: `${MARKER}-prompt`, attachments: [file.id], settings, clientKey: 'audit-redaction' }));
    const turn = (await idle(host, sent.threadId)).turns[0];
    assert.equal(turn.user.text, `${MARKER}-prompt`); assert.equal(turn.answer?.text, `${MARKER}-answer`);
    const originals = await host.call('material.list', { projectId: project.id, includeHidden: true });
    const read = originals.find(entry => entry.fromServer?.tool === 'search')!;
    assert.ok(value(await host.call('material.read', { id: read.id })).text!.includes(`${MARKER}-connector-result`));
    const held = (await host.call('connectors.list', {})).held[0];
    assert.ok(held.statement.includes(`${MARKER}-receipt-statement`));
    const ordinary = value(await host.call('audit.export', AUDIT_PERIOD));
    assert.equal(ordinary.jsonl.includes(MARKER), false, 'no private marker in any default header, event, omission or trailer');
    const refused = await host.call('audit.export', {...AUDIT_PERIOD,includeContent:true}); assert.equal(refused.ok,false);
    const opted = await exportAudit(coreAuditSource(link), { ...AUDIT_PERIOD, includeContent: true });
    const record = readAudit(opted.jsonl);
    assert.deepEqual(record.header.exportedBy, {kind:'home-person',personId:link.id.person}); assert.equal(record.header.includeContent, true);
    assert.ok(record.events.some(event => event.receiptStatement?.includes(`${MARKER}-receipt-statement`)));
    const descriptions = (await link.read<{ id: string; description: string }>(link.person(), 'SELECT id, description FROM app.effects')).rows;
    for (const event of record.events) {
      if (event.receiptStatement !== undefined) assert.equal(event.receiptStatement, descriptions.find(row => row.id === event.effect!.id)!.description, 'exact Core receipt statement, never a connector log or a note');
      const { receiptStatement, ...metadata } = event;
      assert.equal(JSON.stringify(metadata).includes(MARKER), false, 'even with content enabled all other event fields stay redacted');
    }
    for (const suffix of ['prompt', 'answer', 'file-name', 'document-title', 'document-text', 'connector-result']) assert.equal(opted.jsonl.includes(`${MARKER}-${suffix}`), false, suffix);
    assert.ok(record.events.every(event => ['prompt', 'answer', 'document', 'fileName', 'documentTitle', 'connectorArguments', 'connectorResult'].every(field => event.omitted.includes(field))));
  } finally {
    await link?.close(); if(opened){opened.host.close();await hostClosed(opened.home);} await model.close();
    if (old.endpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = old.endpoint;
    if (old.model === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = old.model;
  }
});
