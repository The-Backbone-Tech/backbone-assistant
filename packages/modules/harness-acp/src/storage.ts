import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, rm, lstat, chmod, readdir, readlink, symlink, copyFile, rmdir, unlink, readFile, writeFile, link } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanupCommand } from './cleanup-command.ts';
import { AcpRefusal } from './refusal.ts';

/** Never repair an existing untrusted folder by chmod; refuse it. */
export async function privateDirectory(path: string): Promise<string> {
  // Another harness may remove an empty shared parent while this session is being created.
  // Recreate only on absence; all ownership, mode and no-follow checks still apply.
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const info = await dir.stat();
        if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700) throw new Error('ACP storage must be owned by this user, mode 0700, and not a symlink.');
        return await realpath(path);
      } finally { await dir.close(); }
    } catch (error) {
      if (attempt >= 3 || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Traverse only the private retired tree; never follow its symlinks or open special files. */
async function removePlainTree(path: string): Promise<void> {
  let info;
  try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (info.isDirectory() && !info.isSymbolicLink()) {
    await chmod(path, (info.mode & 0o777) | 0o700);
    for (const name of await readdir(path)) await removePlainTree(join(path, name));
    await rmdir(path);
  } else await unlink(path); // Includes FIFOs, sockets and links; none is opened.
}

const repairable = (error: unknown) => ['EPERM', 'EACCES', 'ENAMETOOLONG'].includes((error as NodeJS.ErrnoException).code ?? '');
function reportRetired(path: string, reason: string) {
  process.stderr.write(`[harness-acp] ${JSON.stringify({ event: 'retired-state-removal-failed', path, reason })}\n`);
}
export async function removeRetiredTree(path: string): Promise<void> {
  try { await removeWithRepair(path); }
  catch (error) {
    const reason = error instanceof AcpRefusal ? error.message : `ACP native state cleanup failed (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}); retired state remains and must not be reused.`;
    reportRetired(path, reason); throw new AcpRefusal(reason);
  }
}
async function removeWithRepair(path: string): Promise<void> {
  let initial: unknown;
  try { await removePlainTree(path); return; }
  catch (error) { if (!repairable(error)) throw error; initial = error; }
  const parent = dirname(path), relative = './' + basename(path);
  if (process.platform === 'darwin') {
    const tolerate = async (command: string, args: string[]) => { try { await cleanupCommand(command, args, parent); } catch { /* Independent steps still run; removal below verifies their result. */ } };
    const repair = async (entries: { path: string; link: boolean }[]) => {
      for (let offset = 0; offset < entries.length; offset += 256) {
        const batch = entries.slice(offset, offset + 256), paths = batch.map(entry => entry.path), plain = batch.filter(entry => !entry.link).map(entry => entry.path);
        await tolerate('/usr/bin/chflags', ['-h', '0', ...paths]);
        if (plain.length) {
          await tolerate('/bin/chmod', ['u+rwX', ...plain]);
          // Without -h, chmod -N uses the path ACL API, including on FIFOs. Links are excluded.
          await tolerate('/bin/chmod', ['-N', ...plain]);
        }
      }
    };
    try {
      const info = await lstat(path); await repair([{ path: relative, link: info.isSymbolicLink() }]);
      const queue = info.isDirectory() && !info.isSymbolicLink() ? [relative] : [];
      for (const directory of queue) {
        const entries = await readdir(join(parent, directory), { withFileTypes: true });
        await repair(entries.map(entry => ({ path: join(directory, entry.name), link: entry.isSymbolicLink() })));
        for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(join(directory, entry.name));
      }
    } catch {
      // Physical relative traversal also reaches entries beyond PATH_MAX. Directory steps run
      // independently before descent. chflags/mode calls end options; ACL calls need ./{}
      // because macOS chmod -N treats -- as a filename. Short names still work beyond PATH_MAX.
      await tolerate('/usr/bin/find', ['-P', relative, '-type', 'd',
        '(', '-execdir', '/usr/bin/chflags', '-h', '--', '0', '{}', ';', '-o', '-true', ')',
        '(', '-execdir', '/bin/chmod', '--', 'u+rwx', '{}', ';', '-o', '-true', ')',
        '(', '-execdir', '/bin/chmod', '-N', './{}', ';', '-o', '-true', ')']);
      await tolerate('/usr/bin/find', ['-P', relative, '-execdir', '/usr/bin/chflags', '-h', '--', '0', '{}', '+']);
      await tolerate('/usr/bin/find', ['-P', relative, '!', '-type', 'l', '-execdir', '/bin/chmod', '--', 'u+rwX', '{}', '+']);
      await tolerate('/usr/bin/find', ['-P', relative, '!', '-type', 'l', '-execdir', '/bin/chmod', '-N', './{}', ';']);
    }
  }
  try { await removePlainTree(path); return; } catch (error) { if (!repairable(error)) throw error; }
  // rm uses physical relative traversal too; a second find-delete fallback was redundant.
  try { await cleanupCommand('/bin/rm', ['-rf', relative], parent); } catch { /* Never expose process diagnostics or silently declare success. */ }
  try { await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; }
  throw new AcpRefusal(`ACP native state cleanup failed (${(initial as NodeJS.ErrnoException).code}); retired state remains and must not be reused.`);
}

/** Native-state copying is best effort for regular files, directories and links only. */
export async function copyRetainedTree(source: string, target: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) { await symlink(await readlink(source), target); return; }
  if (info.isDirectory()) {
    await chmod(source, (info.mode & 0o777) | 0o700);
    await mkdir(target, { mode: 0o700 });
    for (const name of await readdir(source)) await copyRetainedTree(join(source, name), join(target, name));
  } else if (info.isFile()) {
    await chmod(source, (info.mode & 0o777) | 0o600);
    await copyFile(source, target);
  }
  // FIFOs, sockets and devices are deliberately not copied into a new incarnation.
}

const liveOwner = async (owner: string) => {
  try {
    const pid: unknown = JSON.parse(await readFile(owner, 'utf8'));
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  } catch { return false; }
};

/** A sibling owner record prevents one process sweeping another's in-flight retired copy. */
export async function sweepRetired(parent: string): Promise<string[]> {
  const warnings: string[] = [];
  // A pending owner record is left only by a process that died while publishing it; give a live one time to finish.
  for (const name of (await readdir(parent)).filter(name => /^\.retired-[0-9a-f-]{36}\.owner\.json\.pending$/.test(name))) {
    const pending = join(parent, name);
    try { if (Date.now() - (await lstat(pending)).mtimeMs > 60_000) await unlink(pending); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const stems = new Set((await readdir(parent)).filter(name => /^\.retired-[0-9a-f-]{36}(?:\.owner\.json)?$/.test(name)).map(name => name.replace(/\.owner\.json$/, '')));
  for (const stem of stems) {
    const path = join(parent, stem), owner = path + '.owner.json';
    if (await liveOwner(owner)) continue;
    // A leftover from an older policy or an outside process must not poison this thread forever.
    // Keep an unremovable tree for a later sweep; continue cleaning independent retired trees.
    try { await removeRetiredTree(path); await unlink(owner).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    catch (error) { const reason = error instanceof AcpRefusal ? error.message : `ACP retired-state sweep could not remove an old tree (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`; warnings.push(reason); if (!(error instanceof AcpRefusal)) reportRetired(path, reason); }
  }
  return warnings;
}

/** Revoke the old paths before copying; always remove the retired tree even if copying fails. */
export async function retireDirectory(path: string, inspect?: typeof rm): Promise<void> {
  const retired = join(dirname(path), `.retired-${randomUUID()}`), owner = retired + '.owner.json';
  // Publish the owner record whole: a sweep must never see it created but still empty and take it as dead.
  const pending = owner + '.pending';
  try { await writeFile(pending, JSON.stringify(process.pid), { flag: 'wx', mode: 0o600 }); await link(pending, owner); }
  catch (error) { await unlink(pending).catch(() => undefined); if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  await unlink(pending).catch(() => undefined);
  try {
    try { await rename(path, retired); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try { await inspect?.(retired, { recursive: true, force: true }); }
    finally { await removeRetiredTree(retired); }
  } finally { await unlink(owner).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
