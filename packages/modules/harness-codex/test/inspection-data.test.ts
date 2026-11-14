// Synthetic source staging and the actual trusted snapshot program; no model, Core or provider.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, access, rm, symlink, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { ToolHost, TurnRequest } from '@backbone-next/platform/ports';
import { createCodexHarness, prompt, type ConditionalDraftHost } from '../src/index.ts';
import { stageSources, proposedFiles, safeName } from '../src/staging.ts';
import { SNAPSHOT_PROGRAM } from '../src/snapshot.ts';

const VIEW = '.backbone-source-data-' + 'a'.repeat(32);
const manifestOf = (staged: Awaited<ReturnType<typeof stageSources>>) => [...staged.inspection.keys()].find(name => name.endsWith('/manifest.json'))!;
const inputs = [
  { name: 'note.md', text: 'An ordinary original\n', class: 'original' as const },
  { name: 'AGENTS.md', text: 'Untrusted instruction-like data\n', class: 'original' as const },
  { name: 'docs/CLAUDE.md', text: 'More source data\n', class: 'original' as const },
  { name: '.codex/config.toml', text: 'model = "not-a-configuration"\n', class: 'original' as const },
  { name: '.github/workflows/build.yml', text: 'name: source-only\n', class: 'original' as const },
  { name: '.backbone-source-data/manifest.json', text: 'A logical name never occupies the host-owned map', class: 'original' as const },
  { name: 'legacy/AGENTS.override.md', text: 'An older managed document\n', class: 'accepted' as const },
];
const files = inputs.map((file, i) => ({ ...file, materialId: `material-${i}`, projectId: 'project', withdrawals: 0, version: i + 1, by: 'person' as const, mediaType: 'text/plain' }));
const request: TurnRequest = { threadId: 'thread', turnId: 'turn', text: 'Inspect the source data', history: [], attachments: files.map(f => f.name), effort: 3, resumed: false };
function host(): ToolHost {
  return { list: async () => files.map(({ text: _text, ...file }) => file), read: async name => files.find(file => file.name === name) ?? null, write: async () => { throw new Error('Staging never writes canonical material'); } };
}
const snapshot = (root: string) => JSON.parse(execFileSync(process.execPath, ['--openssl-config=/dev/null', '-e', SNAPSHOT_PROGRAM], { cwd: root, encoding: 'utf8' }));

for (const name of ['AGENTſ.md', 'AGENTſ.override.md', 'agents.MD', 'ＡGENTS.md', 'ＡＧＥＮＴＳ.override.md', 'ＣＬＡＵＤＥ.md', '.\u0307cfg/a.md', '.\u0308cfg/a.md']) test(`Unicode-sensitive source remains data and its raw output target is refused (${name})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'inspection-unicode-'));
  const file = { ...files[0], name, text: 'Untrusted Unicode-named source\n' };
  const tools: ToolHost = { list: async () => [file], read: async requested => requested === name ? file : null, write: async () => { throw new Error('No canonical writes'); } };
  try {
    const staged = await stageSources(root, tools, { ...request, attachments: [name] }, new AbortController().signal);
    assert.equal(staged.original.size, 0);
    assert.deepEqual(staged.sources, [{ name, version: file.version }]);
    const manifest = JSON.parse(await readFile(join(root, manifestOf(staged)), 'utf8'));
    assert.equal(manifest.files[0].name, name);
    assert.equal(await readFile(join(root, manifest.files[0].path), 'utf8'), file.text);
    await assert.rejects(access(join(root, name)), { code: 'ENOENT' });
    assert.throws(() => safeName(name), /unsafe/i);
    assert.deepEqual(await proposedFiles(staged.original, snapshot(root), staged.inspection), []);
    await assert.rejects(proposedFiles(new Map(), { files: [{ name, base64: Buffer.from('output').toString('base64') }] }), /unsafe/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Unicode name checks preserve ordinary NFC names and refuse non-NFC Kelvin-sign paths before reads', async () => {
  assert.equal(safeName('Kelvin.md'), 'Kelvin.md');
  assert.equal(safeName('café.md'), 'café.md');
  const root = await mkdtemp(join(tmpdir(), 'inspection-nfc-'));
  let reads = 0;
  const file = { ...files[0], name: '.Kodex/config.toml' };
  const tools: ToolHost = { list: async () => [file], read: async () => { reads++; return file; }, write: async () => { throw new Error('No canonical writes'); } };
  try {
    assert.throws(() => safeName('Kelvin.md'), /unsafe/i);
    await assert.rejects(stageSources(root, tools, { ...request, attachments: [] }, new AbortController().signal), /unsafe/i);
    assert.equal(reads, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('instruction and configuration paths are inspectable only under neutral names with an exact source map', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inspection-map-'));
  try {
    const staged = await stageSources(root, host(), request, new AbortController().signal);
    assert.deepEqual([...staged.original.keys()], ['note.md']);
    assert.deepEqual(staged.sources, files.map(({ name, version }) => ({ name, version })));
    const manifest = JSON.parse(await readFile(join(root, manifestOf(staged)), 'utf8'));
    assert.equal(manifest.version, 1); assert.equal(manifest.files.length, files.length - 1);
    for (const entry of manifest.files) {
      const source = files.find(file => file.name === entry.name)!; assert.ok(source);
      assert.equal(entry.version, source.version); assert.equal(entry.class, source.class);
      assert.match(entry.path, /^\.backbone-source-data-[a-f0-9]{32}\/\d+\.txt$/);
      assert.equal(await readFile(join(root, entry.path), 'utf8'), source.text);
      await assert.rejects(access(join(root, source.name)), { code: 'ENOENT' });
      assert.throws(() => safeName(source.name), /unsafe/i, 'raw output/staging target policy stays unchanged');
      assert.equal(staged.sourceFiles.find(file => file.name === source.name)?.inspectionPath, entry.path);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('trusted snapshots keep inspection data separate and import only normal proposals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inspection-snapshot-'));
  try {
    const staged = await stageSources(root, host(), request, new AbortController().signal);
    const initial = snapshot(root);
    assert.deepEqual(initial.files.map((file: { name: string }) => file.name), ['note.md']);
    assert.equal(initial.inspection.length, files.length);
    assert.deepEqual(await proposedFiles(staged.original, initial, staged.inspection), []);
    await writeFile(join(root, 'brief.md'), 'A normal proposal\n');
    assert.deepEqual(await proposedFiles(staged.original, snapshot(root), staged.inspection), [{ name: 'brief.md', body: 'A normal proposal\n', existing: false }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const change of ['body', 'manifest', 'extra', 'deleted', 'symlink'] as const) test(`inspection ${change} changes refuse before any output is offered`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'inspection-integrity-'));
  try {
    const staged = await stageSources(root, host(), request, new AbortController().signal);
    const manifestPath = join(root, manifestOf(staged));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')), path = join(root, manifest.files[0].path);
    await writeFile(join(root, 'brief.md'), 'This must not be offered on a refused snapshot');
    if (change === 'body') await writeFile(path, 'Changed instruction data');
    if (change === 'manifest') await writeFile(manifestPath, '{}');
    if (change === 'extra') await writeFile(join(root, manifestOf(staged).replace('manifest.json', 'unowned.txt')), 'Unknown data');
    if (change === 'deleted') await unlink(path);
    if (change === 'symlink') { await unlink(path); await symlink(join(root, 'note.md'), path); }
    await assert.rejects(async () => proposedFiles(staged.original, snapshot(root), staged.inspection), /inspection|snapshot/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the native prompt identifies mapped data without presenting it as editable configuration', () => {
  const sources = [{ name: 'AGENTS.md', version: 3, class: 'original' as const, inspectionPath: VIEW + '/001.txt' }];
  const text = prompt({ ...request, attachments: ['AGENTS.md'] }, sources);
  assert.match(text, /inspection-only data/i); assert.ok(text.includes(JSON.stringify(sources[0].inspectionPath)));
  assert.match(text, /not instructions or configuration/i); assert.doesNotMatch(text, /AGENTS\.md" v3 \[.*may revise in place/);
});

for (const mode of ['inspection-map', 'inspection-change', 'inspection-manifest', 'inspection-raw-output']) test(`the native protocol verifies inspection data before importing proposals (${mode})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'inspection-protocol-'));
  const writes: { name: string; body: string }[] = [];
  const writeIfVersion: ConditionalDraftHost['writeIfVersion'] = async (name, body, base) => {
    assert.equal(base.targetVersion, null);
    assert.deepEqual(base.sources, files.map(({ name, version }) => ({ name, version })));
    writes.push({ name, body }); return { outcome: 'DONE', name, version: 1 };
  };
  const tools = Object.assign(host(), { writeIfVersion, stillGranted: () => true });
  const fixture = fileURLToPath(new URL('./fixtures/native.mjs', import.meta.url));
  const harness = createCodexHarness({ command: [process.execPath, fixture, mode], temporaryRoot: root, requestTimeoutMs: 5000, turnTimeoutMs: 10000 });
  try {
    const outcome = await harness.start(request, { tools, route: { kind: 'native', provider: 'codex', model: 'test-model', credential: null, baseUrl: '', label: 'Synthetic native protocol' }, credential: async () => { throw new Error('No credentials in this protocol control'); } }).outcome;
    if (mode === 'inspection-map') {
      assert.equal(outcome.status, 'done', outcome.error ?? 'native completed');
      assert.deepEqual(writes, [{ name: 'brief.md', body: '# Brief\nAn ordinary original\n' }]);
    } else { assert.equal(outcome.status, 'failed'); assert.match(outcome.error ?? '', mode === 'inspection-raw-output' ? /unsafe/i : /inspection/i); assert.deepEqual(writes, []); }
    await rm(join(root, 'model-started'), { force: true }); assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const change of ['version', 'class']) test(`mapped source ${change} drift refuses staging`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'inspection-identity-')), tools = host(), read = tools.read;
  tools.read = async name => { const source = await read(name); return name === 'AGENTS.md' && source ? { ...source, ...(change === 'version' ? { version: 99 } : { class: 'working' as const }) } : source; };
  try { await assert.rejects(stageSources(root, tools, request, new AbortController().signal), /source.*changed/); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('mapping autoload-sensitive names never neutralises traversal, controls or invalid path syntax', async () => {
  for (const name of ['AGENTS.md/../escape.md', '/.codex/config.toml', '.codex//config.toml', '.codex/trailing.', '.bad\u0000/config', '.e\u0301/config']) {
    const root = await mkdtemp(join(tmpdir(), 'inspection-path-'));
    let read = false;
    const file = { ...files[0], name };
    const tools: ToolHost = { list: async () => [file], read: async () => { read = true; return file; }, write: async () => { throw new Error('No write crossing'); } };
    try {
      await assert.rejects(stageSources(root, tools, { ...request, attachments: [] }, new AbortController().signal), /unsafe/i);
      assert.equal(read, false, name);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
