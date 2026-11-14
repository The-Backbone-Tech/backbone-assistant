import { BASE_POLICY } from './seatbelt-policy.ts';
import { existsSync } from 'node:fs';
import { WorkspaceRefusal } from './result.ts';
import { linuxWorkspaceAvailable } from './linux-policy.ts';

export const WORKSPACE_RUNTIME_READS = ['/private/var/select', '/bin', '/usr/bin', '/usr/lib', '/System/Library', '/Library/Apple', '/Library/Developer/CommandLineTools'];

export const workspaceAvailable = async (platform = process.platform, available?: boolean, home?: string) => platform === 'darwin' ? available ?? existsSync('/usr/bin/sandbox-exec') : platform === 'linux' && available !== false && linuxWorkspaceAvailable(home);

export function workspaceCommand(mount: string, platform = process.platform, available = existsSync('/usr/bin/sandbox-exec'), label?: { permit: string; refuse: string }): string[] {
  if (platform !== 'darwin') throw new WorkspaceRefusal('Thread workspace requires macOS; execution is unavailable on this platform.');
  if (!available) throw new WorkspaceRefusal('macOS sandbox-exec is missing; workspace execution is refused.');
  if (!mount.startsWith('/') || /["\\\x00-\x1f]/.test(mount)) throw new WorkspaceRefusal('Unsafe workspace mount path.');
  // Unlike ACP's native-agent environment there is no general file-read or network grant.
  // Explicit process-info denial also closes KERN_PROCARGS2 on the qualified macOS release.
  if (label && [label.permit, label.refuse].some(path => !path.startsWith('/') || /["\\\x00-\x1f]/.test(path))) throw new WorkspaceRefusal('Unsafe workspace process label.');
  const profile = [BASE_POLICY,
    ...(label ? [`(allow file-read-metadata (literal ${JSON.stringify(label.permit)}))`, `(deny file-read-metadata (literal ${JSON.stringify(label.refuse)}))`] : []),
    '(deny process-info* (require-not (target self)))', '(deny network*)', '(deny file-read* (subpath "/Library/Keychains") (subpath "/System/Library/Keychains"))', '(deny file-write-flags)', '(deny file-write-acl)',
    '(allow file-read* (literal "/Library") (literal "/Library/Developer") (literal "/usr") (literal "/System"))',
    ...WORKSPACE_RUNTIME_READS.map(path => `(allow file-read* (subpath ${JSON.stringify(path)}))`),
    '(allow file-read* (literal "/") (literal "/private/var/select/sh") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (subpath "/dev/fd"))',
    `(allow file-read* (subpath ${JSON.stringify(mount)}))`,
    `(allow file-write* (subpath ${JSON.stringify(mount + '/work')}))`,
    `(deny file-write* (literal ${JSON.stringify(mount + '/work')}))`,
  ].join('\n');
  return ['/usr/bin/sandbox-exec', '-p', profile];
}
