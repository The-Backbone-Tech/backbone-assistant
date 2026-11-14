import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportHome, importHome } from '../src/composition/backup.ts';
import { assertHomeWriteAdmission, withHomeLock } from '../src/composition/home-lock.ts';
import { saveAgentRole } from '../src/memory/agent-roles.ts';
import { freshDir, freshHome } from './helpers.ts';
const role = '---\nname: researcher\ndescription: Find evidence\ntools: [Read]\n---\nFind dates.\n';
function source(home: string) {
  return { home, projects: [], threads: [], documents: () => [], versionPath: () => '', secrets: async () => [], receipts: async () => [] };
}
test('home export includes every canonical role as readable definitions and restore keeps them inactive', async () => {
  const home = freshHome(), to = join(freshDir('roles-export-'), 'export');
  await withHomeLock(home, async () => { for (let i = 0; i < 70; i++) saveAgentRole(home, `role-${i}`, role.replace('name: researcher', `name: role-${i}`), null, []); });
  const result = await exportHome(source(home), { to });
  assert.equal(result.counts.roles, 70);
  assert.equal(readdirSync(join(to, 'roles')).length, 70);
  assert.match(readFileSync(join(to, 'roles', 'r001.md'), 'utf8'), /Find dates/);
  const target = join(freshDir('roles-restore-'), 'home');
  const attached: { name: string; base64: string }[] = [];
  const plan = await importHome({ from: to, home: target, api: {
    call: async (method: string, args: unknown) => {
      if (method === 'projects.list' || method === 'threads.list') return [];
      if (method === 'memory.get') return { entries: [], instructions: { person: '' } };
      if (method === 'projects.create') return { ok: true, value: { id: 'history' } };
      if (method === 'material.attach') { attached.push(args as never); return { ok: true, value: {} }; }
      throw new Error('Unexpected import operation: ' + method);
    }, hasSkills: () => false,
  } as never });
  assert.equal(plan.done, true);
  const definitions = attached.filter(a => a.name.startsWith('Agent role - '));
  assert.equal(definitions.length, 70);
  assert.ok(definitions.every(a => Buffer.from(a.base64, 'base64').toString().includes('Find dates.')));
});
test('a linked role directory refuses export rather than reading outside the home', async () => {
  const home = freshHome(), other = freshHome();
  await withHomeLock(home, async () => { assertHomeWriteAdmission(home, home); symlinkSync(other, join(home, '.agent-roles')); });
  await assert.rejects(exportHome(source(home), { to: join(freshDir('roles-export-link-'), 'export') }));
});

test('restore refuses a home that already holds saved roles before writing any imported work', async () => {
  const home = freshHome(), to = join(freshDir('roles-export-existing-'), 'export'), target = freshHome();
  await exportHome(source(home), { to });
  await withHomeLock(target, async () => saveAgentRole(target, 'researcher', role, null, []));
  const plan = await importHome({ from: to, home: target, dryRun: true, api: {
    call: async (method: string) => {
      if (method === 'projects.list' || method === 'threads.list') return [];
      if (method === 'memory.get') return { entries: [], instructions: { person: '' } };
      throw new Error('No write is allowed while checking an occupied home.');
    }, hasSkills: () => false,
  } as never });
  assert.ok(plan.conflicts.length > 0);
  assert.equal(readFileSync(join(target, '.agent-roles', 'researcher.md'), 'utf8'), role);
});

test('role export checks decoded YAML fields after redaction and refuses an encoded credential', async () => {
  const home = freshHome(), to = join(freshDir('roles-export-encoded-'), 'export');
  const secret = 'canary-value';
  const encoded = role.replace('description: Find evidence', 'description: "Find canary\\x2dvalue evidence"');
  await withHomeLock(home, async () => saveAgentRole(home, 'researcher', encoded, null, []));
  await assert.rejects(exportHome({ ...source(home), secrets: async () => [secret] }, { to }), { reason: 'INVALID' });
  assert.equal(existsSync(to), false, 'nothing is published when decoded role fields cannot be checked safely');
  assert.equal(readFileSync(join(home, '.agent-roles', 'researcher.md'), 'utf8'), encoded);
});

test('role export still scrubs a plain credential without changing the source definition', async () => {
  const home = freshHome(), to = join(freshDir('roles-export-scrub-'), 'export');
  const secret = 'canary-value', original = role.replace('Find dates.', `Find dates. Keep ${secret} private.`);
  await withHomeLock(home, async () => saveAgentRole(home, 'researcher', original, null, []));
  const result = await exportHome({ ...source(home), secrets: async () => [secret] }, { to });
  assert.equal(result.counts.roles, 1);
  assert.ok(!readFileSync(join(to, 'roles', 'r001.md'), 'utf8').includes(secret));
  assert.equal(readFileSync(join(home, '.agent-roles', 'researcher.md'), 'utf8'), original);
});
