import { describe, expect, it } from 'vitest';
import {
  addPerson,
  answer,
  candidateWithEvidence,
  decisionOf,
  newWorld,
  propose,
  recordSource,
  refused,
  requestPromotion,
  useTarget,
} from '../harness.ts';

const target = useTarget('isolation.catalog');

interface Attempt {
  refused: boolean;
  reason: string | null;
  detail: string | null;
}
interface Store {
  store: string;
  readable: boolean;
  forced: boolean;
  wall: string;
}
interface Fn {
  schema: string;
  name: string;
  signature: string;
  internal: boolean;
  serviceExecutes: boolean;
  publicExecutes: boolean;
}

const attack = (name: string, args: Record<string, unknown> = {}) => target().adversary.attack<Attempt>(name, args);
/** Refused by the storage itself, for the reason the promise names. */
const holds = (attempt: Attempt, reason = 'frozen') => expect(attempt, attempt.detail ?? 'the attack succeeded').toMatchObject({ refused: true, reason });

describe('the schema’s guarantees hold for every object, including future ones', () => {
  it('[S18] the service may execute no internal function', async () => {
    const w = await newWorld(target(), 'Published');
    const fns = await w.owner$.observe<Fn>('catalog.functions');
    expect(fns.filter((f) => f.internal).length).toBeGreaterThan(0);
    expect(fns.filter((f) => f.internal && f.serviceExecutes).map((f) => f.signature)).toEqual([]);
  });

  it('[S18] internal functions are refused to the service, whoever the session names', async () => {
    const w = await newWorld(target(), 'Internals');
    for (const session of [w.owner$, w.agent$, w.system$, target().setWorkspace(null)]) {
      const calls = await session.observe<{ signature: string; refusal: string | null }>('catalog.call_internals');
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.filter((c) => !/permission denied for function/.test(c.refusal ?? '')).map((c) => c.signature)).toEqual([]);
    }
  });

  it('[S18] no function in the product schemas is executable by PUBLIC', async () => {
    const w = await newWorld(target(), 'NoPublic');
    const fns = await w.owner$.observe<Fn>('catalog.functions');
    expect(fns.filter((f) => f.publicExecutes).map((f) => f.signature)).toEqual([]);
  });

  it('[S18] functions the owning roles create later are not executable by PUBLIC either (default privileges)', async () => {
    expect(await target().adversary.attack('storage.later_functions')).toEqual({
      'sec.later_by_owner': false,
      'gov.later_by_gov': false,
      'sec.later_by_installer': false,
      // Control: a role without the schema's default privileges does hand it to PUBLIC.
      'sec.later_by_probe': true,
    });
  });

  it('[S1] every store, partitioned ones included, has forced row-level security and the exact tenant wall', async () => {
    const w = await newWorld(target(), 'Walls');
    const stores = await w.owner$.observe<Store>('catalog.stores');
    // Amended (oracle/AMENDMENTS.md A-1): the target's own catalogue of stores, both ways, in place of a legacy count.
    const declared = (await w.owner$.observe<{ store: string }>('catalog.declared_stores')).map((d) => d.store).sort();
    expect(declared.length).toBeGreaterThan(0);
    expect(stores.map((s) => s.store).sort()).toEqual(declared);
    expect(stores.filter((s) => !s.forced || s.wall !== 'exact').map((s) => `${s.store}: ${s.wall}`)).toEqual([]);
  });

  it('[S1] the inventory catches a partitioned store without a wall and a wall that lets everything through', async () => {
    const after = await target().adversary.attack<Store[]>('storage.break_walls_then_inventory');
    expect(after.find((s) => s.store === 'later_partitioned')).toMatchObject({ wall: 'missing' });
    expect(after.find((s) => s.store === 'tasks')).toMatchObject({ wall: 'not-the-workspace' });
  });

  it('[S18] the service and crossing roles are neither superusers nor able to bypass row-level security', async () => {
    const w = await newWorld(target(), 'Roles');
    const roles = await w.owner$.observe<{ role: string; superuser: boolean; bypassRls: boolean }>('catalog.roles');
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.filter((r) => r.superuser || r.bypassRls)).toEqual([]);
  });

  it('[S6] the service reads a run but not why it is marked', async () => {
    const w = await newWorld(target(), 'MarkReasons');
    expect(await w.owner$.observe('catalog.run_hidden_columns')).toEqual([
      { column: 'elsewhere_source' },
      { column: 'sensitive_source' },
      { column: 'untrusted_source' },
    ]);
    await refused(w.owner$.observe('run.mark_sources', { run: w.run }), 'denied');
    expect(await w.owner$.observe('run', { id: w.run })).toHaveLength(1);
  });

  it('[S18] accounts live outside the tenant stores: only the service reaches them, the crossings never do', async () => {
    const w = await newWorld(target(), 'Accounts');
    const stores = await w.owner$.observe<{ owner: string; serviceReaches: boolean; crossingsReach: boolean; publicReaches: boolean }>(
      'catalog.account_stores',
    );
    expect(stores.length).toBe(4);
    for (const s of stores) expect(s).toMatchObject({ serviceReaches: true, crossingsReach: false, publicReaches: false });
  });

  it('[S18] the service cannot read the operations stores: queues, user directory, invitations, migrations', async () => {
    const w = await newWorld(target(), 'OpsHidden');
    const reads = await w.owner$.observe<{ store: string; refusal: string | null }>('catalog.read_operations_stores');
    expect(reads.map((r) => r.store)).toEqual(expect.arrayContaining(['run_queue', 'effect_queue', 'invitations', 'schema_migrations']));
    expect(reads.filter((r) => !/permission denied for schema ops/.test(r.refusal ?? ''))).toEqual([]);
  });

  it('[S1] negative control: without the wall, the isolation check would see other workspaces', async () => {
    const x = await newWorld(target(), 'ControlA');
    const y = await newWorld(target(), 'ControlB');
    expect(await target().adversary.attack('storage.drop_wall_then_count', { from: x.ws, of: y.ws })).toBeGreaterThan(0);
    // With the wall in place the same count is zero.
    expect((await x.owner$.observe<{ others: number }>('catalog.rows', { store: 'principals', workspace: x.ws }))[0]?.others).toBe(0);
  });
});

describe('no store is ever truncated, not even by the role that owns it', () => {
  it('[S10] the owning role cannot truncate the ledger, and the service has no right to try', async () => {
    const w = await newWorld(target(), 'NoTruncate');
    const { plain, cascade } = await target().adversary.attack<{ plain: Attempt; cascade: Attempt }>('storage.truncate_ledger_as_owner');
    expect(plain.refused).toBe(true);
    holds(cascade);
    await refused(w.owner$.call('iso.ledger.truncate'), 'denied');
    expect((await w.owner$.observe('ledger')).length).toBeGreaterThan(0);
  });

  it('[S10] every store refuses truncation by its owning role', async () => {
    const attempts = await target().adversary.attack<Record<string, Attempt>>('storage.truncate_every_store_as_owner');
    // Amended (oracle/AMENDMENTS.md A-2): every store of the target's own catalogue, in place of a legacy count.
    const w = await newWorld(target(), 'TruncateCatalogue');
    const declared = (await w.owner$.observe<{ store: string }>('catalog.declared_stores')).map((d) => d.store).sort();
    expect(declared.length).toBeGreaterThan(0);
    expect(Object.keys(attempts).sort()).toEqual(declared);
    expect(Object.entries(attempts).filter(([, a]) => !a.refused || a.reason !== 'frozen').map(([s]) => s)).toEqual([]);
  });
});

describe('the storage holds even for a writer that bypasses every grant', () => {
  it('[S10] evidence is immutable: sources, messages and document versions', async () => {
    const w = await newWorld(target(), 'EvidenceTrigger');
    const source = await recordSource(w, 'Budget approved on 12 May.');
    await w.owner$.call('iso.message.post', { task: w.task, author: w.owner, content: 'Hi' });
    const document = await w.owner$.call<string>('iso.document.create', { content: 'v1', by: w.owner });
    await w.owner$.call('iso.document.revise', { document, content: 'v2', by: w.owner });
    for (const [name, args] of [
      ['storage.rewrite_source', { source }],
      ['storage.delete_source', { source }],
      ['storage.rewrite_messages', {}],
      ['storage.delete_messages', {}],
      ['storage.rewrite_document_versions', { document }],
      ['storage.delete_document_versions', { document }],
    ] as const) {
      holds(await attack(name, { workspace: w.ws, ...args }));
    }
  });

  it('[S10] the ledger is append-only', async () => {
    const w = await newWorld(target(), 'LedgerTrigger');
    holds(await attack('storage.delete_ledger', { workspace: w.ws }));
    holds(await attack('storage.rewrite_ledger', { workspace: w.ws }));
  });

  it('[O1] a step’s input is frozen and a completed step never changes', async () => {
    const w = await newWorld(target(), 'StepTrigger');
    await w.agent$.call('run.step.write', { run: w.run, seq: 7, kind: 'tool', input: { q: 1 }, fence: w.fence });
    holds(await attack('storage.rewrite_step_input', { workspace: w.ws, run: w.run, seq: 7 }));
    expect(await w.agent$.call('run.step.complete', { run: w.run, seq: 7, output: { ok: true } })).toBe(1);
    holds(await attack('storage.rewrite_completed_step', { workspace: w.ws, run: w.run, seq: 7 }));
  });

  it('[S8] a proposed effect cannot be altered, its hash always matches its arguments, and it only moves forward', async () => {
    const w = await newWorld(target(), 'EffectTrigger');
    const effect = await propose(w);
    holds(await attack('storage.alter_effect_args', { workspace: w.ws, effect }));
    holds(await attack('storage.skip_effect_status', { workspace: w.ws, effect, to: 'succeeded' }));
    holds(
      await attack('storage.insert_effect_with_wrong_hash', { workspace: w.ws, run: w.run, agent: w.agent, mandate: w.mandate }),
      'invalid',
    );
  });

  it('[S7] an answered decision stays answered, and its checker must be independent', async () => {
    const w = await newWorld(target(), 'DecisionTrigger');
    const decision = await decisionOf(w, await propose(w, { classHint: 5 }));
    holds(await attack('storage.answer_as', { workspace: w.ws, decision, by: w.agent }), 'not_independent');
    await answer(w.owner$, w, decision, 'rejected');
    holds(await attack('storage.reopen_decision', { workspace: w.ws, decision }));
  });

  it('[S4] mandate terms never change, and a revoked mandate stays revoked', async () => {
    const w = await newWorld(target(), 'MandateTrigger');
    holds(await attack('storage.alter_mandate', { workspace: w.ws, mandate: w.mandate }));
    await w.owner$.call('mandate.revoke', { mandate: w.mandate });
    holds(await attack('storage.unrevoke_mandate', { workspace: w.ws, mandate: w.mandate }));
  });

  it('[S7] a candidate’s claim never changes, its terms are set once, and a closed candidate stays closed', async () => {
    const w = await newWorld(target(), 'CandidateTrigger');
    const { candidate } = await candidateWithEvidence(w, 'The office moves in May.', 'office moves in May');
    const colleague = await addPerson(w, 'Colleague');
    await requestPromotion(w, candidate);
    holds(await attack('storage.rewrite_candidate', { workspace: w.ws, candidate }));
    holds(await attack('storage.flip_candidate_marks', { workspace: w.ws, candidate }));
    holds(await attack('storage.reassign_candidate', { workspace: w.ws, candidate, to: colleague.id }));
    holds(await attack('storage.reopen_closed_candidate', { workspace: w.ws, candidate }));
  });

  it('[S12] forgotten memory stays forgotten, and memory is never reassigned', async () => {
    const w = await newWorld(target(), 'MemoryTrigger');
    const colleague = await addPerson(w, 'Colleague');
    const memory = await w.owner$.call<string>('memory.write', { owner: w.owner, agent: w.agent, content: 'Prefers calls after 16:00.' });
    holds(await attack('storage.reassign_memory', { workspace: w.ws, memory, to: colleague.id }));
    await w.owner$.call('memory.forget', { memory });
    holds(await attack('storage.unforget_memory', { workspace: w.ws, memory, content: 'Prefers calls after 16:00.' }));
  });

  it('[S1] a person’s bound account never changes', async () => {
    const w = await newWorld(target(), 'AccountTrigger');
    await w.owner$.call('iso.account.bind', { user: 'user-account-trigger' });
    holds(await attack('storage.rebind_account', { workspace: w.ws, principal: w.owner }));
  });

  it('[O5] a document keeps its identity, and every write keeps the previous version, whoever writes it', async () => {
    const w = await newWorld(target(), 'DocumentTrigger');
    const document = await w.owner$.call<string>('iso.document.create', { content: 'first', by: w.owner });
    holds(await attack('storage.retarget_document', { workspace: w.ws, document, task: w.task }));
    expect(await target().adversary.attack('storage.rewrite_document', { workspace: w.ws, document })).toEqual([
      { version: 2, content: 'rewritten', kept_version: 1, kept: 'first' },
    ]);
  });
});
