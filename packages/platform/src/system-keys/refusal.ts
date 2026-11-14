import { KeysRefused } from '../keys/vault.ts';

/** Stable recovery information; human wording is never a discriminator. */
export type SystemKeyRefusalReason =
  | { kind: 'store-disabled'; source: 'switch' | 'test' }
  | { kind: 'provider-mismatch'; provider: 'plaintext' | 'system' }
  | { kind: 'store-unavailable' | 'platform-unsupported' | 'missing-item' | 'wrapped-key-invalid'
      | 'downgrade' | 'invalid-choice' | 'legacy-home' | 'missing-vault' | 'app-required'
      | 'vault-unreadable' | 'keys-not-chosen' };

/** Remains a KeysRefused with the existing code and message; Vault need not change. */
export class SystemKeysRefused extends KeysRefused {
  readonly reason: Readonly<SystemKeyRefusalReason>;
  constructor(reason: SystemKeyRefusalReason, code: KeysRefused['code'], message: string) {
    super(code, message);
    this.reason = Object.freeze(reason);
  }
}
