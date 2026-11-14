import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Id } from '../../target.ts';
import {
  addPerson,
  dispatch,
  newWorld,
  propose,
  proposeCandidate,
  recordSource,
  requestPromotion,
  useTarget,
  verifierAnswer,
  type World,
} from '../harness.ts';
import { DIGEST, type Entry, ledgerOf } from './fixtures.ts';

const target = useTarget('ledger.words');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const digests = (entries: Entry[]): string[] => JSON.stringify(entries).match(/[0-9a-f]{64}/g) ?? [];

describe('the ledger every member reads holds identifiers and hashes, never words', () => {
  it('[O2] a verifier’s note, and every reason, note, description and topic someone wrote, are there by their hash only', async () => {
    const w = await newWorld(target(), 'LedgerWords');
    const pau = await addPerson(w, 'Pau');
    const words = {
      note: 'The candidate repeats Ana’s salary (41k) from “Salaries 2026”; check it may be shared.',
      cancel: 'Stop: it would tell Ana her raise (44k) early.',
      reconcile: 'The CRM shows deal 42 at 90k for Ana.',
      retract: 'Superseded by the pay review that gives Ana 44k.',
      description: 'Deals over 80k need Ana’s sign-off.',
      topic: 'pay of Ana',
    };
    // A verifier hands a question on, saying why in words that quote what it read.
    const source = await recordSource(w, 'Ana earns 41k. The launch is in May.');
    const candidate = (statement: string, topic: string) =>
      proposeCandidate(
        w.agent$,
        w.agent,
        statement,
        [{ episode: source, excerpt: 'The launch is in May.' }],
        topic,
      );
    const handedOn = await requestPromotion(w, await candidate('The launch is in May', 'launch'));
    await w.verifier$.call('decision.escalate', { decision: handedOn, note: words.note });
    // Knowledge accepted under a topic someone wrote, then retracted with a reason.
    const accepted = await candidate('The launch is in May (confirmed)', words.topic);
    await verifierAnswer(w.verifier$, w, await requestPromotion(w, accepted), 'approved');
    const [knowledge] = await w.owner$.observe<{ id: Id }>('knowledge', { candidate: accepted });
    expect(knowledge).toBeDefined();
    await w.owner$.call('knowledge.retract', { knowledge: knowledge?.id, reason: words.retract });
    // An effect cancelled with a reason; one reconciled with a note; a catalogue description.
    const cancelled = await propose(w, { step: 1 });
    await w.owner$.call('effect.cancel', { effect: cancelled, reason: words.cancel });
    const unknown = await propose(w, { step: 2 });
    await dispatch(w, unknown, 'unknown');
    await w.owner$.call('effect.reconcile', { effect: unknown, outcome: 'succeeded', note: words.reconcile });
    const { change } = await w.owner$.call<{ change: Id }>('operations.classify', {
      changes: [{ operation: 'crm:close_deal', class: 5, external: true, description: words.description }],
    });

    // Each is kept where it was written, with that place's visibility...
    const [question] = await w.owner$.observe<{ escalationNote: string | null }>('decision', {
      id: handedOn,
    });
    expect(question?.escalationNote).toBe(words.note);
    expect(await pau.$.observe('decision', { id: handedOn })).toEqual([]);
    // ...and the ledger Pau reads has none of the words, nor their plain hash, and still verifies.
    const entries = await ledgerOf(pau.$);
    const ledger = JSON.stringify(entries.map(({ subject, payload, text }) => ({ subject, payload, text })));
    for (const text of Object.values(words)) {
      expect(ledger).not.toContain(text);
      // Keyed: whoever has the words cannot test them against the ledger by hashing them.
      expect(ledger).not.toContain(sha(text));
    }
    expect(ledger).not.toMatch(/Ana|41k|44k|90k/);
    // Every act is on the record, carrying a digest in place of its words.
    for (const subject of [handedOn, knowledge?.id, cancelled, unknown, change]) {
      const about = entries.filter((e) => e.subject === subject);
      expect(about.length, `entries about ${subject}`).toBeGreaterThan(0);
      expect(digests(about).length, `digests about ${subject}`).toBeGreaterThan(0);
    }
    expect(await pau.$.call('ledger.verify')).toBeNull();
  });

  it('[O2] the same words are hashed differently in another workspace: the digest is keyed per workspace', async () => {
    const reason = 'Stop: it would tell Ana her raise (44k) early.';
    // The digests the cancellation added to the effect's record.
    const reasonDigests = async (w: World) => {
      const id = await propose(w);
      const before = digests(await ledgerOf(w.owner$, id));
      await w.owner$.call('effect.cancel', { effect: id, reason });
      return digests(await ledgerOf(w.owner$, id)).filter((d) => !before.includes(d));
    };
    const a = await reasonDigests(await newWorld(target(), 'KeyedA'));
    const b = await reasonDigests(await newWorld(target(), 'KeyedB'));
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    for (const d of a) expect(b).not.toContain(d);
    expect([...a, ...b]).not.toContain(sha(reason));
  });

  it('[O2] names a person’s own connection by its id: never its slug, nor the tool called through it; a workspace connection as before', async () => {
    const w = await newWorld(target(), 'LedgerConnections');
    const pau = await addPerson(w, 'Pau');
    const { own, bank } = await connectionsAndCalls(w);
    await w.owner$.call('led.connection_mark_sensitive', { connection: bank, sensitive: false });

    const ledger = await ledgerOf(pau.$);
    const text = JSON.stringify(ledger.map(({ type, subject, payload }) => ({ type, subject, payload })));
    expect(text).not.toMatch(/marta_bank_ing|list_transfers/);
    // What was done through Marta's bank is named by the connection's id and a hash of the tool...
    const done = ledger.filter((l) => l.subject === own);
    expect(done.map((l) => [l.type, l.payload.connection, l.payload.tool_hash])).toEqual(
      ['effect.proposed', 'effect.dispatched', 'effect.observed'].map((entry) => [
        entry,
        bank,
        expect.stringMatching(DIGEST),
      ]),
    );
    // ...one hash for one tool, which is not the tool name's plain hash...
    const toolHash = done[0]?.payload.tool_hash;
    expect(done.map((l) => l.payload.tool_hash)).toEqual([toolHash, toolHash, toolHash]);
    expect(text).not.toContain(sha('list_transfers'));
    // ...and the connection by its id alone; the workspace's CRM by its name, as before.
    expect(ledger.filter((l) => l.subject === bank).map((l) => [l.type, l.payload.slug])).toEqual([
      ['connection.registered', null],
      ['connection.checked', null],
      ['connection.marked', null],
    ]);
    expect(text).toContain('mcp.crm_team.get_deal');
    expect(text).toContain('"slug":"crm_team"');
    expect(await pau.$.call('ledger.verify')).toBeNull();

    // Keyed: the same tool through the same kind of connection hashes differently in another workspace.
    const other = await newWorld(target(), 'LedgerConnectionsOther');
    const elsewhere = await connectionsAndCalls(other);
    const [otherEntry] = await ledgerOf(other.owner$, elsewhere.own);
    expect(otherEntry?.payload.tool_hash).toMatch(DIGEST);
    expect(otherEntry?.payload.tool_hash).not.toBe(toolHash);
  });
});

/** A person's own bank connection and the workspace's CRM, each discovered and called once. */
async function connectionsAndCalls(w: World) {
  const register = (name: string, slug: string, scope: 'person' | 'workspace') =>
    w.owner$.call<Id>('led.connection_register', {
      name,
      slug,
      url: `https://${slug.replace(/_/g, '-')}.example.com/mcp`,
      scope,
    });
  const bank = await register('Marta’s bank', 'marta_bank_ing', 'person');
  const crm = await register('CRM', 'crm_team', 'workspace');
  const discover = async (connection: Id, names: string[]) => {
    const tools = names.map((name) => ({ name, title: name, input_schema: { type: 'object' } }));
    expect(await w.system$.call('led.connection_record_tools', { connection, tools })).toBe(names.length);
    expect(
      (await w.system$.observe<{ name: string }>('led.connection_tool', { connection })).map((r) => r.name),
    ).toEqual([...names].sort());
  };
  await discover(bank, ['list_transfers']);
  await discover(crm, ['get_deal']);
  const call = async (step: number, slug: string, tool: string) => {
    const id = await propose(w, {
      step,
      tool: `${slug}__${tool}`,
      operation: `mcp.${slug}.${tool}`,
      connection: slug,
      args: { since: '2026-01-01' },
      description: 'A call',
      key: `idem-ledger-${step}`,
    });
    await dispatch(w, id, 'succeeded', `episode:${step}`);
    return id;
  };
  const own = await call(1, 'marta_bank_ing', 'list_transfers');
  await call(2, 'crm_team', 'get_deal');
  return { own, bank, crm };
}
