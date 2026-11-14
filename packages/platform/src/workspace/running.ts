import { readFile, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { processIdentity, stopSandbox, type ProcessIdentity } from './processes.ts';
export interface Running extends ProcessIdentity { token: string; deadline: number }
export async function running(folder: string): Promise<Running | null> {
  try {
    const value = JSON.parse(await readFile(join(folder, '.running'), 'utf8')) as Running;
    if (!Number.isSafeInteger(value.pid) || value.pid <= 1 || !/^\d+:\d+$/.test(value.start) || !/^[a-f0-9-]{36}$/.test(value.token) || !Number.isSafeInteger(value.deadline)) return null;
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
export async function runningAlive(folder: string): Promise<boolean> {
  const record = await running(folder);
  if (!record) return false;
  const now = await processIdentity(record.pid);
  return !!now && now.start === record.start && now.uid === record.uid;
}
/** Only a dead supervisor's label can be reclaimed. Pid reuse never targets the replacement. */
export async function recoverRunning(folder: string): Promise<void> {
  if (await runningAlive(folder)) throw new Error('The previous workspace supervisor is still closing; this command did not run.');
  const record = await running(folder);
  if (record) {
    const permit = join(folder, `.permit-${record.token}`), refuse = join(folder, `.refuse-${record.token}`);
    const labeled = await Promise.all([access(permit), access(refuse)]).then(() => true, () => false);
    if (labeled) await stopSandbox(permit, refuse);
    for (const path of [permit, refuse]) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  await unlink(join(folder, '.running')).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
