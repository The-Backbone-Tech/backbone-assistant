// The journey VM's fetch window, read from the committed script. The VM run is the proof; this
// keeps the script from drifting back to rules that let a connection opened in the window go on.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const script = () => readFile(new URL('../journey/vm/install.sh', import.meta.url), 'utf8');

test('once the window closes, no established traffic is accepted but sshd\'s own replies', async () => {
  const text = await script();
  const closing = text.slice(text.indexOf('# Close'));
  assert.ok(closing.length < text.length, 'the script marks where the window closes');
  const accepts = closing.split('\n').filter((l) => /iptables .*-A OUTPUT/.test(l) && /ACCEPT/.test(l));
  for (const rule of accepts) assert.ok(/-o lo\b/.test(rule) || (/ESTABLISHED/.test(rule) && /--sport 22\b/.test(rule) && !/RELATED/.test(rule)), `accepted after the window: ${rule.trim()}`);
  assert.match(closing, /-P OUTPUT DROP/);
});

test('the window\'s close flushes connection state and ends what the install started', async () => {
  const closing = (await script()).split('# Close')[1] ?? '';
  assert.match(closing, /conntrack -F/);
  assert.match(closing, /pkill|kill /);
});

test('the script proves a connection opened in the window cannot send after it', async () => {
  const text = await script();
  assert.match(text, /long-lived/);
  assert.match(text, /window\.closed/);
});
