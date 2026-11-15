// The person's document write as a v0.8 effect attempt: an attempt with no verdict, on the same
// Gateway the turn code uses, so a turn cannot tell which kernel it runs on. The door assigns class,
// tool, operation and cost here; the turn only names a file, and the kernel sees digests alone.
import type { MaterialEntry } from '../../api.ts';
import { originalWrite, retainOriginalWrite, type WriteTarget } from '../../composition/thread-custody.ts';
import { withHomeLock } from '../../composition/home-lock.ts';
import { writtenVersion, type StoredWrite } from '../../composition/recovered-writes.ts';
import { sha256 } from '../../stub/fsx.ts';
import type { Gateway } from '../../stub/harness.ts';
import type { MaterialStore } from '../../stub/material.ts';
import type { AttemptRequest, EffectAttempt, EffectDoor, RunHandle } from './types.ts';

export type V08WritePoint = 'write.custodied' | 'write.attempted' | 'write.claimed' | 'write.begun' | 'write.landing' | 'write.performing' | 'write.projecting' | 'write.landed' | 'write.materialised' | 'write.settled';
const TARGET_HELD = '55006';
/** Rows that did not go out. Held waits for a person, and its run's close ends it. */
const UNSENT = ['denied', 'attempted', 'held'];
const DOCUMENT_WRITE = { class: 'document', tool: 'workspace', operation: 'write_document', cost: 1 } as const;

export const argsOf = (target: Pick<WriteTarget, 'document' | 'name' | 'body' | 'baseVersion'>): StoredWrite['args'] =>
  ({ document_id: target.document, title: target.name, content_sha256: sha256(target.body), base_version: target.baseVersion });
export const argsDigest = (target: Parameters<typeof argsOf>[0]) => sha256(JSON.stringify(argsOf(target)));
export const originalKey = (turn: string, name: string) => sha256(`${turn}:${name}`);
const request = (turn: string, target: WriteTarget): AttemptRequest =>
  ({ ...DOCUMENT_WRITE, target: sha256(target.document), args: argsDigest(target), key: originalKey(turn, target.name) });

export const heldStatement = (name: string) => `The write of ${name} is above what its contract allows, so it waits for acceptance. Nothing was sent.`;

export interface DocumentDoorOptions {
  home: string;
  door: EffectDoor;
  handle: RunHandle;
  threadId: string;
  turnId: string;
  projectId: string;
  material: MaterialStore;
  leaseMs: number;
  /** How long the bytes take. The door waits here, so its last check sits right before them. */
  writeDelayMs: number;
  signal: AbortSignal;
  crash(point: V08WritePoint): void;
  pause(point: V08WritePoint): Promise<void>;
  /** Close the run. An aborted write waits for it, so a dispatch cannot begin past a Stop. */
  closeRun(): Promise<void>;
  /** Waits for a person's word on a held write. A Stop ends the wait. */
  decision(attempt: string, signal: AbortSignal): Promise<'accepted' | 'denied' | 'stopped'>;
  /** Whether this host still holds the workspace's door. Asked of the database right before the bytes. */
  held(): Promise<boolean>;
}

/** The original write behind an attempt, from private custody. Null: the digests do not match it. */
export async function originalOf(home: string, thread: string, turn: string, project: string, row: EffectAttempt, name: string): Promise<WriteTarget | null> {
  const original = await originalWrite(home, thread, row.run, turn, project, name);
  return original && row.key === originalKey(turn, name) && row.args === argsDigest(original.target) ? original.target : null;
}

const pass = (ms: number, signal: AbortSignal) => new Promise<boolean>((resolve) => {
  if (signal.aborted) return resolve(false);
  const timer = setTimeout(() => resolve(true), ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(false); }, { once: true });
});

export function createDocumentDoor(options: DocumentDoorOptions): Gateway {
  const { home, door, handle: h, threadId, turnId, projectId, material, signal, crash, pause } = options;
  const observed = new Map<string, { id: string; name: string; version: number }>();
  const rowOf = async (id: string) => {
    const rows = await door.attempts(h.run);
    return rows.status === 'committed' ? rows.value.find((row) => row.id === id) : undefined;
  };
  return {
    conditionalWrites: true,
    // This backend has no verified native material journal. It preserves writes/recovery but
    // cannot fabricate a preparation receipt or hand raw source text to a producer.
    async read() {
      throw new Error('Material preparation is paused: this backend has no verified native material journal.');
    },
    // The home lock covers the custody and the landing, never the kernel's calls or a wait between them.
    async write(input, effect, perform): Promise<MaterialEntry | undefined> {
      const target = { ...input, sourceVersions: input.sourceVersions ?? [...observed.values()] };
      const unchanged = () => {
        const entries = material.list(projectId, true);
        const current = entries.find((entry) => entry.name === target.name);
        return (current?.current ?? null) === target.baseVersion && (!current || current.id === target.document)
          && target.sourceVersions.every((source) => entries.some((entry) => entry.id === source.id && entry.current === source.version && !entry.hidden));
      };
      const custodied = await withHomeLock(home, async () => {
        if (!unchanged()) {
          effect.outcome = 'REFUSED';
          effect.detail = 'A source or target changed while this draft was being prepared. Nothing was sent.';
          return false;
        }
        if (signal.aborted) { effect.outcome = 'REFUSED'; effect.detail = 'Stopped before proposal. Nothing was sent.'; return false; }
        await retainOriginalWrite(home, threadId, h.run, turnId, projectId, target);
        return true;
      });
      if (!custodied) return undefined;
      crash('write.custodied');
      const made = request(turnId, target);
      const attempted = await door.attempt(h, made);
      if (attempted.status === 'denied') {
        effect.outcome = 'REFUSED';
        effect.detail = attempted.code === TARGET_HELD
          ? `${target.name} is held: an earlier write of it is still going out, or its outcome is UNKNOWN. Nothing was sent.`
          : `The kernel refused this write of ${target.name}: the contract does not cover it. Nothing was sent.`;
        return undefined;
      }
      if (attempted.status !== 'committed') {
        effect.detail = `The attempt to write ${target.name} has no confirmed receipt. It was not repeated.`;
        return undefined;
      }
      effect.key = attempted.value;
      crash('write.attempted');
      /** A held write waits here for a person. True: it was accepted, so it is claimed again. */
      const accepted = async () => {
        effect.detail = heldStatement(target.name);
        const word = await options.decision(attempted.value, signal);
        if (word === 'accepted') return true;
        effect.outcome = 'REFUSED';
        effect.detail = word === 'denied' ? `The write of ${target.name} was refused. Nothing was sent.` : `Stopped while ${target.name} waited for acceptance. Nothing was sent.`;
        return false;
      };
      let claim: string;
      for (;;) {
        const claimed = await door.claim(attempted.value, options.leaseMs);
        if (claimed.status !== 'committed' || claimed.value === null) {
          const row = await rowOf(attempted.value);
          if (row?.status === 'held') { if (await accepted()) continue; return undefined; }
          effect.outcome = UNSENT.includes(row?.status ?? '') ? 'REFUSED' : 'UNKNOWN';
          effect.detail = `The write of ${target.name} did not go out (${row?.status ?? claimed.status}).`;
          return undefined;
        }
        claim = claimed.value;
        crash('write.claimed');
        await pause('write.claimed');
        if (signal.aborted) await options.closeRun();
        const begun = await door.begin(attempted.value, claim, made.args, made.target);
        if (begun.status === 'unknown') {
          effect.detail = `${target.name} was not written, but its dispatch has no confirmed receipt. It was not repeated.`;
          return undefined;
        }
        if (begun.status === 'committed' && begun.value) break;
        const row = await rowOf(attempted.value);
        if (row?.status === 'held' && !signal.aborted) { if (await accepted()) continue; return undefined; }
        effect.outcome = UNSENT.includes(row?.status ?? '') ? 'REFUSED' : 'UNKNOWN';
        effect.detail = signal.aborted ? 'Stopped before dispatch. Nothing was sent.' : `Dispatch of ${target.name} did not begin (${row?.status ?? begun.status}).`;
        return undefined;
      }
      crash('write.begun');
      await pause('write.begun');
      const settle = (outcome: 'executed' | 'failed' | 'unknown') => door.settle(attempted.value, claim, outcome);
      /** Nothing landed. The receipt says so, and if it cannot, the outcome stays UNKNOWN. */
      const notWritten = async (why: string) => {
        const closed = await settle('failed');
        effect.outcome = closed.status === 'committed' ? 'REFUSED' : 'UNKNOWN';
        effect.detail = closed.status === 'committed' ? `${why} Nothing was sent.` : `${why} ${target.name} was not written, but its receipt is not confirmed. It will not be resent.`;
        return undefined;
      };
      if (!(await pass(options.writeDelayMs, signal))) {
        await settle('unknown');
        effect.detail = `Stopped before ${target.name} was written, but its receipt stays UNKNOWN. It will not be resent.`;
        return undefined;
      }
      let landing: { result: Awaited<ReturnType<typeof perform>>; lost: boolean } | 'not written' | { error: unknown; absent: boolean };
      try {
        landing = await withHomeLock(home, async (lost) => {
          await pause('write.landing');
          // A lock taken over, a changed target or a lost hold stops the bytes. The kernel is asked last, so its
          // effect_cap sits right before them: a run closed or revoked since begin ends here, and no later.
          if (lost.aborted || !unchanged() || !(await options.held())) return 'not written' as const;
          const may = await door.mayLand(h.run, h.fence, attempted.value);
          if (may.status !== 'committed' || !may.value || lost.aborted) return 'not written' as const;
          try {
            await pause('write.performing');
            const result = await perform();
            await pause('write.landed');
            return { result, lost: lost.aborted };
          } catch (error) {
            // Under the lock, an absent version is proof. A lost lock or a failed look proves nothing.
            let absent = false;
            try { absent = !lost.aborted && !writtenVersion(material, argsOf(target), projectId); } catch { /* Not proved. */ }
            return { error, absent };
          }
        });
      } catch { landing = 'not written'; }
      if (landing === 'not written') return notWritten(`The run, the data folder or ${target.name} changed before it was written.`);
      if ('error' in landing) {
        const closed = await settle(landing.absent ? 'failed' : 'unknown');
        effect.outcome = !landing.absent || closed.status !== 'committed' ? 'UNKNOWN' : 'REFUSED';
        effect.detail = !landing.absent ? 'The write may have committed before reporting failed. Its outcome is UNKNOWN and it will not be resent.' : String(landing.error);
        return undefined;
      }
      crash('write.materialised');
      const { result } = landing;
      if (result === 'stopped') {
        await settle('unknown');
        effect.detail = `Stopped before ${target.name} was written, but its receipt stays UNKNOWN. It will not be resent.`;
        return undefined;
      }
      if (landing.lost) {
        await settle('unknown');
        effect.detail = `The data folder was taken over while ${target.name} was being written, so it may have been written. Its outcome is UNKNOWN and it will not be resent.`;
        return undefined;
      }
      const settled = await settle('executed');
      if (settled.status !== 'committed') {
        effect.detail = `${target.name} was written, but its receipt is not confirmed. Its outcome is UNKNOWN and it will not be resent.`;
        return undefined;
      }
      crash('write.settled');
      effect.outcome = 'DONE';
      return result;
    },
  };
}
