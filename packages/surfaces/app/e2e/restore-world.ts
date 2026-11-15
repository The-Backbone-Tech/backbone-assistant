// What the restore specs share: a real backup made from a throwaway data folder, and the data folder
// a restore made, opened and read through the platform api. Nothing here touches a real data folder.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import type { Page } from '@playwright/test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge, stopBridge } from './bridge';
import { openSidebar } from './journey';

const b64 = (text: string) => Buffer.from(text).toString('base64');

async function post<T>(url: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await res.json()) as T;
}

/** A call on a bridge's api port, as the page makes it. */
export const callOn = <T = unknown>(url: string, method: string, args: unknown) => post<T>(url, '/api', { method, args });

export interface Backup { folder: string; scratch: string; end(): Promise<void> }

/**
 * A real export of a data folder that holds `projects` (each with a brief document of two versions, and one
 * chat), made by the app's own export through a throwaway bridge. `scratch` is a folder of the test's own.
 */
export async function makeBackup(projects: string[] = ['Harbor', 'Ledger']): Promise<Backup> {
  const home = freshDataHome('restore-source');
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'backbone-restore-e2e-')));
  const picked = join(scratch, 'exports');
  mkdirSync(picked);
  process.env.BACKBONE_BRIDGE_PICK = picked;
  const bridge = await startBridge(home);
  delete process.env.BACKBONE_BRIDGE_PICK;
  try {
    for (const name of projects) {
      const made = await callOn<{ value: { id: string } }>(bridge.url, 'projects.create', { name, kind: 'folder' });
      const attached = await callOn<{ ok: boolean; value: { id: string } }>(bridge.url, 'material.attach', { projectId: made.value.id, name: `${name} notes.md`, base64: b64(`# ${name}\n\nFirst words.\n`), mediaType: 'text/markdown' });
      await callOn(bridge.url, 'material.save', { id: attached.value.id, text: `# ${name}\n\nSecond words.\n`, baseVersion: 1 });
      if (name === projects[0]) {
        const sent = await callOn<{ ok: boolean; value: { threadId: string } }>(bridge.url, 'turns.send', { projectId: made.value.id, text: 'Write a brief', attachments: [], settings: { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'restore-source' });
        for (let i = 0; i < 300; i += 1) {
          const got = await callOn<{ value: { summary: { running: boolean } } }>(bridge.url, 'threads.get', { id: sent.value.threadId });
          if (!got.value.summary.running) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
    const ticket = await post<{ ticket: string }>(bridge.url, '/api/choose-export-folder');
    const done = await callOn<{ ok: boolean; value: { folder: string }; detail?: string }>(bridge.url, 'backup.export', { ticket: ticket.ticket });
    if (!done.ok) throw new Error(`the export failed: ${done.detail}`);
    return { folder: done.value.folder, scratch, end: async () => { rmSync(scratch, { recursive: true, force: true }); } };
  } finally {
    await stopBridge(bridge.proc);
    await removeDataHome(home);
  }
}

/** What a restored data folder holds, read through the platform api on a bridge opened on it. */
export async function readRestored(folder: string): Promise<{ projects: string[]; documents: string[] }> {
  const bridge = await startBridge(folder);
  try {
    const projects = await callOn<{ id: string; name: string }[]>(bridge.url, 'projects.list', {});
    const documents: string[] = [];
    for (const p of projects) for (const d of await callOn<{ name: string }[]>(bridge.url, 'material.list', { projectId: p.id })) documents.push(`${p.name}/${d.name}`);
    return { projects: projects.map((p) => p.name).sort(), documents: documents.sort() };
  } finally { await stopBridge(bridge.proc); }
}

/** Opens Settings › Backup on a bridge whose backup picker answers with `backup` and whose place picker with `parent`. */
export async function openBackup(page: Page, options: { backup: string; parent?: string | 'current'; env?: NodeJS.ProcessEnv }) {
  const home = freshDataHome('restore-target');
  process.env.BACKBONE_BRIDGE_RESTORE_FROM = options.backup;
  if (options.parent) process.env.BACKBONE_BRIDGE_PICK = options.parent === 'current' ? home : options.parent;
  const bridge = await startBridge(home, options.env);
  delete process.env.BACKBONE_BRIDGE_RESTORE_FROM;
  delete process.env.BACKBONE_BRIDGE_PICK;
  await page.goto(bridge.url);
  await page.locator('[data-ready=true]').waitFor();
  await openSidebar(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Backup' }).click();
  return { home, bridge, settings, section: settings.getByTestId('backup'), end: async () => { await stopBridge(bridge.proc); await removeDataHome(home); } };
}

/**
 * A copy of an export, digests recomputed, with one more document whose name is too long for any file: the
 * export still checks, and the restore stops part-way, after the projects were made, on the operation's own refusal.
 */
export function breakable(backup: string, scratch: string): string {
  const copy = join(scratch, 'broken');
  cpSync(backup, copy, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8')) as { files: Record<string, string> };
  const dir = 'projects/p002/documents/d099';
  mkdirSync(join(copy, dir), { recursive: true });
  const files: Record<string, string> = {
    [`${dir}/meta.json`]: JSON.stringify({ name: `${'long'.repeat(80)}.txt`, mediaType: 'text/plain', class: 'original', projection: undefined, current: 1, versions: [{ n: 1, file: 'v1', by: 'person' }] }),
    [`${dir}/v1`]: 'text',
  };
  for (const [rel, text] of Object.entries(files)) {
    writeFileSync(join(copy, rel), text);
    manifest.files[rel] = createHash('sha256').update(text).digest('hex');
  }
  writeFileSync(join(copy, 'manifest.json'), JSON.stringify(manifest));
  return copy;
}
