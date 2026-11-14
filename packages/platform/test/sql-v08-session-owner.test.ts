import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type PresenceAnswer, type PresenceCheck, presentPersonSessions, SESSION_REUSE_MS, PRESENT_FOR_MS } from '../src/authority/sql-v08/session-owner.ts';
import type { PersonRequest } from '../src/authority/sql-v08/types.ts';
import { contractStatement } from '../src/authority/sql-v08/transport.ts';

const binding = { workspaceId: '00000000-0000-7000-8000-000000000001', personId: '00000000-0000-7000-8000-000000000002', accountId: 'account' };

function setup(answers: PresenceAnswer[] = [], mint?: () => Promise<string | null>) {
  let clock = 1_000_000;
  const asked: PersonRequest[] = [];
  let minted = 0;
  const presence: PresenceCheck = { attests: 'person', confirm: async (r) => { asked.push(r); return answers.shift() ?? 'confirmed'; } };
  const owner = presentPersonSessions({ binding, presence, now: () => clock, mint: mint ?? (async () => `token-${++minted}`) });
  return { owner, asked, advance: (ms: number) => { clock += ms; }, minted: () => minted };
}
const token = (r: Awaited<ReturnType<ReturnType<typeof setup>['owner']['current']>>) => (r.status === 'authenticated' ? r.personToken : null);

test('one presence carries routine acts for its window; a session is reused only while the kernel keeps it', async () => {
  const s = setup();
  assert.equal(token(await s.owner.current({ act: 'open' })), 'token-1');
  assert.equal(token(await s.owner.current({ act: 'create-task' })), 'token-1');
  assert.equal(s.asked.length, 1);
  s.advance(SESSION_REUSE_MS);
  assert.equal(token(await s.owner.current({ act: 'create-task' })), 'token-2', 'a new session, without asking again');
  assert.equal(s.asked.length, 1);
  s.advance(PRESENT_FOR_MS);
  assert.equal(token(await s.owner.current({ act: 'cancel' })), 'token-3');
  assert.deepEqual(s.asked.map((r) => r.act), ['open', 'cancel'], 'past the window the person is asked again');
});

test('a declined, unavailable or failing presence mints nothing', async () => {
  for (const answer of ['declined', 'unavailable'] as const) {
    const s = setup([answer]);
    assert.deepEqual(await s.owner.current({ act: 'open' }), { status: 'required' });
    assert.equal(s.minted(), 0);
  }
  const owner = presentPersonSessions({ binding, mint: async () => 'never', presence: { attests: 'person', confirm: async () => { throw new Error('no window'); } } });
  assert.deepEqual(await owner.current({ act: 'open' }), { status: 'required' });
});

test('a statement is asked every time, word for word, and gets a session of its own', async () => {
  const s = setup();
  await s.owner.current({ act: 'open' });
  const statement = 'Write brief.md (412 bytes) to Projects/Acme.';
  assert.equal(token(await s.owner.current({ act: 'accept-held', statement })), 'token-2');
  assert.equal(token(await s.owner.current({ act: 'accept-held', statement })), 'token-3');
  assert.deepEqual(s.asked.slice(1), [{ act: 'accept-held', statement }, { act: 'accept-held', statement }]);
  const declined = setup(['confirmed', 'declined']);
  await declined.owner.current({ act: 'open' });
  assert.deepEqual(await declined.owner.current({ act: 'accept-held', statement }), { status: 'required' }, 'a present person still has to say yes to this');
  assert.deepEqual(await s.owner.current({ act: 'accept-held', statement: '  ' }), { status: 'required' });
  assert.equal(s.asked.length, 3, 'an empty statement is refused without asking');
});

test('end() forgets the presence and the session, and drops a session minted across it', async () => {
  const s = setup();
  await s.owner.current({ act: 'open' });
  s.owner.end();
  await s.owner.current({ act: 'create-task' });
  assert.equal(s.asked.length, 2);
  let release!: (v: string) => void;
  const slow = setup([], () => new Promise<string>((r) => { release = r; }));
  const pending = slow.owner.current({ act: 'open' });
  await new Promise((r) => setImmediate(r));
  slow.owner.end();
  release('late');
  assert.deepEqual(await pending, { status: 'required' });
});

test('concurrent acts wait for one question', async () => {
  const s = setup();
  const all = await Promise.all([s.owner.current({ act: 'a' }), s.owner.current({ act: 'b' }), s.owner.current({ act: 'c' })]);
  assert.deepEqual(all.map(token), ['token-1', 'token-1', 'token-1']);
  assert.equal(s.asked.length, 1);
});

test('a mint with no answer refuses the act instead of holding it', async () => {
  const owner = presentPersonSessions({ binding, mintTimeoutMs: 20, mint: () => new Promise(() => {}), presence: { attests: 'person', confirm: async () => 'confirmed' } });
  assert.deepEqual(await owner.current({ act: 'cancel' }), { status: 'required' });
});

test('the owner reports what its presence attests', () => {
  assert.equal(setup().owner.attests, 'person');
  assert.equal(presentPersonSessions({ binding, mint: async () => null, presence: { attests: 'fixture', confirm: async () => 'confirmed' } }).attests, 'fixture');
});

test('a statement\'s session is never reused by a routine act', async () => {
  const s = setup();
  await s.owner.current({ act: 'open' });
  assert.equal(token(await s.owner.current({ act: 'accept-held', statement: 'Release brief.md?' })), 'token-2');
  assert.equal(token(await s.owner.current({ act: 'create-task' })), 'token-1', 'the routine session, not the confirmed one');
});

test('end() refuses acts already waiting and answers an open question with no', async () => {
  let reply!: (a: PresenceAnswer) => void;
  const owner = presentPersonSessions({ binding, mint: async () => 'token', presence: { attests: 'person', confirm: () => new Promise((r) => { reply = r; }) } });
  const asking = owner.current({ act: 'accept-held', statement: 'Release brief.md?' });
  const waiting = owner.current({ act: 'create-task' });
  await new Promise((r) => setImmediate(r));
  owner.end();
  reply('confirmed');
  assert.deepEqual(await asking, { status: 'required' }, 'a yes that arrives after the end does not count');
  assert.deepEqual(await waiting, { status: 'required' }, 'queued before the end, refused after it');
});

test('an unanswered question counts as no, and later acts still run', async () => {
  let calls = 0;
  const owner = presentPersonSessions({ binding, presenceTimeoutMs: 20, mint: async () => 'token', presence: { attests: 'person', confirm: () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve('confirmed')) } });
  assert.deepEqual(await owner.current({ act: 'open' }), { status: 'required' });
  assert.equal(token(await owner.current({ act: 'open' })), 'token');
});

test('a question that no longer counts is closed: its signal aborts on timeout, on end() and once answered', async () => {
  const signals: AbortSignal[] = [];
  let calls = 0;
  const owner = presentPersonSessions({ binding, presenceTimeoutMs: 20, mint: async () => 'token', presence: { attests: 'person', confirm: (_r, signal) => { signals.push(signal); return ++calls === 1 ? new Promise(() => {}) : Promise.resolve('confirmed'); } } });
  await owner.current({ act: 'open' });
  assert.equal(signals[0].aborted, true, 'timed out');
  await owner.current({ act: 'open' });
  assert.equal(signals[1].aborted, true, 'answered');
  const open = presentPersonSessions({ binding, mint: async () => 'token', presence: { attests: 'person', confirm: (_r, signal) => { signals.push(signal); return new Promise(() => {}); } } });
  const pending = open.current({ act: 'accept-held', statement: 'Release brief.md?' });
  await new Promise((r) => setImmediate(r));
  open.end();
  await pending;
  assert.equal(signals[2].aborted, true, 'ended');
});

test('a contract is confirmed in its exact terms: purpose, lifetime to the millisecond, and quoted lists', () => {
  const terms = { purpose: '00000000-0000-7000-8000-00000000000a', data: ['a, b'], tools: ['a', 'b'], destinations: [], models: ['m'], budget: 5, ceiling: 2 as const, ttlMs: 89 * 60_000 + 1, checker: false };
  const said = contractStatement('p', terms);
  assert.match(said, /task 00000000-0000-7000-8000-00000000000a/);
  assert.match(said, /for 1 hour 29 minutes 1 millisecond/);
  assert.match(said, /data "a, b"; tools "a", "b"; destinations none/);
  assert.match(said, /may not check other work/);
});
