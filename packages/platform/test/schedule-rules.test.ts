// When scheduled work is due: a person's words become a rule, a rule names its next time, and a
// heartbeat keeps to its active hours. Local time throughout, as the person reads a clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeRule, nextAfter, parseWhen, withinHours, type Rule } from '../src/schedules/rules.ts';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const next = (rule: Rule, from: number, anchor = from) => new Date(nextAfter(rule, from, anchor)!);
const hm = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
const parsed = (words: string) => {
  const r = parseWhen(words, at(2026, 11, 2, 10, 0));
  assert.ok('rule' in r, `${words}: ${'problem' in r ? r.problem : ''}`);
  return r.rule;
};

// Monday 2 November 2026, 10:00 local.
const monday10 = at(2026, 11, 2, 10, 0);

test('everyday words become rules', () => {
  assert.deepEqual(parsed('every weekday at 9am'), { kind: 'rrule', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0' });
  assert.deepEqual(parsed('every day at 8:30'), { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=30' });
  assert.deepEqual(parsed('daily at 6pm'), { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=18;BYMINUTE=0' });
  assert.deepEqual(parsed('every monday and thursday at 10'), { kind: 'rrule', rrule: 'FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=10;BYMINUTE=0' });
  assert.deepEqual(parsed('every 30 minutes'), { kind: 'rrule', rrule: 'FREQ=MINUTELY;INTERVAL=30' });
  assert.deepEqual(parsed('hourly'), { kind: 'rrule', rrule: 'FREQ=HOURLY;INTERVAL=1' });
  assert.deepEqual(parsed('every morning'), { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' });
  assert.deepEqual(parsed('every weekend at 11:15'), { kind: 'rrule', rrule: 'FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=11;BYMINUTE=15' });
  assert.deepEqual(parsed('0 9 * * 1-5'), { kind: 'cron', cron: '0 9 * * 1-5' });
  assert.deepEqual(parsed('RRULE:FREQ=DAILY;BYHOUR=7;BYMINUTE=0'), { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0' });
  assert.deepEqual(parsed('tomorrow at 9'), { kind: 'once', at: new Date(at(2026, 11, 3, 9, 0)).toISOString() });
  assert.deepEqual(parsed('in 2 hours'), { kind: 'once', at: new Date(at(2026, 11, 2, 12, 0)).toISOString() });
  assert.deepEqual(parsed('2026-11-14 09:00'), { kind: 'once', at: new Date(at(2026, 11, 14, 9, 0)).toISOString() });
  assert.deepEqual(parsed('2026-11-14T18:30'), { kind: 'once', at: new Date(at(2026, 11, 14, 18, 30)).toISOString() });
});

test('words it cannot read are said back plainly, never guessed', () => {
  for (const words of ['', 'whenever you like', 'every 0 minutes', 'at 25:00 daily', '61 * * * *', 'FREQ=YEARLY']) {
    const r = parseWhen(words, monday10);
    assert.ok('problem' in r, words);
  }
});

test('a rule names its next time, after the one given', () => {
  assert.deepEqual(hm(next(parsed('every weekday at 9am'), monday10)), [2026, 11, 3, 9, 0]);
  assert.deepEqual(hm(next(parsed('every weekday at 9am'), at(2026, 11, 6, 9, 0))), [2026, 11, 9, 9, 0]);
  assert.deepEqual(hm(next(parsed('every day at 8:30'), at(2026, 11, 2, 8, 29))), [2026, 11, 2, 8, 30]);
  assert.deepEqual(hm(next(parsed('every 30 minutes'), monday10, at(2026, 11, 2, 9, 50))), [2026, 11, 2, 10, 20]);
  assert.deepEqual(hm(next({ kind: 'cron', cron: '*/15 9-17 * * 1-5' }, at(2026, 11, 6, 17, 50))), [2026, 11, 9, 9, 0]);
  assert.deepEqual(hm(next({ kind: 'cron', cron: '0 0 1 * *' }, monday10)), [2026, 12, 1, 0, 0]);
  const once = parsed('tomorrow at 9');
  assert.deepEqual(hm(next(once, monday10)), [2026, 11, 3, 9, 0]);
  assert.equal(nextAfter(once, at(2026, 11, 3, 9, 0), monday10), null);
});

test('a heartbeat keeps to its active hours', () => {
  const hours = { start: '08:00', end: '20:00' };
  assert.equal(withinHours(at(2026, 11, 2, 7, 59), hours), false);
  assert.equal(withinHours(at(2026, 11, 2, 8, 0), hours), true);
  assert.equal(withinHours(at(2026, 11, 2, 20, 0), hours), false);
  const every = parsed('every 30 minutes');
  assert.deepEqual(hm(new Date(nextAfter(every, at(2026, 11, 2, 19, 45), at(2026, 11, 2, 8, 0), hours)!)), [2026, 11, 3, 8, 0]);
  const overnight = { start: '22:00', end: '06:00' };
  assert.equal(withinHours(at(2026, 11, 2, 23, 0), overnight), true);
  assert.equal(withinHours(at(2026, 11, 2, 12, 0), overnight), false);
});

test('a rule reads back in plain words', () => {
  assert.equal(describeRule(parsed('every weekday at 9am')), 'Weekdays at 09:00');
  assert.equal(describeRule(parsed('every day at 8:30')), 'Every day at 08:30');
  assert.equal(describeRule(parsed('every 30 minutes')), 'Every 30 minutes');
  assert.equal(describeRule(parsed('every monday and thursday at 10')), 'Mon, Thu at 10:00');
  assert.equal(describeRule({ kind: 'cron', cron: '0 9 * * 1-5' }), 'cron 0 9 * * 1-5');
});
