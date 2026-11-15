import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { accessSync, constants, statSync } from 'node:fs';
import type { KeysRefused } from '../keys/vault.ts';
import { SystemKeysRefused, type SystemKeyRefusalReason } from './refusal.ts';
import { ACCOUNT, SERVICE, type SystemKeyStore } from './store.ts';

export const STORE_UNAVAILABLE = 'No usable system key store is available (macOS Keychain or Linux Secret Service with /usr/bin/secret-tool). Unlock or start the store and try again. For an explicit plaintext data folder, BACKBONE_KEYS=plaintext writes the data key in plain text; copied data folders and backups expose it. Nothing falls back to plaintext.';
export const unavailable = () => new SystemKeysRefused({ kind: ['darwin', 'linux'].includes(process.platform) ? 'store-unavailable' : 'platform-unsupported' }, 'no-keychain', process.platform === 'win32' ? 'System key storage is not supported on Windows yet. ' + STORE_UNAVAILABLE : STORE_UNAVAILABLE);

// Preserve only errors made here; an injected store's arbitrary text remains private.
const denials = new WeakMap<Error, { message: string; reason: Readonly<SystemKeyRefusalReason> }>();
export function testStoreRefusal(env: NodeJS.ProcessEnv = process.env): KeysRefused | null {
  const switched = env.BACKBONE_SYSTEM_STORE_UNAVAILABLE === '1' || process.env.BACKBONE_SYSTEM_STORE_UNAVAILABLE === '1';
  const rawTest = !!process.env.NODE_TEST_CONTEXT && process.env.BACKBONE_TEST_SYSTEM_KEYCHAIN !== '1';
  if (!switched && !rawTest) return null;
  const error = new SystemKeysRefused({ kind: 'store-disabled', source: switched ? 'switch' : 'test' }, 'no-keychain', switched
    ? 'System key storage is disabled by BACKBONE_SYSTEM_STORE_UNAVAILABLE=1. Remove this refusal switch from the real command environment to use the store; nothing was changed.'
    : 'System key storage is disabled in a Node test process. Only the explicitly scoped temporary-keychain test may opt in; nothing was changed.');
  denials.set(error, { message: error.message, reason: error.reason });
  return error;
}
export const storeFailure = (error: unknown): KeysRefused => error instanceof Error && denials.has(error)
  ? new SystemKeysRefused(denials.get(error)!.reason, 'no-keychain', denials.get(error)!.message) : unavailable();

export interface ToolRequest { executable: string; args: string[]; input?: Buffer; env: NodeJS.ProcessEnv }
export interface ToolResult { code: number | null; stdout: Buffer; errorOutput: boolean }
export type ToolRunner = (request: ToolRequest) => Promise<ToolResult>;

/** Test wrappers set an unconditional denial. Raw Node tests are denied as well unless opted in. */
function realStoreDenied(env: NodeJS.ProcessEnv): boolean {
  return process.env.BACKBONE_SYSTEM_STORE_UNAVAILABLE === '1' || env.BACKBONE_SYSTEM_STORE_UNAVAILABLE === '1'
    || (!!process.env.NODE_TEST_CONTEXT && process.env.BACKBONE_TEST_SYSTEM_KEYCHAIN !== '1');
}

/** No shell, no inherited stdio, no raw child errors. The bound includes exit and pipe closure. */
export const runTool: ToolRunner = (request) => new Promise((resolve, reject) => {
  if ((request.executable === '/usr/bin/security' || request.executable === '/usr/bin/secret-tool') && realStoreDenied(request.env)) { reject(testStoreRefusal(request.env)!); return; }
  let child: ReturnType<typeof spawn>;
  try { child = spawn(request.executable, request.args, { env: request.env, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { reject(unavailable()); return; }
  let output = Buffer.alloc(0), errorOutput = false, settled = false;
  const fail = () => {
    if (settled) return;
    settled = true; clearTimeout(timer); child.kill('SIGKILL'); reject(unavailable());
  };
  const timer = setTimeout(fail, 3_000);
  child.on('error', fail);
  child.stdin!.on('error', () => {}); // EPIPE is reported by the exit, without the input buffer.
  child.stdout!.on('data', (chunk: Buffer) => {
    if (output.length + chunk.length > 4096) { fail(); return; }
    output = Buffer.concat([output, chunk]);
  });
  child.stderr!.on('data', () => { errorOutput = true; }); // Discard, including any unexpected echo.
  child.on('close', (code) => {
    if (settled) return;
    settled = true; clearTimeout(timer); resolve({ code, stdout: output, errorOutput });
  });
  child.stdin!.end(request.input);
});

/** Interactive security is not a shell. Quote its tokenizer's arguments, rejecting control bytes. */
export function securityWord(word: string): string {
  if (/[\x00-\x1f\x7f]/.test(word)) throw unavailable();
  return `"${word.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function toolEnvironment(platform: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const fixed: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', LC_ALL: 'C' };
  // Only session locators, never arbitrary inherited variables (NODE_OPTIONS, DYLD_*, etc.).
  if (platform === 'linux') for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) {
    if (env[name]) fixed[name] = env[name];
  }
  return fixed;
}

/** keychain is an explicit scope for the opt-in Mac test; never taken from the environment. */
export function toolStore(options: { platform?: string; env?: NodeJS.ProcessEnv; keychain?: string; run?: ToolRunner } = {}): SystemKeyStore {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runTool;
  const chosenEnv = options.env ?? process.env;
  const disabled = chosenEnv.BACKBONE_SYSTEM_STORE_UNAVAILABLE === '1' || (!options.run && !!testStoreRefusal(chosenEnv));
  const env = toolEnvironment(platform, chosenEnv);
  const keychain = options.keychain;
  if (keychain && (!isAbsolute(keychain) || platform !== 'darwin')) throw unavailable();
  const call = async (args: string[], input?: Buffer): Promise<ToolResult> => {
    if (disabled) throw testStoreRefusal(chosenEnv)!;
    try { return await run({ executable: platform === 'darwin' ? '/usr/bin/security' : '/usr/bin/secret-tool', args, input, env }); }
    catch (error) { throw storeFailure(error); }
  };
  // Metadata only: never ask the Security framework for settings on a locked keychain.
  // default-keychain without -s only reads the preference; item operations are then scoped.
  const macFile = (path: string): string => {
    if (disabled) throw testStoreRefusal(chosenEnv)!;
    if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw unavailable();
    try { accessSync(path, constants.R_OK); if (!statSync(path).isFile()) throw unavailable(); }
    catch { throw unavailable(); }
    return path;
  };
  const macPath = async (): Promise<string> => {
    let path = keychain;
    if (!path) {
      const result = await call(['default-keychain', '-d', 'user']);
      if (result.code !== 0 || result.errorOutput) throw unavailable();
      const text = result.stdout.toString('utf8').trim();
      if (!/^"[^"\r\n]+"$/.test(text)) throw unavailable();
      path = text.slice(1, -1);
    }
    return macFile(path);
  };
  const validAccount = (account: string) => { if (!ACCOUNT.test(account)) throw unavailable(); };
  const get = async (account: string): Promise<Buffer | null> => {
    validAccount(account);
    const scope = platform === 'darwin' ? [await macPath()] : [];
    const result = await call(platform === 'darwin'
      ? ['find-generic-password', '-w', '-s', SERVICE, '-a', account, ...scope]
      : ['lookup', 'service', SERVICE, 'account', account]);
    if (platform === 'darwin' && result.code === 44) {
      // A file can disappear between lookup and this check. Readability does not
      // prove unlocked/uncorrupted state: an OS failure reported as 44 remains ambiguous.
      macFile(scope[0]!);
      return null;
    }
    if (platform === 'linux' && result.code === 1 && !result.errorOutput) {
      // Lookup returns null both for absence and a dismissed unlock. Search without --unlock
      // still exposes matching locked metadata. Capture/discard all output, including secrets.
      const search = await call(['search', '--all', 'service', SERVICE, 'account', account]);
      if (search.code !== 0 || search.stdout.length || search.errorOutput) throw unavailable();
      return null;
    }
    if (result.code !== 0) throw unavailable();
    const text = result.stdout.toString('utf8').trim();
    if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) throw unavailable();
    return Buffer.from(text, 'base64');
  };
  const supported = () => platform === 'darwin' || platform === 'linux';
  return {
    async available() {
      if (!supported()) return false;
      try {
        if (platform === 'darwin') await macPath();
        else {
          // No --unlock, and no credential lookup during an availability probe.
          const result = await call(['search', '--all', 'service', SERVICE, 'account', randomUUID()]);
          if (result.code !== 0 || result.stdout.length || result.errorOutput) return false;
        }
        return true;
      } catch { return false; }
    },
    async get(account) { if (!supported()) throw unavailable(); return get(account); },
    async create(account, key) {
      if (!supported() || key.length !== 32) throw unavailable();
      validAccount(account);
      if (await get(account)) throw unavailable();
      const scope = platform === 'darwin' ? [await macPath()] : [];
      const input = platform === 'darwin'
        ? Buffer.from(['add-generic-password', '-s', SERVICE, '-a', account, '-T', '/usr/bin/security', '-w', key.toString('base64'), ...scope].map(securityWord).join(' ') + '\n')
        : Buffer.from(key.toString('base64'));
      try {
        const result = await call(platform === 'darwin' ? ['-q', '-i'] : ['store', '--label=Data home wrapping key', 'service', SERVICE, 'account', account], input);
        if (result.code !== 0 || result.errorOutput) throw unavailable();
      } finally { input.fill(0); }
    },
  };
}
