import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepReason, parseIpcs, sweep } from './pg-shm-sweep.mjs';

test('unknown attachment counts never authorize removal', () => {
  assert.ok(keepReason({ owner: 'me', attached: NaN, creator: 12 }, { user: 'me', alive: () => false }));
  assert.ok(keepReason({ owner: 'me', attached: -1, creator: 12 }, { user: 'me', alive: () => false }));
});

// `ipcs -m -a` on macOS: a leak whose creator died before attaching, a leak that detached, a running
// server's segment (9 attached), one owned by someone else, and one whose creator is still alive.
const IPCS = `IPC status from <running system> as of Mon Oct 26 13:07:19 CET 2026
T     ID     KEY        MODE       OWNER    GROUP  CREATOR   CGROUP NATTCH  SEGSZ  CPID  LPID   ATIME    DTIME    CTIME
Shared Memory:
m 76414976 0x1a6cf557 --rw------- alberto    staff alberto    staff      0     56  88077      0 no-entry no-entry 19:37:46
m 30539777 0x188dad99 --rw------- alberto    staff alberto    staff      0     56  57145  57145 18:35:31 18:38:24 18:35:31
m 233832459 0x1d3ae73e --rw------- alberto    staff alberto    staff      9     56  84668  84668 22:24:06 13:07:14 22:24:06
m 111 0x10 --rw------- someone    staff someone    staff      0     56  4000      0 no-entry no-entry 1:00:00
m 222 0x11 --rw------- alberto    staff alberto    staff      0     56  5000      0 no-entry no-entry 1:00:01
`;

const machine = ({ running = [5000, 84668], segments = parseIpcs(IPCS), removed = [] } = {}) => ({
  user: 'alberto',
  alive: (pid) => running.includes(pid),
  read: () => segments.filter((s) => !removed.includes(s.id)),
  remove: (id) => removed.push(id),
  limit: 32,
});
const quiet = () => {};

test('the table is read by its own header', () => {
  const segments = parseIpcs(IPCS);
  assert.equal(segments.length, 5);
  assert.deepEqual(segments[0], {
    id: 76414976, key: '0x1a6cf557', owner: 'alberto', attached: 0, size: 56, creator: 88077, lastPid: 0, attachedAt: 'no-entry', detachedAt: 'no-entry', created: '19:37:46',
  });
  assert.equal(segments[2].attached, 9);
  assert.deepEqual(parseIpcs('nothing here'), []);
});

test('only a segment of yours with a dead creator and nothing attached is a leak', () => {
  const deps = machine();
  const reasons = parseIpcs(IPCS).map((s) => keepReason(s, { user: deps.user, alive: deps.alive }));
  assert.deepEqual(reasons, [null, null, '9 process(es) attached', 'owned by someone', 'its creator 5000 is running']);
  assert.equal(keepReason({ owner: 'alberto', attached: 0, creator: 0 }, { user: 'alberto', alive: () => false }), 'its creator is unknown');
});

test('without --apply it lists what it would remove and removes nothing', () => {
  const deps = machine();
  const lines = [];
  const { leaked, swept } = sweep({ log: (l) => lines.push(l), deps });
  assert.deepEqual(leaked.map((s) => s.id), [76414976, 30539777]);
  assert.deepEqual(swept, []);
  assert.deepEqual(deps.read().length, 5);
  assert.match(lines.join('\n'), /Dry run: nothing removed\. Run with --apply to remove the 2 listed above\./);
  assert.match(lines.join('\n'), /5 of 32 segments in use/);
});

test('with --apply it removes exactly the leaks', () => {
  const removed = [];
  const { swept } = sweep({ apply: true, log: quiet, deps: machine({ removed }) });
  assert.deepEqual(removed, [76414976, 30539777]);
  assert.deepEqual(swept.map((s) => s.id), removed);
});

test('a segment that is attached, or whose creator came alive, between the listing and its removal is kept', () => {
  const removed = [];
  const first = parseIpcs(IPCS);
  let reads = 0;
  const deps = machine({ removed });
  // The first reading is the listing; later readings are the last look before each removal.
  deps.read = () => {
    reads += 1;
    if (reads === 1) return first;
    return first.map((s) => (s.id === 76414976 ? { ...s, attached: 1 } : s));
  };
  const lines = [];
  const { swept } = sweep({ apply: true, log: (l) => lines.push(l), deps });
  assert.deepEqual(removed, [30539777]);
  assert.deepEqual(swept.map((s) => s.id), [30539777]);
  assert.match(lines.join('\n'), /kept 76414976: 1 process\(es\) attached/);
});
