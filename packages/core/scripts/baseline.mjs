// Writes the generated baseline to packages/core/dist/baseline.sql (build output: never committed).
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildBaseline } from '../src/db/baseline.ts';

const { sql, checksum } = buildBaseline();
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('../dist/baseline.sql', import.meta.url), sql);
console.log(`baseline ${checksum} (${sql.split('\n').length} lines) → packages/core/dist/baseline.sql`);
