// Print a coverage skeleton for a promise: `node oracle/tools/coverage-skeleton.ts ledger ledger.test.ts runs.test.ts`.
import { legacyCases } from '../core/coverage.ts';

const [promise, ...files] = process.argv.slice(2);
console.log(`import type { Coverage } from '../coverage.ts';\n`);
console.log(`export const coverage: Coverage = {\n  promise: '${promise}',\n  legacyFiles: ${JSON.stringify(files)},\n  cases: {`);
for (const file of files) for (const name of await legacyCases(file)) console.log(`    ${JSON.stringify(name)}: { status: 'todo' as never },`);
console.log('  },\n  gaps: [],\n};');
