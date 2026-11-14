import { enableConnector } from '../src/testing/connectors.ts';
import { TEST_HANG_MS, waitFor } from '../../../scripts/lib/test-hang.ts';
import { childHangTimer } from '../../../scripts/lib/test-child.ts';
// Real Host/Core, controlled native-port producer: no vendor client, model or account effect.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { createHost, removeDataHome } from '../src/composition/host.ts';
import type { Receipt } from '../src/api.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { CoreLink } from '../src/composition/core.ts';
import { ThreadJournal } from '../src/composition/thread-journal.ts';
import { checkpointRepairNotice } from '../src/composition/checkpoint-repair.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { pieceDigest, pieceFiles } from '../src/pieces/digest.ts';
import { PIECE_DIRS } from '../src/composition/pieces.ts';
import { b64, freshDir, freshHome, idle, open, settings, value } from './helpers.ts';

const saved = { harness: process.env.BACKBONE_HARNESS, model: process.env.BACKBONE_CODEX_MODEL };
process.env.BACKBONE_HARNESS = 'harness-codex';
process.env.BACKBONE_CODEX_MODEL = 'controlled';
after(() => {
  for (const [name, value] of [['BACKBONE_HARNESS', saved.harness], ['BACKBONE_CODEX_MODEL', saved.model]]) {
    if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
  }
});
const observations = join(freshDir('managed-path-observer-'), 'outcomes.jsonl');
const fixture = freshDir('managed-path-producer-');
for (const rel of pieceFiles(PIECE_DIRS['harness-codex'])) {
  const to = join(fixture, rel); mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(PIECE_DIRS['harness-codex'], rel), to);
}
writeFileSync(join(fixture, 'src/index.ts'), `
import { appendFileSync } from 'node:fs';
export function createCodexHarness() {
  return {
    specificationVersion: 'v1', id: 'controlled-paths', label: 'Controlled path producer (no model)',
    async listModels() { return [{ id: 'controlled', label: 'Controlled', efforts: [4], permissions: ['full'] }]; },
    start(request, { tools }) {
      const outcome = (async () => {
        const { name, body = 'First result.', ordinary = false, stale = false, connector = false, staleTarget = false, checkpoint = false, twoWithdrawals = false } = request.text.startsWith('{') ? JSON.parse(request.text) : { name: 'reports/recovered.md' };
        appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ event: 'start', name }) + '\\n');
        const source = await tools.read('source.md');
        const second = twoWithdrawals ? await tools.read('second.md') : undefined;
        const target = name === 'source.md' ? source : await tools.read(name);
        const sources = [source, ...(second ? [second] : []), ...(target && target !== source ? [target] : [])].map(f => ({ name: f.name, version: f.version + (stale ? 1 : 0) }));
        if (connector) {
          const tool = tools.connectors().find(tool => tool.tool === 'search');
          const label = 'From notes · search · controlled-collision.json';
          const agentWrite = await tools.writeIfVersion(label + '/agent.md', 'Existing agent output.', { targetVersion: null, sources }, new AbortController().signal);
          const invocation = { engine: 'codex', namespace: JSON.stringify(['managed-native-thread', request.turnId]), callId: 'managed-source-read' };
          const result = await tools.callConnector(tool.name, { q: 'launch' }, new AbortController().signal, invocation);
          const again = await tools.callConnector(tool.name, { q: 'launch' }, new AbortController().signal, invocation);
          appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ name, result, again, agentWrite, invocation }) + '\\n');
          return { status: 'done', answer: 'Connector result recorded.', usage: { input: 0, output: 0 } };
        }
        const targetVersion = staleTarget ? 1 : target?.version ?? null;
        if (checkpoint) await tools.checkpoint([{ name, body, targetVersion }], sources);
        if (twoWithdrawals) await globalThis.withdrawFirstForFixture();
        const result = ordinary ? await tools.write(name, body, new AbortController().signal)
          : await tools.writeIfVersion(name, body, { targetVersion, sources }, new AbortController().signal);
        appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ name, result }) + '\\n');
        return { status: 'done', answer: JSON.stringify(result), usage: { input: 0, output: 0 } };
      })();
      return { events: (async function* () {})(), outcome, stop() {}, steer() {} };
    },
  };
}
`);
const manifestPath = join(fixture, 'backbone.module.json');
writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, 'utf8')), digest: pieceDigest(fixture) }));

async function scenario(options: Pick<import('../src/composition/host.ts').HostOptions, 'connectors'> = {}) {
  const home = freshHome();
  let host = open(home, { harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture }, ...options }).host;
  const project = value(await host.call('projects.create', { name: 'Structured work', kind: 'folder' }));
  const original = value(await host.call('material.attach', { projectId: project.id, name: 'source.md', base64: b64('Immutable source.'), mediaType: 'text/markdown' }));
  let threadId: string | undefined;
  const send = async (name: string, extra = {}) => {
    const sent = value(await host.call('turns.send', { projectId: project.id, ...(threadId ? { threadId } : {}), text: JSON.stringify({ name, ...extra }), attachments: [original.id], settings: { ...settings, permission: 'full', model: 'controlled', effort: 4 }, clientKey: randomUUID() }));
    threadId = sent.threadId;
    const thread = await idle(host, threadId);
    return { turn: thread.turns.at(-1)!, result: readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line)).findLast(entry => entry.name === name).result as { outcome: string; detail?: string } };
  };
  return { home, project, original, send, host: () => host, async reopen() {
    host.close(); await CoreLink.whenClosed(home);
    host = open(home, { harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture }, ...options }).host;
  } };
}

test('nested conditional outputs keep their path, identity and versions without project-folder projection', async () => {
  const s = await scenario();
  const created = await s.send('reports/decision.md');
  assert.equal(created.result.outcome, 'DONE', JSON.stringify(created));
  const first = (await s.host().call('material.list', { projectId: s.project.id })).find(e => e.name === 'reports/decision.md');
  assert.ok(first);
  assert.equal(first.projection, 'managed');
  assert.equal((await s.send('reports/decision.md', { body: 'Revised result.' })).result.outcome, 'DONE');
  await s.reopen();
  const read = value(await s.host().call('material.read', { id: first.id }));
  assert.equal(read.entry.name, 'reports/decision.md');
  assert.equal(read.entry.current, 2);
  assert.equal(read.text, 'Revised result.');
  assert.equal(value(await s.host().call('material.read', { id: first.id, version: 1 })).text, 'First result.');
  assert.equal(value(await s.host().call('material.read', { id: s.original.id })).text, 'Immutable source.');
  assert.equal(readdirSync(join(s.home, 'projects'), { recursive: true }).some(p => String(p).includes('reports')), false);
});

test('invalid paths and namespace aliases are refused before the effect gateway', async () => {
  const s = await scenario();
  for (const name of ['../outside.md', '/outside.md', 'x/../../outside.md', 'x//outside.md', 'x/./outside.md', 'x\\outside.md', 'C:/outside.md', '.hidden/result.md', 'x/.hidden', 'x/trailing.', 'x/\ud800.md', 'x/e\u0301.md', 'x/\u200Bhidden.md', 'x/\u202Ename.md', 'x/\u0085name.md', 'x/\u2028name.md']) {
    const { result, turn } = await s.send(name);
    assert.equal(result.outcome, 'REFUSED', name);
    assert.equal(turn.effects.length, 0, name);
  }
  assert.equal((await s.send('reports/decision.md')).result.outcome, 'DONE');
  for (const name of ['Reports/other.md', 'reports/Decision.md', 'reports', 'reports/decision.md/child.md']) {
    const { result, turn } = await s.send(name);
    assert.equal(result.outcome, 'REFUSED', name);
    assert.equal(turn.effects.length, 0, name);
  }
  assert.equal((await s.send('reports/other.md')).result.outcome, 'DONE', 'a distinct sibling remains writable');
});

test('nested paths do not widen ordinary writes, source versions or original authority', async () => {
  const s = await scenario();
  for (const [name, extra] of [['reports/ordinary.md', { ordinary: true }], ['reports/stale.md', { stale: true }], ['source.md', {}]] as const) {
    const { result, turn } = await s.send(name, extra);
    assert.equal(result.outcome, 'REFUSED');
    assert.equal(turn.effects.length, 0);
  }
  assert.equal(existsSync(join(s.home, 'outside.md')), false);
});

test('concurrent managed outputs preserve one spelling for their shared folder', async () => {
  const s = await scenario();
  const results = await Promise.all([s.send('reports/first.md'), s.send('Reports/second.md')]);
  assert.deepEqual(results.map(item => item.result.outcome).sort(), ['DONE', 'REFUSED']);
  const outputs = (await s.host().call('material.list', { projectId: s.project.id })).filter(entry => entry.projection === 'managed');
  assert.equal(outputs.length, 1);
});

test('managed paths do not inspect or replace a physical file occupying their logical folder', async () => {
  const s = await scenario();
  const folder = join(s.home, 'projects', readdirSync(join(s.home, 'projects'))[0]);
  writeFileSync(join(folder, 'reports'), 'Physical person file.');
  assert.equal((await s.send('reports/decision.md')).result.outcome, 'DONE');
  assert.equal(readFileSync(join(folder, 'reports'), 'utf8'), 'Physical person file.');
});

test('structured path validation preserves existing flat managed labels', async () => {
  const s = await scenario();
  assert.equal((await s.send('Label: note.md')).result.outcome, 'DONE');
  const entry = (await s.host().call('material.list', { projectId: s.project.id })).find(entry => entry.name === 'Label: note.md');
  assert.ok(entry);
  assert.equal(entry.projection, 'managed');
});

test('managed source labels from connectors remain data rather than structured output paths', async () => {
  const s = await scenario();
  // This is the same internal custody seam that records an MCP answer, not a path-import API.
  const source = new MaterialStore(s.home, {}, () => {}).create(s.project.id, 'From plugin:catalog/server · result.md', 'text/markdown', Buffer.from('Connector result.'), 'original', 'person', randomUUID(), 'managed');
  const read = value(await s.host().call('material.read', { id: source.id }));
  assert.equal(read.entry.name, 'From plugin:catalog/server · result.md');
  assert.equal(read.text, 'Connector result.');
});

test('managed outputs cannot make a person attachment throw or change legacy flat case labels', async () => {
  const s = await scenario();
  assert.equal((await s.send('reports/a.md')).result.outcome, 'DONE');
  for (const name of ['reports', 'Reports']) {
    const attached = value(await s.host().call('material.attach', { projectId: s.project.id, name, base64: b64('Person upload.'), mediaType: 'text/plain' }));
    assert.notEqual(attached.name.toLowerCase(), 'reports');
    assert.equal(value(await s.host().call('material.read', { id: attached.id })).text, 'Person upload.');
  }
  assert.equal((await s.send('notes.md')).result.outcome, 'DONE');
  const attached = value(await s.host().call('material.attach', { projectId: s.project.id, name: 'Notes.md', base64: b64('Case-sensitive label.'), mediaType: 'text/plain' }));
  assert.equal(attached.name, 'Notes.md', 'flat labels keep their previous semantics');
});

for (const conflicting of [false, true]) test(`a pending nested write recovers ${conflicting ? 'without crossing a new namespace owner' : 'its original receipt without producer replay'}`, { timeout: 600_000 }, async (t) => {
  const home = freshHome();
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-document.ts'), home, fixture], {
    env: { ...process.env, BACKBONE_CRASH_AT: 'write.proposed', BACKBONE_CRASH_OCCURRENCE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes.toString(); });
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const timer = childHangTimer(child, 'crash fixture reaching its selected cut');
  try {
    const signal = await new Promise<string | null>((resolve, reject) => { child.once('error', reject); child.once('exit', (_code, signal) => resolve(signal)); });
    assert.equal(signal, 'SIGKILL', stderr);
  } finally { clearTimeout(timer); }
  const { projectId } = JSON.parse(stdout.trim().split('\n')[0]);
  const stored = JSON.parse(readFileSync(join(home, 'threads', readdirSync(join(home, 'threads')).find(name => name.endsWith('.json'))!), 'utf8'));
  if (conflicting) new MaterialStore(home, {}, () => {}).create(projectId, 'Reports/person.md', 'text/markdown', Buffer.from('Person result.'), 'accepted', 'person', randomUUID(), 'managed');
  const starts = () => readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'start').length;
  const before = starts();
  const host = createHost({ home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(home); });
  await host.resumeInterrupted();
  let thread = value(await host.call('threads.get', { id: stored.summary.id }));

  await waitFor(async()=>{if(!(thread.summary.running))return true;
    await new Promise(resolve => setTimeout(resolve, 25));
    thread = value(await host.call('threads.get', { id: stored.summary.id }));

return !(thread.summary.running);}, 'recovery thread settlement', {diagnostic:()=>JSON.stringify(thread.summary)});
  assert.equal(thread.summary.running, false, 'the existing recovery must settle before it is assessed');
  assert.equal(starts(), before, 'recovery never starts the producer again');
  assert.equal(thread.turns[0].effects[0].outcome, conflicting ? 'REFUSED' : 'DONE', JSON.stringify(thread.turns[0]));
  const entries = await host.call('material.list', { projectId });
  const recovered = entries.find(entry => entry.name === 'reports/recovered.md');
  if (conflicting) {
    assert.equal(recovered, undefined);
    assert.ok(entries.some(entry => entry.name === 'Reports/person.md'));
  } else {
    assert.ok(recovered);
    assert.equal(recovered.projection, 'managed');
    assert.equal(value(await host.call('material.read', { id: recovered.id })).text, 'First result.');
    assert.equal(thread.turns[0].answer?.files[0]?.materialId, recovered.id);
  }
});

test('logical names preserve international letters and OS-specific labels without physical projection', async () => {
  const s = await scenario();
  for (const name of ['informes/decisión.md', 'CON/aux.md']) {
    assert.equal((await s.send(name)).result.outcome, 'DONE');
    const entry = (await s.host().call('material.list', { projectId: s.project.id })).find(entry => entry.name === name);
    assert.equal(entry?.projection, 'managed');
  }
});

test('a connector answer gets an available source label when agent output occupies its name', async t => {
  const person = freshDir('managed-source-person-'), calls = join(person, 'calls.jsonl');
  writeFileSync(join(person, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [join(import.meta.dirname, 'fake-mcp-server.ts')], env: { FAKE_MCP_LOG: calls } } } }));
  const s = await scenario({ connectors: { env: defaultToolEnv({ HOME: person, PATH: process.env.PATH }), sources: ['claude-code'] } });
  value(await s.host().call('connectors.refresh', { serverId: 'claude-code:notes' }));
  value(await enableConnector(s.host(), 'claude-code:notes'));
  value(await enableConnector(s.host(), 'claude-code:notes', 'search'));
  const label = 'From notes · search · controlled-collision.json', allocatedLabels: string[] = [];
  const freeName = MaterialStore.prototype.freeName;
  // Only normalize this source's display label. The real allocator must inspect the actual
  // managed output namespace and choose its own available variant; no allocation is faked.
  t.mock.method(MaterialStore.prototype, 'freeName', function(this: MaterialStore, projectId: string, actualLabel: string) {
    if (projectId === s.project.id && /^From notes · search · [a-f0-9]{16}\.json$/.test(actualLabel)) {
      allocatedLabels.push(actualLabel);
      return freeName.call(this, projectId, label);
    }
    return freeName.call(this, projectId, actualLabel);
  });
  const name = 'Read with colliding source label', { result, turn } = await s.send(name, { connector: true });
  assert.equal(result.outcome, 'READ', JSON.stringify(result));
  const observed = readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line)).findLast(entry => entry.name === name);
  assert.equal(observed.agentWrite.outcome, 'DONE', 'the colliding logical folder must be actual agent output');
  assert.deepEqual(observed.again, result, 'an exact native invocation replay returns the same read');
  assert.deepEqual(observed.invocation, { engine: 'codex', namespace: JSON.stringify(['managed-native-thread', turn.id]), callId: 'managed-source-read' });
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [{ tool: 'search', args: { q: 'launch' } }], 'native replay never dispatches another SDK call');
  const entries = await s.host().call('material.list', { projectId: s.project.id });
  const source = entries.find(entry => entry.class === 'original' && entry.name.startsWith('From notes'));
  assert.ok(source);
  assert.equal(allocatedLabels.length, 1, 'one original label is allocated despite two exact native reads');
  assert.equal(source.name, 'From notes · search · controlled-collision (2).json');
  assert.equal(source.observation?.state, 'registered');
  assert.ok(turn.reads?.some(read => read.id === source.id && read.name === source.name && read.version === 1));
  const existing = entries.find(entry => entry.name === label + '/agent.md');
  assert.ok(existing);
  assert.equal(existing.current, 1);
  assert.equal(value(await s.host().call('material.read', { id: existing.id })).text, 'Existing agent output.', 'source allocation never changes the agent output');
  assert.match(value(await s.host().call('material.read', { id: source.id })).text ?? '', /note about launch/);
  const history = new ThreadJournal(s.home).read();
  const reservations = history.filter(event => event.kind === 'mcp.read.reserved' && event.observation.request.scope.turn === turn.id);
  assert.equal(reservations.length, 1);
  const reserved = reservations[0]; assert.ok(reserved.kind === 'mcp.read.reserved');
  assert.equal(allocatedLabels[0], `From notes · search · ${reserved.observation.id.slice(0, 16)}.json`, 'the intercepted display argument comes from the real observation ID');
  assert.deepEqual(reserved.observation.request.origin, observed.invocation);
  assert.equal(reserved.observation.materialId, source.id);
  assert.equal(source.observation?.id, reserved.observation.id);
  assert.equal(history.filter(event => event.kind === 'mcp.read.dispatched' && event.id === reserved.observation.id).length, 1);
  assert.equal(history.filter(event => event.kind === 'mcp.read.confirmed' && event.id === reserved.observation.id).length, 1);
});


test('a stale child document lands beside its leaf under the same dotted directory', async () => {
  const s = await scenario();
  await s.send('parent.md');
  const parent = (await s.host().call('threads.list', {})).find(thread => thread.projectId === s.project.id)!;
  const child = value(await s.host().call('children.start', { parentThreadId: parent.id, text: JSON.stringify({ name: 'release.notes/README' }), role: 'worker', clientKey: 'structured-worker' }));
  const done = await idle(s.host(), child.threadId);
  assert.equal(done.turns.at(-1)?.effects.at(-1)?.outcome, 'DONE');
  const target = (await s.host().call('material.list', { projectId: s.project.id })).find(entry => entry.name === 'release.notes/README')!;
  assert.ok(target);
  value(await s.host().call('material.save', { id: target.id, text: 'Person version.', baseVersion: target.current }));
  const merged = value(await s.host().call('children.merge', { parentThreadId: parent.id, childThreadId: child.threadId, materialId: target.id, version: 1, baseVersion: 2, clientKey: 'structured-merge' }));
  const completed = await idle(s.host(), parent.id);
  const turn = completed.turns.find(turn => turn.id === merged.turnId)!;
  assert.equal(turn.merge?.outcome, 'beside', turn.answer?.text ?? 'No answer.');
  assert.equal(turn.merge?.beside?.name, 'release.notes/README (revision of v1)');
  assert.equal(value(await s.host().call('material.read', { id: target.id })).text, 'Person version.');
});


test('a settled beside write survives a real kill without another checkpoint copy', { timeout: 600_000 }, async (t) => {
  const home = freshHome();
  const name = 'release.notes/README';
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-document.ts'), home, fixture, name], {
    env: { ...process.env, BACKBONE_CRASH_AT: 'write.observed', BACKBONE_CRASH_OCCURRENCE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes.toString(); });
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const timer = childHangTimer(child, 'crash fixture reaching its selected cut');
  try {
    const signal = await new Promise<string | null>((resolve, reject) => { child.once('error', reject); child.once('exit', (_code, signal) => resolve(signal)); });
    assert.equal(signal, 'SIGKILL', stderr);
  } finally { clearTimeout(timer); }
  const { projectId } = JSON.parse(stdout.trim().split('\n')[0]);
  const stored = JSON.parse(readFileSync(join(home, 'threads', readdirSync(join(home, 'threads')).find(file => file.endsWith('.json'))!), 'utf8'));
  const starts = () => readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'start').length;
  const before = starts();
  const host = createHost({ home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(home); });
  await host.resumeInterrupted();
  let thread = value(await host.call('threads.get', { id: stored.summary.id }));

  await waitFor(async()=>{if(!(thread.summary.running))return true;
    await new Promise(resolve => setTimeout(resolve, 25));
    thread = value(await host.call('threads.get', { id: stored.summary.id }));

return !(thread.summary.running);}, 'recovery thread settlement', {diagnostic:()=>JSON.stringify(thread.summary)});
  assert.equal(thread.summary.running, false);
  assert.equal(starts(), before, 'recovery starts no producer');
  const entries = await host.call('material.list', { projectId, includeHidden: true });
  const revisions = entries.filter(entry => entry.name !== name && entry.name !== 'source.md');
  assert.equal(revisions.length, 1, revisions.map(entry => entry.name).join(', '));
  assert.equal(thread.turns[0].effects.length, 1);
  assert.equal(thread.turns[0].effects[0].outcome, 'DONE');
  const target = entries.find(entry => entry.name === name)!;
  assert.equal(value(await host.call('material.read', { id: target.id })).text, 'Person version two.');
  assert.equal(value(await host.call('material.read', { id: revisions[0].id })).text, 'First result.');
});


test('pending checkpoint work survives a pre-proposal kill and person edit, then admits the next message', { timeout: 600_000 }, async (t) => {
  const home = freshHome(), name = 'r/pending.md';
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-document.ts'), home, fixture, name, 'pending'], {
    env: { ...process.env, BACKBONE_CRASH_AT: 'write.custodied', BACKBONE_CRASH_OCCURRENCE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes.toString(); });
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const timer = childHangTimer(child, 'crash fixture reaching its selected cut');
  try {
    const signal = await new Promise<string | null>((resolve, reject) => { child.once('error', reject); child.once('exit', (_code, signal) => resolve(signal)); });
    assert.equal(signal, 'SIGKILL', stderr);
  } finally { clearTimeout(timer); }
  const { projectId } = JSON.parse(stdout.trim().split('\n')[0]);
  const stored = JSON.parse(readFileSync(join(home, 'threads', readdirSync(join(home, 'threads')).find(file => file.endsWith('.json'))!), 'utf8'));
  const starts = () => readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'start').length;
  const before = starts();
  const host = createHost({ home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(home); });
  // Opening resumes nothing: the person's public Save precedes explicit recovery.
  const target = (await host.call('material.list', { projectId })).find(entry => entry.name === name)!;
  assert.ok(target);
  value(await host.call('material.save', { id: target.id, text: 'Person edit before recovery.', baseVersion: 1 }));
  await host.resumeInterrupted();
  let thread = value(await host.call('threads.get', { id: stored.summary.id }));

  await waitFor(async()=>{if(!(thread.summary.running))return true;
    await new Promise(resolve => setTimeout(resolve, 25));
    thread = value(await host.call('threads.get', { id: stored.summary.id }));

return !(thread.summary.running);}, 'recovery thread settlement', {diagnostic:()=>JSON.stringify(thread.summary)});
  assert.equal(thread.summary.running, false);
  assert.equal(starts(), before, 'recovery never starts the producer');
  const entries = await host.call('material.list', { projectId, includeHidden: true });
  const revisions = entries.filter(entry => entry.name !== name && entry.name !== 'source.md');
  assert.equal(revisions.length, 1, thread.turns[0].answer?.text ?? 'No answer.');
  assert.equal(thread.turns[0].effects.filter(effect => effect.outcome === 'DONE').length, 1);
  assert.equal(value(await host.call('material.read', { id: target.id })).text, 'Person edit before recovery.');
  assert.equal(value(await host.call('material.read', { id: revisions[0].id })).text, 'First result.');
  assert.equal(Object.hasOwn(thread, 'writeCustody'), false, 'private active and inert originals never enter the public thread');
  const follow = await host.call('turns.send', { projectId, threadId: stored.summary.id, text: JSON.stringify({ name: 'r/after-recovery.md' }), attachments: [], settings: { ...settings, permission: 'full', model: 'controlled', effort: 4 }, clientKey: randomUUID() });
  assert.ok(follow.ok, JSON.stringify(follow));
  const continued = await idle(host, follow.value.threadId);
  assert.equal(continued.turns.at(-1)!.status, 'done');
  assert.equal(starts(), before + 1, 'only the deliberate new message starts a producer');
});

test('a public withdrawal and target Save after a real kill retain the unfinished work privately', { timeout: 600_000 }, async (t) => {
  const home = freshHome(), name = 'r/pending.md';
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-document.ts'), home, fixture, name, 'pending-original'], {
    env: { ...process.env, BACKBONE_CRASH_AT: 'write.custodied', BACKBONE_CRASH_OCCURRENCE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes.toString(); });
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const timer = childHangTimer(child, 'crash fixture reaching its selected cut');
  try {
    const signal = await new Promise<string | null>((resolve, reject) => { child.once('error', reject); child.once('exit', (_code, signal) => resolve(signal)); });
    assert.equal(signal, 'SIGKILL', stderr);
  } finally { clearTimeout(timer); }
  const { projectId } = JSON.parse(stdout.trim().split('\n')[0]);
  const stored = JSON.parse(readFileSync(join(home, 'threads', readdirSync(join(home, 'threads')).find(file => file.endsWith('.json'))!), 'utf8'));
  const starts = () => readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'start').length;
  const before = starts();
  const host = createHost({ home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(home); });
  // Opening resumes nothing: the person's public Save precedes explicit recovery.
  const target = (await host.call('material.list', { projectId })).find(entry => entry.name === name)!;
  assert.ok(target);
  value(await host.call('material.save', { id: target.id, text: 'Person edit before recovery.', baseVersion: 1 }));
  const original = (await host.call('material.list', { projectId })).find(entry => entry.name === 'source.md')!;
  value(await host.call('material.lifecycle', { id: original.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  await host.resumeInterrupted();
  let thread = value(await host.call('threads.get', { id: stored.summary.id }));

  await waitFor(async()=>{if(!(thread.summary.running))return true;
    await new Promise(resolve => setTimeout(resolve, 25));
    thread = value(await host.call('threads.get', { id: stored.summary.id }));

return !(thread.summary.running);}, 'recovery thread settlement', {diagnostic:()=>JSON.stringify(thread.summary)});
  assert.equal(thread.summary.running, false);
  assert.equal(starts(), before, 'recovery never starts the producer');
  const entries = await host.call('material.list', { projectId, includeHidden: true });
  const revisions = entries.filter(entry => entry.name !== name && entry.name !== 'source.md');
  assert.equal(revisions.length, 1, thread.turns[0].answer?.text ?? 'No answer.');
  assert.equal(thread.turns[0].effects.filter(effect => effect.outcome === 'DONE').length, 1);
  assert.equal(value(await host.call('material.read', { id: target.id })).text, 'Person edit before recovery.');
  assert.equal(value(await host.call('material.read', { id: revisions[0].id })).text, 'First result.');
  assert.ok(revisions[0].held);
  assert.equal(revisions[0].hidden, true);
});


test('a second public withdrawal before recovery preserves the pending held body', { timeout: 600_000 }, async (t) => {
  const home = freshHome(), name = 'r/kept.md';
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-document.ts'), home, fixture, name, 'pending-two-originals'], {
    env: { ...process.env, BACKBONE_CRASH_AT: 'write.custodied', BACKBONE_CRASH_OCCURRENCE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', bytes => { stdout += bytes.toString(); });
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const timer = childHangTimer(child, 'crash fixture reaching its selected cut', () => { timedOut = true; });
  try {
    const signal = await new Promise<string | null>((resolve, reject) => { child.once('error', reject); child.once('exit', (_code, signal) => resolve(signal)); });
    assert.equal(timedOut, false, 'the fixture must reach its actual custody crash cut');
    assert.equal(signal, 'SIGKILL', stderr);
  } finally { clearTimeout(timer); }
  const { projectId, sourceId, secondId } = JSON.parse(stdout.trim().split('\n')[0]);
  assert.ok(secondId);
  const stored = JSON.parse(readFileSync(join(home, 'threads', readdirSync(join(home, 'threads')).find(file => file.endsWith('.json'))!), 'utf8'));
  const starts = () => readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'start').length;
  const before = starts();
  const host = createHost({ home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(home); });
  value(await host.call('material.lifecycle', { id: secondId, version: 1, state: 'withdrawn', lifecycle: 0 }));
  await host.resumeInterrupted();
  let thread = value(await host.call('threads.get', { id: stored.summary.id }));

  await waitFor(async()=>{if(!(thread.summary.running))return true;
    await new Promise(resolve => setTimeout(resolve, 25));
    thread = value(await host.call('threads.get', { id: stored.summary.id }));

return !(thread.summary.running);}, 'recovery thread settlement', {diagnostic:()=>JSON.stringify(thread.summary)});
  assert.equal(thread.summary.running, false);
  assert.equal(starts(), before, 'recovery starts no producer');
  assert.equal(Object.hasOwn(thread, 'writeCustody'), false, 'private source bindings and original bodies stay out of public thread views');
  const held = (await host.call('material.list', { projectId, includeHidden: true })).filter(entry => entry.held);
  assert.equal(held.length, 1, JSON.stringify({ answer: thread.turns[0].answer, effects: thread.turns[0].effects }));
  assert.equal(held[0].hidden, true);
  assert.equal(value(await host.call('material.read', { id: held[0].id })).text, 'First result.');
  assert.equal(value(await host.call('material.read', { id: sourceId })).text, 'person source v1');
  assert.equal(value(await host.call('material.read', { id: secondId })).text, 'Second immutable source.');
});


test('a second SIGKILL after custody retirement preserves the checkpoint and resumes its original run once', { timeout: TEST_HANG_MS }, async (t) => {
  const home = freshHome(), name = 'r/cold-retirement.md';
  const killAt = async (mode: string, point: string) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-document.ts'), home, fixture, name, mode], {
      env: { ...process.env, BACKBONE_CRASH_AT: point, BACKBONE_CRASH_OCCURRENCE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', bytes => { stdout += bytes.toString(); });
    child.stderr.on('data', bytes => { stderr += bytes.toString(); });
    const timer = childHangTimer(child, 'crash fixture reaching its selected cut', () => { timedOut = true; });
    try {
      const signal = await new Promise<string | null>((resolve, reject) => { child.once('error', reject); child.once('exit', (_code, signal) => resolve(signal)); });
      assert.equal(timedOut, false, `The real ${point} cut must be reached: ${stderr}`);
      assert.equal(signal, 'SIGKILL', stderr);
    } finally { clearTimeout(timer); }
    return stdout;
  };
  const stdout = await killAt('pending', 'write.custodied');
  const { projectId } = JSON.parse(stdout.trim().split('\n')[0]);
  const threadPath = join(home, 'threads', readdirSync(join(home, 'threads')).find(file => file.endsWith('.json'))!);
  const original = JSON.parse(readFileSync(threadPath, 'utf8'));
  let host = createHost({ home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  const target = (await host.call('material.list', { projectId })).find(entry => entry.name === name)!;
  value(await host.call('material.save', { id: target.id, text: 'Person edit before both recoveries.', baseVersion: 1 }));
  host.close(); await CoreLink.whenClosed(home);
  const starts = () => readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'start').length;
  const before = starts();
  await killAt('resume-existing', 'write.reconciled');
  const checkpoint = JSON.parse(readFileSync(join(home, 'checkpoints', `${original.turns[0].id}.json`), 'utf8'));
  assert.equal(checkpoint.files[0].body, 'First result.', 'the only durable import source survives retirement');
  const retired = JSON.parse(readFileSync(threadPath, 'utf8')).writeCustody;
  assert.equal(JSON.stringify(retired.unproposed).includes('First result.'), true, 'inert original evidence survives the second kill');
  assert.ok(retired.writes, 'the private custody envelope remains readable');
  assert.equal(Object.keys(retired.writes).length, 0, 'no unproposed active reservation remains');
  const originalRun = Object.values(original.writeCustody.writes)[0] as { run: string };
  for (const bucket of Object.values(retired.unproposed) as Record<string, { run: string }>[]) for (const entry of Object.values(bucket)) assert.equal(entry.run, originalRun.run);
  assert.equal(starts(), before);
  host = createHost({ home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(home); });
  await host.resumeInterrupted();
  let thread = value(await host.call('threads.get', { id: original.summary.id }));

  await waitFor(async()=>{if(!(thread.summary.running))return true;
    await new Promise(resolve => setTimeout(resolve, 25));
    thread = value(await host.call('threads.get', { id: original.summary.id }));

return !(thread.summary.running);}, 'recovery thread settlement', {diagnostic:()=>JSON.stringify(thread.summary)});
  assert.equal(thread.summary.running, false, JSON.stringify(thread.turns[0].answer));
  assert.equal(starts(), before, 'neither recovery starts a producer');
  const kept = (await host.call('material.list', { projectId, includeHidden: true })).filter(entry => entry.name !== name && entry.name !== 'source.md');
  assert.equal(kept.length, 1, JSON.stringify(thread.turns[0].answer));
  assert.equal(value(await host.call('material.read', { id: kept[0].id })).text, 'First result.');
  assert.equal(value(await host.call('material.read', { id: target.id })).text, 'Person edit before both recoveries.');
  assert.equal(thread.turns[0].effects.filter(effect => effect.outcome === 'DONE').length, 1);
  assert.equal(existsSync(join(home, 'checkpoints', `${original.turns[0].id}.json`)), false, 'only the verified import clears the checkpoint');
  const finalCustody = JSON.parse(readFileSync(threadPath, 'utf8')).writeCustody;
  assert.equal(Object.keys(finalCustody.writes).length, 1, 'one actual gateway proposal replaced the retired reservation');
  assert.equal((Object.values(finalCustody.writes)[0] as { run: string }).run, originalRun.run, 'the imported write uses the original run, with no replacement budget');
  const follow = value(await host.call('turns.send', { projectId, threadId: original.summary.id, text: JSON.stringify({ name: 'r/after-cold-recovery.md' }), attachments: [], settings: { ...settings, permission: 'full', model: 'controlled', effort: 4 }, clientKey: randomUUID() }));
  await idle(host, follow.threadId);
  assert.equal(starts(), before + 1);
});


test('a stopped importer retains its checkpoint across close and reopen, then resumes without a producer', { timeout: TEST_HANG_MS }, async t => {
  const home = freshHome(), name = 'r/stopped-import.md';
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-document.ts'), home, fixture, name, 'pending'], {
    env: { ...process.env, BACKBONE_CRASH_AT: 'write.custodied', BACKBONE_CRASH_OCCURRENCE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', bytes => { stdout += bytes.toString(); });
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const timer = childHangTimer(child, 'crash fixture reaching its selected cut', () => { timedOut = true; });
  try {
    const signal = await new Promise<string | null>((resolve, reject) => { child.once('error', reject); child.once('exit', (_code, signal) => resolve(signal)); });
    assert.equal(timedOut, false, 'the actual custody cut must be reached');
    assert.equal(signal, 'SIGKILL', stderr);
  } finally { clearTimeout(timer); }
  const { projectId } = JSON.parse(stdout.trim().split('\n')[0]);
  const threadPath = join(home, 'threads', readdirSync(join(home, 'threads')).find(file => file.endsWith('.json'))!);
  const original = JSON.parse(readFileSync(threadPath, 'utf8'));
  const checkpointPath = join(home, 'checkpoints', `${original.turns[0].id}.json`);
  const originalRun = (Object.values(original.writeCustody.writes)[0] as { run: string }).run;
  const starts = () => readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'start').length;
  const before = starts();
  let faultSeen = false;
  let host = createHost({ home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture }, atPoint: point => {
    if (point === 'write.reconciled') { faultSeen = true; throw new Error('Controlled importer failure before replay.'); }
  } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(home); });
  const settle = async () => {
    let thread = value(await host.call('threads.get', { id: original.summary.id }));

    await waitFor(async()=>{if(!(thread.summary.running))return true;
      await new Promise(resolve => setTimeout(resolve, 25));
      thread = value(await host.call('threads.get', { id: original.summary.id }));

return !(thread.summary.running);}, 'recovery thread settlement', {diagnostic:()=>JSON.stringify(thread.summary)});
    assert.equal(thread.summary.running, false, JSON.stringify(thread.turns[0].answer));
    return thread;
  };
  const target = (await host.call('material.list', { projectId })).find(entry => entry.name === name)!;
  value(await host.call('material.save', { id: target.id, text: 'Person version survives a stopped importer.', baseVersion: 1 }));
  await host.resumeInterrupted();
  const stopped = await settle();
  assert.equal(faultSeen, true);
  assert.equal(stopped.turns[0].status, 'stopped');
  assert.match(stopped.turns[0].answer?.text ?? '', /Controlled importer failure/);
  assert.equal(existsSync(checkpointPath), true);
  assert.equal(starts(), before);
  host.close(); await CoreLink.whenClosed(home);
  host = createHost({ home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  await host.call('material.list', { projectId }); // Wait for startup classification and sweep.
  assert.equal(existsSync(checkpointPath), true, 'startup must not sweep a stopped importer checkpoint');
  await host.resumeInterrupted();
  const recovered = await settle();
  const kept = (await host.call('material.list', { projectId, includeHidden: true })).filter(entry => entry.name !== name && entry.name !== 'source.md');
  assert.equal(kept.length, 1, JSON.stringify(recovered.turns[0].answer));
  assert.equal(value(await host.call('material.read', { id: kept[0].id })).text, 'First result.');
  assert.equal(value(await host.call('material.read', { id: target.id })).text, 'Person version survives a stopped importer.');
  assert.equal(starts(), before, 'neither recovery restarts the producer');
  assert.equal(recovered.turns[0].effects.filter(effect => effect.outcome === 'DONE').length, 1);
  const imported = JSON.parse(readFileSync(threadPath, 'utf8')).writeCustody.writes;
  assert.equal(Object.keys(imported).length, 1);
  assert.equal((Object.values(imported)[0] as { run: string }).run, originalRun);
  assert.equal(existsSync(checkpointPath), false);
  const follow = value(await host.call('turns.send', { projectId, threadId: original.summary.id, text: JSON.stringify({ name: 'after-stopped-import.md' }), attachments: [], settings: { ...settings, permission: 'full', model: 'controlled', effort: 4 }, clientKey: randomUUID() }));
  const continued = await settle(); assert.equal(follow.threadId, original.summary.id);
  assert.equal(continued.turns.at(-1)!.status, 'done'); assert.equal(starts(), before + 1);
});

async function pendingNewCheckpoint(name: string, point = 'write.custodied', piece = fixture) {
  const home = freshHome();
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-document.ts'), home, piece, name, 'pending-new'], {
    env: { ...process.env, BACKBONE_CRASH_AT: point, BACKBONE_CRASH_OCCURRENCE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', bytes => { stdout += bytes.toString(); }); child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const timer = childHangTimer(child, 'crash fixture reaching its selected cut', () => { timedOut = true; });
  try {
    const signal = await new Promise<string | null>((resolve, reject) => { child.once('error', reject); child.once('exit', (_code, signal) => resolve(signal)); });
    assert.equal(timedOut, false, 'the actual custody cut must be reached'); assert.equal(signal, 'SIGKILL', stderr);
  } finally { clearTimeout(timer); }
  const { projectId } = JSON.parse(stdout.trim().split('\n')[0]);
  const path = join(home, 'threads', readdirSync(join(home, 'threads')).find(file => file.endsWith('.json'))!);
  const thread = JSON.parse(readFileSync(path, 'utf8'));
  const run = (Object.values(thread.writeCustody.writes)[0] as { run: string }).run;
  return { home, projectId, threadId: thread.summary.id as string, turnId: thread.turns[0].id as string, run,
    checkpoint: join(home, 'checkpoints', `${thread.turns[0].id}.json`),
    starts: () => readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'start').length };
}
async function recoverySettled(host: ReturnType<typeof createHost>, id: string) {
  let thread = value(await host.call('threads.get', { id }));

  await waitFor(async()=>{if(!(thread.summary.running))return true; await new Promise(resolve => setTimeout(resolve, 25)); thread = value(await host.call('threads.get', { id }));
return !(thread.summary.running);}, 'recovery thread settlement', {diagnostic:()=>JSON.stringify(thread.summary)});
  assert.equal(thread.summary.running, false, JSON.stringify(thread.turns.at(-1)?.answer)); return thread;
}

test('a revoked original run stays closed when the person explicitly grants its carrier for future work', { timeout: TEST_HANG_MS }, async t => {
  const s = await pendingNewCheckpoint('revoked-result.md'), before = s.starts();
  const link = await CoreLink.open({ home: s.home });
  try {
    const { rows } = await link.read<{ mandate: string; piece: string }>(link.system(), 'SELECT mandate_id AS mandate, piece_id AS piece FROM app.runs WHERE id = $1', [s.run]);
    await link.call(link.person(), 'SELECT gov.revoke_mandate($1)', [rows[0].mandate]);
    // A configured piece with no standing grant cannot open this home (the existing pieces
    // contract). The test person explicitly grants the carrier for FUTURE work. The cancelled
    // original keeps its revoked mandate; recovery may not borrow this new grant or create a run.
    const granted = await link.grantPiece(rows[0].piece);
    assert.notEqual(granted, rows[0].mandate);
    const { rows: original } = await link.read<{ mandate: string; status: string }>(link.system(), 'SELECT mandate_id AS mandate, status FROM app.runs WHERE id = $1', [s.run]);
    assert.deepEqual(original, [{ mandate: rows[0].mandate, status: 'cancelled' }]);
  } finally { await link.release(); }
  const host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(s.home); });
  await host.resumeInterrupted();
  const thread = await recoverySettled(host, s.threadId);
  const copies = (await host.call('material.list', { projectId: s.projectId, includeHidden: true })).filter(entry => entry.recovery);
  assert.equal(copies.length, 1, JSON.stringify(thread.turns[0].answer));
  assert.ok(copies[0].hidden && copies[0].held);
  assert.equal(value(await host.call('material.read', { id: copies[0].id })).text, 'First result.');
  assert.equal(existsSync(s.checkpoint), false);
  assert.equal(thread.turns[0].effects.some(effect => effect.outcome === 'DONE'), false, 'a local inspection copy is not a successful Core write');
  assert.equal(s.starts(), before, 'granting the carrier for future work never restarts this cancelled producer');
  const observed = await CoreLink.open({ home: s.home });
  try {
    const { rows } = await observed.read<{ id: string; status: string }>(observed.system(), 'SELECT id, status FROM app.runs WHERE task_id = (SELECT task_id FROM app.runs WHERE id = $1)', [s.run]);
    assert.deepEqual(rows, [{ id: s.run, status: 'cancelled' }], 'no replacement run or budget was created for recovery');
  } finally { await observed.release(); }
  assert.equal((await host.call('material.lifecycle', { id: copies[0].id, version: 1, state: 'kept', lifecycle: 0 })).ok, false, 'Keep cannot turn unreconciled source/privacy standing into agent input');
  assert.equal((await host.call('material.save', { id: copies[0].id, text: 'Replacement', baseVersion: 1 })).ok, false);
  const attach = await host.call('turns.send', { projectId: s.projectId, threadId: s.threadId, text: 'Use this copy', attachments: [copies[0].id], settings: { ...settings, permission: 'full', model: 'controlled', effort: 4 }, clientKey: randomUUID() });
  assert.equal(attach.ok, false);
  const follow = value(await host.call('turns.send', { projectId: s.projectId, threadId: s.threadId, text: JSON.stringify({ name: 'after-explicit-new-grant.md' }), attachments: [], settings: { ...settings, permission: 'full', model: 'controlled', effort: 4 }, clientKey: randomUUID() }));
  await recoverySettled(host, follow.threadId);
  assert.equal(s.starts(), before + 1, 'only the deliberate new message uses the separate explicit carrier grant');
  value(await host.call('threads.delete', { id: s.threadId }));
  assert.equal(value(await host.call('material.read', { id: copies[0].id })).text, 'First result.', 'deleting the conversation does not delete inspection data');
});

test('a permanently refused checkpoint import ends with a held inspection copy and permits later work', { timeout: TEST_HANG_MS }, async t => {
  const s = await pendingNewCheckpoint('reports/refused.md'), before = s.starts();
  new MaterialStore(s.home, {}, () => {}).create(s.projectId, 'Reports/person.md', 'text/markdown', Buffer.from('Person namespace.'), 'accepted', 'person', randomUUID(), 'managed');
  const host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(s.home); });
  await host.resumeInterrupted(); const thread = await recoverySettled(host, s.threadId);
  const copies = (await host.call('material.list', { projectId: s.projectId, includeHidden: true })).filter(entry => entry.recovery);
  assert.equal(copies.length, 1, JSON.stringify(thread.turns[0].answer));
  assert.equal(value(await host.call('material.read', { id: copies[0].id })).text, 'First result.');
  assert.ok(copies[0].hidden && copies[0].held);
  assert.equal(existsSync(s.checkpoint), false);
  assert.equal(thread.turns[0].effects.some(effect => effect.outcome === 'DONE'), false);
  assert.equal(s.starts(), before);
  const follow = value(await host.call('turns.send', { projectId: s.projectId, threadId: s.threadId, text: JSON.stringify({ name: 'after-refusal.md' }), attachments: [], settings: { ...settings, permission: 'full', model: 'controlled', effort: 4 }, clientKey: randomUUID() }));
  const continued = await recoverySettled(host, follow.threadId);
  assert.equal(continued.turns.at(-1)!.status, 'done'); assert.equal(s.starts(), before + 1);
  value(await host.call('material.lifecycle', { id: copies[0].id, version: 1, state: 'retired', lifecycle: 0 }));
  const retired = value(await host.call('material.read', { id: copies[0].id }));
  assert.equal(retired.entry.hidden, true); assert.ok(retired.entry.recovery);
  const attachRetired = await host.call('turns.send', { projectId: s.projectId, text: 'Use a retired inspection copy', attachments: [copies[0].id], settings: { ...settings, permission: 'full', model: 'controlled', effort: 4 }, clientKey: randomUUID() });
  assert.ok(!attachRetired.ok); assert.equal(attachRetired.reason, 'INVALID'); assert.match(attachRetired.detail, /inspection copy/);
  const queued = await host.call('queue.add', { threadId: s.threadId, text: 'Use this retired copy', attachments: [copies[0].id], settings: { ...settings, permission: 'full', model: 'controlled', effort: 4 }, clientKey: randomUUID() });
  assert.ok(!queued.ok); assert.equal(queued.reason, 'INVALID'); assert.match(queued.detail, /inspection copy/);
  value(await host.call('threads.delete', { id: s.threadId }));
});

test('a damaged checkpoint blocks only its conversation and preserves the exact damaged data', { timeout: TEST_HANG_MS }, async t => {
  const s = await pendingNewCheckpoint('damaged.md'); const damaged = '{ deliberately incomplete checkpoint'; writeFileSync(s.checkpoint, damaged);
  const host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(s.home); });
  const blocked = await host.call('turns.send', { projectId: s.projectId, threadId: s.threadId, text: 'Do not bypass damage', attachments: [], settings: { ...settings, permission: 'full' }, clientKey: randomUUID() });
  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  const sent = value(await host.call('turns.send', { projectId: s.projectId, text: JSON.stringify({ name: 'independent.md' }), attachments: [], settings: { ...settings, permission: 'full', model: 'controlled', effort: 4 }, clientKey: randomUUID() }));
  const other = await recoverySettled(host, sent.threadId); assert.equal(other.turns[0].status, 'done');
  assert.equal(readFileSync(s.checkpoint, 'utf8'), damaged);
  const held = value(await host.call('threads.get', { id: s.threadId }));
  assert.deepEqual(held.summary.recoveryHold, { turnId: s.turnId, kind: 'inspection' });
  assert.deepEqual((await host.call('threads.list', {})).find(row => row.id === s.threadId)?.recoveryHold, held.summary.recoveryHold);
  const events: string[] = []; const unsubscribe = host.on(event => { if (event.topic === 'threads') events.push(event.id ?? ''); });
  t.after(unsubscribe);
  const notice = held.turns[0].recovery;
  assert.ok(notice, 'the person gets a concrete current-data repair action');
  const beforeRepair = s.starts();
  const stale = await host.call('turns.keepRecovery', { threadId: s.threadId, turnId: s.turnId, revision: 'stale-revision' });
  assert.ok(!stale.ok); assert.equal(stale.reason, 'STALE_BASE');
  assert.equal(readFileSync(s.checkpoint, 'utf8'), damaged);
  const kept = value(await host.call('turns.keepRecovery', { threadId: s.threadId, turnId: s.turnId, revision: notice.revision }));
  assert.equal(kept.cleared, true, kept.detail); assert.equal(kept.files.length, 2, 'raw checkpoint and old private bookkeeping are kept');
  assert.equal(value(await host.call('material.read', { id: kept.files[0].materialId })).text, damaged);
  assert.ok(value(await host.call('material.read', { id: kept.files[1].materialId })).text!.includes('First result.'));
  assert.equal(existsSync(s.checkpoint), false); assert.equal(s.starts(), beforeRepair, 'repair starts no producer');
  assert.equal(value(await host.call('threads.get', { id: s.threadId })).summary.recoveryHold, undefined);
  assert.equal((await host.call('threads.list', {})).find(row => row.id === s.threadId)?.recoveryHold, undefined);
  assert.ok(events.includes(s.threadId), 'thread consumers are told to refresh the derived hold');
  assert.equal('recoveryHold' in JSON.parse(readFileSync(join(s.home, 'threads', `${s.threadId}.json`), 'utf8')).summary, false, 'the hold is not persisted authority');
  for (const file of kept.files) assert.ok(value(await host.call('material.read', { id: file.materialId })).entry.recovery);
  const resumed = value(await host.call('turns.send', { projectId: s.projectId, threadId: s.threadId, text: JSON.stringify({ name: 'after-person-repair.md' }), attachments: [], settings: { ...settings, permission: 'full', model: 'controlled', effort: 4 }, clientKey: randomUUID() }));
  assert.equal((await recoverySettled(host, resumed.threadId)).turns.at(-1)!.status, 'done');
  value(await host.call('threads.delete', { id: s.threadId }));
  assert.equal(value(await host.call('material.read', { id: kept.files[0].materialId })).text, damaged, 'thread deletion leaves inspection bytes intact');
});

test('person repair preserves UNKNOWN and its custody rather than releasing damaged recovery', { timeout: TEST_HANG_MS }, async t => {
  const s = await pendingNewCheckpoint('uncertain-repair.md', 'write.begun');
  const damaged = '{ damaged after a possibly dispatched operation'; writeFileSync(s.checkpoint, damaged);
  const host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(s.home); });
  const thread = value(await host.call('threads.get', { id: s.threadId })); assert.ok(thread.turns[0].recovery);
  const path = join(s.home, 'threads', `${s.threadId}.json`), custody = JSON.parse(readFileSync(path, 'utf8')).writeCustody;
  const link = await CoreLink.open({ home: s.home });
  const effects = async () => (await link.read<{ id: string; status: string }>(link.system(), "SELECT id, status FROM app.effects WHERE run_id = $1 AND operation = 'workspace.write_document'", [s.run])).rows;
  try {
    const before = await effects(); assert.equal(before[0].status, 'unknown');
    const count = s.starts();
    const result = value(await host.call('turns.keepRecovery', { threadId: s.threadId, turnId: s.turnId, revision: thread.turns[0].recovery.revision }));
    assert.equal(result.cleared, false); assert.equal(result.files.length, 2);
    assert.deepEqual(value(await host.call('threads.get', { id: s.threadId })).summary.recoveryHold, { turnId: s.turnId, kind: 'inspection' });
    assert.equal((await host.call('threads.list', {})).find(row => row.id === s.threadId)?.recoveryHold?.kind, 'inspection');
    assert.deepEqual(await effects(), before, 'a person data action does not relabel UNKNOWN');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).writeCustody, custody, 'the original receipt bindings stay active and unchanged');
    assert.equal(readFileSync(s.checkpoint, 'utf8'), damaged); assert.equal(s.starts(), count);
    assert.equal((await host.call('threads.delete', { id: s.threadId })).ok, false, 'the separate UNKNOWN decision remains required');
  } finally { await link.release(); }
});

test('a closed original is reconciled in-session after revocation without regranting or restarting', { timeout: TEST_HANG_MS }, async t => {
  const s = await pendingNewCheckpoint('in-session-closed.md'), before = s.starts(); let failOnce = true;
  const reclaim = CoreLink.prototype.reclaimRun; let claims = 0, releaseRetry!: () => void, retryReached!: () => void;
  const retryBlocked = new Promise<void>(resolve => { releaseRetry = resolve; });
  const retryStarted = new Promise<void>(resolve => { retryReached = resolve; });
  t.mock.method(CoreLink.prototype, 'reclaimRun', async function(this: CoreLink, ...args: Parameters<typeof reclaim>) {
    if (args[0] === s.run && ++claims === 2) { retryReached(); await retryBlocked; }
    return reclaim.apply(this, args);
  });
  const host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture }, atPoint: point => {
    if (point === 'write.reconciled' && failOnce) { failOnce = false; throw new Error('Controlled first importer failure.'); }
  } });
  t.after(async () => { releaseRetry(); host.close(); await CoreLink.whenClosed(s.home); });
  await host.resumeInterrupted(); await recoverySettled(host, s.threadId); assert.equal(existsSync(s.checkpoint), true);
  await retryStarted; // The retry observed the open original before revocation.
  const link = await CoreLink.open({ home: s.home });
  try {
    const { rows } = await link.read<{ mandate: string }>(link.system(), 'SELECT mandate_id AS mandate FROM app.runs WHERE id = $1', [s.run]);
    await link.call(link.person(), 'SELECT gov.revoke_mandate($1)', [rows[0].mandate]);
  } finally { await link.release(); releaseRetry(); }
  const attempted = await host.call('turns.send', { projectId: s.projectId, threadId: s.threadId, text: 'Wait for reconciliation', attachments: [], settings: { ...settings, permission: 'full', model: 'controlled', effort: 4 }, clientKey: randomUUID() });
  assert.ok(!attempted.ok);
  // The thread can be idle before the scheduled retry starts. Clearing the checkpoint happens
  // only after the closed-run inspection copy and its projection have been durably saved.
  await waitFor(() => !existsSync(s.checkpoint), 'closed original checkpoint reconciliation', {
    hangMs: 30_000, diagnostic: () => `checkpoint still present: ${existsSync(s.checkpoint)}`,
  });
  await recoverySettled(host, s.threadId);
  const copies = (await host.call('material.list', { projectId: s.projectId, includeHidden: true })).filter(entry => entry.recovery);
  assert.equal(copies.length, 1); assert.equal(value(await host.call('material.read', { id: copies[0].id })).text, 'First result.');
  assert.equal(existsSync(s.checkpoint), false); assert.equal(s.starts(), before, 'no current or replacement grant was used to restart the old producer');
  value(await host.call('threads.delete', { id: s.threadId }));
});

test('SIGKILL after the durable recovery close preserves links and idempotent inspection copies', { timeout: TEST_HANG_MS }, async t => {
  const s = await pendingNewCheckpoint('reports/held-journal.md'), before = s.starts();
  new MaterialStore(s.home, {}, () => {}).create(s.projectId, 'Reports/person.md', 'text/markdown', Buffer.from('Person namespace.'), 'accepted', 'person', randomUUID(), 'managed');
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-document.ts'), s.home, fixture, 'ignored', 'resume-existing'], {
    env: { ...process.env, BACKBONE_CRASH_AT: 'recovery.saved', BACKBONE_CRASH_OCCURRENCE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '', timedOut = false; child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const timer = childHangTimer(child, 'crash fixture reaching its selected cut', () => { timedOut = true; });
  try {
    const signal = await new Promise<string | null>((resolve, reject) => { child.once('error', reject); child.once('exit', (_code, signal) => resolve(signal)); });
    assert.equal(timedOut, false, 'the journal-before-clear cut must be reached'); assert.equal(signal, 'SIGKILL', stderr);
  } finally { clearTimeout(timer); }
  assert.equal(existsSync(s.checkpoint), true, 'the crash really falls before checkpoint clear');
  const saved = JSON.parse(readFileSync(join(s.home, 'threads', `${s.threadId}.json`), 'utf8'));
  assert.equal(saved.turns[0].answer.files.length, 1); const copyId = saved.turns[0].answer.files[0].materialId;
  const host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(s.home); });
  const recovered = value(await host.call('threads.get', { id: s.threadId }));
  const copies = (await host.call('material.list', { projectId: s.projectId, includeHidden: true })).filter(entry => entry.recovery);
  assert.equal(copies.length, 1); assert.equal(copies[0].id, copyId); assert.equal(recovered.turns[0].answer!.files[0].materialId, copyId);
  assert.equal(value(await host.call('material.read', { id: copyId })).text, 'First result.');
  assert.equal(existsSync(s.checkpoint), false); assert.equal(s.starts(), before);
});

for (const cut of ['write.custodied', 'write.begun'] as const) for (const stopAt of ['write.reconciled', 'recovery.ready'] as const) test(`an acknowledged Stop clears a recovered checkpoint without importing it or blocking later work (${cut}, ${stopAt})`, { timeout: TEST_HANG_MS }, async t => {
  const s = await pendingNewCheckpoint('stopped-checkpoint.md', cut), before = s.starts();
  let stop: Promise<Receipt<{ stopped: boolean }>> | undefined;
  const host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture }, atPoint: point => {
    if (point === stopAt && !stop) stop = host.call('turns.stop', { threadId: s.threadId });
  } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(s.home); });
  await host.resumeInterrupted(); const thread = await recoverySettled(host, s.threadId);
  assert.ok(stop); const acknowledged = await stop; assert.ok(acknowledged.ok); assert.equal(acknowledged.value.stopped, true);
  assert.equal(thread.turns[0].stopRequested, true);
  assert.equal(thread.turns[0].status, 'stopped'); assert.equal(s.starts(), before);
  if (cut === 'write.begun') {
    assert.equal(thread.turns[0].effects[0]?.outcome, 'UNKNOWN');
    const link = await CoreLink.open({ home: s.home });
    try {
      const { rows } = await link.read<{ id: string; status: string }>(link.system(), 'SELECT id, status FROM app.effects WHERE run_id = $1', [s.run]);
      assert.equal(rows[0].status, 'unknown');
      const custody = JSON.parse(readFileSync(join(s.home, 'threads', `${s.threadId}.json`), 'utf8')).writeCustody;
      assert.ok(custody.writes[`${s.turnId}:stopped-checkpoint.md`], 'the recorded UNKNOWN key remains in private custody');
      const deletion = await host.call('threads.delete', { id: s.threadId });
      assert.ok(!deletion.ok); assert.match(deletion.detail, /UNKNOWN/); assert.ok(deletion.detail.includes(rows[0].id)); assert.match(deletion.detail, /Needs you/);
      const other = value(await host.call('projects.create', { name: 'Move target', kind: 'folder' }));
      const moved = await host.call('threads.update', { id: s.threadId, patch: { projectId: other.id } });
      assert.ok(!moved.ok); assert.match(moved.detail, /UNKNOWN/); assert.ok(moved.detail.includes(rows[0].id));
    } finally { await link.release(); }
  }
  assert.equal(existsSync(s.checkpoint), false, 'the acknowledged Stop does not leave executable recovery blocking this conversation: ' + JSON.stringify({ answer: thread.turns[0].answer, effects: thread.turns[0].effects }));
  assert.deepEqual((await host.call('material.list', { projectId: s.projectId, includeHidden: true })).map(entry => entry.name), ['source.md'], 'Stop imports no document or inspection copy');
  const follow = value(await host.call('turns.send', { projectId: s.projectId, threadId: s.threadId, text: JSON.stringify({ name: 'after-stopped-checkpoint.md' }), attachments: [], settings: { ...settings, permission: 'full', model: 'controlled', effort: 4 }, clientKey: randomUUID() }));
  assert.equal((await recoverySettled(host, follow.threadId)).turns.at(-1)!.status, 'done');
  assert.equal(s.starts(), before + 1);
});


test('Stop during recovery of an already-stopped importer records its intent and clears only pending cache', { timeout: TEST_HANG_MS }, async t => {
  const s = await pendingNewCheckpoint('stop-after-recovery-error.md'), before = s.starts();
  let host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture }, atPoint: point => {
    if (point === 'write.reconciled') throw new Error('Controlled previous importer failure.');
  } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(s.home); });
  await host.resumeInterrupted();
  assert.equal((await recoverySettled(host, s.threadId)).turns[0].status, 'stopped');
  assert.equal(existsSync(s.checkpoint), true);
  host.close(); await CoreLink.whenClosed(s.home);
  let stop: Promise<Receipt<{ stopped: boolean }>> | undefined;
  host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture }, atPoint: point => {
    if (point === 'recovery.ready' && !stop) stop = host.call('turns.stop', { threadId: s.threadId });
  } });
  await host.resumeInterrupted(); const thread = await recoverySettled(host, s.threadId);
  assert.ok(stop); const acknowledgement = await stop; assert.ok(acknowledgement.ok); assert.equal(acknowledgement.value.stopped, true);
  assert.equal(thread.turns[0].stopRequested, true, 'a Stop acknowledged during a recovery carrier is durable even if its prior projection was stopped');
  assert.equal(existsSync(s.checkpoint), false);
  assert.equal(thread.turns[0].status, 'stopped'); assert.equal(s.starts(), before);
  assert.deepEqual((await host.call('material.list', { projectId: s.projectId, includeHidden: true })).map(entry => entry.name), ['source.md']);
  const follow = value(await host.call('turns.send', { projectId: s.projectId, threadId: s.threadId, text: JSON.stringify({ name: 'after-stop-on-stopped-recovery.md' }), attachments: [], settings: { ...settings, permission: 'full', model: 'controlled', effort: 4 }, clientKey: randomUUID() }));
  assert.equal((await recoverySettled(host, follow.threadId)).turns.at(-1)!.status, 'done');
  assert.equal(s.starts(), before + 1);
});


for (const fileState of ['damaged', 'missing-after-copy'] as const) test(`Stop during damaged recovery preservation is durable and keeps inspection copies across reopen (${fileState})`, { timeout: TEST_HANG_MS }, async t => {
  const s = await pendingNewCheckpoint('stop-damaged-keep.md'), before = s.starts();
  const damaged = '{ damaged checkpoint retained after Stop during Keep'; writeFileSync(s.checkpoint, damaged);
  let host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  let release!: () => void, reached!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { reached = resolve; });
  t.after(async () => { release(); host.close(); await CoreLink.whenClosed(s.home); });
  const shown = value(await host.call('threads.get', { id: s.threadId })); assert.ok(shown.turns[0].recovery);
  const task = JSON.parse(readFileSync(join(s.home, 'threads', `${s.threadId}.json`), 'utf8')).task;
  const read = CoreLink.prototype.read; let once = true;
  t.mock.method(CoreLink.prototype, 'read', async function(this: CoreLink, ...args: Parameters<typeof read>) {
    if (once && args[1].includes('SELECT id, piece_id AS piece, agent_id AS agent FROM app.runs') && args[2]?.[0] === task) {
      once = false; reached(); await paused;
    }
    return read.apply(this, args);
  });
  const keeping = host.call('turns.keepRecovery', { threadId: s.threadId, turnId: s.turnId, revision: shown.turns[0].recovery.revision });
  await ready;
  const during = value(await host.call('threads.get', { id: s.threadId }));
  assert.equal(during.summary.running, true); assert.equal(during.summary.recoveryHold?.kind, 'recovering');
  const copies = (await host.call('material.list', { projectId: s.projectId, includeHidden: true })).filter(entry => entry.recovery);
  assert.equal(copies.length, 1, 'the raw checkpoint copy is already kept before the delayed Core read');
  if (fileState === 'missing-after-copy') rmSync(s.checkpoint); // External loss after the repair acquired its exact snapshot must not erase Stop intent.
  const stopped = value(await host.call('turns.stop', { threadId: s.threadId })); assert.equal(stopped.stopped, true);
  // Record the actual boundary before allowing the interrupted action to settle; inspect no synthetic projection.
  const stopRequested = value(await host.call('threads.get', { id: s.threadId })).turns[0].stopRequested;
  const journal = readFileSync(join(s.home, 'thread-journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  release(); const result = value(await keeping); assert.equal(result.cleared, false);
  assert.equal(stopRequested, true, 'acknowledged Stop on damaged recovery must be journalled, not only abort the in-memory action');
  assert.ok(journal.some(event => event.kind === 'turn.stop' && event.threadId === s.threadId && event.turnId === s.turnId));
  if (fileState === 'damaged') assert.equal(readFileSync(s.checkpoint, 'utf8'), damaged, 'unsafe data is never discarded merely because Stop was recorded');
  else assert.equal(existsSync(s.checkpoint), false, 'Stop does not invent a missing checkpoint');
  assert.equal(value(await host.call('material.read', { id: copies[0].id })).text, damaged);
  assert.equal(s.starts(), before);
  host.close(); await CoreLink.whenClosed(s.home);
  host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  await host.resumeInterrupted();
  const reopened = await recoverySettled(host, s.threadId);
  assert.equal(reopened.turns[0].stopRequested, true);
  if (fileState === 'damaged') { assert.equal(reopened.summary.recoveryHold?.kind, 'inspection'); assert.equal(readFileSync(s.checkpoint, 'utf8'), damaged); }
  const kept = value(await host.call('material.read', { id: copies[0].id })); assert.equal(kept.text, damaged); assert.ok(kept.entry.recovery);
  assert.equal(s.starts(), before, 'cold reopen never starts a producer from the damaged checkpoint');
});

test('Stop binds the earlier repairing turn and leaves completed turns and other conversations unchanged', { timeout: TEST_HANG_MS }, async t => {
  const s = await pendingNewCheckpoint('earlier-repair.md');
  let host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  let release!: () => void, reached!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { reached = resolve; });
  t.after(async () => { release(); host.close(); await CoreLink.whenClosed(s.home); });
  await host.resumeInterrupted(); await recoverySettled(host, s.threadId);
  const send = (name: string, threadId?: string) => host.call('turns.send', { projectId: s.projectId, threadId, text: JSON.stringify({ name }), attachments: [], settings: { ...settings, permission: 'full', model: 'controlled', effort: 4 }, clientKey: randomUUID() });
  const later = value(await send('later-completed.md', s.threadId));
  // Compare the API's JSON data across reopen; optional undefined keys do not survive persistence.
  const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const completed = wire((await recoverySettled(host, s.threadId)).turns.at(-1)!);
  assert.equal(completed.id, later.turnId); assert.equal(completed.status, 'done');
  const other = value(await send('other-completed.md'));
  const otherTurn = wire((await recoverySettled(host, other.threadId)).turns.at(-1)!);
  const before = s.starts();
  // A stale external checkpoint appears only after A settled and B completed through the real Host.
  // The person API accepts its exact file revision for A even when A is no longer the last turn.
  const damaged = '{ stale earlier checkpoint'; writeFileSync(s.checkpoint, damaged);
  const notice = checkpointRepairNotice(s.home, s.turnId); assert.ok(notice);
  const task = JSON.parse(readFileSync(join(s.home, 'threads', `${s.threadId}.json`), 'utf8')).task;
  const read = CoreLink.prototype.read; let once = true;
  t.mock.method(CoreLink.prototype, 'read', async function(this: CoreLink, ...args: Parameters<typeof read>) {
    if (once && args[1].includes('SELECT id, piece_id AS piece, agent_id AS agent FROM app.runs') && args[2]?.[0] === task) { once = false; reached(); await paused; }
    return read.apply(this, args);
  });
  const stops = () => readFileSync(join(s.home, 'thread-journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(event => event.kind === 'turn.stop');
  const keeping = host.call('turns.keepRecovery', { threadId: s.threadId, turnId: s.turnId, revision: notice.revision });
  await ready;
  const initialStops = stops();
  assert.equal(value(await host.call('turns.stop', { threadId: other.threadId })).stopped, false);
  assert.deepEqual(stops(), initialStops, 'Stop in an idle conversation records no Stop on this repair');
  assert.equal(value(await host.call('threads.get', { id: s.threadId })).turns[0].stopRequested, undefined);
  assert.equal(value(await host.call('turns.stop', { threadId: s.threadId })).stopped, true);
  const during = structuredClone(value(await host.call('threads.get', { id: s.threadId })));
  const journal = stops();
  release(); assert.equal(value(await keeping).cleared, false);
  assert.equal(during.turns[0].stopRequested, true, 'Stop must be durable on the earlier turn owned by the repair carrier');
  assert.deepEqual(wire(during.turns.at(-1)), completed, 'a completed later turn is not stopped');
  assert.equal(journal.at(-1)?.turnId, s.turnId);
  assert.equal(journal.length, initialStops.length + 1);
  assert.equal(value(await host.call('turns.stop', { threadId: s.threadId })).stopped, false);
  assert.deepEqual(stops(), journal, 'Stop after the repair released its carrier records nothing');
  assert.deepEqual(wire(value(await host.call('threads.get', { id: other.threadId })).turns.at(-1)), otherTurn);
  const copies = (await host.call('material.list', { projectId: s.projectId, includeHidden: true })).filter(entry => entry.recovery);
  assert.equal(copies.length, 1); assert.equal(value(await host.call('material.read', { id: copies[0].id })).text, damaged);
  host.close(); await CoreLink.whenClosed(s.home);
  host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  await host.resumeInterrupted(); const reopened = await recoverySettled(host, s.threadId);
  assert.equal(reopened.turns[0].stopRequested, true); assert.deepEqual(wire(reopened.turns.at(-1)), completed);
  assert.deepEqual(wire(value(await host.call('threads.get', { id: other.threadId })).turns.at(-1)), otherTurn);
  assert.equal(readFileSync(s.checkpoint, 'utf8'), damaged);
  assert.equal(value(await host.call('material.read', { id: copies[0].id })).text, damaged);
  assert.equal(s.starts(), before);
});

for (const failureAt of ['discovery', 'reconciliation'] as const) test(`a transient checkpoint ${failureAt} read recovers in the same Host without a producer or replacement authority`, { timeout: TEST_HANG_MS }, async t => {
  const s = await pendingNewCheckpoint('transient-discovery.md'), starts = s.starts();
  const before = await CoreLink.open({ home: s.home });
  const identities = async (link: CoreLink) => ({
    runs: (await link.read(link.system(), 'SELECT id, task_id, mandate_id FROM app.runs ORDER BY id')).rows,
    effects: (await link.read(link.system(), 'SELECT id, run_id, idempotency_key FROM app.effects ORDER BY id')).rows,
  });
  const original = await identities(before); await before.release();
  const read = CoreLink.prototype.read; let injected = 0;
  t.mock.method(CoreLink.prototype, 'read', async function(this: CoreLink, ...args: Parameters<typeof read>) {
    const query = failureAt === 'discovery' ? 'SELECT id FROM app.runs WHERE id = $1 AND task_id = $2' : 'SELECT run_id AS run, idempotency_key AS key FROM app.effects WHERE run_id = $1';
    if (!injected && args[1].includes(query) && args[2]?.[0] === s.run) {
      injected++; throw new Error('Controlled one-shot discovery read failure.');
    }
    return read.apply(this, args);
  });
  const host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(s.home); });
  await host.call('threads.get', { id: s.threadId }); assert.equal(injected, failureAt === 'discovery' ? 1 : 0);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(existsSync(s.checkpoint), true, 'opening and reading alone does not enable recovery retries');
  assert.equal(s.starts(), starts);
  await host.resumeInterrupted();
  // A failed reconciliation can wait both the dead holder and a newly claimed six-second lease.

  await waitFor(async()=>{if(!(existsSync(s.checkpoint)))return true;await new Promise(resolve => setTimeout(resolve, 25));
return !(existsSync(s.checkpoint));}, 'recovery checkpoint removal', {diagnostic:()=>`checkpoint present=${existsSync(s.checkpoint)}`});
  assert.equal(injected, 1, 'the intended real Core query was interrupted exactly once');
  assert.equal(existsSync(s.checkpoint), false, 'explicit recovery must retry the failed step without requiring a Host restart or another send');
  const recovered = await recoverySettled(host, s.threadId);
  assert.equal(recovered.summary.recoveryHold, undefined); assert.equal(s.starts(), starts);
  const copies = (await host.call('material.list', { projectId: s.projectId, includeHidden: true })).filter(entry => entry.recovery);
  assert.equal(copies.length, 1); assert.ok(copies[0].hidden && copies[0].held);
  assert.equal(value(await host.call('material.read', { id: copies[0].id })).text, 'First result.');
  assert.equal(recovered.turns[0].effects.some(effect => effect.outcome === 'DONE'), false, 'inspection data is not a completed action');
  const after = await CoreLink.open({ home: s.home });
  try { assert.deepEqual(await identities(after), original, 'recovery creates neither a replacement run/mandate binding nor a new effect identity'); }
  finally { await after.release(); }
});

for (const guard of ['damaged', 'foreign', 'unknown', 'checker', 'allowed', 'claimed', 'closed', 'close'] as const) test(`automatic recovery retry preserves the ${guard} boundary`, { timeout: TEST_HANG_MS }, async t => {
  let piece = fixture;
  if (guard === 'checker') {
    // A synthetic piece explicitly declares the raised class used to obtain a genuine Core decision.
    piece = freshDir('checker-recovery-piece-');
    for (const rel of pieceFiles(fixture)) { const to = join(piece, rel); mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(fixture, rel), to); }
    const path = join(piece, 'backbone.module.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.capabilities.effectClasses = [2, 5]; writeFileSync(path, JSON.stringify(manifest));
    writeFileSync(path, JSON.stringify({ ...manifest, digest: pieceDigest(piece) }));
  }
  const point = guard === 'unknown' ? 'write.begun' : guard === 'allowed' || guard === 'closed' ? 'write.proposed' : guard === 'claimed' ? 'write.claimed' : 'write.custodied';
  const s = await pendingNewCheckpoint('guarded-retry.md', point, piece), starts = s.starts();
  if (guard === 'closed') {
    const link = await CoreLink.open({ home: s.home });
    try {
      const { rows } = await link.read<{ piece: string }>(link.system(), 'SELECT piece_id AS piece FROM app.runs WHERE id = $1', [s.run]);
      await link.finishRun(await link.reclaimRun(s.run, rows[0].piece), 'failed');
    } finally { await link.release(); }
    writeFileSync(s.checkpoint, '{ damaged checkpoint of a closed run with an unsent original receipt');
  }
  let checker: { id: string; status: string } | undefined;
  if (guard === 'checker') {
    const link = await CoreLink.open({ home: s.home });
    try {
      const { rows } = await link.read<{ piece: string }>(link.system(), 'SELECT piece_id AS piece FROM app.runs WHERE id = $1', [s.run]);
      const handle = await link.reclaimRun(s.run, rows[0].piece);
      const target = JSON.parse(readFileSync(join(s.home, 'threads', `${s.threadId}.json`), 'utf8')).writeCustody.writes[`${s.turnId}:guarded-retry.md`].target;
      const args = { document_id: target.document, title: target.name, base_version: target.baseVersion, content_sha256: (await import('../src/stub/fsx.ts')).sha256(target.body) };
      const id = await link.call<string>(link.runOf(handle), "SELECT gov.propose_effect($1, $2, 1, 'write', 'workspace.write_document', NULL, NULL, 5::smallint, false, $3::jsonb, $4, NULL, $5)", [s.run, handle.fence, JSON.stringify(args), 'Synthetic original checker-held write', `${s.turnId}:guarded-retry.md`]);
      checker = { id, status: (await link.effect(id)).status }; assert.equal(checker.status, 'awaiting_checker');
    } finally { await link.release(); }
  }
  const read = CoreLink.prototype.read, locatorReads: unknown[] = []; let injected = false, queries = 0;
  t.mock.method(CoreLink.prototype, 'read', async function(this: CoreLink, ...args: Parameters<typeof read>) {
    if (args[1].includes('SELECT id FROM app.runs WHERE id = $1 AND task_id = $2')) locatorReads.push(args[2]?.[0]);
    if (args[2]?.[0] === s.run) {
      queries++;
      if (!injected && args[1].includes('SELECT id FROM app.runs WHERE id = $1 AND task_id = $2')) { injected = true; throw new Error('Controlled discovery failure.'); }
    }
    return read.apply(this, args);
  });
  const host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': piece } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(s.home); });
  await host.call('threads.get', { id: s.threadId }); assert.equal(injected, guard !== 'closed');
  let foreign: { run: string; status: string; fence: string } | undefined;
  if (guard === 'foreign') {
    const link = await CoreLink.open({ home: s.home });
    try {
      const task = await link.createTask('Unrelated task'), { run } = await link.startRun(task);
      assert.ok(run);
      const { rows } = await link.read<{ status: string; fence: string }>(link.system(), 'SELECT status, fence FROM app.runs WHERE id = $1', [run]);
      foreign = { run, status: rows[0].status, fence: rows[0].fence };
      const checkpoint = JSON.parse(readFileSync(s.checkpoint, 'utf8'));
      checkpoint.recoveryOwner = { version: 1, run, thread: s.threadId, turn: s.turnId, project: s.projectId };
      writeFileSync(s.checkpoint, JSON.stringify(checkpoint));
    } finally { await link.release(); }
  }
  const raw = guard === 'damaged' ? '{ externally damaged after discovery failure' : readFileSync(s.checkpoint, 'utf8');
  if (guard === 'damaged') writeFileSync(s.checkpoint, raw);
  await host.resumeInterrupted();
  if (guard === 'close') {
    host.close(); await removeDataHome(s.home); const atClose = queries;
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(existsSync(s.home), false, 'a cancelled retry cannot recreate a removed data home'); assert.equal(queries, atClose);
  } else {
    await new Promise(resolve => setTimeout(resolve, 1_200));
    if (foreign) assert.equal(locatorReads.filter(run => run === foreign.run).length, 1, 'a deterministic foreign-task refusal is not scheduled again');
    const current = await recoverySettled(host, s.threadId);
    if (checker || ['unknown', 'allowed', 'claimed'].includes(guard)) {
      const link = await CoreLink.open({ home: s.home });
      try {
        const { rows } = await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.runs WHERE id = $1', [s.run]);
        assert.ok(['queued', 'running', 'waiting'].includes(rows[0].status), 'automatic recovery must not close the run while an original receipt needs a decision');
        if (checker) assert.equal((await link.effect(checker.id)).status, checker.status, 'automatic recovery must not cancel a checker-held original write');
      } finally { await link.release(); }
    }
    const waitingKind = current.summary.recoveryHold?.kind;
    if (guard === 'allowed' || guard === 'claimed' || guard === 'closed') {
      const link = await CoreLink.open({ home: s.home });
      try {
        const before = (await link.read<{ id: string; status: string }>(link.system(), 'SELECT id, status FROM app.effects WHERE run_id = $1', [s.run])).rows;
        assert.equal(before.length, 1); assert.equal(before[0].status, guard === 'claimed' ? 'claimed' : 'allowed', 'automatic retry preserves the original authorised proposal');
        assert.ok(current.turns[0].recovery);
        const kept = value(await host.call('turns.keepRecovery', { threadId: s.threadId, turnId: s.turnId, revision: current.turns[0].recovery.revision }));
        const after = (await link.read(link.system(), 'SELECT id, status FROM app.effects WHERE run_id = $1', [s.run])).rows;
        assert.equal(kept.cleared, true, `explicit person Keep must end only the unsent original work: ${JSON.stringify({ waitingKind, after, detail: kept.detail })}`);
        assert.equal(waitingKind, guard === 'closed' ? 'inspection' : 'awaiting-decision');
        assert.deepEqual(after, [{ id: before[0].id, status: 'cancelled' }]);
        assert.equal(existsSync(s.checkpoint), false);
        assert.ok(kept.files.length > 0);
        const bodies = await Promise.all(kept.files.map(async file => value(await host.call('material.read', { id: file.materialId })).text));
        assert.ok(bodies.includes(raw), 'the exact checkpoint copy remains accessible');
        const repeated = await host.call('turns.keepRecovery', { threadId: s.threadId, turnId: s.turnId, revision: current.turns[0].recovery.revision });
        assert.ok(!repeated.ok, 'a stale completed action does not create another cancellation or copy');
        assert.deepEqual((await link.read(link.system(), 'SELECT id, status FROM app.effects WHERE run_id = $1', [s.run])).rows, after);
      } finally { await link.release(); }
    } else assert.equal(waitingKind, guard === 'unknown' || checker ? 'awaiting-decision' : 'inspection');
    if (!['allowed', 'claimed', 'closed'].includes(guard)) assert.equal(readFileSync(s.checkpoint, 'utf8'), raw);
    if (foreign) {
      const link = await CoreLink.open({ home: s.home });
      try {
        assert.deepEqual((await link.read(link.system(), 'SELECT status, fence FROM app.runs WHERE id = $1', [foreign.run])).rows, [{ status: foreign.status, fence: foreign.fence }]);
        assert.equal((await link.read(link.system(), 'SELECT id FROM app.runs')).rows.length, 2, 'no replacement run is created');
        assert.equal((await link.read(link.system(), 'SELECT id FROM app.effects')).rows.length, 0, 'no effect is proposed for the foreign locator');
      } finally { await link.release(); }
    }
    if (guard === 'unknown') {
      const link = await CoreLink.open({ home: s.home });
      try {
        const { rows } = await link.read<{ status: string; key: string }>(link.system(), 'SELECT status, idempotency_key AS key FROM app.effects WHERE run_id = $1', [s.run]);
        assert.equal(rows.length, 1); assert.equal(rows[0].status, 'unknown'); assert.equal(rows[0].key, `${s.turnId}:guarded-retry.md`);
        const custody = JSON.parse(readFileSync(join(s.home, 'threads', `${s.threadId}.json`), 'utf8')).writeCustody;
        assert.ok(custody.writes[rows[0].key], 'the original UNKNOWN key stays recorded');
        assert.ok(current.turns[0].recovery);
        const kept = value(await host.call('turns.keepRecovery', { threadId: s.threadId, turnId: s.turnId, revision: current.turns[0].recovery.revision }));
        assert.equal(kept.cleared, false, 'person Keep never converts UNKNOWN into cancellation or success');
        assert.equal((await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.effects WHERE run_id = $1', [s.run])).rows[0].status, 'unknown');
        assert.equal(readFileSync(s.checkpoint, 'utf8'), raw);
      } finally { await link.release(); }
    }
  }
  assert.equal(s.starts(), starts);
});

test('Stop during an automatic checkpoint retry is durable before release and never starts another action', { timeout: TEST_HANG_MS }, async t => {
  const s = await pendingNewCheckpoint('stopped-retry.md'), starts = s.starts();
  let release!: () => void, reached!: () => void, injected = false;
  const paused = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { reached = resolve; });
  const read = CoreLink.prototype.read;
  t.mock.method(CoreLink.prototype, 'read', async function(this: CoreLink, ...args: Parameters<typeof read>) {
    if (args[2]?.[0] === s.run) {
      if (!injected && args[1].includes('SELECT id FROM app.runs WHERE id = $1 AND task_id = $2')) { injected = true; throw new Error('Controlled discovery failure.'); }
      if (args[1].includes('SELECT run_id AS run, idempotency_key AS key FROM app.effects WHERE run_id = $1')) { reached(); await paused; }
    }
    return read.apply(this, args);
  });
  let host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  t.after(async () => { release(); host.close(); await CoreLink.whenClosed(s.home); });
  await host.resumeInterrupted(); await ready;
  assert.equal(value(await host.call('threads.get', { id: s.threadId })).summary.running, true);
  // The held Core read owns the home lock. Stop journals immediately, but its acknowledged
  // projection save correctly waits for that lock, so release the read before awaiting the receipt.
  const stopping = host.call('turns.stop', { threadId: s.threadId });
  const stopped = value(await host.call('threads.get', { id: s.threadId })).turns[0].stopRequested;
  const journal = readFileSync(join(s.home, 'thread-journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  release(); assert.equal(value(await stopping).stopped, true);
  assert.equal(stopped, true); assert.ok(journal.some(event => event.kind === 'turn.stop' && event.turnId === s.turnId));

  await waitFor(async()=>{if(!(existsSync(s.checkpoint)))return true;await new Promise(resolve => setTimeout(resolve, 25));
return !(existsSync(s.checkpoint));}, 'recovery checkpoint removal', {diagnostic:()=>`checkpoint present=${existsSync(s.checkpoint)}`});
  assert.equal(existsSync(s.checkpoint), false);
  const thread = await recoverySettled(host, s.threadId); assert.equal(thread.turns[0].stopRequested, true);
  assert.equal(thread.turns[0].effects.some(effect => effect.outcome === 'DONE'), false);
  const link = await CoreLink.open({ home: s.home });
  try { assert.equal((await link.read(link.system(), 'SELECT id FROM app.effects WHERE run_id = $1', [s.run])).rows.length, 0); }
  finally { await link.release(); }
  host.close(); await CoreLink.whenClosed(s.home);
  host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  await host.resumeInterrupted(); assert.equal(value(await host.call('threads.get', { id: s.threadId })).turns[0].stopRequested, true);
  assert.equal(s.starts(), starts);
});

test('an importer failure outside reconciliation does not schedule automatic settlement', { timeout: TEST_HANG_MS }, async t => {
  const s = await pendingNewCheckpoint('importer-error.md'), starts = s.starts();
  const reclaim = CoreLink.prototype.reclaimRun; let claims = 0;
  t.mock.method(CoreLink.prototype, 'reclaimRun', async function(this: CoreLink, ...args: Parameters<typeof reclaim>) {
    if (args[0] === s.run) claims++;
    return reclaim.apply(this, args);
  });
  const host = createHost({ home: s.home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture }, atPoint: point => {
    if (point === 'recovery.ready') throw new Error('Controlled importer failure after reconciliation.');
  } });
  t.after(async () => { host.close(); await CoreLink.whenClosed(s.home); });
  await host.resumeInterrupted(); await recoverySettled(host, s.threadId);
  await new Promise(resolve => setTimeout(resolve, 1_200));
  assert.equal(claims, 1, 'a later importer/model failure must not start an automatic reclaim attempt');
  assert.equal(existsSync(s.checkpoint), true, 'a later importer/model failure is not permission for the metadata-only retry');
  const link = await CoreLink.open({ home: s.home });
  try {
    const { rows } = await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.runs WHERE id = $1', [s.run]);
    assert.equal(rows[0].status, 'running');
  } finally { await link.release(); }
  assert.equal(s.starts(), starts);
});
