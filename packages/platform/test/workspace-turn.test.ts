import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { startScriptedModel, type Message, type Step } from '../src/testing/scripted-model.ts';
import { WorkspaceStore } from '../src/workspace/store.ts';
import { pollUntil, b64, open, settings, value  } from './helpers.ts';
import type { Host } from '../src/composition/host.ts';

const python = (code: string) => `python3 - <<'PY'\n${code}\nPY`;
const text = (m: Message) => typeof m.content === 'string' ? m.content : (m.content ?? []).map(c => c.text ?? '').join('');
async function finished(host: Host, id: string) {
  return await pollUntil(async active => {
    while (active()) { const t = value(await host.call('threads.get', { id })); if (!t.summary.running) return t; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('workspace turn did not settle');
  }, "packages/platform/test/workspace-turn.test.ts finished");
}
// Real ZIP central directory and OOXML workbook, generated from owned cells (7 and 11).
const workbook = 'UEsDBBQAAAAIAJtdal3XR4wSswAAAAwBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QvY7CMAx+lSorIkY3MJzaLsB6MNwL+FK3jZrEUeJC7+0v7TExMFn29yvX37+RcrV4F3KjRpH4CZDNSB6z5kihID0nj1LWNEBEM+FA8HE4HMFwEAqyl9VDtfWZepydVJelnLPl0KgiV9Xpn7dGNQpjdNagFBhWFNr6eqeUbEfVDZN8oS8sWBw8OE0/zJN+b3IP3UvTPfe9NdSxmX2R6BwTYZdHIvFOb1N7tGH3zIftCe0fUEsDBBQAAAAIAJtdal1/ESgWiAAAAO4AAAALAAAAX3JlbHMvLnJlbHONzz0OAiEQBeCrbDjAzmphYYDKxtZ4AcThJ/wMAYzr7aVcjYXl5L18L8MvGFX3lJvzpU1rirkJ5novR4CmHSbVZiqYR2KoJtXHWS0UpYOyCPtlOUDdGkzyrTmd74LVHZuur4L/yGSM13gi/UiY+4+Br8aQVbXYBVsjPKmGG1GYB8pAcvh4T74BUEsDBBQAAAAIAJtdal2lDZlhjwAAAOEAAAAPAAAAeGwvd29ya2Jvb2sueG1sjY9BDoJADEWvMukBLLpwQYCVLjxGheJMYKaTdowcXwKyd9X+/9P30+YjOj1FJrfEOVkLvpRcI1rvOZKdJHNak1E0UlmlvtCyMg3mmUuc8VJVV4wUEuyEWv9hyDiGnm/SvyOnskOUZypBkvmQDbpma7DfdIkit3BfihK4zXoMLZzBaR3WRc+AXYPHDR5vdV9QSwMEFAAAAAgAm11qXUpJcVWMAAAA7wAAABoAAAB4bC9fcmVscy93b3JrYm9vay54bWwucmVsc43POw7CMAwG4KtEOUDdMjCgNBMLK+ICUXAeavNQbATcnogBFYmByfJv6ftldcbVcCyZQqwkHmnNNMvAXA8AZAMmQ0OpmPvFlZYM97V5qMYuxiPsxnEPbWtIrbamOF1n2SYpLs+K/8jFuWjxWOwtYeYfBXAvbaGAyB01zSPP8hMRvMc0dFWCVvD1n34BUEsDBBQAAAAIAJtdal0Tsc7sfwAAAL8AAAAYAAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sXY5LCsMwDESvEnyAKvaigeIICr2IcNy6NP4gmyTHr+OFKV0IRqM3g/Qe+ZOdtWU4/BryLFwp6QaQjbOe8iUmG+rlGdlTqSu/ICe2tLSQX0GN4xU8vYNA3bwHFULNcR94FrK65hT3U204adhQg6lTiY6pjqmGSfnHwU819J/xC1BLAQIUAxQAAAAIAJtdal3XR4wSswAAAAwBAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgAm11qXX8RKBaIAAAA7gAAAAsAAAAAAAAAAAAAAIAB5AAAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgAm11qXaUNmWGPAAAA4QAAAA8AAAAAAAAAAAAAAIABlQEAAHhsL3dvcmtib29rLnhtbFBLAQIUAxQAAAAIAJtdal1KSXFVjAAAAO8AAAAaAAAAAAAAAAAAAACAAVECAAB4bC9fcmVscy93b3JrYm9vay54bWwucmVsc1BLAQIUAxQAAAAIAJtdal0Tsc7sfwAAAL8AAAAYAAAAAAAAAAAAAACAARUDAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWxQSwUGAAAAAAUABQBFAQAAygMAAAAA';

function script(messages: Message[]): Step {
  const start = messages.findLastIndex(m => m.role === 'user'), asked = text(messages[start]!);
  const results = messages.slice(start + 1).filter(m => m.role === 'tool').map(text);
  const call = (command: string, attachment?: string): Step => ({ calls: [{ name: 'workspace_run', args: { command, ...(attachment ? { attachment } : {}) } }] });
  if (asked.startsWith('Load both')) {
    if (!results.length) return call('ls ../inputs', 'sales.csv');
    if (results.length === 1) return call('ls ../inputs', 'extra.xlsx');
    if (results.length === 2) {
      const inputs = JSON.parse(results[1]!).inputs as { name: string; path: string }[];
      const csv = inputs.find(i => i.name === 'sales.csv')!.path, xlsx = inputs.find(i => i.name === 'extra.xlsx')!.path;
      return call(python(`import csv,sqlite3,zipfile,xml.etree.ElementTree as E\nc=sqlite3.connect('analysis.db')\nc.execute('create table sales(n integer)')\nc.executemany('insert into sales values (?)',[(int(r['n']),) for r in csv.DictReader(open(${JSON.stringify(csv)}))])\nwith zipfile.ZipFile(${JSON.stringify(xlsx)}) as z:\n sheet=E.fromstring(z.read('xl/worksheets/sheet1.xml'))\n values=[(int(v.text),) for v in sheet.iter('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v')]\nc.executemany('insert into sales values (?)',values)\nc.commit()\nprint(c.execute('select sum(n) from sales').fetchone()[0]*2)`));
    }
    return { text: `Combined total doubled: ${JSON.parse(results[2]!).stdout.trim()}.` };
  }
  if (!results.length) return call("sqlite3 analysis.db 'select sum(n),count(*) from sales'");
  if (asked.includes('Query after withdrawal')) return { text: results[0]! };
  if (asked.startsWith('Propose') && results.length === 1) return { calls: [{ name: 'write_file', args: { name: 'result.md', content: `# Result\n\n${JSON.parse(results[0]!).stdout.trim()}\n` } }] };
  return { text: `Retained table: ${JSON.parse(results[0]!).stdout.trim()}.` };
}

test('Pi through Host loads CSV and XLSX, calculates, retains its table across turns and proposes only through write_file', { timeout: TEST_HANG_MS * 2 }, async () => {
  if (process.platform !== 'darwin') return;
  const model = await startScriptedModel('workspace-script', script);
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  const { host, home } = open(undefined, { harness: 'harness-pi' });
  const store = new WorkspaceStore(home); let id: string | undefined;
  try {
    const p = value(await host.call('projects.create', { name: 'Workspace calculation', kind: 'folder' }));
    const csv = value(await host.call('material.attach', { projectId: p.id, name: 'sales.csv', base64: b64('n\n2\n3\n'), mediaType: 'text/csv' }));
    const xlsx = value(await host.call('material.attach', { projectId: p.id, name: 'extra.xlsx', base64: workbook, mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Load both attachments into a table and double their total', attachments: [csv.id, xlsx.id], settings, clientKey: 'load' })); id = sent.threadId;
    const first = (await finished(host, id)).turns[0]!;
    const firstResults = model.requests.flatMap(request => {
      try { return (JSON.parse(request.body).messages as Message[] ?? []).filter(message => message.role === 'tool').map(text); } catch { return []; }
    });
    assert.equal(first.status, 'done', first.answer?.text ?? ''); assert.equal(first.answer?.text, 'Combined total doubled: 46.', JSON.stringify(firstResults));
    assert.equal(first.effects.length, 0); assert.deepEqual((await host.call('material.list', { projectId: p.id })).map(f => f.name).sort(), ['extra.xlsx', 'sales.csv']);
    value(await host.call('turns.send', { projectId: p.id, threadId: id!, text: 'Query the retained table', attachments: [], settings, clientKey: 'query' }));
    const second = (await finished(host, id)).turns.at(-1)!;
    assert.equal(second.answer?.text, 'Retained table: 23|4.'); assert.equal(second.status, 'done');
    assert.deepEqual(new Set((second.reads ?? []).map(r => r.id)), new Set([csv.id, xlsx.id]), 'persistent scratch rebinds its original sources on the next turn');
    assert.equal(second.effects.length, 0);
    value(await host.call('turns.send', { projectId: p.id, threadId: id!, text: 'Propose the table result as a document', attachments: [], settings, clientKey: 'propose' }));
    const third = (await finished(host, id)).turns.at(-1)!;
    assert.equal(third.status, 'done', third.answer?.text ?? ''); assert.equal(third.effects.length, 1); assert.equal(third.effects[0]!.outcome, 'DONE');
    const material = await host.call('material.list', { projectId: p.id }); assert.deepEqual(material.map(f => f.name).sort(), ['extra.xlsx', 'result.md', 'sales.csv']);
    assert.equal(material.find(f => f.id === xlsx.id)!.versions[0]!.sha256, createHash('sha256').update(Buffer.from(workbook, 'base64')).digest('hex'));
    assert.equal(material.find(f => f.id === csv.id)!.versions.length, 1);
    const record = (await store.inspect(id))!;
    assert.ok(record); assert.ok(!record.folder.startsWith(home));
    for (const request of model.requests) { assert.ok(!request.body.includes(home)); assert.ok(!request.body.includes('postgres://')); }
    value(await host.call('material.lifecycle', { id: csv.id, version: 1, lifecycle: 0, state: 'withdrawn' }));
    value(await host.call('turns.send', { projectId: p.id, threadId: id!, text: 'Query after withdrawal', attachments: [], settings, clientKey: 'withdrawn' }));
    const withdrawn = (await finished(host, id)).turns.at(-1)!;
    assert.match(withdrawn.answer?.text ?? '', /withdrawn|retired|source/i);
    assert.equal(await store.inspect(id), null, 'withdrawal retires derived scratch before it can be queried');
    // Recreate empty scratch to independently exercise thread deletion's Host cleanup.
    await store.run(id, { command: 'echo disposable', inputs: [] });
    value(await host.call('threads.delete', { id }));
    await pollUntil(async active => { while (active() && (await store.inspect(id!))) await new Promise(resolve => setTimeout(resolve, 25)); }, "packages/platform/test/workspace-turn.test.ts:79 polling state");
    assert.equal(await store.inspect(id), null, 'thread deletion removes its workspace');
  } finally {
    if (id) await store.remove(id);
    host.close(); delete process.env.BACKBONE_MODEL_ENDPOINT; delete process.env.BACKBONE_MODEL_ID; await model.close();
  }
});
