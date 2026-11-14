// Print every top-level case of the named legacy files: `node oracle/tools/list-legacy-cases.ts ledger.test.ts`.
import { legacyCases } from '../core/coverage.ts';

for (const file of process.argv.slice(2)) for (const name of await legacyCases(file)) console.log(name);
