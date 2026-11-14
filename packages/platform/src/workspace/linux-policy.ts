import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { workspaceProcess } from './runtime.ts';
import { WorkspaceRefusal } from './result.ts';

export const LINUX_RUNTIME_READS = ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/bin', '/sbin', '/lib', '/lib64', '/etc/ld.so.cache', '/etc/alternatives'];
/** Namespace ABI and probe parent; test mounts bind their own private directory here. */
export const LINUX_PROBE_PARENT = '/tmp';
const SECCOMP_LIBRARIES = ['/lib/aarch64-linux-gnu/libseccomp.so.2', '/lib/x86_64-linux-gnu/libseccomp.so.2', '/lib64/libseccomp.so.2', '/usr/lib64/libseccomp.so.2', '/usr/lib/libseccomp.so.2'];
const MISSING = 'Linux workspace requires bubblewrap (/usr/bin/bwrap), Python 3 (/usr/bin/python3), util-linux unshare (/usr/bin/unshare) and libseccomp.so.2; execution is refused.';
type Readiness = { available: boolean; detail: string };
let cached: (Readiness & { uid: number; at: number }) | undefined;
let probing: { uid: number; promise: Promise<Readiness> } | undefined;
async function readiness(home?: string): Promise<Readiness> {
  if (process.arch !== 'arm64') return { available: false, detail: 'Linux workspace is qualified only on arm64; this architecture is unqualified.' };
  const uid = process.getuid?.() ?? 0;
  if (uid === 0) return { available: false, detail: 'Linux workspace must run as an unprivileged user; no workspace was created.' };
  // Discovery must not turn an ambient TMPDIR into an unadmitted data-home write.
  // Check each caller's home before sharing even an already successful probe.
  if (home && isAbsolute(home)) {
    try {
      const owner = realpathSync(home), parent = realpathSync(LINUX_PROBE_PARENT);
      if (owner === '/' || owner === parent || parent.startsWith(owner + '/')) return { available: false, detail: 'This data home overlaps the workspace temporary probe parent; execution is refused without creating state.' };
      const controls = '/sys/fs/cgroup';
      if (owner === controls || owner.startsWith(controls + '/') || controls.startsWith(owner + '/')) return { available: false, detail: 'This data home overlaps the workspace cgroup hierarchy; execution is refused without creating state.' };
    } catch { return { available: false, detail: 'The workspace data-home boundary could not be confirmed; execution is refused.' }; }
  }
  if (!existsSync('/usr/bin/bwrap') || !existsSync('/usr/bin/python3') || !existsSync('/usr/bin/unshare') || !SECCOMP_LIBRARIES.some(path => existsSync(path))) return { available: false, detail: MISSING };
  if (cached?.uid === uid && Date.now() - cached.at < 30_000) return cached;
  if (probing?.uid === uid) return probing.promise;
  const promise = (async () => {
    let available = false, detail = 'Linux namespace, bounded-volume or seccomp preflight refused execution; no workspace was created.';
    let folder: string | undefined;
    try {
      // Share one asynchronous launch probe. Its owned directory is removed even if Python
      // times out; parent-death handling closes any namespace before it can outlive the probe.
      folder = await mkdtemp(join(LINUX_PROBE_PARENT, 'workspace-preflight-'));
      const stdout = await new Promise<string>((resolve, reject) => execFile('/usr/bin/python3', ['-I', '-S', '-c', readFileSync(workspaceProcess('linux'), 'utf8'), 'preflight', folder!], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65_536 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      const value = JSON.parse(stdout) as { code?: number; reason?: string };
      available = value.code === 0 && !value.reason;
      if (!available && typeof value.reason === 'string') detail = value.reason;
    } catch { /* A failed inspection never offers an unconfined command. */ }
    finally { if (folder) await rm(folder, { recursive: true, force: true }); }
    cached = { uid, at: Date.now(), available, detail };
    return cached;
  })();
  probing = { uid, promise };
  try { return await promise; } finally { if (probing?.promise === promise) probing = undefined; }
}
export const linuxWorkspaceAvailable = async (home?: string) => (await readiness(home)).available;
export async function assertLinuxWorkspace(home?: string) {
  const state = await readiness(home);
  if (!state.available) throw new WorkspaceRefusal(state.detail);
}
