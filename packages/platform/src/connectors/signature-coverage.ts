// Compatibility only: preserve the meaning of signatures given before argument-wide coverage.
import { createHash } from 'node:crypto';
export const SENDING_ARG = /^(send|send_?now|auto_?send|send_?immediately|publish|post|share|deliver|notify|broadcast)$/i;
// This is the released rule, including its depth bound and false-like exceptions.
export const sendingArgs = (v: unknown, depth = 0): boolean => !!v && typeof v === 'object' && (depth >= 32
  || Object.entries(v as Record<string, unknown>).some(([k, x]) => (SENDING_ARG.test(k) && x !== false && x !== null && x !== 0 && x !== '' && x !== 'false') || sendingArgs(x, depth + 1)));
export const coverageDigest = (definition: string) => createHash('sha256').update(JSON.stringify(['connector-signature-coverage', 1, definition])).digest('hex');
export const LEGACY_ARGUMENTS = 'This signature was given before it covered sending arguments. This call waits for you; signing again covers those arguments.';
