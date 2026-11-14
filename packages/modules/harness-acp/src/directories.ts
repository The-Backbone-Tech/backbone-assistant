import { lstatSync, type Stats } from 'node:fs';
import { AcpRefusal } from './refusal.ts';

/** Host-recorded identity, captured only when creating or admitting a session directory. */
export interface DirectoryIdentity { path: string; dev: number; ino: number; mode: number }
export function directoryIdentity(path: string): DirectoryIdentity {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new AcpRefusal('ACP session folder is not its original real directory.');
  return { path, dev: info.dev, ino: info.ino, mode: info.mode };
}
export function assertDirectory(expected: DirectoryIdentity): void {
  try {
    const actual = directoryIdentity(expected.path);
    if (actual.dev === expected.dev && actual.ino === expected.ino && actual.mode === expected.mode) return;
  } catch {}
  throw new AcpRefusal('ACP session folder was replaced or changed; access refused.');
}

/** Second check behind the profile: bind an opened file to the still-checked parent and name. */
export function assertOpenedFile(directory: DirectoryIdentity, path: string, opened: Stats): void {
  assertDirectory(directory);
  const named = lstatSync(path);
  assertDirectory(directory);
  if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() || opened.nlink !== 1 || named.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino) throw new AcpRefusal('ACP opened file no longer matches its checked path.');
}
export function assertOpenedDirectory(directory: DirectoryIdentity, opened: Stats): void {
  assertDirectory(directory);
  const named = lstatSync(directory.path);
  if (!opened.isDirectory() || opened.dev !== directory.dev || opened.ino !== directory.ino || opened.mode !== directory.mode || opened.dev !== named.dev || opened.ino !== named.ino) throw new AcpRefusal('ACP opened directory no longer matches its checked path.');
}
