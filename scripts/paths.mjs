// No machine-specific paths anywhere, no vendor version pins inside the core, no committed evidence.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isText, listFiles, read } from './lib/repo.mjs';

// An absolute path starts the token, so `components/home/x` is not one.
export const HOME_PATH = /(?:^|[\s"'`(=:,])(?:\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|~\/|[A-Z]:\\Users\\)/m;
// Pointers into the owner's private notes use the private reference instead.
export const PRIVATE_REF = /\balberto\/lanes\//;
const VENDOR_VERSION = /\b(?:codex|claude|gpt|opus|sonnet|haiku|gemini)[-_ ]?v?\d+(?:\.\d+)+/i;
const EVIDENCE_DIRS = /^(?:dist|evidence|\.pg-data|coverage)\//;
export const MAX_FILE_BYTES = 1_000_000;

export function check(root) {
  const problems = [];
  for (const f of listFiles(root)) {
    if (!existsSync(join(root, f))) continue;
    if (EVIDENCE_DIRS.test(f)) problems.push(`${f}: evidence and build output are never committed; keep them outside the repository.`);
    if (statSync(join(root, f)).size > MAX_FILE_BYTES) problems.push(`${f}: larger than ${MAX_FILE_BYTES} bytes; store it outside the repository.`);
    if (!isText(f) || f === 'scripts/paths.mjs' || f === 'scripts/checks.test.mjs') continue;
    const text = read(root, f);
    if (HOME_PATH.test(text)) problems.push(`${f}: contains an absolute home path; use a relative path or an environment variable.`);
    if (PRIVATE_REF.test(text)) problems.push(`${f}: points into the owner's private notes; use an private reference.`);
    if (f.startsWith('packages/core/') && VENDOR_VERSION.test(text)) {
      problems.push(`${f}: names a vendor model or client version inside the core; keep versions in modules or configuration.`);
    }
  }
  return problems;
}
