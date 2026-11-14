import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMemory, type MemoryDeps } from '../src/composition/memory.ts';
import { assertHomeWriteAdmission, withHomeLock } from '../src/composition/home-lock.ts';
import { saveAgentRole } from '../src/memory/agent-roles.ts';
import { acceptDraft, draftSkill } from '../src/memory/imports.ts';
import { b64, freshHome, open, value } from './helpers.ts';
const definition = (name = 'researcher', body = 'Find dates.') => `---\nname: ${name}\ndescription: Find evidence\ntools: [Read]\n---\n${body}\n`;
async function fixture(withdrawn = false) {
  const home = freshHome(), briefs: string[] = [];
  let known: string[] = [];
  await withHomeLock(home, async () => {
    for (const title of ['Agents', 'Reports']) {
      const skill = draftSkill(home, { threadId: 't', title, request: 'Find evidence', steps: [], answer: 'Done', sources: [{ id: 'source', name: 'source.md', version: 1 }] }, []);
      acceptDraft(home, skill.name);
    }
    assertHomeWriteAdmission(home, home);
    writeFileSync(join(home, 'skills', 'agents', 'reference.md'), definition('reference'));
    assertHomeWriteAdmission(home, join(home, 'skills'));
    writeFileSync(join(home, 'skills', '.usage.json'), JSON.stringify({ agents: { offered: 1, used: 0 }, reports: { offered: 1, used: 0 } }));
  });
  const memory = createMemory({ home, threads: new Map(), emit() {}, projectExists: () => false, credentials: async () => known,
    locked: <T>(fn: () => Promise<T>) => withHomeLock(home, fn), now: () => Date.now() + 32 * 86400000,
    brief: (item: { detail: string }) => briefs.push(item.detail), material: { load: () => withdrawn ? { withdrawals: [{}] } : undefined } } as unknown as MemoryDeps);
  return { home, memory, briefs, known: (values: string[]) => { known = values; } };
}
test('ambiguous Agents folder leaves other withdrawn skills purged and reports unfinished cleanup', async () => {
  const f = await fixture(true);
  await assert.rejects(withHomeLock(f.home, async () => f.memory.purgeSource('source')), /manual review/i);
  assert.equal(existsSync(join(f.home, 'skills', 'reports')), false);
  assert.equal(existsSync(join(f.home, 'skills', 'agents', 'reference.md')), true);
  const sources = JSON.parse(readFileSync(join(f.home, 'skills', '.sources.json'), 'utf8'));
  assert.ok(sources.agents); assert.equal(sources.reports, undefined);
  const usage = JSON.parse(readFileSync(join(f.home, 'skills', '.usage.json'), 'utf8'));
  assert.equal(usage.agents, undefined, 'withdrawal clears names even while their folder awaits review');
  assert.equal(usage.reports, undefined);
  assert.ok(f.briefs.some(text => /manual review/i.test(text)));
});
test('ambiguous Agents folder does not stop daily curation of unrelated skills', async () => {
  const f = await fixture();
  await f.memory.daily();
  assert.equal(existsSync(join(f.home, 'skills', '.archive', 'reports', 'SKILL.md')), true);
  assert.equal(existsSync(join(f.home, 'skills', 'agents', 'SKILL.md')), true);
});
test('migration errors never fail a turn and role listing gives a typed refusal', async () => {
  const f = await fixture();
  const other = freshHome();
  await withHomeLock(f.home, async () => { assertHomeWriteAdmission(f.home, f.home); symlinkSync(other, join(f.home, '.agent-roles')); });
  const recall = await f.memory.forTurn('p', 'report'); assert.ok(recall);
  const listing = await f.memory.handlers['agents.list']({});
  assert.equal(listing.ok, false); if (!listing.ok) assert.equal(listing.reason, 'NOT_AVAILABLE');
});
test('migration checks decoded credentials before any canonical or recovery copy', async () => {
  const home = freshHome();
  await withHomeLock(home, async () => { assertHomeWriteAdmission(home, home); mkdirSync(join(home, 'skills', 'agents'), { recursive: true }); writeFileSync(join(home, 'skills', 'agents', 'researcher.md'), definition().replace('description: Find evidence', 'description: \"fresh\\x2dsecret\"')); });
  const memory = createMemory({ home, threads: new Map(), emit() {}, projectExists: () => false, credentials: async () => ['fresh-secret'], material: { load: () => undefined }, locked: <T>(fn: () => Promise<T>) => withHomeLock(home, fn) } as unknown as MemoryDeps);
  await memory.forTurn('p', 'report');
  assert.equal(existsSync(join(home, '.agent-roles', 'researcher.md')), false);
  assert.equal(existsSync(join(home, 'skills', 'agents', 'researcher.md')), true);
});
test('role listings report when the 64-entry traversal cap withholds later entries', async () => {
  const f = await fixture();
  await withHomeLock(f.home, async () => { for (let i = 0; i < 70; i++) saveAgentRole(f.home, `role-${i}`, definition(`role-${i}`), null, []); });
  const result = value(await f.memory.handlers['agents.list']({}));
  assert.equal(result.truncated, true); assert.ok(result.roles.length <= 64);
});

test('withdrawal retries refuse pending skill cleanup and succeed only after purging reviewed references', async () => {
  const { home, host } = open(undefined, { harness: 'stub' });
  const project = value(await host.call('projects.create', { name: 'Withdrawal retry', kind: 'folder' }));
  const doc = value(await host.call('material.attach', { projectId: project.id, name: 'source.md', base64: b64('Disposable source.'), mediaType: 'text/markdown' }));
  const reference = definition('reference');
  await withHomeLock(home, async () => {
    for (const title of ['Agents', 'Reports']) {
      const skill = draftSkill(home, { threadId: 'retry', title, request: 'Find evidence', steps: [], answer: 'Done', sources: [{ id: doc.id, name: doc.name, version: 1 }] }, []);
      acceptDraft(home, skill.name);
    }
    assertHomeWriteAdmission(home, join(home, 'skills', 'agents'));
    writeFileSync(join(home, 'skills', 'agents', 'reference.md'), reference);
  });
  const sources = () => JSON.parse(readFileSync(join(home, 'skills', '.sources.json'), 'utf8'));
  await assert.rejects(host.call('material.lifecycle', { id: doc.id, version: doc.current, lifecycle: doc.lifecycle ?? 0, state: 'withdrawn' }), { reason: 'NOT_AVAILABLE' });
  assert.equal(existsSync(join(home, 'skills', 'reports')), false, 'independent cleanup completes despite the ambiguous folder');
  assert.ok(sources().agents);
  assert.equal(sources().reports, undefined);
  const withdrawn = (await host.call('material.list', { projectId: project.id, includeHidden: true })).find(entry => entry.id === doc.id)!;
  const retry = () => host.call('material.lifecycle', { id: doc.id, version: withdrawn.current, lifecycle: withdrawn.lifecycle ?? 0, state: 'withdrawn' });
  await assert.rejects(retry(), { reason: 'NOT_AVAILABLE' });
  assert.ok(sources().agents, 'a refused retry preserves provenance for later cleanup');
  // Saving this exact definition establishes ownership independently of the withdrawn skill.
  value(await host.call('agents.save', { name: 'reference', markdown: reference, base: null }));
  const completed = value(await retry());
  assert.equal(existsSync(join(home, 'skills', 'agents')), false, 'success follows removal of the withdrawn skill');
  assert.equal(sources().agents, undefined);
  assert.equal(readFileSync(join(home, '.agent-roles', 'reference.md'), 'utf8'), reference, 'the independently saved role survives');
  // Core delivery receipts can settle independently; compare the withdrawal effect itself.
  const lifecycleOf = (entry: typeof doc) => ({ id: entry.id, hidden: entry.hidden, lifecycle: entry.lifecycle,
    withdrawals: entry.withdrawals?.map(({ at, version, restoredAt }) => ({ at, version, restoredAt })) });
  assert.deepEqual(lifecycleOf(completed), lifecycleOf(withdrawn), 'retry does not repeat the withdrawal effect or change its lifecycle');
  assert.deepEqual(lifecycleOf(value(await retry())), lifecycleOf(withdrawn), 'completed cleanup remains idempotent');
});
