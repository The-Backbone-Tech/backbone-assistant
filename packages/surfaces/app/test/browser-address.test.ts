import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { browserAddress } from '../electron/browser-address.ts';

test('browser addresses admit only valid HTTP and HTTPS URLs', () => {
  assert.equal(browserAddress('https://example.test/path'), 'https://example.test/path');
  assert.equal(browserAddress('http://127.0.0.1:3456/'), 'http://127.0.0.1:3456/');
  for (const address of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hello', 'about:blank', 'custom://host', 'https://', '']) {
    assert.equal(browserAddress(address), undefined, address);
  }
});

test('bare hosts select the local or public protocol and return the exact canonical address', () => {
  for (const host of ['localhost:5173','127.0.0.1:3000','192.168.1.12','10.1.2.3:8080','172.16.2.3','[::1]:5173','[fd00::1]','preview.local','localhost.:5173','192.168.1.12:443','[::ffff:192.168.1.12]' ]) {
    assert.equal(browserAddress(host), new URL(`http://${host}`).href, host);
  }
  assert.equal(browserAddress('example.test:80/path'), 'https://example.test:80/path');
  assert.equal(browserAddress('https://example.test/path@safe'), 'https://example.test/path@safe');
  assert.equal(browserAddress('example.test/path'), 'https://example.test/path');
  assert.equal(browserAddress('https://例え.テスト/資料'), 'https://xn--r8jz45g.xn--zckzah/%E8%B3%87%E6%96%99');
  assert.equal(browserAddress('  example.test/path  '), 'https://example.test/path');
});
test('ambiguous addresses, credentials, control characters and oversized input are refused', () => {
  for (const value of ['https://bank.test@evil.test','https://u:p@example.test','https://@example.test','@example.test','user:pass@example.test','https://user%40name@example.test','https://example.test\\@evil.test','https:\\example.test','//example.test','https://exa mple.test','https://exam\nple.test','https://example.test/\tpath','https://example.test/'+ 'a'.repeat(8192)]) {
    assert.equal(browserAddress(value),undefined,value.slice(0,80));
  }
});
