// An administrator runs this with an offline Ed25519 private key. It never installs policy.
import { strictJson } from '../packages/platform/src/policy/verify.ts';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function signPolicy(file, keyFile) {
  const bytes = readFileSync(file), key = createPrivateKey(readFileSync(keyFile));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The policy signing key must be Ed25519.');
  const { id, version, rollbackOf } = strictJson(bytes);
  if (typeof id !== 'string' || !Number.isSafeInteger(version) || version < 1 || (rollbackOf !== undefined && (!Number.isSafeInteger(rollbackOf) || rollbackOf <= version))) throw new Error('Policy needs a valid id, version and optional rollbackOf.');
  writeFileSync(`${file}.sig`, sign(null, bytes, key), { mode: 0o644 });
  return { keys: [createPublicKey(key).export({ type: 'spki', format: 'pem' })], deployment: { id, version: rollbackOf ?? version, sha256: createHash('sha256').update(bytes).digest('hex') } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) { process.stderr.write('Usage: node scripts/sign-managed-policy.mjs <policy.json> <private-key.pem>\n'); process.exitCode = 2; }
  else { try { process.stdout.write(JSON.stringify(signPolicy(process.argv[2], process.argv[3]), null, 2) + '\n'); } catch { process.stderr.write('Policy signing failed. Inspect the policy and offline Ed25519 key.\n'); process.exitCode = 1; } }
}
