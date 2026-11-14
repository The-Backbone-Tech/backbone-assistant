import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BehaviourUse } from '../target.ts';
import { guarded, HomeGuardRefusal } from './harness.ts';
import type { HomePort, Scratch } from './port.ts';

/** A port that only counts what reached it: the guard must refuse before anything does. */
function spy() {
  const reached: BehaviourUse[] = [];
  const reach = (name: string) => reached.push({ name, kind: 'process' });
  const port: HomePort = {
    async scratch(label) {
      const root = join(tmpdir(), `guard-${label}`);
      return { root, profile: join(root, 'profile'), home: (n) => join(root, n), file: (n) => join(root, n) };
    },
    async discard() {},
    async cli() {
      reach('cli');
      return { code: 0, stdout: '', stderr: '' };
    },
    async provision() {
      reach('provision');
    },
    async open() {
      reach('open');
      throw new Error('not opened');
    },
    adversary: {
      async attack() {
        reach('attack');
        return null as never;
      },
    },
  };
  return { port, reached };
}

describe('the lifecycle harness never lets a run reach the default profile (lesson 17, for the oracle itself)', () => {
  it('[V5] refuses the default profile, a Home or file outside the scratch, the scratch profile and a scratch it did not make; nothing reaches the target', async () => {
    const { port, reached } = spy();
    const homes = guarded(port);
    const s = await homes.scratch('case');
    const outsiders: Scratch = { ...s };
    for (const home of [
      join(homedir(), '.backbone', 'default'),
      join(homedir(), '.backbone'),
      join(tmpdir(), 'elsewhere'),
      s.root,
      s.profile,
      join(s.profile, '.backbone', 'default'),
      '',
    ]) {
      await expect(homes.cli(s, ['verify-ledger'], { home }), home).rejects.toBeInstanceOf(HomeGuardRefusal);
      await expect(homes.provision(home), home).rejects.toBeInstanceOf(HomeGuardRefusal);
      await expect(homes.open(home), home).rejects.toBeInstanceOf(HomeGuardRefusal);
      await expect(
        homes.adversary.attack('home.ledger.rewrite_payload', { home }),
        home,
      ).rejects.toBeInstanceOf(HomeGuardRefusal);
    }
    await expect(
      homes.adversary.attack('file.flip_byte', {
        file: join(homedir(), '.backbone', 'default', 'config.json'),
      }),
    ).rejects.toBeInstanceOf(HomeGuardRefusal);
    await expect(
      homes.cli(outsiders, ['verify-ledger'], { home: s.home('instance') }),
    ).rejects.toBeInstanceOf(HomeGuardRefusal);
    expect(reached).toEqual([]);
    // What it lets through: a Home below the scratch, or no Home (the adapter points the profile into the scratch).
    await homes.cli(s, ['verify-ledger'], { home: s.home('instance') });
    await homes.cli(s, ['verify-ledger'], { home: null });
    await homes.provision(s.home('instance'));
    await homes.adversary.attack('file.flip_byte', { file: s.file('archive') });
    expect(reached.map((r) => r.name)).toEqual(['cli', 'cli', 'provision', 'attack']);
  });
});
