import { defineConfig } from 'vitest/config';

// One PostgreSQL cluster for the run (src/db/global-setup.ts): each test file clones its own database from its template.
export default defineConfig({ test: { globalSetup: ['./src/db/global-setup.ts'] } });
