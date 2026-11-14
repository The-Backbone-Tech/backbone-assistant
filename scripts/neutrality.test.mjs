import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileProblems } from './contamination.mjs';

test('package imports and file reads are resolved before checking distribution independence', () => {
  const file = 'packages/platform/src/example.ts';
  for (const source of [
    "import config from '../../../distributions/./backbone/distribution.json';",
    "export {default} from '../../../distributions/./backbone/distribution.json';",
    "const config = require('../../../distributions/./backbone/distribution.json');",
    "const config = import('../../../distributions/./backbone/distribution.json');",
    "readFileSync(new URL('../../../distributions/./backbone/distribution.json', import.meta.url));",
    "import path from 'node:path'; import fs from 'node:fs'; fs.readFileSync(path.join(__dirname, '..', '..', '..', 'distributions', '.', 'backbone', 'distribution.json'));",
    "import {join as at} from 'node:path'; import {readFileSync as read} from 'node:fs'; const folder = 'backbone'; const target = at(process.cwd(), 'distributions', '.', folder, 'distribution.json'); read(target);",
    "readFileSync('../../../examples/distribution/distribution.json');",
  ]) assert.match(fileProblems(file, source).join('\n'), /resolved distribution dependency/, source);
  assert.deepEqual(fileProblems(file, "readFileSync(new URL('./local.json', import.meta.url));"), []);
  assert.deepEqual(fileProblems(file, "function f(target) { return readFileSync(target); }"), []);
});
