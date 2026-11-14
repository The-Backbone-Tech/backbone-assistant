// When scheduled work is due. A rule is an RRULE (the subset people say: every N minutes or hours,
// daily, weekly on named days, at a time), a five-field cron, or one moment. Words a person types
// become one of these, or a plain problem: nothing is guessed. Times are local, as a clock reads.

import type { Hours, Rule } from '../api.ts';

export type { Hours, Rule };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const WEEK_ORDER = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DAY_WORDS: Record<string, string> = {
  monday: 'MO', mon: 'MO', tuesday: 'TU', tue: 'TU', tues: 'TU', wednesday: 'WE', wed: 'WE', thursday: 'TH', thu: 'TH', thurs: 'TH',
  friday: 'FR', fri: 'FR', saturday: 'SA', sat: 'SA', sunday: 'SU', sun: 'SU',
};
const DAY_NAMES: Record<string, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };
const PART_OF_DAY: Record<string, [number, number]> = { morning: [9, 0], noon: [12, 0], afternoon: [14, 0], evening: [18, 0], night: [21, 0] };
/** How far ahead a rule is searched; a rule with no time inside it is refused rather than looped on. */
const HORIZON_MINUTES = 400 * 24 * 60;

type Parsed = { rule: Rule } | { problem: string };
const problem = (p: string): Parsed => ({ problem: p });
const pad = (n: number) => String(n).padStart(2, '0');

/** A person's words, or a raw cron or RRULE, as a rule. `now` places "tomorrow" and "in 2 hours". */
export function parseWhen(input: string, now: number): Parsed {
  const words = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!words) return problem('Say when, for example "every weekday at 9am" or "every 30 minutes".');
  if (/^(rrule:)?freq=/.test(words)) {
    const rrule = input.trim().replace(/^rrule:/i, '').toUpperCase();
    const compiled = compileRRule(rrule);
    return 'problem' in compiled ? compiled : { rule: { kind: 'rrule', rrule } };
  }
  if (/^[\d*/,-]+( [\d*/,-]+){4}$/.test(words)) {
    const compiled = compileCron(words);
    return 'problem' in compiled ? compiled : { rule: { kind: 'cron', cron: words } };
  }
  const inMatch = /^in (\d+) (minute|minutes|min|mins|hour|hours)$/.exec(words);
  if (inMatch) {
    const n = Number(inMatch[1]);
    if (n < 1) return problem('A delay needs at least one minute.');
    return { rule: { kind: 'once', at: new Date(now + n * (inMatch[2].startsWith('h') ? HOUR : MINUTE)).toISOString() } };
  }
  const every = /^(?:every|each) (?:(\d+) )?(minute|minutes|min|mins|hour|hours)$/.exec(words) ?? (words === 'hourly' ? [words, '1', 'hour'] : null);
  if (every) {
    const n = Number(every[1] ?? 1);
    if (!Number.isInteger(n) || n < 1) return problem('An interval needs at least one minute.');
    return { rule: { kind: 'rrule', rrule: every[2].startsWith('h') ? `FREQ=HOURLY;INTERVAL=${n}` : `FREQ=MINUTELY;INTERVAL=${n}` } };
  }

  // One moment written as a date and a time, in the person's own time zone.
  const moment = /^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/.exec(words);
  if (moment) {
    const [y, mo, d, h, mi] = moment.slice(1).map(Number);
    const at = new Date(y, mo - 1, d, h, mi, 0, 0);
    if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d || h > 23 || mi > 59) return problem('That date and time do not exist.');
    if (at.getTime() <= now) return problem('That time has already passed.');
    return { rule: { kind: 'once', at: at.toISOString() } };
  }

  const time = timeIn(words);
  if (time && 'problem' in time) return time;
  const day = /^(today|tomorrow)\b/.exec(words) ?? / (today|tomorrow)$/.exec(words);
  if (day) {
    if (!time) return problem(`Say what time ${day[1]}.`);
    const d = new Date(now);
    if (day[1] === 'tomorrow') d.setDate(d.getDate() + 1);
    d.setHours(time.h, time.m, 0, 0);
    if (d.getTime() <= now) return problem('That time has already passed.');
    return { rule: { kind: 'once', at: d.toISOString() } };
  }

  let days: string[] | 'daily' | null = null;
  if (/\b(weekday|weekdays|week day|work ?days?)\b/.test(words)) days = ['MO', 'TU', 'WE', 'TH', 'FR'];
  else if (/\bweekends?\b/.test(words)) days = ['SA', 'SU'];
  else {
    const named = [...words.matchAll(/\b([a-z]+)\b/g)].map((m) => DAY_WORDS[m[1]]).filter(Boolean);
    if (named.length) days = WEEK_ORDER.filter((d) => named.includes(d));
    else if (/\b(every|each) (day|morning|afternoon|evening|night)\b|\bdaily\b|\bevery ?day\b/.test(words)) days = 'daily';
  }
  if (!days) return problem('Say how often, for example "every weekday at 9am", "daily at 8:30" or "every 30 minutes". For one time, say "in 2 hours", "tomorrow at 9am" or a date and time such as "2026-11-14 09:00".');
  const part = /\b(morning|noon|afternoon|evening|night)\b/.exec(words);
  const [h, m] = time ? [time.h, time.m] : part ? PART_OF_DAY[part[1]] : [NaN, NaN];
  if (Number.isNaN(h)) return problem('Say what time, for example "at 9am".');
  const byTime = `BYHOUR=${h};BYMINUTE=${m}`;
  return { rule: { kind: 'rrule', rrule: days === 'daily' ? `FREQ=DAILY;${byTime}` : `FREQ=WEEKLY;BYDAY=${days.join(',')};${byTime}` } };
}

/** "at 9", "at 9:30", "at 6pm", "9am": the hour and minute, a problem for an impossible one, or null. */
function timeIn(words: string): { h: number; m: number } | { problem: string } | null {
  const match = /\bat (\d{1,2})(?::(\d{2}))? ?(am|pm)?\b/.exec(words) ?? /\b(\d{1,2})(?::(\d{2}))? ?(am|pm)\b/.exec(words);
  if (!match) return null;
  let h = Number(match[1]);
  const m = Number(match[2] ?? 0);
  if (match[3]) {
    if (h < 1 || h > 12) return { problem: `${match[0].trim()} is not a time.` };
    h = (h % 12) + (match[3] === 'pm' ? 12 : 0);
  }
  if (h > 23 || m > 59) return { problem: `${match[0].trim()} is not a time.` };
  return { h, m };
}

interface RRule { freq: 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY'; interval: number; byDay?: string[]; byHour?: number[]; byMinute?: number[] }

function compileRRule(rrule: string): RRule | { problem: string } {
  const parts = new Map<string, string>();
  for (const part of rrule.split(';').filter(Boolean)) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) return { problem: `"${part}" is not part of an RRULE.` };
    parts.set(k, v);
  }
  const freq = parts.get('FREQ');
  if (freq !== 'MINUTELY' && freq !== 'HOURLY' && freq !== 'DAILY' && freq !== 'WEEKLY') return { problem: 'Only minutely, hourly, daily and weekly rules are understood.' };
  for (const k of parts.keys()) if (!['FREQ', 'INTERVAL', 'BYDAY', 'BYHOUR', 'BYMINUTE'].includes(k)) return { problem: `${k} is not understood in an RRULE here.` };
  const interval = Number(parts.get('INTERVAL') ?? 1);
  if (!Number.isInteger(interval) || interval < 1) return { problem: 'INTERVAL must be a whole number of at least 1.' };
  const list = (k: string, max: number) => {
    const raw = parts.get(k);
    if (raw === undefined) return undefined;
    const ns = raw.split(',').map(Number);
    return ns.every((n) => Number.isInteger(n) && n >= 0 && n <= max) ? ns : null;
  };
  const byHour = list('BYHOUR', 23);
  const byMinute = list('BYMINUTE', 59);
  if (byHour === null || byMinute === null) return { problem: 'BYHOUR and BYMINUTE must be hours 0–23 and minutes 0–59.' };
  const byDay = parts.get('BYDAY')?.split(',');
  if (byDay && !byDay.every((d) => (DAY_CODES as readonly string[]).includes(d))) return { problem: 'BYDAY takes MO, TU, WE, TH, FR, SA and SU.' };
  return { freq, interval, byDay, byHour, byMinute };
}

interface Cron { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean }

function compileCron(cron: string): Cron | { problem: string } {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return { problem: 'A cron line has five fields: minute hour day month weekday.' };
  const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const sets: Set<number>[] = [];
  for (const [i, field] of fields.entries()) {
    const [lo, hi] = ranges[i];
    const set = new Set<number>();
    for (const item of field.split(',')) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
      if (!m) return { problem: `"${item}" is not a cron field.` };
      const step = Number(m[4] ?? 1);
      const from = m[1] === '*' ? lo : Number(m[2]);
      const to = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : from;
      if (step < 1 || from < lo || to > hi || from > to) return { problem: `"${item}" is outside ${lo}–${hi}.` };
      for (let n = from; n <= to; n += step) set.add(i === 4 && n === 7 ? 0 : n);
    }
    sets.push(set);
  }
  return { minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4], domAny: fields[2] === '*', dowAny: fields[4] === '*' };
}

const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();
const clock = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

export function withinHours(t: number, hours: Hours): boolean {
  const m = minuteOfDay(new Date(t));
  const s = clock(hours.start);
  const e = clock(hours.end);
  if (s === e) return true;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const daysBetween = (a: number, b: number) => Math.round((startOfDay(b) - startOfDay(a)) / (24 * HOUR));

/**
 * The first time strictly after `after` that the rule names and `hours` allow, or null when there is
 * none (a moment that has passed). `anchor` is when the rule began: intervals count from it.
 */
export function nextAfter(rule: Rule, after: number, anchor: number, hours?: Hours): number | null {
  if (rule.kind === 'once') {
    const t = Date.parse(rule.at);
    return t > after ? t : null;
  }
  const allowed = (t: number) => !hours || withinHours(t, hours);
  if (rule.kind === 'rrule') {
    const r = compileRRule(rule.rrule);
    if ('problem' in r) return null;
    if (r.freq === 'MINUTELY' || r.freq === 'HOURLY') {
      const step = r.interval * (r.freq === 'HOURLY' ? HOUR : MINUTE);
      let t = after < anchor ? anchor : anchor + (Math.floor((after - anchor) / step) + 1) * step;
      for (let i = 0; i < HORIZON_MINUTES; i++, t += step) {
        if (t > after && allowed(t) && matchesFilters(r, new Date(t))) return t;
      }
      return null;
    }
    const a = new Date(anchor);
    const hourSet = new Set(r.byHour ?? [a.getHours()]);
    const minuteSet = new Set(r.byMinute ?? [a.getMinutes()]);
    const daySet = r.freq === 'WEEKLY' ? new Set(r.byDay ?? [DAY_CODES[a.getDay()]]) : r.byDay ? new Set(r.byDay) : null;
    return scan(after, (d) => {
      if (daySet && !daySet.has(DAY_CODES[d.getDay()])) return false;
      if (r.interval > 1) {
        const gap = daysBetween(anchor, d.getTime());
        if (gap < 0 || (r.freq === 'DAILY' ? gap % r.interval : Math.floor(gap / 7) % r.interval)) return false;
      }
      return true;
    }, hourSet, minuteSet, allowed);
  }
  const c = compileCron(rule.cron);
  if ('problem' in c) return null;
  return scan(after, (d) => {
    if (!c.month.has(d.getMonth() + 1)) return false;
    const dom = c.dom.has(d.getDate());
    const dow = c.dow.has(d.getDay());
    // Standard cron: when both day fields are restricted, either one matching is enough.
    return c.domAny && c.dowAny ? true : c.domAny ? dow : c.dowAny ? dom : dom || dow;
  }, c.hour, c.minute, allowed);
}

function matchesFilters(r: RRule, d: Date): boolean {
  return (!r.byDay || r.byDay.includes(DAY_CODES[d.getDay()])) && (!r.byHour || r.byHour.includes(d.getHours())) && (!r.byMinute || r.byMinute.includes(d.getMinutes()));
}

/** Minute by minute from just after `after`, skipping whole days and hours that cannot match. */
function scan(after: number, dayOk: (d: Date) => boolean, hours: Set<number>, minutes: Set<number>, allowed: (t: number) => boolean): number | null {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const end = after + HORIZON_MINUTES * MINUTE;
  while (d.getTime() <= end) {
    if (!dayOk(d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!hours.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (minutes.has(d.getMinutes()) && allowed(d.getTime())) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** The rule in a few plain words, for a card or a list. */
/**
 * A rule in words. A daily or weekly rule with no hour or minute of its own runs at its anchor's, so
 * with the anchor given the words say that time, as it will run.
 */
export function describeRule(rule: Rule, anchor?: number): string {
  if (rule.kind === 'cron') return `cron ${rule.cron}`;
  if (rule.kind === 'once') {
    const d = new Date(rule.at);
    return `Once, ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const r = compileRRule(rule.rrule);
  if ('problem' in r) return rule.rrule;
  if (r.freq === 'MINUTELY') return r.interval === 1 ? 'Every minute' : `Every ${r.interval} minutes`;
  if (r.freq === 'HOURLY') return r.interval === 1 ? 'Every hour' : `Every ${r.interval} hours`;
  const at = anchor === undefined ? null : new Date(anchor);
  const times = (r.byHour ?? [at ? at.getHours() : 0]).flatMap((h) => (r.byMinute ?? [at ? at.getMinutes() : 0]).map((m) => `${pad(h)}:${pad(m)}`)).join(', ');
  if (r.freq === 'DAILY') return `${r.interval > 1 ? `Every ${r.interval} days` : 'Every day'} at ${times}`;
  const days = r.byDay ?? [];
  const label = days.join(',') === 'MO,TU,WE,TH,FR' ? 'Weekdays' : days.join(',') === 'SA,SU' ? 'Weekends' : days.map((d) => DAY_NAMES[d]).join(', ');
  return `${label} at ${times}`;
}
