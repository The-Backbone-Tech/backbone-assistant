import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { claimCoreHome, claimHomeKernel, homeKernel } from '../src/composition/home-kernel.ts';
import { withHomeLock } from '../src/composition/home-lock.ts';

const homes: string[] = [];
const fresh = () => { const home = mkdtempSync(join(tmpdir(), 'backbone-kernel-')); homes.push(home); return home; };
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });
const v08 = { kernel: 'v0.8', database: 'one', workspace: 'w' };
const openV08 = (home: string) => withHomeLock(home, async () => claimHomeKernel(home, v08));

test('two kernels racing for one empty home: exactly one holds it', async () => {
  for (const order of [[claimCoreHome, openV08], [openV08, claimCoreHome]]) {
    const home = fresh();
    const results = await Promise.allSettled(order.map((open) => open(home)));
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
    assert.equal(homeKernel(home)?.kernel, order[0] === claimCoreHome ? 'core' : 'v0.8');
  }
});

test('an existing unstamped home of the older core opens as it did, with only the stamp added', async () => {
  const home = fresh();
  writeFileSync(join(home, 'core.json'), '{"kept":true}');
  await claimCoreHome(home);
  assert.equal(homeKernel(home)?.kernel, 'core');
  assert.equal(readFileSync(join(home, 'core.json'), 'utf8'), '{"kept":true}');
  assert.deepEqual(readdirSync(home).filter((name) => !name.startsWith('.')).sort(), ['core.json', 'kernel.json']);
  await claimCoreHome(home);
});

test('the older core refuses a stamped home and leaves it stamped', async () => {
  const home = fresh();
  await openV08(home);
  await assert.rejects(claimCoreHome(home), /v0\.8/);
  assert.equal(homeKernel(home)?.kernel, 'v0.8');
  assert.equal(existsSync(join(home, 'core.json')), false);
});

test('a home of the older core that cannot take the stamp opens as it did; an empty one cannot', async (t) => {
  if (process.getuid?.() === 0) return t.diagnostic('root ignores the directory mode this needs');
  const home = fresh();
  writeFileSync(join(home, 'core.json'), '{}');
  const empty = fresh();
  chmodSync(home, 0o555); chmodSync(empty, 0o555);
  t.after(() => { chmodSync(home, 0o755); chmodSync(empty, 0o755); });
  // Retain the historical grader identity; safe admission now propagates actual write refusal.
  const denied=(error:unknown)=>(error as NodeJS.ErrnoException).code==='EACCES';
  await assert.rejects(claimCoreHome(home),denied);
  assert.equal(homeKernel(home), null);
  assert.equal(readFileSync(join(home,'core.json'),'utf8'),'{}');
  assert.deepEqual(readdirSync(home),['core.json'],'no stamp or lock appears in the unwritable home');
  await assert.rejects(claimCoreHome(empty),denied);
  assert.deepEqual(readdirSync(empty),[],'the empty unwritable home is also unchanged');
});
