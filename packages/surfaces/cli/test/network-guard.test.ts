import assert from 'node:assert/strict';
import {test} from 'node:test';

test('the package test runner installs its local-only network guard',()=>{
 assert.ok((globalThis as Record<symbol,unknown>)[Symbol.for('backbone.test.local-network')]);
});
