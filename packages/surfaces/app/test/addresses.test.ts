import assert from 'node:assert/strict';
import { test } from 'node:test';
import { showAddresses } from '../src/lib/addresses.ts';

test('an address in prose is kept visible; other markup is not opened up', () => {
  assert.equal(showAddresses('To: Dana <dana@example.com>'), 'To: Dana &lt;dana@example.com&gt;');
  assert.equal(showAddresses('<script>alert(1)</script>'), '<script>alert(1)</script>');
});

test('code shows exactly what was written', () => {
  for (const text of ['`<a@example.com>`', '```\n<a@example.com>\n```', '~~~\n<a@example.com>\n~~~', '    <a@example.com>', '```\nopen <a@example.com>']) {
    assert.equal(showAddresses(text), text);
  }
  assert.equal(showAddresses('`x` <a@example.com> `y`'), '`x` &lt;a@example.com&gt; `y`');
});

test('a code span closes on a run of the same length, as CommonMark says', () => {
  for (const text of ['``<a@example.com>``', '`` ` <a@example.com> ``', '```<a@example.com>```', '`one\n<a@example.com>`']) assert.equal(showAddresses(text), text);
  // An unclosed or mismatched run is not code, so the address still has to show.
  assert.equal(showAddresses('`` <a@example.com> `'), '`` &lt;a@example.com&gt; `');
  assert.equal(showAddresses('` x\n\n<a@example.com> `'), '` x\n\n&lt;a@example.com&gt; `');
});
