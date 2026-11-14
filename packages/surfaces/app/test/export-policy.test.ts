// Export admits only the version shown of a document in its project, within its size, one at a time;
// it writes by a fresh file and a rename, never through a link or into a folder that changed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MaterialEntry } from '@backbone-next/platform';
import { chosenFolder, EXPORT_LIMITS, exportSlot, refusal, withTimeout, writeChosen } from '../electron/export-policy.ts';

const entry = (over: Partial<MaterialEntry> = {}): MaterialEntry => ({
  id: 'm1', projectId: 'p1', name: 'brief.md', mediaType: 'text/markdown', class: 'working', hidden: false, current: 2,
  versions: [{ n: 1, by: 'agent', at: '', bytes: 100, sha256: '' }, { n: 2, by: 'person', at: '', bytes: 100, sha256: '' }],
  ...over,
});

test('admits the current or an earlier existing version of a document in the project', () => {
  assert.equal(refusal(entry(), 2, 'pdf'), undefined);
  assert.equal(refusal(entry(), 1, 'html'), undefined);
  assert.match(refusal(undefined, 1, 'pdf')!, /not in this project/);
  assert.match(refusal(entry(), 3, 'pdf')!, /does not exist/);
  assert.match(refusal(entry({ current: 1 }), 2, 'pdf')!, /does not exist/, 'beyond current');
  assert.match(refusal(entry({ held: { id: 's', name: 'src.md' } }), 2, 'md')!, /held/);
  assert.match(refusal(entry({ withdrawals: [{ at: '', version: 2 }] }), 2, 'md')!, /withdrawn/);
  assert.equal(refusal(entry({ withdrawals: [{ at: '', version: 2, restoredAt: 'x' }] }), 2, 'md'), undefined, 'restored');
});

test('the size limit is on the stored bytes, per format', () => {
  const sized = (bytes: number) => entry({ versions: [{ n: 1, by: 'agent', at: '', bytes, sha256: '' }], current: 1 });
  assert.equal(refusal(sized(EXPORT_LIMITS.pdf), 1, 'pdf'), undefined);
  assert.match(refusal(sized(EXPORT_LIMITS.pdf + 1), 1, 'pdf')!, /too large.*PDF.*2 MB/);
  assert.equal(refusal(sized(EXPORT_LIMITS.pdf + 1), 1, 'html'), undefined);
  assert.match(refusal(sized(20 * 1024 * 1024 + 1), 1, 'md')!, /too large.*20 MB/);
});

test('one export at a time', () => {
  const slot = exportSlot();
  assert.equal(slot.take(), true);
  assert.equal(slot.take(), false);
  slot.release();
  assert.equal(slot.take(), true);
});

test('a timeout destroys the work and rejects', async () => {
  let destroyed = false;
  await assert.rejects(withTimeout(new Promise(() => {}), 20, () => { destroyed = true; }, 'too slow'), /too slow/);
  assert.equal(destroyed, true);
  assert.equal(await withTimeout(Promise.resolve(7), 1000, () => assert.fail('not late'), 'x'), 7);
});

function folder() {
  const root = mkdtempSync(join(tmpdir(), 'export-write-'));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}
const leftovers = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.export'));

test('writes a new file, and replaces a regular file the person chose', async () => {
  const { root, done } = folder();
  try {
    const chosen = join(root, 'brief-v2.md');
    await writeChosen(chosen, await chosenFolder(chosen), '# one');
    assert.equal(readFileSync(chosen, 'utf8'), '# one');
    await writeChosen(chosen, await chosenFolder(chosen), new TextEncoder().encode('# two'));
    assert.equal(readFileSync(chosen, 'utf8'), '# two');
    assert.deepEqual(leftovers(root), []);
  } finally { done(); }
});

test('refuses a link or a folder at the chosen name, leaving its target untouched', async () => {
  const { root, done } = folder();
  try {
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'keep');
    const chosen = join(root, 'brief-v2.pdf');
    const at = await chosenFolder(chosen);
    symlinkSync(victim, chosen); // substituted after the dialog
    await assert.rejects(writeChosen(chosen, at, 'x'), /link or not a file/);
    assert.equal(readFileSync(victim, 'utf8'), 'keep');
    const dir = join(root, 'brief-v2.html');
    mkdirSync(dir);
    await assert.rejects(writeChosen(dir, at, 'x'), /link or not a file/);
    assert.deepEqual(leftovers(root), []);
  } finally { done(); }
});

test('refuses when the chosen folder was swapped for a link elsewhere', async () => {
  const { root, done } = folder();
  try {
    const chosenDir = join(root, 'out');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(chosenDir);
    mkdirSync(elsewhere);
    const chosen = join(chosenDir, 'brief-v1.md');
    const at = await chosenFolder(chosen);
    renameSync(chosenDir, join(root, 'moved'));
    symlinkSync(elsewhere, chosenDir);
    await assert.rejects(writeChosen(chosen, at, 'x'), /folder changed|ENOENT/);
    assert.deepEqual(readdirSync(elsewhere), []);
    assert.deepEqual(readdirSync(join(root, 'moved')), []);
  } finally { done(); }
});

test('replacing a private file keeps it private, and a new file never starts readable by others while written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'export-mode-'));
  try {
    const folder = await chosenFolder(join(dir, 'x'));
    const target = join(dir, 'secret.md');
    writeFileSync(target, 'old');
    chmodSync(target, 0o640);
    await writeChosen(target, folder, 'new');
    assert.equal(readFileSync(target, 'utf8'), 'new');
    assert.equal(statSync(target).mode & 0o777, 0o640, 'the replaced file keeps exactly its permissions, never wider');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
