// Explicit source paths are logical identity, never a filesystem or instruction-loading grant.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoreLink } from '../src/composition/core.ts';
import { exportHome, importHome, type ImportApi } from '../src/composition/backup.ts';
import { runHarnessTurn } from '../src/composition/harness-turn.ts';
import { hostClosed } from '../src/composition/host.ts';
import type { Turn } from '../src/api.ts';
import { MaterialStore, sourceText } from '../src/stub/material.ts';
import { b64, freshDir, open, value } from './helpers.ts';
import { controlledReadCore, controlledReadHandle, typedMaterialGateway } from './fixtures/typed-material-gateway.ts';

const originals = [
  { path: 'sources/east/terms.json', body: '{"region":"east","days":30}\n', mediaType: 'application/json' },
  { path: 'sources/north/terms.json', body: '{"region":"north","days":45}\n', mediaType: 'application/json' },
  { path: 'tools/company.py', body: 'print("Synthetic source, not a provider call")\n', mediaType: 'application/octet-stream' },
];

test('explicit relative sources retain distinct paths and exact originals without project-folder projection across cold reopen', async () => {
  const s = open();
  const project = value(await s.host.call('projects.create', { name: 'Structured source input', kind: 'folder' }));
  const ids: string[] = [];
  for (const source of originals) {
    const entry = value(await s.host.call('material.attach', {
      projectId: project.id, name: source.path.split('/').at(-1)!, relativePath: source.path,
      base64: b64(source.body), mediaType: source.mediaType,
    }));
    assert.equal(entry.name, source.path);
    assert.equal(entry.class, 'original');
    assert.equal(entry.projection, 'managed');
    assert.deepEqual(entry.source, { kind: 'person', path: source.path });
    assert.equal(entry.current, 1);
    ids.push(entry.id);
    const read = value(await s.host.call('material.read', { id: entry.id }));
    assert.equal(read.text ?? Buffer.from(read.base64!, 'base64').toString(), source.body);
  }
  assert.deepEqual((await s.host.call('material.list', { projectId: project.id })).map(e => e.name).sort(), originals.map(e => e.path).sort());
  const physical = readdirSync(join(s.home, 'projects'), { recursive: true }).map(String);
  assert.ok(!physical.some(name => /(?:terms\.json|company\.py|sources\/|tools\/)/.test(name)), 'logical sources never appear in the project directory');
  s.host.close(); await CoreLink.whenClosed(s.home); await hostClosed(s.home);
  const cold = open(s.home, { readOnly: true });
  for (const [i, id] of ids.entries()) {
    const read = value(await cold.host.call('material.read', { id }));
    assert.equal(read.entry.name, originals[i].path);
    assert.equal(read.entry.class, 'original');
    assert.equal(read.entry.current, 1);
    assert.equal(read.text ?? Buffer.from(read.base64!, 'base64').toString(), originals[i].body);
  }
});

test('explicit path replay reuses only the same original and refuses changed bytes or namespace aliases without silent renaming', async () => {
  const { host } = open();
  const project = value(await host.call('projects.create', { name: 'Source identity replay', kind: 'folder' }));
  const input = { projectId: project.id, name: 'terms.json', relativePath: 'sources/east/terms.json', base64: b64('first'), mediaType: 'application/json' };
  const first = value(await host.call('material.attach', input));
  const replay = value(await host.call('material.attach', input));
  assert.equal(replay.id, first.id, 'an identical explicit source retry has one durable identity');
  for (const change of [
    { base64: b64('changed') }, { mediaType: 'text/plain' },
    { relativePath: 'Sources/east/other.json' }, { relativePath: 'sources/east/Terms.json' },
    { relativePath: 'sources/east/terms.json/child.json' }, { relativePath: 'sources/east' },
  ]) {
    const result = await host.call('material.attach', { ...input, ...change });
    assert.equal(result.ok, false, JSON.stringify(change));
  }
  const entries = await host.call('material.list', { projectId: project.id, includeHidden: true });
  assert.deepEqual(entries.map(e => e.id), [first.id]);
  assert.equal(value(await host.call('material.read', { id: first.id })).text, 'first');
});

test('explicit source paths reject traversal and aliases while ordinary names keep their existing basename behavior', async () => {
  const { host, home } = open();
  const project = value(await host.call('projects.create', { name: 'Source input validation', kind: 'folder' }));
  for (const relativePath of ['', '../outside.md', '/outside.md', 'x/../../outside.md', 'x//outside.md', 'x/./outside.md', 'x\\outside.md', 'C:/outside.md', 'x/trailing.', 'x/\ud800.md', 'x/e\u0301.md', 'x/\u200Bhidden.md', 'x/\u202Ename.md', 'x/\u0085name.md', 'x/\u2028name.md']) {
    const result = await host.call('material.attach', { projectId: project.id, name: 'source.md', relativePath, base64: b64('Synthetic data'), mediaType: 'text/markdown' });
    assert.equal(result.ok, false, relativePath);
  }
  assert.equal((await host.call('material.list', { projectId: project.id, includeHidden: true })).length, 0);
  for (const relativePath of ['.github/workflows/ci.yml', 'AGENTS.md', 'docs/CLAUDE.md', 'docs/AGENTS.override.md', 'docs/.codex/config.toml']) {
    const entry = value(await host.call('material.attach', { projectId: project.id, name: relativePath, relativePath, base64: b64('Inspectable data only'), mediaType: 'text/plain' }));
    assert.equal(entry.projection, 'managed'); assert.equal(entry.name, relativePath);
    assert.equal(value(await host.call('material.read', { id: entry.id })).text, 'Inspectable data only');
  }
  const physical = readdirSync(join(home, 'projects'), { recursive: true }).map(String);
  assert.ok(!physical.some(name => /(?:^|[\\/])(?:AGENTS(?:\.override)?\.md|CLAUDE\.md|\.codex|\.github)(?:[\\/]|$)/.test(name)), 'instruction-like logical sources never become project configuration files');
  const legacy = value(await host.call('material.attach', { projectId: project.id, name: 'folder/legacy.md', base64: b64('Ordinary attachment'), mediaType: 'text/markdown' }));
  assert.equal(legacy.name, 'legacy.md');
  assert.equal(legacy.projection, undefined);
});

test('introduced and restored managed originals never assert word authorship while connector origin takes precedence', async () => {
  const home = freshDir('structured-source-read-'), projectId = 'project';
  const material = new MaterialStore(home, {}, () => {});
  const person = value(material.attachSource(projectId, 'docs/source.md', 'text/markdown', Buffer.from('Person-supplied data')));
  assert.deepEqual(person.source, { kind: 'person', path: 'docs/source.md' });
  const legacy = material.create(projectId, 'legacy.md', 'text/markdown', Buffer.from('Legacy data'), 'original', 'person', undefined, 'managed');
  const connector = material.create(projectId, 'connector.md', 'text/markdown', Buffer.from('Server data'), 'original', 'person', undefined, 'managed', undefined, { connection: 'synthetic-connection', tool: 'lookup' });
  // Recording port, not a real Core outcome. The actual Host assignment is covered above.
  const {link,records}=controlledReadCore(home);
  const {gateway}=typedMaterialGateway({home,link,handle:controlledReadHandle,projectId,material,turnId:'port-control',threadId:'port-control'});
  const identity=(entry:typeof person)=>({materialId:entry.id,name:entry.name,version:entry.current,withdrawals:entry.withdrawals?.length??0,profile:'harness' as const});
  await gateway.read(identity(person));
  await gateway.read(identity(legacy));
  const contradictoryCaller={...identity(connector),source:{kind:'person',path:connector.name}};
  await gateway.read(contradictoryCaller);
  const restoredPerson = value(await material.importDocument(projectId, 'restored/person.md', 'text/markdown', ['Archive data'], { projection: 'managed', original: true, source: { kind: 'person', path: 'restored/person.md' } }));
  const restoredConnector = value(await material.importDocument(projectId, 'restored/connector.md', 'text/markdown', ['Archived server answer'], { projection: 'managed', original: true }));
  await gateway.read(identity(restoredPerson));
  await gateway.read(identity(restoredConnector));
  assert.deepEqual(records.map(record=>record.sourceKind==='mcp'?['server',record.connection,record.tool]:['file',record.authoredBy]), [['file', null], ['file', null], ['server', 'synthetic-connection', 'lookup'], ['file', null], ['file', null]]);
  assert.equal(records[2].authoredBy,null,'caller labels cannot turn server words into person authorship');
  const recovery=material.create(projectId,'Recovery.md','text/markdown',Buffer.from('Recovery data'),'working','agent',undefined,'managed',undefined,undefined,{turnId:'pending',reason:'inspection only'});
  await assert.rejects(() => gateway.read(identity(recovery)), /unavailable/);
  assert.equal(records.length, 5, 'the recovery-copy refusal precedes every origin path');
});

test('unknown-MIME explicit UTF-8 sources are read exactly while binary and ordinary unknown formats keep their honest placeholder', async () => {
  const home = freshDir('structured-source-text-'), projectId = 'project';
  const material = new MaterialStore(home, {}, () => {}), reads = new Map<string, string>();
  const source = 'print("Exact UTF-8 source")\n';
  for (const [path, bytes] of [
    ['tools/company.py', Buffer.from(source)], ['tools/binary.dat', Buffer.from([65, 0, 66])], ['tools/invalid.dat', Buffer.from([0xc3, 0x28])],
  ] as const) value(material.attachSource(projectId, path, 'application/octet-stream', bytes));
  material.create(projectId, 'legacy.py', 'application/octet-stream', Buffer.from(source), 'original', 'person');
  const turn: Turn = { id: 'text-port-control', side: false, user: { text: 'Read source data without a model', attachments: [], at: '' }, work: { startedAt: '', harness: 'recording', steps: [] }, effects: [], status: 'running' };
  const {link}=controlledReadCore(home);
  const {gateway}=typedMaterialGateway({home,link,handle:controlledReadHandle,material,projectId,threadId:'text-port-control',turnId:turn.id});
  await runHarnessTurn({
    material, projectId, threadId: 'text-port-control', gateway,
    signal: new AbortController().signal, writeDelayMs: 0, readOnly: true, history: [], resumed: false, progress() {},
    route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'recording', label: 'recording', credential: null }, credential: async () => { throw new Error('No credential'); },
    harness: { specificationVersion: 'v1', id: 'recording', label: 'No-model source read', start(_request, { tools }) {
      const outcome = (async () => { for (const file of await tools.list()) reads.set(file.name, (await tools.read(file.name))!.text); return { status: 'done' as const, answer: 'Read control complete', usage: { input: 0, output: 0 } }; })();
      return { outcome, events: (async function* () {})(), stop() {}, steer() {} };
    } },
  }, turn, []);
  assert.equal(reads.get('tools/company.py'), source);
  for (const name of ['tools/binary.dat', 'tools/invalid.dat', 'legacy.py']) assert.match(reads.get(name)!, /this format is not read as text yet/, name);
  assert.equal(turn.effects.length, 0);
});

test('structured export declares a new layout before a legacy reader could silently flatten it', async () => {
  const root = freshDir('structured-layout-'), home = join(root, 'source'), material = new MaterialStore(home, {}, () => {});
  value(material.attachSource('project', 'docs/source.md', 'text/markdown', Buffer.from('Explicit original')));
  const exported = await exportHome({ home, projects: [{ id: 'project', name: 'Source layout', kind: 'folder' }], documents: id => material.list(id, true), versionPath: (id, version) => join(home, 'material', id, 'versions', String(version)), threads: [], async receipts() { return []; }, async secrets() { return []; } }, { to: join(root, 'export') });
  const manifest = JSON.parse(readFileSync(join(exported.folder, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 4, 'version 3 readers must refuse before dropping the new source identity');
  const metaPath = Object.keys(manifest.files).find(path => /documents\/d\d+\/meta.json$/.test(path))!;
  const meta = JSON.parse(readFileSync(join(exported.folder, metaPath), 'utf8'));
  assert.equal(meta.projection, 'managed');
  assert.deepEqual(meta.source, { kind: 'person', path: 'docs/source.md' });
});

test('legacy-valid ordinary names stay exportable when a home also holds managed material', async () => {
  const root = freshDir('structured-legacy-names-'), home = join(root, 'source'), material = new MaterialStore(home, {}, () => {});
  for (const name of ['Report.md', 'report.md', 'direction-\u200e.md', 'emoji-👩‍💻.md', 'section/report.md']) material.create('project', name, 'text/markdown', Buffer.from(name), 'original', 'person');
  material.create('project', 'From server.md', 'text/markdown', Buffer.from('Connector answer'), 'original', 'person', undefined, 'managed', undefined, { connection: 'old-connection', tool: 'lookup' });
  for (const name of ['Answer.md', 'answer.md']) material.create('project', name, 'text/markdown', Buffer.from(name), 'working', 'agent', undefined, 'managed');
  const exported = await exportHome({ home, projects: [{ id: 'project', name: 'Legacy names', kind: 'folder' }], documents: id => material.list(id, true), versionPath: (id, n) => join(home, 'material', id, 'versions', String(n)), threads: [], async receipts() { return []; }, async secrets() { return []; } }, { to: join(root, 'export') });
  assert.equal(exported.counts.documents, 8);
  assert.equal(JSON.parse(readFileSync(join(exported.folder, 'manifest.json'), 'utf8')).version, 4);
});

test('managed restore syntax is checked again at the store commit boundary', async () => {
  const material = new MaterialStore(freshDir('structured-store-names-'), {}, () => {});
  for (const name of ['../x.md', '/x.md', 'a//b.md', '.codex/x', 'x/trailing.', 'C:\\x', 'x/' + 'a'.repeat(501), 'x/e\u0301.md']) {
    const result = await material.importDocument('project', name, 'text/markdown', [Buffer.from('Data')], { projection: 'managed', original: false });
    assert.equal(result.ok, false, name);
  }
  assert.equal(material.list('project', true).length, 0);
});

test('structured originals and managed version history survive actual export, fresh-home restore and cold reopen', async () => {
  const source = open();
  const project = value(await source.host.call('projects.create', { name: 'Source restore', kind: 'folder' }));
  for (const entry of originals) value(await source.host.call('material.attach', { projectId: project.id, name: entry.path.split('/').at(-1)!, relativePath: entry.path, base64: b64(entry.body), mediaType: entry.mediaType }));
  const store = new MaterialStore(source.home, {}, () => {});
  const working = store.create(project.id, 'reports/answer.md', 'text/markdown', Buffer.from('First version'), 'working', 'agent', undefined, 'managed');
  value(await store.save(working.id, 'Second version', 1, 'agent'));
  for (const name of ['Report.md', 'report.md', 'direction-\u200e.md', 'emoji-👩‍💻.md', 'legacy/reports']) store.create(project.id, name, 'text/markdown', Buffer.from(name), 'original', 'person');
  const exported = value(await source.host.call('backup.export', { to: join(freshDir('structured-restored-'), 'export') }));
  const restored = open();
  await restored.host.importExport(exported.folder);
  const target = (await restored.host.call('projects.list', {})).find(p => p.name === project.name)!;
  assert.ok(target);
  const entries = await restored.host.call('material.list', { projectId: target.id });
  for (const original of originals) {
    const entry = entries.find(e => e.name === original.path);
    assert.ok(entry, original.path);
    assert.equal(entry.class, 'original');
    assert.equal(entry.projection, 'managed');
    assert.deepEqual(entry.source, { kind: 'person', path: original.path });
    assert.equal(entry.restored, true);
    const read = value(await restored.host.call('material.read', { id: entry.id }));
    assert.equal(read.text ?? Buffer.from(read.base64!, 'base64').toString(), original.body);
  }
  const history = entries.find(e => e.name === 'reports/answer.md');
  assert.ok(history);
  assert.equal(history.projection, 'managed');
  assert.equal(history.current, 2);
  assert.deepEqual(history.versions.map(v => v.by), ['agent', 'agent']);
  assert.equal(history.restored, true);
  assert.equal(value(await restored.host.call('material.read', { id: history.id, version: 1 })).text, 'First version');
  assert.equal(value(await restored.host.call('material.read', { id: history.id, version: 2 })).text, 'Second version');
  for (const body of ['Report.md', 'report.md', 'direction-\u200e.md', 'emoji-👩‍💻.md', 'legacy/reports']) {
    const found = await Promise.all(entries.map(entry => restored.host.call('material.read', { id: entry.id })));
    assert.ok(found.some(read => read.ok && read.value.text === body), body);
  }
  restored.host.close(); await CoreLink.whenClosed(restored.home); await hostClosed(restored.home);
  const cold = open(restored.home, { readOnly: true });
  assert.deepEqual((await cold.host.call('material.list', { projectId: target.id })).map(e => [e.name, e.current]).sort(), entries.map(e => [e.name, e.current]).sort());
  for (const entry of entries) assert.equal(value(await cold.host.call('material.read', { id: entry.id })).entry.projection, entry.projection);
});

test('v4 restore checks source identities and the complete namespace before its first mutation', async () => {
  const root = freshDir('structured-admission-'), home = join(root, 'source'), material = new MaterialStore(home, {}, () => {});
  value(material.attachSource('project', 'docs/first.md', 'text/markdown', Buffer.from('First original')));
  value(material.attachSource('project', 'docs/second.md', 'text/markdown', Buffer.from('Second original')));
  const exported = await exportHome({ home, projects: [{ id: 'project', name: 'Admission control', kind: 'folder' }], documents: id => material.list(id, true), versionPath: (id, n) => join(home, 'material', id, 'versions', String(n)), threads: [], async receipts() { return []; }, async secrets() { return []; } }, { to: join(root, 'export') });
  const failures: string[] = [];
  const unsafeManaged: Record<string, string> = { 'managed-parent': '../x.md', 'managed-absolute': '/x.md', 'managed-empty-segment': 'a//b.md', 'managed-config': '.codex/x', 'managed-long': 'x/' + 'a'.repeat(501), 'managed-decomposed': 'x/e\u0301.md' };
  const expectedErrors: Record<string, RegExp> = {
    'false-source': /invalid person-source identity/, 'unknown-origin': /invalid person-source identity/,
    'mismatched-path': /invalid person-source identity/, 'agent-original': /invalid person-source identity/,
    'bad-projection': /unsupported document layout/, 'version-gap': /contiguous current versions/,
    'case-alias': /managed document namespace/i, 'file-parent': /managed document namespace/i,
    'hidden-projected-name': /invalid ordinary document name/, 'server-origin': /invalid server origin for restore/, 'multiple-original-versions': /original.*one version/i,
  };
  for (const corruption of [...Object.keys(expectedErrors), ...Object.keys(unsafeManaged)]) {
    const folder = join(root, corruption); cpSync(exported.folder, folder, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
    const paths = Object.keys(manifest.files).filter(path => /documents\/d\d+\/meta.json$/.test(path)).sort();
    const first = JSON.parse(readFileSync(join(folder, paths[0]), 'utf8'));
    const meta = JSON.parse(readFileSync(join(folder, paths[1]), 'utf8'));
    if (corruption === 'false-source') meta.source = false;
    if (corruption === 'unknown-origin') meta.source.kind = 'unknown';
    if (corruption === 'mismatched-path') meta.source.path = 'docs/another.md';
    if (corruption === 'agent-original') meta.versions[0].by = 'agent';
    if (corruption === 'bad-projection') meta.projection = 'physical';
    if (corruption === 'version-gap') meta.versions[0].n = 2;
    if (corruption === 'case-alias') meta.source.path = meta.name = first.name.toUpperCase();
    if (corruption === 'file-parent') meta.source.path = meta.name = first.name + '/child.md';
    if (corruption === 'hidden-projected-name') { delete meta.source; delete meta.projection; meta.name = '.hidden'; }
    if (corruption === 'server-origin') meta.fromServer = { connection: 'old-home-connection', tool: 'lookup' };
    if (corruption in unsafeManaged) { delete meta.source; meta.class = 'working'; meta.name = unsafeManaged[corruption]; }
    if (corruption === 'multiple-original-versions') {
      delete meta.source; meta.current = 2;
      meta.versions.push({ ...meta.versions[0], n: 2, file: 'v2' });
      const rel = paths[1].replace('meta.json', 'v2'), data = Buffer.from('Second alleged original');
      writeFileSync(join(folder, rel), data); manifest.files[rel] = createHash('sha256').update(data).digest('hex');
    }
    const bytes = Buffer.from(JSON.stringify(meta)); writeFileSync(join(folder, paths[1]), bytes);
    manifest.files[paths[1]] = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest));
    let writes = 0;
    const api = {
      async call(method: string) {
        if (method === 'projects.list' || method === 'threads.list') return [];
        if (method === 'memory.get') return { entries: [], instructions: { person: '' } };
        writes++; throw new Error('Unexpected mutation ' + method);
      },
      hasSkills: () => false,
    } as unknown as ImportApi;
    try { await importHome({ from: folder, home: join(root, corruption + '-target'), api }); failures.push(corruption + ': accepted'); }
    catch (error) {
      if (writes || !(expectedErrors[corruption] ?? /invalid managed document path/).test(String(error))) failures.push(corruption + ': ' + String(error));
    }
    if (writes) failures.push(corruption + ': mutated before refusal');
  }
  assert.deepEqual(failures, []);
});

// G-F4 replaces the documented temporary refusal with mapped native data inspection.
test('source intake keeps instruction-like originals as logical data without a filesystem grant', () => {
  const material = new MaterialStore(freshDir('structured-native-view-'), {}, () => {});
  for (const path of ['.github/workflows/ci.yml', 'AGENTS.md', 'docs/CLAUDE.md', 'docs/AGENTS.override.md', 'docs/.codex/config.toml']) {
    const entry = value(material.attachSource('project', path, 'text/plain', Buffer.from('Data, never instructions')));
    assert.equal(entry.name, path); assert.equal(entry.class, 'original'); assert.equal(entry.projection, 'managed');
    assert.deepEqual(entry.source, { kind: 'person', path });
    assert.equal(Buffer.from(material.bytes(entry.id, 1)).toString(), 'Data, never instructions');
  }
  assert.equal(material.list('project', true).length, 5);
});

test('explicit octet-stream fallback preserves BOM and exact size bound without widening other MIME decoders', () => {
  const material = new MaterialStore(freshDir('structured-decode-bound-'), {}, () => {});
  const entry = value(material.attachSource('project', 'code/source.py', 'application/octet-stream', Buffer.from('x')));
  assert.equal(sourceText(entry, Buffer.from([0xef, 0xbb, 0xbf, 65])), '\ufeffA');
  assert.equal(sourceText(entry, Buffer.alloc(2_000_000, 65))?.length, 2_000_000);
  assert.equal(sourceText(entry, Buffer.alloc(2_000_001, 65)), undefined);
  assert.equal(sourceText({ ...entry, mediaType: 'application/x-python-code' }, Buffer.from('print(1)')), undefined);
});

test('restored version authors remain historical labels and never grant Core trust', async () => {
  const home = freshDir('structured-restore-labels-'), material = new MaterialStore(home, {}, () => {});
  const entry = value(await material.importDocument('project', 'reports/history.md', 'text/markdown', ['Agent draft', 'Person revision'], { projection: 'managed', original: false, versionAuthors: ['agent', 'person'] }));
  assert.deepEqual(entry.versions.map(v => v.by), ['agent', 'person']);
  assert.equal(entry.restored, true);
  const {link,records}=controlledReadCore(home);
  const {gateway}=typedMaterialGateway({home,link,handle:controlledReadHandle,material,threadId:'restored-labels',turnId:'restored-labels'});
  const identity={materialId:entry.id,name:entry.name,withdrawals:0};
  assert.equal((await gateway.read({...identity,version:2,profile:'harness'})).text,'Person revision');
  assert.equal((await gateway.read({...identity,version:1,profile:'historical-utf8',historical:true})).text,'Agent draft');
  assert.deepEqual(records.map(record=>record.authoredBy), [null, null]);
  assert.equal((await material.importDocument('project', 'reports/invalid.md', 'text/markdown', ['One', 'Two'], { projection: 'managed', original: true, versionAuthors: ['person', 'person'] })).ok, false);
});

test('an export refusal identifies the offending managed document without exposing control characters', async () => {
  for (const name of ['Server answer\nunsafe.md', 'Server ' + 'x'.repeat(1024)]) {
    const root = freshDir('structured-export-diagnostic-'), home = join(root, 'source'), material = new MaterialStore(home, {}, () => {});
    material.create('project', name, 'text/plain', Buffer.from('Synthetic server answer'), 'original', 'person', undefined, 'managed', undefined, { connection: 'synthetic', tool: 'lookup' });
    await assert.rejects(() => exportHome({ home, projects: [{ id: 'project', name: 'Bad label', kind: 'folder' }], documents: id => material.list(id, true), versionPath: (id, n) => join(home, 'material', id, 'versions', String(n)), threads: [], async receipts() { return []; }, async secrets() { return []; } }, { to: join(root, 'export') }), error => {
      assert.ok(error instanceof Error); assert.ok(error.message.includes(JSON.stringify(name)), 'the refusal names the exact offending label safely');
      assert.ok(!error.message.includes('\n'), 'the diagnostic never injects raw line breaks'); return true;
    });
  }
});

test('identical retries never reactivate withdrawn or held source originals', () => {
  const material = new MaterialStore(freshDir('structured-unavailable-replay-'), {}, () => {});
  for (const state of ['withdrawn', 'held'] as const) {
    const path = `sources/${state}.md`, entry = value(material.attachSource('project', path, 'text/markdown', Buffer.from('Original bytes')));
    if (state === 'withdrawn') material.withdraw(entry.id);
    else material.mark(entry.id, { hidden: true, held: { id: 'source', name: 'Withdrawn dependency' } });
    const before = material.load(entry.id);
    const result = material.attachSource('project', path, 'text/markdown', Buffer.from('Original bytes'));
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.reason, 'STALE_BASE');
    assert.deepEqual(material.load(entry.id), before);
    assert.deepEqual(material.list('project', true).filter(e => e.name === path).map(e => e.id), [entry.id]);
  }
});

test('layout-3 restore ignores injected structured and server metadata and retains legacy basename behavior', async () => {
  const root = freshDir('structured-legacy-fields-'), home = join(root, 'source'), material = new MaterialStore(home, {}, () => {});
  value(material.attachSource('project', 'docs/source.md', 'text/markdown', Buffer.from('Legacy source data')));
  const exported = await exportHome({ home, projects: [{ id: 'project', name: 'Legacy fields', kind: 'folder' }], documents: id => material.list(id, true), versionPath: (id, n) => join(home, 'material', id, 'versions', String(n)), threads: [], async receipts() { return []; }, async secrets() { return []; } }, { to: join(root, 'export') });
  const manifestPath = join(exported.folder, 'manifest.json'), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const rel = Object.keys(manifest.files).find(path => /documents.*meta.json$/.test(path))!;
  const meta = JSON.parse(readFileSync(join(exported.folder, rel), 'utf8'));
  meta.source = { kind: 'forged', path: '/outside' }; meta.fromServer = { connection: 'old-authority', tool: 'lookup' }; meta.restored = true;
  const bytes = Buffer.from(JSON.stringify(meta)); writeFileSync(join(exported.folder, rel), bytes);
  manifest.version = 3; manifest.files[rel] = createHash('sha256').update(bytes).digest('hex'); writeFileSync(manifestPath, JSON.stringify(manifest));
  const target = open(); await target.host.importExport(exported.folder);
  const project = (await target.host.call('projects.list', {})).find(p => p.name === 'Legacy fields')!;
  const entries = await target.host.call('material.list', { projectId: project.id }); assert.equal(entries.length, 1);
  const entry = entries[0]; assert.equal(entry.name, 'source.md');
  assert.equal(entry.projection, undefined); assert.equal(entry.source, undefined); assert.equal(entry.fromServer, undefined); assert.equal(entry.restored, undefined);
  assert.equal(value(await target.host.call('material.read', { id: entry.id })).text, 'Legacy source data');
});
