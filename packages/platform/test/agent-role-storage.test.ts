import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMemory, type MemoryDeps } from '../src/composition/memory.ts';
import { assertHomeWriteAdmission, withHomeLock } from '../src/composition/home-lock.ts';
import { readAgentRoles, saveAgentRole } from '../src/memory/agent-roles.ts';
import { acceptDraft, draftSkill } from '../src/memory/imports.ts';
import { freshHome, value } from './helpers.ts';
const definition = (name = 'researcher', body = 'Find dates.') => `---\nname: ${name}\ndescription: Find evidence\ntools: [Read]\n---\n${body}\n`;
const write = (home: string, fn: () => void) => withHomeLock(home, async () => { assertHomeWriteAdmission(home, home); fn(); });
async function skill(home: string) {
  await write(home, () => {
    const draft = draftSkill(home, { threadId: 'thread', title: 'Agents', request: 'Find evidence', steps: [], answer: 'Done', sources: [{ id: 'source', name: 'source.md', version: 1 }] }, []);
    assert.equal(draft.name, 'agents'); acceptDraft(home, draft.name);
  });
}
async function memory(home: string, withdrawn = false) {
  return withHomeLock(home, async () => createMemory({ home, threads: new Map(), projectExists: () => false, emit() {}, credentials: async () => [], now: () => Date.now() + 32 * 86400000,
    locked: <T>(fn: () => Promise<T>) => withHomeLock(home, fn), material: { load: () => withdrawn ? { withdrawals: [{}] } : undefined },
  } as unknown as MemoryDeps));
}
test('an Agents skill can be withdrawn without removing a separately saved role', async () => {
  const home = freshHome(); await skill(home);
  await write(home, () => { saveAgentRole(home, 'researcher', definition(), null, []); });
  const mem = await memory(home, true);
  await withHomeLock(home, async () => mem.purgeSource('source'));
  assert.equal(existsSync(join(home, 'skills', 'agents')), false);
  assert.equal(readAgentRoles(home, [])[0]?.name, 'researcher');
  assert.equal(readFileSync(join(home, '.agent-roles', 'researcher.md'), 'utf8'), definition());
});
for (const action of ['purge', 'archive'] as const) test(`explicitly adopted legacy roles survive the Agents skill's ${action}`, async () => {
  const home = freshHome(); await skill(home);
  const legacy = join(home, 'skills', 'agents', 'researcher.md');
  await write(home, () => writeFileSync(legacy, definition()));
  const mem = await memory(home, action === 'purge');
  const adopted = await mem.handlers['agents.save']({ name: 'researcher', markdown: definition(), base: null }); assert.equal(adopted.ok, true);
  if (action === 'purge') await withHomeLock(home, async () => mem.purgeSource('source'));
  else { const result = await mem.handlers['skills.curate']({}); assert.equal(result.ok, true); }
  assert.equal(readAgentRoles(home, [])[0]?.markdown, definition());
  assert.equal(existsSync(legacy), false);
  if (action === 'archive') assert.equal(existsSync(join(home, 'skills', '.archive', 'agents', 'SKILL.md')), true);
});
test('ambiguous skill files stay in place and do not replace an independent canonical role', async () => {
  const home = freshHome(); await skill(home);
  const skillPath = join(home, 'skills', 'agents', 'SKILL.md'), originalSkill = readFileSync(skillPath, 'utf8');
  await write(home, () => {
    saveAgentRole(home, 'researcher', definition('researcher', 'New definition.'), null, []);
    writeFileSync(join(home, 'skills', 'agents', 'researcher.md'), definition());
    writeFileSync(join(home, 'skills', 'agents', 'notes.md'), 'A skill reference, not a role.');
  });
  const mem = await memory(home);
  await mem.handlers['agents.list']({}); await mem.handlers['agents.list']({});
  assert.equal(readAgentRoles(home, [])[0]?.instructions, 'New definition.');
  const conflicts = join(home, '.agent-roles', '.legacy');
  const copies = readdirSync(conflicts).filter(name => name.endsWith('.md'));
  assert.equal(copies.length, 0);
  assert.equal(readFileSync(skillPath, 'utf8'), originalSkill);
  assert.equal(readFileSync(join(home, 'skills', 'agents', 'notes.md'), 'utf8'), 'A skill reference, not a role.');
  assert.equal(readFileSync(join(home, 'skills', 'agents', 'researcher.md'), 'utf8'), definition());
});
test('unsafe migration destinations preserve the legacy role', async () => {
  const home = freshHome(), other = freshHome(); await skill(home);
  const legacy = join(home, 'skills', 'agents', 'researcher.md');
  await write(home, () => { writeFileSync(legacy, definition()); symlinkSync(other, join(home, '.agent-roles')); });
  const mem = await memory(home, true);
  await assert.rejects(withHomeLock(home, async () => mem.purgeSource('source')));
  assert.equal(readFileSync(legacy, 'utf8'), definition());
  assert.equal(existsSync(join(other, 'researcher.md')), false);
});
test('one role listing reads at most 64 directory entries', async () => {
  const home = freshHome();
  await write(home, () => { for (let i = 0; i < 70; i++) saveAgentRole(home, `role-${i}`, definition(`role-${i}`), null, []); });
  assert.ok(readAgentRoles(home, []).length <= 64);
  assert.ok(readAgentRoles(home, []).length > 0);
});

test('role receipts distinguish stale definitions, invalid input and storage failures', async () => {
  const home = freshHome();
  await write(home, () => { saveAgentRole(home, 'researcher', definition(), null, []); });
  const mem = await memory(home);
  const stale = await mem.handlers['agents.delete']({ name: 'researcher', base: 'old' });
  assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.reason, 'STALE_BASE');
  const invalid = await mem.handlers['agents.save']({ name: 'researcher', markdown: 'Not a definition.', base: null });
  assert.equal(invalid.ok, false); if (!invalid.ok) assert.equal(invalid.reason, 'INVALID');
  const role = readAgentRoles(home, [])[0];
  const target = join(home, '.agent-roles', 'researcher.md');
  await write(home, () => writeFileSync(target, definition() + 'x'.repeat(33000)));
  const unavailable = await mem.handlers['agents.delete']({ name: 'researcher', base: role.digest });
  assert.equal(unavailable.ok, false); if (!unavailable.ok) assert.equal(unavailable.reason, 'NOT_AVAILABLE');
  assert.equal(readFileSync(target, 'utf8').length, definition().length + 33000);
});

test('a bounded migration defers purge and a later pass preserves every legacy role', async () => {
  const home = freshHome();
  await write(home, () => {
    mkdirSync(join(home, 'skills', 'agents'), { recursive: true });
    for (let i = 0; i < 70; i++) { assertHomeWriteAdmission(home, home); writeFileSync(join(home, 'skills', 'agents', `role-${i}.md`), definition(`role-${i}`)); }
  });
  const mem = await memory(home, true);
  await withHomeLock(home, async () => mem.purgeSource('source'));
  assert.ok(readdirSync(join(home, 'skills', 'agents')).length > 0);
  await mem.handlers['agents.list']({}); await mem.handlers['agents.list']({});
  await withHomeLock(home, async () => mem.purgeSource('source'));
  assert.equal(readdirSync(join(home, 'skills', 'agents')).length, 0);
  for (let i = 0; i < 70; i++) assert.equal(readFileSync(join(home, '.agent-roles', `role-${i}.md`), 'utf8'), definition(`role-${i}`));
});

test('migration resumes an already verified copy without replacing it', async () => {
  const home = freshHome(); await skill(home);
  await write(home, () => { saveAgentRole(home, 'researcher', definition(), null, []); });
  const path = join(home, '.agent-roles', 'researcher.md');
  const { statSync } = await import('node:fs'); const before = statSync(path).ino;
  await write(home, () => writeFileSync(join(home, 'skills', 'agents', 'researcher.md'), definition()));
  const mem = await memory(home); await mem.handlers['agents.list']({});
  assert.equal(statSync(path).ino, before);
  assert.equal(readFileSync(join(home, 'skills', 'agents', 'researcher.md'), 'utf8'), definition());
});

test('role-shaped skill references stay in place and a deleted migrated role stays deleted', async () => {
  const home = freshHome(); await skill(home);
  const reference = join(home, 'skills', 'agents', 'reference.md');
  await write(home, () => writeFileSync(reference, definition('reference')));
  const mem = await memory(home);
  assert.deepEqual(value(await mem.handlers['agents.list']({})).roles, []);
  const saved = await mem.handlers['agents.save']({ name: 'reference', markdown: definition('reference'), base: null }); assert.equal(saved.ok, true);
  const roles = value(await mem.handlers['agents.list']({})).roles;
  const role = roles.find(role => role.name === 'reference'); assert.ok(role);
  assert.equal(readFileSync(reference, 'utf8'), definition('reference'));
  const result = await mem.handlers['agents.delete']({ name: role.name, base: role.digest }); assert.equal(result.ok, true);
  assert.equal(value(await mem.handlers['agents.list']({})).roles.some(role => role.name === 'reference'), false);
  await write(home, () => writeFileSync(reference, definition('reference', 'A later skill-reference edit.')));
  assert.equal(value(await mem.handlers['agents.list']({})).roles.some(role => role.name === 'reference'), false);
  assert.equal(readFileSync(reference, 'utf8'), definition('reference', 'A later skill-reference edit.'));
});

test('explicit role admission still works beyond the bounded advertised listing', async () => {
  const home = freshHome();
  await write(home, () => { for (let i = 0; i < 70; i++) saveAgentRole(home, `role-${i}`, definition(`role-${i}`), null, []); });
  const offered = new Set(readAgentRoles(home, []).map(role => role.name));
  const unseen = Array.from({ length: 70 }, (_, i) => `role-${i}`).find(name => !offered.has(name)); assert.ok(unseen);
  const mem = await memory(home);
  const admitted = await mem.agentRole(`own/${unseen}`, 'Inspect');
  assert.equal('refused' in admitted, false);
  if (!('refused' in admitted)) assert.equal(admitted.agentRole?.name, unseen);
});

for (const damaged of ['oversized', 'malformed', 'invalid-utf8'] as const) test(`an ${damaged} legacy role edit blocks destructive skill cleanup`, async () => {
  const home = freshHome(); await skill(home);
  const path = join(home, 'skills', 'agents', 'researcher.md');
  const edited = damaged === 'oversized' ? definition() + 'x'.repeat(33000) : damaged === 'invalid-utf8' ? Buffer.concat([Buffer.from(definition()), Buffer.from([255])]) : definition().replace('tools: [Read]', 'tools: [Read');
  await write(home, () => writeFileSync(path, edited));
  const mem = await memory(home, true);
  await assert.rejects(withHomeLock(home, async () => mem.purgeSource('source')));
  assert.deepEqual(readFileSync(path), Buffer.from(edited));
  assert.equal(existsSync(join(home, 'skills', 'agents', 'SKILL.md')), true);
});

test('a readable ordinary skill reference does not block withdrawal', async () => {
  const home = freshHome(); await skill(home);
  await write(home, () => writeFileSync(join(home, 'skills', 'agents', 'notes.md'), 'A normal skill reference.'));
  const mem = await memory(home, true);
  await withHomeLock(home, async () => mem.purgeSource('source'));
  assert.equal(existsSync(join(home, 'skills', 'agents')), false);
});

for (const action of ['list', 'admit'] as const) test(`credential checks follow migration's lock wait during role ${action}`, async () => {
  const home = freshHome();
  await write(home, () => { saveAgentRole(home, 'researcher', definition('researcher', 'Contains fresh-secret.'), null, []); });
  let known: string[] = [], enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const mem = await withHomeLock(home, async () => createMemory({ home, threads: new Map(), projectExists: () => false, emit() {}, credentials: async () => known, material: { load: () => undefined },
    locked: async <T>(fn: () => Promise<T>) => { enter(); await held; return withHomeLock(home, fn); },
  } as unknown as MemoryDeps));
  const pending = action === 'list' ? mem.handlers['agents.list']({}) : mem.agentRole('own/researcher', 'Inspect');
  await entered; known = ['fresh-secret']; release();
  const result = await pending;
  if (action === 'list') { assert.ok('ok' in result && result.ok); if ('ok' in result && result.ok) assert.deepEqual(result.value.roles, []); }
  else assert.equal('refused' in result, true);
});


test('an unrecognizable edit of a previously migrated role still blocks destructive cleanup', async () => {
  const home = freshHome(); await skill(home);
  const path = join(home, 'skills', 'agents', 'researcher.md');
  await write(home, () => writeFileSync(path, definition()));
  const mem = await memory(home, true);
  await mem.handlers['agents.save']({ name: 'researcher', markdown: definition(), base: null });
  await write(home, () => writeFileSync(path, 'A human replaced the entire role header.'));
  await assert.rejects(withHomeLock(home, async () => mem.purgeSource('source')));
  assert.equal(readFileSync(path, 'utf8'), 'A human replaced the entire role header.');
});


test('an ambiguous role-shaped skill reference is never activated or copied outside its provenance', async () => {
  const home = freshHome(); await skill(home);
  const path = join(home, 'skills', 'agents', 'reference.md'), body = definition('reference', 'Source-derived reference.');
  await write(home, () => writeFileSync(path, body));
  const mem = await memory(home, true);
  assert.deepEqual(value(await mem.handlers['agents.list']({})).roles, []);
  assert.equal('refused' in await mem.agentRole('own/reference', 'Inspect'), true);
  await assert.rejects(withHomeLock(home, async () => mem.purgeSource('source')));
  assert.equal(readFileSync(path, 'utf8'), body);
  assert.equal(existsSync(join(home, '.agent-roles')), false);
});

test('skill source records prevent reclassification when SKILL.md is missing', async () => {
  const home = freshHome(); await skill(home);
  await write(home, () => { unlinkSync(join(home, 'skills', 'agents', 'SKILL.md')); writeFileSync(join(home, 'skills', 'agents', 'reference.md'), definition('reference')); });
  const mem = await memory(home, true);
  assert.deepEqual(value(await mem.handlers['agents.list']({})).roles, []);
  await assert.rejects(withHomeLock(home, async () => mem.purgeSource('source')));
  assert.equal(existsSync(join(home, '.agent-roles')), false);
});

test('a known skill reference is purged with its source and leaves no active role or recovery text', async () => {
  const home = freshHome(); await skill(home);
  const path = join(home, 'skills', 'agents', 'references', 'reference.md');
  await write(home, () => { mkdirSync(join(home, 'skills', 'agents', 'references')); writeFileSync(path, definition('reference', 'Source-derived reference.')); });
  const mem = await memory(home, true);
  await withHomeLock(home, async () => mem.purgeSource('source'));
  assert.equal(existsSync(join(home, 'skills', 'agents')), false);
  assert.equal(existsSync(join(home, '.agent-roles')), false);
  assert.equal('refused' in await mem.agentRole('own/reference', 'Inspect'), true);
});
