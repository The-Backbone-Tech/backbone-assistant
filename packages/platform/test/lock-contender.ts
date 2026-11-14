// Child process for the data-home lock tests: takes the lock again and again, and counts any moment
// another holder was inside at the same time.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withHomeLock } from '../src/composition/home-lock.ts';

const [home, rounds] = process.argv.slice(2);
if (rounds === 'hold') {
  await withHomeLock(home, async () => {
    await new Promise<void>(resolve => {
      process.stdin.once('data', () => resolve());
      process.stdout.write('held\n');
    });
  });
  process.stdout.write('released\n');
  process.exit(0);
}
const inside = join(home, 'inside');
let overlaps = 0;
for (let i = 0; i < Number(rounds); i++) {
  await withHomeLock(home, async () => {
    if (existsSync(inside)) overlaps++;
    writeFileSync(inside, String(process.pid));
    await new Promise((r) => setTimeout(r, 3));
    if (readFileSync(inside, 'utf8') !== String(process.pid)) overlaps++;
    rmSync(inside, { force: true });
  });
}
process.stdout.write(`${overlaps}\n`);
