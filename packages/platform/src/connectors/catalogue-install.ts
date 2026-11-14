// The release archive digest is pinned independently of the download location. Never execute an
// archive member, and never extract its paths: retain only the one executable we requested.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeDurable } from '@backbone-next/kernel/files';
import { assertHomeWriteAdmission, withHomeLock } from '../composition/home-lock.ts';
const execute = promisify(execFile);
export const GITHUB_RELEASES: Record<string, { asset: string; sha256: string }> = {
  'darwin-arm64': { asset: 'Darwin_arm64', sha256: '3fb2936c33416693a8b268442ab9b1e838d4fbb8c2a6813d8a77f87c3009ced6' },
  'darwin-x64': { asset: 'Darwin_x86_64', sha256: '3c4b023b0d90bdc8f3a2ab63307ff55d293e98c27e733008eed0fa35aca55499' },
  'linux-arm64': { asset: 'Linux_arm64', sha256: '34d5a268f65cd1e9b7107fa976f3571ccd575f9df00cec489fec79a039923a22' },
  'linux-x64': { asset: 'Linux_x86_64', sha256: 'a442f9db287cea01008bcb55fe6bc0292270301046c3edbd1a8b22d6e4157b2b' },
};
export const binaryDigest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
/** Preserve the verified extraction pin; never bless bytes replaced before bundle sealing. */
export function verifiedBinaryDigest(binary: { path: string; digest: string }, command: string | undefined): string {
  if (command !== binary.path || binaryDigest(binary.path) !== binary.digest) throw new Error('The installed executable changed before sealing.');
  return binary.digest;
}
export async function installCatalogueGithub(home: string, signal: AbortSignal): Promise<{ path: string; digest: string }> {
  const release = GITHUB_RELEASES[`${process.platform}-${process.arch}`];
  if (!release) throw new Error('This platform has no qualified GitHub catalogue executable.');
  return installPinnedGithubArchive(home, signal, { url: `https://github.com/github/github-mcp-server/releases/download/v2.1.0/github-mcp-server_${release.asset}.tar.gz`, sha256: release.sha256 });
}
/** The source seam is trusted constructor/test input, never a config or renderer parameter. */
export async function installPinnedGithubArchive(home: string, signal: AbortSignal, source: { url: string; sha256: string; maxBytes?: number }): Promise<{ path: string; digest: string }> {
  const limit = source.maxBytes ?? 64 * 1024 * 1024;
  const response = await fetch(source.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
  if (!response.ok || Number(response.headers.get('content-length')) > limit) throw new Error('The pinned GitHub release download failed or exceeded its size limit.');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body!) { size += chunk.length; if (size > limit) throw new Error('The GitHub release exceeded its size limit.'); chunks.push(chunk); }
  const archive = Buffer.concat(chunks);
  if (createHash('sha256').update(archive).digest('hex') !== source.sha256) throw new Error('The GitHub release digest did not match its pin. Nothing was installed.');
  return withHomeLock(home, async () => {
    signal.throwIfAborted();
    const root = join(home, 'connectors', 'bin');
    assertHomeWriteAdmission(home, root); mkdirSync(root, { recursive: true, mode: 0o700 });
    assertHomeWriteAdmission(home, root); const scratch = mkdtempSync(join(root, '.github-'));
    try {
      const file = join(scratch, 'release.tar.gz');
      assertHomeWriteAdmission(home, scratch); writeDurable(file, archive);
      const { stdout } = await execute('tar', ['-xOf', file, 'github-mcp-server'], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, signal });
      const licence = await execute('tar', ['-xOf', file, 'LICENSE'], { encoding: 'utf8', maxBuffer: 64 * 1024, signal });
      if (!licence.stdout.includes('MIT License')) throw new Error('The pinned release did not include its expected licence.');
      const path = join(root, 'github-mcp-server-2.1.0');
      assertHomeWriteAdmission(home, root); writeDurable(`${path}.LICENSE`, licence.stdout);
      assertHomeWriteAdmission(home, root); writeDurable(path, stdout, 0o700);
      return { path, digest: createHash('sha256').update(stdout).digest('hex') };
    } finally { assertHomeWriteAdmission(home, scratch); rmSync(scratch, { recursive: true, force: true }); }
  });
}
