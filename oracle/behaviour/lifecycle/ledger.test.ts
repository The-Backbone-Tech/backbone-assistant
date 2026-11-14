import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { newWorld, propose } from '../../core/harness.ts';
import type { Id } from '../../target.ts';
import { exists, ok, refusedBy, useHomes, withHome } from './harness.ts';
import type { CliResult, Scratch } from './port.ts';

const homes = useHomes('ledger');

let s: Scratch;
let home: string;
let first: Id;
let second: Id;

/** The output line that names `ws`. */
const lineOf = (result: CliResult, ws: Id) =>
  result.stdout.split('\n').find((line) => line.includes(ws)) ?? '';

beforeAll(async () => {
  s = await homes().scratch('ledger');
  home = s.home('instance');
  await homes().provision(home);
  const made = await withHome(homes(), home, async (t) => {
    const ids: Id[] = [];
    for (const name of ['Ledger one', 'Ledger two']) {
      const w = await newWorld(t, `${name} ${randomUUID().slice(0, 6)}`, { verifier: false });
      await propose(w);
      ids.push(w.ws);
    }
    return ids;
  });
  first = made[0] ?? '';
  second = made[1] ?? '';
});

describe('backbone verify-ledger', () => {
  it('[S10] passes on a healthy instance, naming every workspace', async () => {
    const result = ok(await homes().cli(s, ['verify-ledger'], { home }), 'verify-ledger');
    expect(lineOf(result, first)).toMatch(/\bOK\b/);
    expect(lineOf(result, second)).toMatch(/\bOK\b/);
  });

  it('[S10] fails, non-zero, naming the workspace and the entry, when an entry was rewritten below every grant', async () => {
    await homes().adversary.attack('home.ledger.rewrite_payload', { home, workspace: first, seq: 2 });
    const result = await homes().cli(s, ['verify-ledger'], { home });
    expect(result.code, result.stdout).not.toBe(0);
    expect(lineOf(result, first), 'the tampered workspace is not named as failing').not.toMatch(/\bOK\b/);
    expect(lineOf(result, first), 'the first bad entry is not named').toMatch(/\b2\b/);
    expect(lineOf(result, second), 'the untouched workspace no longer verifies').toMatch(/\bOK\b/);
  });

  it('[S10] refuses a Home with no instance, and creates none', async () => {
    const none = s.home('no-instance');
    refusedBy(await homes().cli(s, ['verify-ledger'], { home: none }), /instance/i);
    expect(await exists(none)).toBe(false);
  });
});
