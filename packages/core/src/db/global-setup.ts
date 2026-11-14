import { startSharedTestCluster } from './testing.ts';

/** The vitest `globalSetup` of a package whose tests need a database: one cluster for the run, stopped when it ends, also on failure and Ctrl-C. */
export default async function setup() {
  const cluster = await startSharedTestCluster();
  return () => cluster.stop();
}
