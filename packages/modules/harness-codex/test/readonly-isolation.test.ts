import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifySandbox } from '../src/staging.ts';

const result = { inside_read: 'allowed', inside_write: 'denied', outside_read: 'denied', outside_write: 'allowed', denied_read: 'denied', symlink_read: 'denied', child_inside_read: 'allowed', child_read: 'denied', alias_read: 'denied', network: 'denied', temp_read: 'denied', temp_write: 'denied', var_temp_read: 'denied', var_temp_write: 'denied' };
for (const fault of ['none', 'fully-denied', 'base-host-create', 'base-host-modify', 'base-host-extra', 'host-create', 'host-modify', 'host-extra', 'concurrent-leak', 'later-leak', 'same-namespace', 'namespace-array', 'write-array', 'reader-array', 'all-denied', 'release-blocked', 'missing-ready'] as const) {
  test(`Linux read-only private writes: ${fault}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-isolation-test-')), stage = join(root, 'stage');
    await mkdir(stage); let readers = 0, writers = 0, writerSettled = false;
    try {
      const command = async (args: string[], observe?: (output: string) => void) => {
        const program = args[args.indexOf('-e') + 1];
        if (!program.includes('backbone-readonly-isolation-v1')) {
          if (fault === 'base-host-create') await writeFile(join(root, 'outside-write-canary'), 'changed');
          if (fault === 'base-host-modify') await writeFile(join(root, 'outside-canary'), 'changed');
          if (fault === 'base-host-extra') await writeFile(join(root, 'unexpected'), 'changed');
          return JSON.stringify(fault === 'fully-denied' ? { ...result, outside_write: 'denied' } : result);
        }
        const spec = JSON.parse(args.at(-1)!);
        if (spec.phase === 'write') {
          writers++;
          if (fault === 'missing-ready') return '{}';
          if (fault === 'host-create') await writeFile(spec.targets[0], spec.token);
          if (fault === 'host-modify') await writeFile(join(root, 'outside-canary'), 'changed');
          if (fault === 'host-extra') await writeFile(join(root, 'unexpected'), 'changed');
          const ready = JSON.stringify({ ready: true, namespace: fault === 'namespace-array' ? ['mnt:[1]'] : 'mnt:[1]', writes: fault === 'write-array' ? [['allowed'], 'denied', 'denied'] : ['all-denied', 'fully-denied'].includes(fault) ? ['denied', 'denied', 'denied'] : ['allowed', 'denied', 'denied'] });
          if (fault === 'release-blocked') await mkdir(spec.release);
          observe?.(ready + '\n');
          if (fault === 'release-blocked') { await new Promise(resolve => setTimeout(resolve, 100)); writerSettled = true; return ready + '\n' + JSON.stringify({ released: true }); }
          for (let i = 0; i < 1000; i++) {
            try { if (await readFile(spec.release, 'utf8') === spec.token) return ready + '\n' + JSON.stringify({ released: true }); } catch {}
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          throw Error('synthetic writer not released');
        }
        readers++;
        return JSON.stringify({ inside_read: 'allowed', namespace: fault === 'same-namespace' ? 'mnt:[1]' : 'mnt:[2]', private_reads: spec.readTargets.map(() => fault === 'reader-array' ? ['absent'] : fault === 'concurrent-leak' || (fault === 'later-leak' && readers > 1) ? 'visible' : 'absent') });
      };
      const verification = verifySandbox(command, root, stage, 'readOnly', process.execPath, 'linux');
      if (fault === 'none' || fault === 'fully-denied') { await verification; assert.equal(writers, 1); assert.equal(readers, 2); }
      else await assert.rejects(verification, /read-only isolation/);
      if (fault === 'release-blocked') assert.equal(writerSettled, true, 'cleanup joined the writer despite release failure');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
