// Child process for the sweep-race tests: another process's recovery sweep, running every 200 ms
// for the given number of milliseconds, as the app's would.
import { CoreLink } from '../src/composition/core.ts';
import { sweepInterruptedDispatches } from '../src/composition/gateway.ts';
import { outboxExecutor } from '../src/composition/outbox.ts';

const [home, ms] = process.argv.slice(2);
const link = await CoreLink.open({ home });
const until = Date.now() + Number(ms);
while (Date.now() < until) {
  await sweepInterruptedDispatches(link, { 'outbox.write': outboxExecutor(home) }).catch(() => 0);
  await new Promise((r) => setTimeout(r, 200));
}
await link.release();
