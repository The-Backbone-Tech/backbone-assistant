import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('the first-message lost acknowledgement limit is documented',()=>{
 const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');
 assert.match(readme,/If this happens on the first message, no mapping was recorded and the answer never reaches the channel\./);
});
