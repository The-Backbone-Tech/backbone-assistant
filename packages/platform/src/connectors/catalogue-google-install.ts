import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { writeDurable } from '@backbone-next/kernel/files';
import { assertHomeWriteAdmission, withHomeLock } from '../composition/home-lock.ts';
import { GOOGLE_REQUIREMENTS } from './catalogue-google-lock.ts';
import { binaryDigest } from './catalogue-install.ts';
const execute = promisify(execFile);
/** Fixed native installation locations; neither PATH nor the renderer chooses uv. */
export function resolveCatalogueUv(): string {
  for (const path of [join(homedir(), '.local', 'bin', 'uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv', '/usr/bin/uv']) {
    try { accessSync(path, constants.X_OK); return realpathSync(path); } catch { /* Try the next explicit install location. */ }
  }
  throw new Error('Install uv in a supported native location before connecting Google.');
}
export async function installCatalogueGoogle(home: string, instance: string, signal: AbortSignal, nativeUv = resolveCatalogueUv()): Promise<{ path: string; digest: string }> {
  if (!isAbsolute(nativeUv)) throw new Error('An absolute uv executable is required.');
  const uv = realpathSync(nativeUv), root = join(home, 'connectors', 'bin', `google-${instance}`);
  try {
    await withHomeLock(home, async () => {
      assertHomeWriteAdmission(home, root); mkdirSync(root, { recursive: true, mode: 0o700 });
      assertHomeWriteAdmission(home, root); writeDurable(join(root, 'requirements.txt'), GOOGLE_REQUIREMENTS);
    });
    const env = getDefaultEnvironment();
    // No app/provider variables reach the installer. No source builds or floating resolution.
    assertHomeWriteAdmission(home, root);
    await execute(uv, ['--no-config', 'venv', '--python', '3.13', '--no-python-downloads', join(root, 'venv')], { env, signal, timeout: 60_000 });
    assertHomeWriteAdmission(home, root);
    await execute(uv, ['--no-config', 'pip', 'sync', '--python', join(root, 'venv', 'bin', 'python'), '--require-hashes', '--only-binary', ':all:', join(root, 'requirements.txt')], { env, signal, timeout: 180_000, maxBuffer: 1024 * 1024 });
    const path = join(root, 'venv', 'bin', 'workspace-mcp');
    return { path, digest: binaryDigest(path) };
  } catch (error) { assertHomeWriteAdmission(home, root); rmSync(root, { recursive: true, force: true }); throw error; }
}
