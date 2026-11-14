# The v0.8 kernel, one synthetic host path

Unaccepted, and reached by nothing in the normal route: no default, no package export, no consumer. The app stays on the older core. Two kernels never hold live truth for one data folder.

| File | What it is |
| --- | --- |
| `transport.ts`, `session.ts`, `types.ts` | The typed port: fixed queries, credential and role checks, honest outcomes. SQL owns authority; this holds no permissions. |
| `document-door.ts` | A person's document write as an effect attempt, on the same `Gateway` the turn code uses. The door assigns class, tool, operation and cost; the kernel sees digests. |
| `composition/home-owner.ts` (shared) | One live host per data folder, held for the process's life by a socket the operating system ends with it. A paused owner still answers; only a dead one is recovered. |
| `door-hold.ts` | One live door per workspace: a session advisory lock on a connection of its own, for the host's life. A second data folder or a copy does not open. If the connection goes, the host stops acting. |
| `host.ts` | One thread behind the `Host` contract, using the real `Gateway`, turn code and material store. It answers only the methods that thread needs. |
| `session-owner.ts` | The person's session owner. It alone holds the identity login, the only one that mints a person's session; a login that holds both it and the door is refused. It mints only after a `PresenceCheck` the person answers outside the renderer and the agent. One presence carries routine acts for 15 minutes. Settling an unknown outcome, answering a held action or settling a promotion asks for that exact statement every time, on a session of its own. Tokens stay in memory; `end()` forgets them. Only an owner whose presence attests `person` has its word reported as yours; any other is reported as a fixture's. |

`composition/host.ts` is written against the older core, so this is a second composition, not a swap.

## The path

- **Turn:** a thread is one task under one contract. A turn is one run. Run secrets stay in the process and are never written down.
- **Write:** private custody, then attempt, claim, begin, the bytes, settle. Custody comes first, so a lost acknowledgement still leaves the exact intent.
- **One kernel:** `kernel.json` is written under the data folder lock by whichever kernel first opens a free data folder, naming it and, here, its database and workspace. The older core stamps `core` on a data folder it opens and changes nothing else. A data folder with its work in it opens as it always did even if the stamp cannot be written. Each refuses the other's data folder, and this one refuses a data folder already holding work.
- **Landing:** the data folder lock covers custody and the landing, not the kernel's calls or a wait. Inside it, right before the bytes, the door rereads the attempt, the run and the target. A run closed by then lands nothing. A lock taken over before the bytes stops them, and after they start the outcome is unknown.
- **Restart:** the owner lock and the workspace door hold prove no other host is live, and recovery runs only under them, so it closes first and no attempt can follow the read. Open attempts settle by their state in SQL, however their turn ended. One not begun is denied. A dead process's run closes as cancelled through the door, with no person. A begun attempt lapses to unknown outcome, and only the exact bytes found at the source reconcile it, and only after the folder copy a kill left is finished. A different file in the folder stays, and the write stays unknown outcome. An attempt that cannot be resolved within a lease stays held and is reported. One kernel call has a bound, past which its outcome is unknown and it is not retried. Nothing is sent.
- **End of a turn:** finished only if the turn did all it said and the kernel agrees that nothing is open or unknown. Anything else is cancelled. Stop always cancels. A close with no answer is read back and tried again within three tries. Still unconfirmed, Stop answers `stopped: false`, the turn says so, and the next start closes the run.
- **Stop:** aborts, closes the run, then saves and acknowledges. An aborted write waits for the close before it can begin, and is denied.
- **Held:** the kernel refuses a new attempt on a target with a dispatching or unknown row, lapsed or live, in any thread of the workspace, and lets one of two claims begin. The door reports that as REFUSED, held, and the door keeps no hold of its own. A receipt that is not confirmed is unknown outcome in the turn.
- **unknown outcome with no bytes:** stays unknown outcome and held, and the turn says the bytes were not found. Absence cannot prove a write never landed, because a restored data folder looks the same, so nothing lifts it alone. `settleUnknown` takes a confirmation naming the attempt and the digest of the exact statement shown: on a closed run, after the door finds no bytes under the data folder lock, it reconciles to `failed` with a digest of that confirmation. The turn then reads REFUSED and says who confirmed it: you, or a fixture. A lost acknowledgement is told by that digest in the row; any other failure is shown with no attribution. It sends nothing, and it never reads as success. Bytes found, or custody that cannot say what to look for, refuse it.

## Run it

The SQL, its pin and the provisioner are in `packages/kernel`. The suite starts that package's disposable PostgreSQL 18, apart from the core's, because roles belong to a cluster and both kernels name a `backbone_app`.

```bash
pnpm --dir packages/platform test:sql-v08:sql
```

`test/sql-v08.test.ts` needs no database and runs with the platform's tests. The real-SQL suites are not in `pnpm check` or CI yet.

## Not established

- **Presence is a port.** The app's main-process dialog that implements it is not written yet (S5), so every run so far used a scripted presence that attests `fixture`. A presence check proves someone at this OS session answered, not who. The OS account and the identity login's sealed credential stand for the rest.
- The door's role is trusted. SQL binds its calls to the attempt, not to what really happened.
- **Run closure stops at `begin_attempt`, not at the wire.** Past it SQL cannot call a dispatcher back. The door rechecks `gov.effect_cap` as its last step before the bytes, but a run closed or revoked after that check still lands. The window is as long as a process pause, and only a fence at the destination closes it: `DestinationFence` in `types.ts` says what one must honour, and nothing implements it yet. Until then `failed` means not observed, not that it will never happen. `settle` still records what happened.
- **The file lock between its last heartbeat and the landing.** A takeover there goes unseen until the next heartbeat, and a check cannot close that. Only outside interference with `.lock` reaches it, because the owner socket already excludes other v0.8 hosts.
- **The door hold is a promise between hosts.** The advisory lock needs nothing from the kernel, and the kernel requires nothing of it: a door that does not take the lock is not stopped. A kernel check would be needed to refuse one.
- **A connection lost while a write is past its last check.** If the hold's connection drops during a process pause, another data folder can open while that write can still land. Only a fence at the destination closes that.
- **A stale copy.** A copy opened after the live data folder has gone can look for bytes that only the other data folder holds, find none, and be confirmed. The confirmation is what stands in for that knowledge.
- **A real confirmation.** With a scripted presence, `settleUnknown` shows that a caller presented the digest of the statement, not that a person read it. The kernel stores a digest and binds no person to `reconcile_attempt`.
- **Held actions.** A write above the contract's ceiling waits in its turn, with no time limit, until `decideHeld` or a Stop. That route confirms the attempt and the exact statement, then calls `gov.accept_attempt` or `gov.deny_attempt`. A restart closes the run, which ends the row. With a scripted presence, acceptance shows a caller presented the digest, not that a person read it.
- **Promotions.** No promotion runs on this path, and `PromotionCrossing` lives in `work-planes-lab:`. `crossingDoor` is the door hook its binding must carry, and `RunAuthority.reconcilePromotion` is the live checker's route. `settlePromotionUnknown` is the owner's route past a dead checker: it confirms the statement `promotionUnknowns` shows and stores a digest of that word. SQL cannot check it, and the tests build their records by hand, so no real crossing has been run through here. Both routes read the audit export.
- **The class is the door's word.** SQL cannot see the effect. `irreversible` is accepted by the port, and no door here assigns it.
- **Finding a dead run.** `read_run` needs an id, and a kill can lose one, so recovery still lists runs through the audit export.
- **The stamp guards against mistakes, not against a local writer.** Anything that can write the data folder can rewrite `kernel.json`.
- A claim that lapses while a live dispatcher is slow stays dispatching until a restart sweeps it. Nothing sweeps during a run.
- The stub engine only. Native checkpoints, withdrawal, attachments and the person's Save are not on this path.
