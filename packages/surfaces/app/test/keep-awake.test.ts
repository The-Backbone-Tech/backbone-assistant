// The machine stays awake while a goal runs, and only then: the blocker starts when a run is
// running, stops when none is (paused, met, blocked or out of budget), and is released on quit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApiEvent, GoalRun } from '@backbone-next/platform';
import { keepAwake } from '../electron/keep-awake.ts';

function fixture() {
  let runs: Pick<GoalRun, 'status'>[] = [];
  const listeners = new Set<(e: ApiEvent) => void>();
  const host = {
    call: async () => runs as GoalRun[],
    on: (l: (e: ApiEvent) => void) => { listeners.add(l); return () => listeners.delete(l); },
  };
  let next = 1;
  const started = new Set<number>();
  const blocker = { start: (type: string) => { assert.equal(type, 'prevent-app-suspension'); started.add(next); return next++; }, stop: (id: number) => { started.delete(id); } };
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { host, blocker, started, set: async (s: Pick<GoalRun, 'status'>[]) => { runs = s; listeners.forEach((l) => l({ topic: 'goals' })); await settle(); }, settle };
}

test('awake while a goal runs, asleep otherwise, and released on quit', async () => {
  const f = fixture();
  const release = keepAwake(f.host, f.blocker);
  await f.settle();
  assert.equal(f.started.size, 0);
  await f.set([{ status: 'running' }, { status: 'met' }]);
  assert.equal(f.started.size, 1);
  await f.set([{ status: 'running' }, { status: 'running' }]);
  assert.equal(f.started.size, 1, 'one hold however many goals run');
  await f.set([{ status: 'paused' }]);
  assert.equal(f.started.size, 0);
  await f.set([{ status: 'running' }]);
  assert.equal(f.started.size, 1);
  release();
  assert.equal(f.started.size, 0);
});
