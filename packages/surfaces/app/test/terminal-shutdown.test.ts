import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

// Exercise the bridge's actual signal registration with a Host that never finishes closing.
function fixture() {
  const source = readFileSync(new URL('../server/bridge.ts', import.meta.url), 'utf8');
  const shutdown = source.slice(source.indexOf('let closing = false;')).replace("['SIGINT', 'SIGTERM'] as const", "['SIGINT', 'SIGTERM']");
  const process = Object.assign(new EventEmitter(), { exit(code: number) { exits.push(code); } });
  const exits: number[] = [], delays: number[] = [], callbacks: (() => void)[] = [];
  let closes = 0;
  new Function('process', 'server', 'host', 'hostClosed', 'home', 'setTimeout', 'clearTimeout', shutdown)(
    process, { close() {}, closeIdleConnections() {} }, { close() { closes++; } }, () => new Promise(() => {}), '/fixture',
    (fn: () => void, ms: number) => { delays.push(ms); callbacks.push(fn); return 1; }, () => {});
  return { process, exits, delays, callbacks, closes: () => closes };
}
test('bridge shutdown uses Electron’s five second bound when Host closure stalls', () => {
  const f = fixture(); f.process.emit('SIGTERM');
  assert.deepEqual(f.delays, [5_000]); assert.equal(f.closes(), 1);
  f.callbacks[0](); assert.deepEqual(f.exits, [1]);
});
test('a second interrupt or terminate exits at once instead of waiting for Host closure', () => {
  for (const second of ['SIGINT', 'SIGTERM']) {
    const f = fixture(); f.process.emit('SIGTERM'); f.process.emit(second);
    assert.deepEqual(f.exits, [1]); assert.equal(f.closes(), 1);
  }
});
