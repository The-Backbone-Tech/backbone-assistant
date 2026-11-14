/** A wrapping-key store. Implementations must never put values in diagnostics. */
export interface SystemKeyStore {
  available(): Promise<boolean>;
  /** Null means missing, not an unavailable or locked store. */
  get(account: string): Promise<Buffer | null>;
  /** Install a new key under the caller's home lock; refuse observed existing or locked items. */
  create(account: string, key: Buffer): Promise<void>;
}

export const SERVICE = 'io.github.albertoangulo.backbone.home-keys';
export const SYSTEM_WRAP = 'os-keyring-v1';
export const ACCOUNT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
