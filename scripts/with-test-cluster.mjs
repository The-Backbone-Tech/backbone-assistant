// Runs a command with one embedded PostgreSQL for the whole run, told to it through BACKBONE_TEST_PG
// (packages/core/src/db/testing.ts): the command's test files take their databases from the cluster's
// template instead of each starting a cluster, which macOS allows only 32 of per machine. The cluster
// is stopped, and its folder removed, when the command ends, fails, or is stopped with Ctrl-C or
// SIGTERM. Put it inside scripts/no-leftovers.mjs, so its folder is in the run's TMPDIR and counted.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { testEnvironment } from './lib/test-environment.mjs';
import { startSharedTestCluster } from '../packages/core/src/db/testing.ts';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/with-test-cluster.mjs <command> [args...]');
  process.exit(2);
}

const cluster = await startSharedTestCluster();
const run = spawn(command, args, { stdio: 'inherit', env: testEnvironment() });
// Ctrl-C reaches the whole foreground group, the command included: wait for it rather than send a
// second SIGINT, which test runners take as "quit now". Other signals only reach this process.
for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => run.kill(signal));
process.on('SIGINT', () => setTimeout(() => run.kill('SIGINT'), 10_000).unref());

const status = await new Promise((resolve) => {
  run.on('error', (error) => {
    console.error(`with-test-cluster: ${error.message}`);
    resolve(127);
  });
  run.on('exit', (code, signal) => resolve(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)));
});
await cluster.stop();
process.exit(status);
