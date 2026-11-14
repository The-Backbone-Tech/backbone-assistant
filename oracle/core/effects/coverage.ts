import type { Coverage } from '../coverage.ts';

/**
 * The effects promise: every outside action passes one gate; hints only raise care; two dispatchers
 * never take the same action; an unclear outcome stays unknown until a dispatcher or an admin settles
 * it, and is never re-sent, not under a new key either.
 *
 * Promise-specific refusal reason: `not_undoable` (adapters/legacy/refusals/effects.ts).
 */
export const coverage: Coverage = {
  promise: 'effects',
  legacyFiles: ['effects.test.ts', 'dispatch.test.ts', 'connector-unknown-repeat.test.ts', 'undo.test.ts'],
  cases: {
    'effects.test.ts > the gateway routes exactly as the kernel does > sec.route_effect agrees with kernel route() on every one of the 2304 possible inputs':
      {
        status: 'ported',
        oracle: [
          'effects/gateway.test.ts > the gateway routes exactly as the kernel does > [S8] sec.route_effect agrees with kernel route() on every one of the 2304 possible inputs',
        ],
      },
    'effects.test.ts > the gateway routes exactly as the kernel does > the database lifecycle table matches the kernel lifecycle table':
      {
        status: 'ported',
        oracle: [
          'effects/gateway.test.ts > the gateway routes exactly as the kernel does > [S8] the database lifecycle table matches the kernel lifecycle table',
        ],
      },
    'effects.test.ts > the class of an effect: built-in classes are fixed, the catalogue decides the rest, hints only raise > an unknown operation is treated as a reversible external change (class 3)':
      {
        status: 'ported',
        oracle: [
          'effects/gateway.test.ts > the class of an effect: built-in classes are fixed, the catalogue decides the rest, hints only raise > [S8] an unknown operation is treated as a reversible external change (class 3)',
        ],
      },
    'effects.test.ts > the class of an effect: built-in classes are fixed, the catalogue decides the rest, hints only raise > a hint may raise the class, never lower it':
      {
        status: 'ported',
        oracle: [
          'effects/gateway.test.ts > the class of an effect: built-in classes are fixed, the catalogue decides the rest, hints only raise > [S8] a hint may raise the class, never lower it',
        ],
      },
    'effects.test.ts > the class of an effect: built-in classes are fixed, the catalogue decides the rest, hints only raise > lowering a built-in in the catalogue changes nothing, even once it is applied':
      {
        status: 'ported',
        oracle: [
          'effects/gateway.test.ts > the class of an effect: built-in classes are fixed, the catalogue decides the rest, hints only raise > [S8] lowering a built-in in the catalogue changes nothing, even once it is applied',
        ],
      },
    'effects.test.ts > the class of an effect: built-in classes are fixed, the catalogue decides the rest, hints only raise > in a team, lowering a built-in is an elevation, and even approved it changes nothing':
      {
        status: 'ported',
        oracle: [
          'effects/gateway.test.ts > the class of an effect: built-in classes are fixed, the catalogue decides the rest, hints only raise > [S4] in a team, lowering a built-in is an elevation, and even approved it changes nothing',
        ],
      },
    'effects.test.ts > the class of an effect: built-in classes are fixed, the catalogue decides the rest, hints only raise > in a team, lowering an operation below its class is an elevation the proposer cannot decide and a second admin can':
      {
        status: 'ported',
        oracle: [
          'effects/gateway.test.ts > the class of an effect: built-in classes are fixed, the catalogue decides the rest, hints only raise > [S4] in a team, lowering an operation below its class is an elevation the proposer cannot decide and a second admin can',
        ],
      },
    'effects.test.ts > the class of an effect: built-in classes are fixed, the catalogue decides the rest, hints only raise > in a team, marking an external operation internal is an elevation too':
      {
        status: 'ported',
        oracle: [
          'effects/gateway.test.ts > the class of an effect: built-in classes are fixed, the catalogue decides the rest, hints only raise > [S4] in a team, marking an external operation internal is an elevation too',
        ],
      },
    'effects.test.ts > the class of an effect: built-in classes are fixed, the catalogue decides the rest, hints only raise > only owners and admins classify operations, never from inside a run':
      {
        status: 'narrowed',
        oracle: [
          'effects/gateway.test.ts > the class of an effect: built-in classes are fixed, the catalogue decides the rest, hints only raise > [S4] only owners and admins classify operations, never from inside a run',
        ],
        note: 'Leaves out the owner session that also carries a run id and secret: the adapter Session offers a principal or a run, never both. Covers the run session, the agent principal and a member, and asserts the catalogue is unchanged.',
      },
    'effects.test.ts > proposing and dispatching > a reversible external change inside the mandate is allowed, dispatched by the system and receipted':
      {
        status: 'ported',
        oracle: [
          'effects/proposing.test.ts > proposing and dispatching > [S8] a reversible external change inside the mandate is allowed, dispatched by the system and receipted',
        ],
      },
    'effects.test.ts > proposing and dispatching > the database hashes the arguments, and a checker approves exactly those arguments':
      {
        status: 'narrowed',
        oracle: [
          'effects/proposing.test.ts > proposing and dispatching > [S14] the database hashes the arguments, and a checker approves exactly those arguments',
        ],
        note: 'Does not recompute the hash as sha256 of PostgreSQL jsonb text (a legacy encoding); asserts the gateway hash is the decision proposal hash, differs for other arguments, and that answering with the other hash is refused and leaves the question open.',
      },
    'effects.test.ts > proposing and dispatching > the proposing agent cannot dispatch its own effect': {
      status: 'ported',
      oracle: [
        'effects/proposing.test.ts > proposing and dispatching > [S8] the proposing agent cannot dispatch its own effect',
      ],
    },
    'effects.test.ts > proposing and dispatching > effects are proposed only from inside their run, by the worker holding its fence and secret':
      {
        status: 'ported',
        oracle: [
          'effects/proposing.test.ts > proposing and dispatching > [S8] effects are proposed only from inside their run, by the worker holding its fence and secret',
        ],
        note: 'Legacy answers a session outside the run (no secret, or a principal) with its stale-fence text, so those two steps accept not_in_run or stale.',
      },
    'effects.test.ts > proposing and dispatching > the same idempotency key returns the same effect, even under concurrency':
      {
        status: 'ported',
        oracle: [
          'effects/proposing.test.ts > proposing and dispatching > [O1] the same idempotency key returns the same effect, even under concurrency',
        ],
      },
    'effects.test.ts > proposing and dispatching > something above the ceiling goes to the person the work is for':
      {
        status: 'ported',
        oracle: [
          'effects/proposing.test.ts > proposing and dispatching > [S4] something above the ceiling goes to the person the work is for',
        ],
      },
    'effects.test.ts > proposing and dispatching > untrusted input, sensitive data and an external effect together go to a verifier':
      {
        status: 'ported',
        oracle: [
          'effects/proposing.test.ts > proposing and dispatching > [S8] untrusted input, sensitive data and an external effect together go to a verifier',
        ],
        note: 'Uses a run on a private task (fixtures.privateRun): the core task.create binding defaults to a shared task, where the owner’s words are not private material.',
      },
    'effects.test.ts > proposing and dispatching > the cancellation window is the workspace’s, not the proposer’s':
      {
        status: 'ported',
        oracle: [
          'effects/proposing.test.ts > proposing and dispatching > [S8] the cancellation window is the workspace’s, not the proposer’s',
        ],
      },
    'effects.test.ts > a rejected proposal is not asked again under the same authority > the same payment with a new idempotency key is denied as already rejected; other arguments ask anew':
      {
        status: 'ported',
        oracle: [
          'effects/proposing.test.ts > a rejected proposal is not asked again under the same authority > [S4] the same payment with a new idempotency key is denied as already rejected; other arguments ask anew',
        ],
      },
    'effects.test.ts > recovery semantics > once dispatch has begun, an effect cannot be cancelled': {
      status: 'ported',
      oracle: [
        'effects/recovery.test.ts > recovery semantics > [S8] once dispatch has begun, an effect cannot be cancelled',
      ],
    },
    'effects.test.ts > recovery semantics > an unknown outcome is reconciled by the dispatcher or an admin, never by the proposer, and never re-claimed':
      {
        status: 'ported',
        oracle: [
          'effects/recovery.test.ts > recovery semantics > [S8] an unknown outcome is reconciled by the dispatcher or an admin, never by the proposer, and never re-claimed',
        ],
      },
    'effects.test.ts > recovery semantics > a dispatcher that lost its claim cannot begin dispatch': {
      status: 'ported',
      oracle: [
        'effects/recovery.test.ts > recovery semantics > [O1] a dispatcher that lost its claim cannot begin dispatch',
      ],
    },
    'effects.test.ts > recovery semantics > authority is re-checked when it is spent: revoked after approval means cancelled, not dispatched':
      {
        status: 'ported',
        oracle: [
          'effects/recovery.test.ts > recovery semantics > [S5] authority is re-checked when it is spent: revoked after approval means cancelled, not dispatched',
        ],
      },
    'effects.test.ts > recovery semantics > an effect whose mandate expired after it was claimed is cancelled when dispatch would begin':
      {
        status: 'ported',
        oracle: [
          'effects/recovery.test.ts > recovery semantics > [S5] an effect whose mandate expired after it was claimed is cancelled when dispatch would begin',
        ],
      },
    'effects.test.ts > recovery semantics > revoking a mandate cancels effects that have not been dispatched and withdraws their questions':
      {
        status: 'ported',
        oracle: [
          'effects/recovery.test.ts > recovery semantics > [S5] revoking a mandate cancels effects that have not been dispatched and withdraws their questions',
        ],
      },
    'dispatch.test.ts > the dispatch queue > an allowed effect goes to the next dispatcher, as the workspace’s system principal, and leaves once observed':
      {
        status: 'narrowed',
        oracle: [
          'effects/queue-handoff.test.ts > the dispatch queue > [S8] an allowed effect goes to the next dispatcher, as the workspace’s system principal, and leaves once observed',
        ],
        note: 'Queue membership (ops.effect_queue rows, administrator) is replaced by what claim_next hands out: the effect, then nothing once observed. The file holds only this case’s work instead of emptying the shared queue.',
      },
    'dispatch.test.ts > the dispatch queue > the claim is worthless to anyone but the system principal': {
      status: 'ported',
      oracle: [
        'effects/queue-claim-only.test.ts > the dispatch queue > [S8] the claim is worthless to anyone but the system principal',
      ],
    },
    'dispatch.test.ts > the dispatch queue > an effect inside its cancellation window is handed out only once the window ends':
      {
        status: 'ported',
        oracle: [
          'effects/queue-window.test.ts > the dispatch queue > [S8] an effect inside its cancellation window is handed out only once the window ends',
        ],
      },
    'dispatch.test.ts > the dispatch queue > effects that are waiting for a checker, denied or cancelled never reach a dispatcher':
      {
        status: 'narrowed',
        oracle: [
          'effects/queue-not-due.test.ts > the dispatch queue > [S13] effects that are waiting for a checker, denied or cancelled never reach a dispatcher',
        ],
        note: 'Queue membership is observed through claim_next: it hands out the allowed effect and nothing else, and nothing after that effect is cancelled. The legacy check that cancelling removes the row before any claim is left out (the effect here is cancelled after being claimed).',
      },
    'dispatch.test.ts > the dispatch queue > concurrent dispatchers never take the same effect, and together they take every one':
      {
        status: 'ported',
        oracle: [
          'effects/queue-concurrent.test.ts > the dispatch queue > [O1] concurrent dispatchers never take the same effect, and together they take every one',
        ],
      },
    'dispatch.test.ts > the dispatch queue > a claimed effect whose dispatcher lost its lease is claimed again under a new claim; the old one is dead':
      {
        status: 'ported',
        oracle: [
          'effects/queue-lost-lease.test.ts > the dispatch queue > [O1] a claimed effect whose dispatcher lost its lease is claimed again under a new claim; the old one is dead',
        ],
      },
    'dispatch.test.ts > the dispatch queue > a dispatching effect whose dispatcher went silent comes back as stale, to be inspected and never re-sent':
      {
        status: 'narrowed',
        oracle: [
          'effects/queue-stale-dispatch.test.ts > the dispatch queue > [O1] a dispatching effect whose dispatcher went silent comes back as stale, to be inspected and never re-sent',
        ],
        note: 'Waits out the legacy 30-second grace period instead of moving ops.effect_queue.available_at as the administrator, and observes that the queue is empty through claim_next instead of reading the queue table.',
      },
    'connector-unknown-repeat.test.ts > phase-A connected effect repeat guard > keeps the public proposal crossing and app effect-table ACL while adding only bounded lineage storage':
      {
        status: 'narrowed',
        oracle: [
          'effects/unknown-repeat.test.ts > an unclear outcome is never re-sent, not under a new key either > [S8] the service reaches the effect record only through the gateway: it cannot insert, change or delete an effect row',
        ],
        note: 'Asserts what the ACL is for: the service can neither insert, update nor delete an effect row, and nothing changed. The catalogue introspection (one overload, owner, SECURITY DEFINER, search_path, delegation to a private function, trigger names, private function ACLs) is SG-EFF-01.',
      },
    'connector-unknown-repeat.test.ts > phase-A connected effect repeat guard > records one durable denied receipt for an exact UNKNOWN copy and replays that key after reconciliation':
      {
        status: 'narrowed',
        oracle: [
          'effects/unknown-repeat.test.ts > an unclear outcome is never re-sent, not under a new key either > [S8] an exact copy of an unknown change is a durable denied receipt under any key, and its own key replays it after reconciliation',
        ],
        note: 'Leaves out the probe of the session’s transaction isolation level (SG-EFF-04); adds that the replayed copy stays denied after reconciliation.',
      },
    'connector-unknown-repeat.test.ts > phase-A connected effect repeat guard > prefers pending custody over UNKNOWN and ignores an already denied linked copy':
      {
        status: 'narrowed',
        oracle: [
          'effects/unknown-repeat.test.ts > an unclear outcome is never re-sent, not under a new key either > [S8] pending custody blocks an exact copy in every unresolved state, and a denied copy is never the original',
        ],
        note: 'Pending custody and an older UNKNOWN of the same exact change cannot coexist through the gateway (the second would be blocked); legacy seeds that state as the administrator (SG-EFF-02). Asserts instead that allowed, claimed, dispatching and awaiting-checker originals block as repeat_pending, the unknown one as repeat_unknown_blocked, and that copies link to the original, never to a denied copy.',
      },
    'connector-unknown-repeat.test.ts > phase-A connected effect repeat guard > keeps multiple legacy UNKNOWN rows intact and links to the deterministic earliest match':
      { status: 'gap', gap: 'SG-EFF-02' },
    'connector-unknown-repeat.test.ts > phase-A connected effect repeat guard > serializes independent roots for the same task and beneficiary without weakening live run claims':
      {
        status: 'ported',
        oracle: [
          'effects/unknown-repeat.test.ts > an unclear outcome is never re-sent, not under a new key either > [O1] independent roots for the same task and beneficiary are serialised: of two simultaneous copies exactly one is allowed',
        ],
      },
    'connector-unknown-repeat.test.ts > phase-A connected effect repeat guard > observes the post-advisory READ COMMITTED snapshot after a different root commits':
      {
        status: 'narrowed',
        oracle: [
          'effects/unknown-repeat.test.ts > an unclear outcome is never re-sent, not under a new key either > [O1] a copy proposed while a different root’s original is uncommitted sees the original once it commits',
        ],
        note: 'Holds the first proposal uncommitted and releases it while the second is in flight; that the second actually waited on the advisory lock (pg_stat_activity) is not observable (SG-EFF-03).',
      },
    'connector-unknown-repeat.test.ts > phase-A connected effect repeat guard > commits a denied lineage receipt while current public dispatch holds the original and waits on its ledger':
      {
        status: 'narrowed',
        oracle: [
          'effects/unknown-repeat.test.ts > an unclear outcome is never re-sent, not under a new key either > [O1] a denied copy commits while the original’s dispatch waits for it, and the dispatch then goes ahead once',
        ],
        note: 'Asserts the outcome (denied copy linked to the original, dispatch true, original dispatching, ledger verified); the lock wait and the FOR KEY SHARE NOWAIT probe need the administrator (SG-EFF-03), and the copy’s state inside its own open transaction is read after commit instead.',
      },
    'connector-unknown-repeat.test.ts > phase-A connected effect repeat guard > keeps different tasks and authoritative class-one reads outside the exact-change block':
      {
        status: 'ported',
        oracle: [
          'effects/unknown-repeat.test.ts > an unclear outcome is never re-sent, not under a new key either > [S8] another task, and a read the catalogue makes class 1, are outside the exact-change block',
        ],
        note: 'Strengthened: the other task’s change has an unknown exact copy on the first task, so the case shows the task boundary rather than an empty history.',
      },
    'connector-unknown-repeat.test.ts > phase-A connected effect repeat guard > does not join distinct connector, operation, JSONB payload, or expected-version intents':
      {
        status: 'ported',
        oracle: [
          'effects/unknown-repeat.test.ts > an unclear outcome is never re-sent, not under a new key either > [S8] a different connector, operation, payload or expected version is a different intent',
        ],
      },
    'connector-unknown-repeat.test.ts > phase-A connected effect repeat guard > does not join a same-task receipt recorded under a different beneficiary':
      {
        status: 'ported',
        oracle: [
          'effects/unknown-repeat.test.ts > an unclear outcome is never re-sent, not under a new key either > [S8] an unknown change made for another beneficiary on the same task does not block this one',
        ],
        note: 'The other beneficiary’s UNKNOWN is made through the gateway (their own run on the shared task, dispatched unknown) instead of seeded by the administrator.',
      },
    'connector-unknown-repeat.test.ts > phase-A connected effect repeat guard > refuses malformed high-class MCP targets and project partition escapes':
      {
        status: 'ported',
        oracle: [
          'effects/unknown-repeat.test.ts > an unclear outcome is never re-sent, not under a new key either > [S8] a change naming the wrong connector is refused, and a project does not partition the block',
        ],
      },
    'connector-unknown-repeat.test.ts > phase-A connected effect repeat guard > replays original keys before the READ COMMITTED precondition and rejects only fresh higher-isolation intents':
      { status: 'gap', gap: 'SG-EFF-04' },
    'connector-unknown-repeat.test.ts > phase-A connected effect repeat guard > keeps lineage immutable and rejects mismatched exact payload at deferred validation':
      {
        status: 'adversary',
        oracle: [
          'effects/unknown-repeat.test.ts > the record of an unknown outcome and its blocked copies cannot be erased, even below every grant > [S8] lineage is immutable: unlinking, deleting, re-keying, truncating or forging a mismatched copy is refused',
        ],
      },
    'connector-unknown-repeat.test.ts > phase-A connected effect repeat guard > validates missing, cross-workspace, two-node-cycle, and null-route lineage at commit':
      {
        status: 'adversary',
        oracle: [
          'effects/unknown-repeat.test.ts > the record of an unknown outcome and its blocked copies cannot be erased, even below every grant > [S8] forged lineage is refused at commit: a missing or foreign original, a cycle, or a copy without a route',
        ],
      },
    'undo.test.ts > undo: a person reverses a completed effect through the gateway > the agent’s change to a document is undone by the person it was for, and the dispatcher restores it':
      {
        status: 'ported',
        oracle: [
          'effects/undo.test.ts > undo: a person reverses a completed effect through the gateway > [S8] the agent’s change to a document is undone by the person it was for, and the dispatcher restores it',
        ],
      },
    'undo.test.ts > undo: a person reverses a completed effect through the gateway > only a completed effect with a way back can be undone':
      {
        status: 'ported',
        oracle: [
          'effects/undo.test.ts > undo: a person reverses a completed effect through the gateway > [S8] only a completed effect with a way back can be undone',
        ],
      },
    'undo.test.ts > undo: a person reverses a completed effect through the gateway > an undo is asked for by the person the effect was for, or an admin — never by a run or another member':
      {
        status: 'ported',
        oracle: [
          'effects/undo.test.ts > undo: a person reverses a completed effect through the gateway > [S4] an undo is asked for by the person the effect was for, or an admin — never by a run or another member',
        ],
        note: 'Uses a run on a private task (fixtures.privateRun): the core task.create binding defaults to a shared task.',
      },
    'undo.test.ts > undo: a person reverses a completed effect through the gateway > one undo at a time: the same key returns the same undo, and another is refused while one stands':
      {
        status: 'ported',
        oracle: [
          'effects/undo.test.ts > undo: a person reverses a completed effect through the gateway > [O1] one undo at a time: the same key returns the same undo, and another is refused while one stands',
        ],
      },
    'undo.test.ts > undo: a person reverses a completed effect through the gateway > an undo above the person’s role goes to another owner or admin':
      {
        status: 'ported',
        oracle: [
          'effects/undo.test.ts > undo: a person reverses a completed effect through the gateway > [S4] an undo above the person’s role goes to another owner or admin',
        ],
      },
  },
  gaps: [
    {
      id: 'SG-EFF-01',
      kind: 'migration-history',
      summary:
        'The shape of the proposal crossing in the catalogue: one overload, owned by the governance role, SECURITY DEFINER with a fixed search_path, delegating to a private repeat-guard function, with named lineage triggers and private trigger-function ACLs.',
      needs:
        'Nothing black-box: the successor states "the effect record is reachable only through the gateway" as its own structural test; the oracle keeps the behavioural half (the service cannot write an effect row).',
    },
    {
      id: 'SG-EFF-02',
      kind: 'administrative',
      summary:
        'Several unresolved records of the same exact change (pending custody beside an older UNKNOWN, or two UNKNOWNs) exist only as historical rows the administrator seeds; the gateway itself never lets the second one in.',
      needs:
        "A named crossing that imports or restores historical effect records, or a contract statement that such states are unreachable (then the deterministic earliest-match rule is the successor's migration test).",
    },
    {
      id: 'SG-EFF-03',
      kind: 'no-surface',
      summary:
        'That a waiting proposer or dispatcher is actually blocked on the partition lock (pg_stat_activity wait event, FOR KEY SHARE NOWAIT probe) while another transaction is open.',
      needs:
        'An adapter signal that a held or in-flight call is waiting on another session (for example `hold` reporting "blocked"), or a lock-wait view.',
    },
    {
      id: 'SG-EFF-04',
      kind: 'no-surface',
      summary:
        'A fresh connected change proposed at REPEATABLE READ is refused while its original key still replays; the oracle cannot choose the transaction isolation level of a call.',
      needs:
        "An adapter verb to open a session at a stated isolation level, or a contract that isolation is adapter-internal (then the case is the successor's own).",
    },
  ],
};
