// Child process for the home-ownership test: opens a home another process holds, and prints what it was told.
import { createHost } from '../src/composition/host.ts';

const [home] = process.argv.slice(2);
const host = createHost({ home });
try {
  await host.call('threads.list', {});
  console.log('opened');
} catch (error) {
  console.log(`refused: ${(error as Error).message}`);
}
process.exit(0);
