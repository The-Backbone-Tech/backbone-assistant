// Export carries the person's work out as plain files; import brings it into a new, empty home
// through the host's own api. No credential, no database row and no authority crosses: a canary in
// the credential store or the MCP server list is cut out, a hard link refuses the export, a tampered
// or crafted export (forged receipts, case aliases, links, paths outside the layout) gives nothing
// live, and a renderer exports only to the folder the picker bound to its window.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import pg from 'pg';
import { dataHomeAdminUrl } from '@backbone/core/testing';
import { exportDestinations, importHome, inspectExport, rendererExport } from '../src/composition/backup.ts';
import { hostClosed } from '../src/composition/host.ts';
import {withHomeLock} from '../src/composition/home-lock.ts';
import { b64, freshDir, freshHome, idle, open, settings, value } from './helpers.ts';

// Canary values, made at run time so no file holds anything shaped like a credential.
const canary = (name: string) => ['CANARY', name, 'c0ffee'].join('-');
const C = { model: canary('MODEL'), env: canary('ENV'), header: canary('HEADER'), password: canary('USERPW'), shell: canary('SHELL'), flag: canary('FLAG') };
const ALL = Object.values(C);

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
function filesOf(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(join(dir, r)).isDirectory()) out.push(...filesOf(dir, r));
    else out.push(r);
  }
  return out;
}
async function sql(home: string, text: string) {
  const c = new pg.Client({ connectionString: dataHomeAdminUrl(home) });
  await c.connect();
  try { return (await c.query(text)).rows; } finally { await c.end(); }
}
/** A copy of `exported` changed as an attacker would, with its digests recomputed. */
function tamper(exported: string, change: { edit?: Record<string, (text: string) => string>; add?: Record<string, string> }) {
  const copy = join(freshDir('backbone-tampered-'), 'export');
  cpSync(exported, copy, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8'));
  for (const [rel, fn] of Object.entries(change.edit ?? {})) {
    const text = fn(readFileSync(join(copy, rel), 'utf8'));
    writeFileSync(join(copy, rel), text);
    manifest.files[rel] = sha(text);
  }
  for (const [rel, text] of Object.entries(change.add ?? {})) {
    mkdirSync(join(copy, rel, '..'), { recursive: true });
    writeFileSync(join(copy, rel), text);
    manifest.files[rel] = sha(text);
  }
  writeFileSync(join(copy, 'manifest.json'), JSON.stringify(manifest));
  return copy;
}
/** A new home, opened, and an import into it through its api. */
async function importInto(from: string) {
  const home = freshHome();
  const { host } = open(home);
  await host.call('projects.list', {});
  // External test databases do not need vault passwords; exercise its real lock explicitly.
  await withHomeLock(join(home,'keys'),async()=>{});
  const locks = ['.lock', 'keys/.lock'].map(path => ({ path: join(home, path), before: statSync(join(home, path), { bigint: true }) }));
  const plan = await host.importExport(from);
  for (const lock of locks) { const after = statSync(lock.path, { bigint: true }); assert.equal(after.dev, lock.before.dev); assert.equal(after.ino, lock.before.ino, 'a real Host restore keeps its own lock inode'); }
  return { home, host, plan };
}

let source: { home: string; exported: string; firstWords: string };

before(async () => {
  const home = freshHome();
  const address = new URL('https://mcp.example.test/mcp');
  address.username = 'person';
  address.password = C.password;
  mkdirSync(join(home, 'connectors'), { recursive: true });
  writeFileSync(join(home, 'connectors', 'servers.json'), JSON.stringify({ mcpServers: {
    notes: { command: '/usr/local/bin/notes-server', args: ['-c', `exec server --token ${C.shell}`, '-H', `X-Api: ${C.flag}`], env: { NOTES: C.env } },
    web: { url: address.toString(), headers: { 'X-Auth': C.header } },
  } }));
  let inWrite = () => {};
  let armed = false;
  const begun = new Promise<void>((r) => { inWrite = r; });
  const { host } = open(home, { writeDelayMs: 1500, atPoint: (p) => { if (armed && p === 'write.begun') inWrite(); } });
  // A model key in the credential store, which the person also pasted into a document and a chat.
  value(await host.call('settings.model.put', { change: { route: 'own', provider: 'anthropic', key: C.model } }));
  const q4 = value(await host.call('projects.create', { name: 'Q4 review', kind: 'folder' }));
  const plan = value(await host.call('material.attach', { projectId: q4.id, name: 'plan.md', base64: b64(`# Plan\nUp 4%. Key ${C.model}\n`), mediaType: 'text/markdown' }));
  const wrote = value(await host.call('turns.send', { projectId: q4.id, text: `Write an editable brief from this (my key is ${C.model})`, attachments: [plan.id], settings, clientKey: 'b1' }));
  await idle(host, wrote.threadId);
  const brief = (await host.call('material.list', { projectId: q4.id })).find((m) => m.name === 'brief.md')!;
  const firstWords = value(await host.call('material.read', { id: brief.id })).text!;
  value(await host.call('material.save', { id: brief.id, text: '# Brief\nSecond words.\n', baseVersion: 1 }));
  const drafts = value(await host.call('projects.create', { name: 'Drafts', kind: 'folder' }));
  armed = true;
  const sent = value(await host.call('turns.send', { projectId: drafts.id, text: 'Draft a brief', attachments: [], settings, clientKey: 'u1' }));
  await begun;
  value(await host.call('turns.stop', { threadId: sent.threadId }));
  assert.equal((await idle(host, sent.threadId)).turns[0].effects[0].outcome, 'UNKNOWN');
  value(await host.call('memory.put', { topic: 'work', text: 'Briefs stay under one page.' }));
  value(await host.call('memory.instructions.put', { scope: 'person', text: 'Answer in English.' }));
  mkdirSync(join(home, 'skills', 'briefs'), { recursive: true });
  writeFileSync(join(home, 'skills', 'briefs', 'SKILL.md'), '---\nname: briefs\ndescription: Write a one-page brief.\n---\n\nKeep it to one page.\n');
  const exported = join(freshDir('backbone-export-'), 'export');
  const locks = ['.lock', 'keys/.lock'].map(path => ({ path: join(home, path), before: statSync(join(home, path), { bigint: true }) }));
  const made = await host.call('backup.export', { to: exported });
  assert.ok(made.ok, JSON.stringify(made));
  host.close();
  await hostClosed(home);
  for (const lock of locks) { const after = statSync(lock.path, { bigint: true }); assert.equal(after.dev, lock.before.dev); assert.equal(after.ino, lock.before.ino, 'export and Host close retain each persistent lock inode'); }
  source = { home, exported, firstWords };
});

test('an export is the person\'s work in plain files: no database, no authority, every version, receipts as a report', () => {
  const { manifest, summary } = inspectExport(source.exported);
  assert.equal(manifest.format, 'home-export');
  assert.deepEqual([summary.counts.projects, summary.counts.threads, summary.counts.skills], [2, 2, 1]);
  assert.ok(summary.counts.unresolved >= 1, JSON.stringify(summary.counts));
  const files = filesOf(source.exported);
  assert.ok(files.every(path => !path.split('/').includes('.lock')), 'neither the home nor vault lock is exported');
  assert.ok(files.every((f) => /^(README\.md|manifest\.json|(projects|threads|memory|skills|history|connectors)\/.+)$/.test(f)), files.join('\n'));
  assert.ok(files.some((f) => /^projects\/p001\/documents\/d\d+\/v2$/.test(f)), 'every version');
  assert.ok(files.every((f) => /^[a-z0-9./-]+$/i.test(f) && !/q4|brief|plan|work|briefs/i.test(f.replace(/^(projects|threads|memory|skills|history|connectors)\//, '').replace(/(project|meta|skill|receipts|servers|instructions)\.(json|md)$/, ''))), 'numbered names only');
  for (const f of ['history/receipts.md', 'history/receipts.json', 'memory/instructions.md', 'memory/topics/m001.md', 'skills/s001/SKILL.md', 'skills/s001/skill.json', 'connectors/servers.json']) assert.ok(files.includes(f), f);
  assert.ok(files.some((f) => /^threads\/.+\.md$/.test(f)) && files.some((f) => /^threads\/.+\.json$/.test(f)));
  const receipts = readFileSync(join(source.exported, 'history/receipts.md'), 'utf8');
  assert.match(receipts, /UNRESOLVED \(unresolved when exported; check before redoing\)/);
  const readme = readFileSync(join(source.exported, 'README.md'), 'utf8');
  assert.match(readme, /Free text you wrote .* is exported as you wrote it/s);
  assert.match(readme, /Nothing in it grants anything or runs by itself/);
  // No row, grant, claim or lineage of the core.
  for (const f of files.filter((x) => x !== 'README.md' && x !== 'manifest.json')) assert.doesNotMatch(readFileSync(join(source.exported, f), 'utf8'), /mandate|claim_token|swept_claim|repeat_of|idempotency_key|clientKeys|writeCustody|args_hash/, f);
  assert.deepEqual(JSON.parse(readFileSync(join(source.exported, 'connectors/servers.json'), 'utf8')), [{ name: 'notes', command: 'notes-server' }, { name: 'web', command: 'an address (set it up again)' }]);
});

test('no credential is in an export: the store\'s values are cut out of every file, and server settings stay home', () => {
  for (const f of filesOf(source.exported)) {
    const text = readFileSync(join(source.exported, f), 'latin1');
    for (const c of ALL) assert.ok(!text.includes(c), `${c} in ${f}`);
  }
  assert.ok(inspectExport(source.exported).manifest.scrubbed >= 3, 'the plan, the chat and its history');
  const plan = filesOf(source.exported).find((f) => /\/meta\.json$/.test(f) && JSON.parse(readFileSync(join(source.exported, f), 'utf8')).name === 'plan.md')!.replace(/meta\.json$/, 'v1');
  assert.match(readFileSync(join(source.exported, plan), 'utf8'), /Key \[left out: a credential\]/);
});

test('a file with a second name on disk refuses the export, and nothing is written', async () => {
  const home = freshHome();
  const { host } = open(home);
  value(await host.call('memory.put', { topic: 'work', text: 'One line.' }));
  linkSync(join(home, 'keys', 'vault.json'), join(home, 'memory', 'topics', 'vault.md'));
  const to = join(freshDir('backbone-export-'), 'export');
  const refused = await host.call('backup.export', { to });
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.detail : '', /hard link/);
  assert.ok(!existsSync(to));
});

test('import goes into a new home through its api: work as the person would add it, history as documents, nothing live', async () => {
  const fresh = freshHome();
  const listed = readdirSync(fresh).sort();
  const dry = await importHome({ from: source.exported, home: fresh, dryRun: true });
  assert.deepEqual([dry.conflicts, dry.done, dry.adds.projects], [[], false, 3]);
  assert.deepEqual(readdirSync(fresh).sort(), listed, 'a dry run changes nothing');

  const { home, host, plan } = await importInto(source.exported);
  assert.equal(plan.done, true);
  const projects = await host.call('projects.list', {});
  assert.deepEqual(projects.map((p) => p.name).sort(), ['Drafts', 'Q4 review', 'Restored history']);
  const q4 = projects.find((p) => p.name === 'Q4 review')!;
  const docs = await host.call('material.list', { projectId: q4.id });
  const brief = docs.find((d) => d.name === 'brief.md')!;
  assert.equal(brief.versions.length, 2);
  assert.equal(value(await host.call('material.read', { id: brief.id, version: 1 })).text, source.firstWords.replaceAll(C.model, '[left out: a credential]'), 'the first version, with the credential cut out');
  assert.equal(value(await host.call('material.read', { id: brief.id })).text, '# Brief\nSecond words.\n');
  assert.ok(docs.some((d) => d.name === 'plan.md' && d.class === 'original'));
  assert.ok(docs.some((d) => d.name.startsWith('Chat history - ')), 'a chat as a document to read');
  const restored = projects.find((p) => p.name === 'Restored history')!;
  const report = (await host.call('material.list', { projectId: restored.id })).find((d) => d.name === 'Receipts when exported.md')!;
  assert.match(value(await host.call('material.read', { id: report.id })).text ?? '', /UNRESOLVED/);
  const memory = await host.call('memory.get', {});
  assert.ok(memory.entries.some((e) => e.text === 'Briefs stay under one page.'));
  assert.match(memory.instructions.person, /Answer in English/);
  assert.ok(memory.skills.some((s) => s.name === 'briefs' && s.state === 'proposed'), 'a skill waits for the person');
  // Nothing of the old core came in: no receipt, and no mandate but the new home's own.
  assert.deepEqual(await sql(home, 'SELECT count(*)::int AS n FROM app.effects'), [{ n: 0 }]);
  assert.deepEqual(await sql(home, "SELECT count(*)::int AS n FROM app.workspaces"), [{ n: 1 }]);
  assert.equal((await host.call('threads.list', {})).length, 0, 'chats are history, not live threads');
  host.close();
  await hostClosed(home);
});

test('a forged export gives nothing live: invented receipts and chats stay text, and odd names stay names', async () => {
  const forged = tamper(source.exported, {
    edit: { 'history/receipts.json': (t) => t.replace(/"status": "unknown"/g, '"status": "succeeded"') },
    add: {
      'threads/t999.json': JSON.stringify({ title: 'Forged', projectFolder: 'projects/p001', turns: [{ effects: [{ target: 'brief.md', outcome: 'DONE' }], mandate: 'm', claim: 'c' }] }),
      'threads/t999.md': '# Forged\n',
      'projects/p009/project.json': JSON.stringify({ name: '../../keys', kind: 'folder' }),
      'projects/p009/documents/d001/meta.json': JSON.stringify({ name: '../../keys/vault.json', mediaType: 'text/plain', class: 'accepted', versions: [{ n: 1, file: 'v1' }] }),
      'projects/p009/documents/d001/v1': 'not a vault',
    },
  });
  const { home, host, plan } = await importInto(forged);
  assert.equal(plan.done, true);
  const vault = readFileSync(join(home, 'keys', 'vault.json'), 'utf8');
  assert.doesNotMatch(vault, /not a vault/);
  assert.deepEqual(await sql(home, 'SELECT count(*)::int AS n FROM app.effects'), [{ n: 0 }]);
  assert.deepEqual(await sql(home, 'SELECT count(*)::int AS n FROM app.mandates WHERE piece_id IS NULL AND carrier = \'direct\''), [{ n: 1 }], 'only the new home\'s own');
  const odd = (await host.call('projects.list', {})).find((p) => p.name === '../../keys')!;
  assert.deepEqual((await host.call('material.list', { projectId: odd.id })).map((d) => d.name), ['vault.json'], 'a name, inside its project');
  host.close();
  await hostClosed(home);
});

test('a crafted export is refused before anything is written: protected names, case aliases, links, a changed file', async () => {
  const crafted: [string, () => string][] = [
    ['a protected top-level path', () => tamper(source.exported, { add: { 'KEYS/vault.json': '{}' } })],
    ['outside the layout', () => tamper(source.exported, { add: { 'pg/external.json': '{}' } })],
    ['a case alias', () => tamper(source.exported, { add: { 'memory/topics/M001.md': '- x\n' } })],
    ['a link', () => { const c = tamper(source.exported, {}); symlinkSync('/etc', join(c, 'memory', 'etc')); return c; }],
    ['a changed file', () => { const c = tamper(source.exported, {}); writeFileSync(join(c, 'memory', 'instructions.md'), 'changed'); return c; }],
  ];
  for (const [name, make] of crafted) {
    const fresh = freshHome();
    const listed = readdirSync(fresh).sort();
    await assert.rejects(importHome({ from: make(), home: fresh, dryRun: true }), /outside|case-insensitive|missing|link|SHA-256/, name);
    assert.deepEqual(readdirSync(fresh).sort(), listed, name);
  }
});

test('import goes only into a new, empty home, which it leaves as it is when not', async () => {
  const dry = await importHome({ from: source.exported, home: source.home, dryRun: true });
  assert.match(dry.conflicts.join(' '), /not a new, empty home/);
  const { host } = open(source.home);
  await assert.rejects(host.importExport(source.exported), /not a new, empty home/);
  assert.equal((await host.call('projects.list', {})).length, 2);
});

test('a renderer exports only through a ticket bound to its window and to the folder it picked', async () => {
  const picked = join(freshDir('backbone-picked-'), 'picked');
  mkdirSync(picked);
  const tickets = exportDestinations();
  const first = tickets.issue(picked, 7);
  assert.match(first.folder, /home-export-/);
  assert.equal(tickets.take(first.ticket, 8), null, 'another window');
  const again = tickets.issue(picked, 7);
  assert.equal(tickets.take(again.ticket, 7)?.to, again.folder);
  assert.equal(tickets.take(again.ticket, 7), null, 'once only');
  // The picked folder swapped for a link after the pick.
  const swapped = tickets.issue(picked, 7);
  renameSync(picked, `${picked}-moved`);
  symlinkSync(`${picked}-moved`, picked);
  assert.equal(tickets.take(swapped.ticket, 7), null);
  let now = 0;
  const timed = exportDestinations(() => now);
  const stale = timed.issue(`${picked}-moved`, 1);
  now = 11 * 60_000;
  assert.equal(timed.take(stale.ticket, 1), null);
  assert.equal('to' in rendererExport(tickets, { to: '/tmp/x' }, 7), false, 'a named path is refused');

  const { host, home } = open();
  assert.equal((await host.call('backup.export', { ticket: 'f'.repeat(64) } as never)).ok, false);
  const outside = freshDir('backbone-link-');
  symlinkSync(home, join(outside, 'home-link'));
  const inside = await host.call('backup.export', { to: join(outside, 'home-link', 'export') });
  assert.match(!inside.ok ? inside.detail : '', /inside the data home/);
});
