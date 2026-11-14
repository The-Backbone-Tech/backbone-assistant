import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { startScriptedModel, type Message, type Step } from '../src/testing/scripted-model.ts';
import { WorkspaceStore } from '../src/workspace/store.ts';
import { assertLinuxWorkspace } from '../src/workspace/linux-policy.ts';
import { b64, open, settings, value } from './helpers.ts';

test('Pi through the Linux Host calculates an attached CSV, retains SQLite and proposes the result through the document gateway', { timeout: 120_000 }, async t => {
  if (process.platform !== 'linux') { t.skip('The Linux Host workspace journey requires a Linux kernel'); return; }
  if (process.arch !== 'arm64') { t.skip('The Linux Host workspace journey is qualified only on arm64; ' + process.arch + ' is unqualified'); return; }
  if (process.getuid?.() === 0) { t.skip('The Linux Host workspace journey requires an unprivileged user'); return; }
  if (!existsSync('/usr/bin/bwrap') || !existsSync('/usr/bin/python3') || !existsSync('/usr/bin/unshare')) { t.skip('The Linux Host workspace journey requires bubblewrap, Python 3 and util-linux unshare'); return; }
  const library = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', "import ctypes; ctypes.CDLL('libseccomp.so.2')"], { encoding: 'utf8' });
  if (library.status !== 0) { t.skip('The Linux Host workspace journey requires libseccomp.so.2'); return; }
  const probe = spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', '--mount', '--propagation', 'private', '/usr/bin/bwrap', '--unshare-all', '--ro-bind', '/', '/', '--', '/bin/true'], { encoding: 'utf8' });
  if (probe.status !== 0 && /Operation not permitted|No permissions to create|Creating new namespace failed/i.test(probe.stderr)) { t.skip('Kernel or container refuses Linux namespaces: ' + probe.stderr.trim()); return; }
  assert.equal(probe.status, 0, probe.stderr);
  try { await assertLinuxWorkspace(); }
  catch (error) {
    if (error instanceof Error && /delegated cgroup/i.test(error.message)) { t.skip(error.message); return; }
    throw error;
  }
  const originalEndpoint = process.env.BACKBONE_MODEL_ENDPOINT, originalModel = process.env.BACKBONE_MODEL_ID;
  const text = (m: Message) => typeof m.content === 'string' ? m.content : (m.content ?? []).map(p => p.text ?? '').join('');
  const model = await startScriptedModel('linux-workspace-model', messages => {
    const start = messages.findLastIndex(m => m.role === 'user');
    const results = messages.slice(start + 1).filter(m => m.role === 'tool').map(text);
    for (const result of results) {
      try { const work = JSON.parse(result) as { code?: number; reason?: string; stderr?: string }; if ('code' in work && (work.code !== 0 || work.reason)) return { text: `Workspace refused: ${result}` }; } catch { /* Document-tool confirmations are plain text. */ }
    }
    const call = (command: string, attachment?: string): Step => ({ calls: [{ name: 'workspace_run', args: { command, ...(attachment ? { attachment } : {}) } }] });
    if (text(messages[start]).includes('Retained')) {
      if (!results.length) return call(`python3 -c "import sqlite3; print(sqlite3.connect('analysis.db').execute('select sum(v)*2 from n').fetchone()[0])"`);
      return { text: `Retained total: ${JSON.parse(results[0]).stdout.trim()}` };
    }
    if (!results.length) return call('ls ../inputs', 'sales.csv');
    if (results.length === 1) {
      const input = JSON.parse(results[0]).input;
      return call(`python3 - <<'PY'\nimport csv,sqlite3\nc=sqlite3.connect('analysis.db')\nc.execute('create table n(v integer)')\nc.executemany('insert into n values (?)', [(int(r['n']),) for r in csv.DictReader(open(${JSON.stringify(input)}))])\nc.commit()\nprint(c.execute('select sum(v) from n').fetchone()[0])\nPY`);
    }
    if (results.length === 2) return { calls: [{ name: 'write_file', args: { name: 'total.md', content: `# Total\n\n${JSON.parse(results[1]).stdout.trim()}\n` } }] };
    return { text: 'Saved total.md through the document gateway.' };
  });
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  let store: WorkspaceStore | undefined, threadId: string | undefined;
  let closeHost = () => {};
  try {
    const { host, home } = open(undefined, { harness: 'harness-pi' });
    store = new WorkspaceStore(home); closeHost = () => host.close();
    const finished = async () => {
      for (let i = 0; i < 600; i++) {
        const thread = value(await host.call('threads.get', { id: threadId! }));
        if (!thread.summary.running) return thread.turns.at(-1)!;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Linux workspace turn did not finish');
    };
    const project = value(await host.call('projects.create', { name: 'Linux calculation', kind: 'folder' }));
    const source = value(await host.call('material.attach', { projectId: project.id, name: 'sales.csv', base64: b64('n\n2\n3\n'), mediaType: 'text/csv' }));
    threadId = value(await host.call('turns.send', { projectId: project.id, text: 'Calculate the CSV total and propose a document', attachments: [source.id], settings, clientKey: 'calculate' })).threadId;
    const first = await finished(); assert.equal(first.status, 'done', first.answer?.text ?? '');
    assert.equal(first.effects.length, 1, first.answer?.text ?? ''); assert.equal(first.effects[0].outcome, 'DONE');
    const files = await host.call('material.list', { projectId: project.id });
    assert.deepEqual(files.map(f => f.name).sort(), ['sales.csv', 'total.md']);
    const output = files.find(f => f.name === 'total.md')!;
    const toolResults = model.requests.flatMap(request => {
      const body = JSON.parse(request.body) as { messages?: Message[] };
      return (body.messages ?? []).filter(message => message.role === 'tool').map(text);
    });
    assert.match(value(await host.call('material.read', { id: output.id })).text ?? '', /# Total\s+5/, JSON.stringify(toolResults).slice(-6000));
    value(await host.call('turns.send', { projectId: project.id, threadId, text: 'Retained table: double the total', attachments: [], settings, clientKey: 'retained' }));
    const second = await finished(); assert.equal(second.status, 'done', second.answer?.text ?? ''); assert.equal(second.answer?.text, 'Retained total: 10');
    assert.ok(second.reads?.some(r => r.id === source.id)); assert.equal(second.effects.length, 0);
  } finally {
    if (threadId) await store?.remove(threadId);
    closeHost(); await model.close();
    if (originalEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = originalEndpoint;
    if (originalModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = originalModel;
  }
});
