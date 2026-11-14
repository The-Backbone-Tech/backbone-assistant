import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactWorkText, scrubKnownCredentials } from '../src/ports/redaction.ts';

test('work records preserve path-shaped tokens, lowercase hex and tokens without mixed case and digits', () => {
  const paths = [
    '/' + ['Users', 'alberto', 'projects', 'sales-review', 'data', 'sales_2026.csv'].join('/'),
    ['~', 'projects', 'SalesReview2026', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ.csv'].join('/'),
    './SalesReview2026/ABCDEFGHIJKLMNOPQRSTUVWXYZ.csv',
    'data/SalesReview2026/ABCDEFGHIJKLMNOPQRSTUVWXYZ.csv',
  ];
  for (const path of paths) {
    const command = `python3 analyse.py ${path}`;
    assert.equal(redactWorkText(command, []), command);
  }
  for (const token of ['f76752604ec3cc43da6730b880f827f36183d14b974', 'abcdefghijklmnopqrstuvwxyz0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ']) {
    assert.equal(redactWorkText(`git show ${token}`, []), `git show ${token}`);
  }
});

test('colon-form credential headers redact even short values and preserve header names', () => {
  for (const name of ['x-api-key', 'api_key', 'key', 'X-Auth-Token', 'token', 'client-secret', 'secret', 'authorization', 'PASSWORD']) {
    assert.equal(redactWorkText(`${name}: fake-value`, []), `${name}: [credential]`);
    assert.equal(redactWorkText(`${name}: "two words"`, []), `${name}: [credential]`);
  }
  assert.equal(redactWorkText('Authorization: Bearer fake-value', []), 'Authorization: Bearer [credential]');
  assert.equal(redactWorkText('Authorization: Basic fake-value', []), 'Authorization: Basic [credential]');
  assert.equal(redactWorkText('Content-Type: application/json', []), 'Content-Type: application/json');
});

test('known values and provider prefixes still win over heuristic exemptions', () => {
  assert.equal(scrubKnownCredentials('known known-long', ['known', 'known-long']), '[credential] [credential]');
  assert.equal(redactWorkText('/fake/path/to/credential', ['/fake/path/to/credential']), '[credential]');
  assert.equal(redactWorkText('sk-proj-abcdef0123456789abcdef', []), '[credential]'); // public-tree: synthetic
  assert.equal(redactWorkText('Q7nB4xV9kT2mW8cR5pH3yL6sF1dJ0aZq', []), '[credential]');
});

test('a base64 secret that contains a slash is still redacted, while a relative path is kept', () => {
  const secret = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY9x'].join('/');
  assert.equal(redactWorkText(`curl -d ${secret} https://example.test`, []).includes(secret), false);
  const path = 'projects/sales-review/data/sales_2026Q3Final.csv';
  assert.equal(redactWorkText(`python3 analyse.py ${path}`, []), `python3 analyse.py ${path}`);
});

test('an assignment to a key-like name keeps ordinary code and still redacts a real secret', () => {
  // The one form shown as written: the key keyword argument given a lambda with its parameters.
  const code = [
    "rows.sort(key=lambda x:x['kib'], reverse=True)",
    'sorted(rows, key=lambda row: row[1])',
    'max(pairs, key=lambda a, b: a)',
  ];
  for (const line of code) assert.equal(redactWorkText(line, []), line, line);
  // Real assignments of made-up values: [prefix, name, equals, value]. The pieces are joined so no
  // line of this file reads as a live credential.
  const cases: [string, string, string, string][] = [
    ['', 'API_KEY', '=', 'abcdef012345'],
    ['export ', 'TOKEN', '=', 'abc123def456'],
    ['', 'password', ' = ', '"hunter2 is long"'],
    ['', 'password', '=', "'hunter2'"],
    ['', 'PASSWORD', '=', 'hunter2'],
    ['', 'GITHUB_TOKEN', '=', ['eyJhbGciOi', 'eyJzdWIiOi', 'c2lnbmF0dXJl'].join('.')],
    ['', 'client_secret', '=', 'Zm9vYmFy'],
    ['', 'api_key', '=', 'abc123'],
    ['', 'SECRET', '=', 'letmein'],
    ['', 'SECRET', '=', 'lambda'],
    ['', 'key', '=', '"lambda"'],
    ['', 'password', '=', 'hunter'],
    ['', 'token', '=', 'letmein'],
    ['', 'ssh_key', '=', 'id_rsa'],
    // Outside a call's keyword-argument position the bare name key is a credential like any other.
    ['', 'key', '=', 'hunter'],
    ['', 'key', '=', 'correct.horse'],
    ['', 'key', '=', 'lambda'],
    ['tool --opt ', 'key', '=', 'hunter'],
    ['', 'PASSWORD', '=', 'foo(bar)'],
    ['', 'TOKEN', '=', 'abc[123]'],
    ['f(', 'api_key', '=', 'secret(value)'],
    ['login(', 'token', '=', 'read_token()'],
    ['f(', 'key', '=', '"quoted"'],
    // A name or a call in keyword position could be a secret; only a lambda with its parameters is code.
    ['login(', 'key', '=', 'hunter)'],
    ['connect(', 'key', '=', 'correct.horse)'],
    ['request(', 'key', '=', 'secret(value))'],
    ['log (prior event), ', 'key', '=', 'hunter'],
    ['sorted(rows, ', 'key', '=', 'len)'],
    ['', 'key', '=', 'lambda:abc'],
  ];
  for (const [prefix, name, equals, value] of cases) {
    assert.equal(redactWorkText(`${prefix}${name}${equals}${value}`, []), `${prefix}${name}${equals}[credential]`, name + equals);
  }
});
