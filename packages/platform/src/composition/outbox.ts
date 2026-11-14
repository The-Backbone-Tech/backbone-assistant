// `outbox.write`: the one operation this installation can carry out for a door today. It writes a
// named file into the data home's `outbox` folder, where the person picks it up. A file already
// there with other words is not overwritten (FAILED); the same words again are the same effect.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Executor } from '../gateway.ts';
import { sha256, writeAtomic } from '../stub/fsx.ts';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_BYTES = 256 * 1024;

export function outboxExecutor(home: string): Executor {
  const dir = join(home, 'outbox');
  const target = (args: Record<string, unknown>) => join(dir, String(args.name));
  return {
    validate(args) {
      if (typeof args.name !== 'string' || !NAME.test(args.name) || args.name.endsWith('.tmp')) return 'name is a plain file name (letters, digits, dot, dash, underscore)';
      if (typeof args.content !== 'string') return 'content is text';
      if (Buffer.byteLength(args.content) > MAX_BYTES) return `content is at most ${MAX_BYTES} bytes`;
      // Fixed words only: a refusal never repeats the caller's names or values.
      return Object.keys(args).some((k) => k !== 'name' && k !== 'content') ? 'only name and content are accepted' : null;
    },
    async dispatch(args) {
      const path = target(args);
      const want = sha256(String(args.content));
      if (existsSync(path)) {
        const have = sha256(readFileSync(path));
        return have === want
          ? { outcome: 'succeeded', evidence: want, note: 'already in the outbox with these words' }
          : { outcome: 'failed', evidence: have, note: 'a different file of that name is in the outbox; it was left as it is' };
      }
      writeAtomic(path, String(args.content));
      return { outcome: 'succeeded', evidence: want };
    },
    async inspect(args) {
      const path = target(args);
      const want = sha256(String(args.content));
      const landed = existsSync(path) && sha256(readFileSync(path)) === want;
      return { landed, evidence: landed ? want : sha256(`not-found:${want}`) };
    },
  };
}
