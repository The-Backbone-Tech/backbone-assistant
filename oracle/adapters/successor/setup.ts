import type { TestProject } from 'vitest/node';
import { startTestPostgres } from '../../../packages/core/src/db/testing.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    successor: { admin: string; app: string; operator: string };
  }
}

/**
 * One embedded PostgreSQL 18 for the run, with the core's baseline installed once into a template.
 * Each oracle file clones the template into its own fresh installation (index.ts).
 */
export default async function setup(project: TestProject) {
  const postgres = await startTestPostgres();
  project.provide('successor', {
    admin: postgres.adminUrl('{db}'),
    app: postgres.appUrl('{db}'),
    operator: postgres.operatorUrl('{db}'),
  });
  return () => postgres.stop();
}
