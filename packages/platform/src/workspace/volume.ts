// Trusted OS volume operations. Never traverse a mounted, engine-written filesystem for cleanup.
import { execFile } from 'node:child_process';
import { lstat, readdir, rename, rm, rmdir, open, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const systemEnvironment = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' };
export function reportCleanup(name: string, error: unknown) {
  process.stderr.write(`[workspace] Cleanup remains pending for ${name}: ${error instanceof Error ? error.message : 'unknown error'}\n`);
}
export function system(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, { env: systemEnvironment, timeout: 60_000, maxBuffer: 65_536 }, (error, stdout) => error ? reject(new Error(`Workspace OS operation failed: ${command.split('/').at(-1)} (${error.code ?? 'failed'}).`)) : resolve(stdout)));
}
export async function syncDirectory(path: string) { const fd = await open(path, 'r'); try { await fd.sync(); } finally { await fd.close(); } }
export async function detach(folder: string): Promise<void> {
  // Linux tmpfs belongs to a fresh PID/mount namespace. Closing that namespace and its
  // retained snapshot descriptor releases it; no mount is ever made in the host namespace.
  if (process.platform === 'linux') return;
  // Each command has a new mount path: detached descendants cannot regain access on a later turn.
  const info = await system('/usr/bin/hdiutil', ['info', '-plist']);
  const paths = [...info.matchAll(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/g)].map(m => m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  for (const mount of paths) if (mount.startsWith(folder + '/mount-')) await system('/usr/bin/hdiutil', ['detach', '-force', mount]);
  // Mount directories are Host metadata too: do not accumulate one outside the quota per call.
  let entries: string[];
  try { entries = await readdir(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of entries) if (name.startsWith('mount-')) {
    try { await rmdir(join(folder, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export async function removeFolder(folder: string): Promise<void> {
  await detach(folder);
  // The mount is gone. Its files (including links, ACLs and flags) are just bytes in the image.
  await rm(folder, { recursive: true, force: true });
  await syncDirectory(dirname(folder));
}
export async function markRetiring(folder: string): Promise<boolean> {
  try {
    const stat = await lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Workspace storage was replaced.');
    await writeFile(join(folder, '.retiring'), '', { mode: 0o600 }); await syncDirectory(folder);
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function retireFolder(folder: string): Promise<string | null> {
  try {
    if (!await markRetiring(folder)) return null;
    await detach(folder); // Mountpoint must retain its name until detached.
    const retired = join(dirname(folder), `.retired-${randomUUID()}`);
    await rename(folder, retired); await syncDirectory(dirname(folder)); return retired;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function sweepGarbage(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    try {
      if (name.startsWith('.creating-')) {
        const pid = Number(name.split('-')[1]);
        if (pid > 0 && Date.now() - (await lstat(join(directory, name))).mtimeMs < 120_000) { try { process.kill(pid, 0); continue; } catch { /* dead creator */ } }
      } else if (!name.startsWith('.retired-')) continue;
      await removeFolder(join(directory, name));
    } catch (error) { reportCleanup(name, error); }
  }
}
