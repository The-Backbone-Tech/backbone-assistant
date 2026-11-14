// A key the person stored in the macOS Keychain themselves (`security add-generic-password -s <service>`),
// read at request time and nowhere else: never copied into the home, a log, an event or a model's input.
// Only the services named here can be reached, and only by a host told to (the desktop app).
import { execFile, execFileSync } from 'node:child_process';

/** The Keychain services a route may read, by the handle that names each. */
export const KEYCHAIN_SERVICES = Object.freeze({ 'keychain:backbone-openrouter': 'backbone-openrouter' } as const);
export type KeychainHandle = keyof typeof KEYCHAIN_SERVICES;
export const isKeychainHandle = (handle: unknown): handle is KeychainHandle =>
  typeof handle === 'string' && Object.hasOwn(KEYCHAIN_SERVICES, handle);

export interface KeychainReader {
  /** Whether the item exists, without reading its value. */
  has(service: string): boolean;
  /** The item's value; it throws when there is none. */
  read(service: string): Promise<string>;
}

const SECURITY = '/usr/bin/security';

/** The real reader, through Apple's `security` tool. The value travels only on its stdout pipe. */
export function macosKeychain(): KeychainReader {
  return {
    has(service) {
      if (process.platform !== 'darwin') return false;
      try { execFileSync(SECURITY, ['find-generic-password', '-s', service], { stdio: 'ignore', timeout: 5_000 }); return true; }
      catch { return false; }
    },
    read(service) {
      return new Promise((resolve, reject) => {
        if (process.platform !== 'darwin') { reject(new Error('The Keychain is only on macOS.')); return; }
        execFile(SECURITY, ['find-generic-password', '-s', service, '-w'], { timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
          const value = String(stdout ?? '').replace(/\n$/, '');
          // The tool's own error text can name the item; a fixed message says only what is missing.
          if (error || !value) reject(new Error(`No key is stored in the Keychain under ${service}.`));
          else resolve(value);
        });
      });
    },
  };
}

/**
 * Whether a launch is the person's own app, which reads their Keychain routes. Every test and journey
 * launch names its own data home (BACKBONE_HOME) or a scripted model, so none of them can find a real key.
 */
export const personKeychainRoutes = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform) =>
  platform === 'darwin' && !env.BACKBONE_HOME && !env.BACKBONE_MODEL_ENDPOINT && env.BACKBONE_KEYS !== 'plaintext';
