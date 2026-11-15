import { assertSharedHistory, recordCarrier } from './shared-history.ts';
import { IdentityRefused, SharedEngineRequired, OwnerAutomationThreadRefused, PersonalConversationRequired } from './identity-core.ts';
import { hostToolsOnly } from './harnesses.ts';
import { engineDecision } from '../policy/index.ts';
import {nativeTurnForProject,SharedEngineRefusal} from './engine-admission.ts';
import {noteSharedCodex} from './shared-codex.ts';
import { withdrawalNotice } from './work-now.ts';
import { taintedReads } from './withdrawal.ts';
import { runTurn } from '../stub/harness.ts';
import { isWithdrawn, type MaterialStore } from '../stub/material.ts';
import { runScriptedTurn } from '../stub/scripted.ts';
import { NO_ROUTE, type ModelRoutes } from '../models/route.ts';
import type { CredentialStore } from '../credentials/store.ts';
import type { HarnessV1 } from '../ports/harness.ts';
import type { ApiEvent, MaterialEntry, Turn, TurnSelection } from '../api.ts';
import type { CoreLink, RunHandle } from './core.ts';
import { recoveredStatus, runHarnessTurn, type Checkpoint } from './harness-turn.ts';
import { verifiedRecoveredWrites } from './recovered-writes.ts';
import { continueOriginalWrites, turnWrites, cancelUncontinuableWrites, type WriteCrashPoint } from './document-writes.ts';
import { boundedSelection, recordOf, type turnRoute } from '../selection/pin.ts';
import { settleUnproposedWrites, unconfirmedCustody, reconcileReclaimedCustody } from './thread-custody.ts';
import { createCheckpointRecovery, preserveClosedCheckpoint, retryableRecoveryError, type CheckpointContext } from './checkpoint-recovery.ts';
import type { StoredThread } from './thread-journal.ts';
import type { createParallelWork } from './parallel-work.ts';
import type { createPolicyAdmission } from './policy-admission.ts';
import type { createMemory } from './memory.ts';
import type { createGoalRuns } from './goal-runs.ts';
import type { createProactivity } from './proactivity.ts';
import type { createTriggers } from './triggers.ts';
import type { createTaskBoard } from './task-board.ts';
import type { createConnectorReadDecisions } from './connector-read-decisions.ts';
import type { ConnectorService } from '../connectors/service.ts';
import type { pieceOnDisk } from './pieces.ts';
const RUN_LEASE_MS = 6_000;
const UNRECEIPTED = 'Another original write from this turn has no confirmed receipt. It was not replayed.';
const NOT_WRITTEN = 'This turn stopped before its write reached the record, so nothing was written. Send it again to continue.';
const now = () => new Date().toISOString();
type Deps = {
 home: string; material: MaterialStore; threads: Map<string, StoredThread>; running: Map<string, AbortController>;
 inflight: Set<Promise<void>>; carriers: Map<string, Promise<void>>;
 parallel: ReturnType<typeof createParallelWork>; admission: ReturnType<typeof createPolicyAdmission>;
 memory: ReturnType<typeof createMemory>; goalRuns: ReturnType<typeof createGoalRuns>; proactivity: ReturnType<typeof createProactivity>;
 triggers: ReturnType<typeof createTriggers>; board: ReturnType<typeof createTaskBoard>;
 gateway: ReturnType<typeof createConnectorReadDecisions>['gateway']; connectors: ConnectorService;
 restricted?: boolean; routes: ModelRoutes; credentials: CredentialStore; engine: HarnessV1 | undefined; harnessId: string;
 harnessPiece: ReturnType<typeof pieceOnDisk> | undefined; scriptDir: string | undefined; writeDelayMs: number;
 checkpointsFor: (id: string) => {load: () => Checkpoint | null; save: (checkpoint: Checkpoint) => Promise<void>; clear: () => Promise<void>};
 closeRecovery: (thread: StoredThread, turn: Turn) => Promise<void>;
 projectDir: (id: string) => string; crash: (point: WriteCrashPoint) => void;
 routeFor: (thread: StoredThread, model: string | undefined, selection: TurnSelection | undefined) => (NonNullable<ReturnType<typeof turnRoute>> & {carries?: string}) | null;
 coordinationFor: (thread: StoredThread, turn: Turn, h: RunHandle, signal: AbortSignal) => NonNullable<Parameters<typeof runHarnessTurn>[0]['coordination']>;
 saveThread: (thread: StoredThread) => Promise<void>; classify: (turn: Turn, projectId: string, files: import('../api.ts').FileLink[]) => Promise<void>;
 emit: (event: ApiEvent) => void; watchRecovery: (thread: StoredThread, turn: Turn) => void;
};
export function createTurnCarrier(deps: Deps) {
  const {home, material, threads, running, inflight, carriers, parallel, admission, memory, goalRuns, proactivity, triggers, board, gateway, connectors, routes, credentials, harnessId, harnessPiece, scriptDir, writeDelayMs, checkpointsFor, closeRecovery, projectDir, crash, routeFor, coordinationFor, saveThread, classify, emit, watchRecovery} = deps;
  return function carry(link: CoreLink, thread: StoredThread, turn: Turn, entries: MaterialEntry[], controller: AbortController, run: Promise<RunHandle>, resumed = false, recoveryRun?: { id?: string }) {
    const p = carrying(link, thread, turn, entries, controller, run, resumed, recoveryRun).then(() => parallel.drain(thread.summary.id)).catch(() => {}).finally(() => { inflight.delete(p); if (carriers.get(thread.summary.id) === p) carriers.delete(thread.summary.id); });
    carriers.set(thread.summary.id, p);
    inflight.add(p);
    return p;
  }
  async function carrying(link: CoreLink, thread: StoredThread, turn: Turn, entries: MaterialEntry[], controller: AbortController, run: Promise<RunHandle>, resumed: boolean, recoveryRun?: { id?: string }) {
    const projectId = thread.summary.projectId;
    const task = thread.task ?? '';
    let handle: RunHandle | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let recoveredFiles: import('../api.ts').FileLink[] = [];
    let keepRunOpen = resumed;
    let terminalRecovery = false, producerStarted = false;
    let recoveryReading = resumed, retryRead = false;
    let recovery: ReturnType<typeof createCheckpointRecovery> | undefined;
    const recoveryContext: CheckpointContext = { home, threadId: thread.summary.id, projectId, taskId: task, turn, link, material, store: checkpointsFor(turn.id) };
    try {
      handle = await run;
      const restrictedIdentity = deps.restricted || link.id.person !== link.identities.devicePerson || !!thread.automationId;
      if (restrictedIdentity && !hostToolsOnly(harnessId, harnessPiece?.manifest)) {
        // The owner on their own computer is restricted only by the automation's thread: say what is true for them.
        const ownerOnly = !deps.restricted && link.id.person === link.identities.devicePerson;
        throw ownerOnly ? new OwnerAutomationThreadRefused() : new SharedEngineRequired();
      }
      admission.check(true);
      const h = handle;
      recovery = createCheckpointRecovery(recoveryContext, h, resumed && !turn.stopRequested, () => closeRecovery(thread, turn));
      const checkpointRecovery = recovery.importing;
      if (checkpointRecovery) { await recovery.reconcile(); crash('write.reconciled'); }
      parallel.opened(thread.summary.id, h);
      heartbeat = setInterval(() => void link.renewRun(h).catch(() => {}), RUN_LEASE_MS / 3);
      if (resumed) {
        // An acknowledged Stop binds here too: nothing below may continue past it.
        if (turn.stopRequested) controller.abort();
        if (gateway(link, h, thread.summary.id, turn.id, projectId, controller.signal).connector?.pending()) throw new Error('An observed connector response still needs its original material registration. No producer was restarted.');
        // Recovery is independent of model-generated tool calls or local preflight checks.
        let rows = await turnWrites(link, h.run, turn.id);
        const before = await verifiedRecoveredWrites(link, rows, material, projectId);
        turn.effects = before.effects;
        recoveredFiles = before.files;
        if (before.pending && !before.stop) {
          if (thread.child?.role === 'reviewer' || turn.judge) await cancelUncontinuableWrites(link, h.run, turn.id); // a review never finishes a write; what was sent stays recorded
          else await continueOriginalWrites({ home, link, handle: h, threadId: thread.summary.id, turnId: turn.id, projectId, material, projectDir, crash, signal: controller.signal,
            heldFor: () => { const read = taintedReads(turn, (id) => material.load(id))[0]; return read && { id: read.id, name: read.name }; }, relatedHold: (document, body) => parallel.held(link, thread, document, body) }, rows);
          rows = await turnWrites(link, h.run, turn.id);
        }
        const recovered = await verifiedRecoveredWrites(link, rows, material, projectId);
        turn.effects = recovered.effects;
        recoveredFiles = recovered.files;
        keepRunOpen = recovered.pending || await unconfirmedCustody(home, thread.summary.id, h.run, turn.id, projectId, rows);
        if (turn.stopRequested && await recovery.stop()) { terminalRecovery = true; keepRunOpen = false; recoveredFiles = turn.answer?.files ?? []; return; }
        // Finished pieces wait on disk: the run stays open for their imports, through the harness path below.
        const interruptedWork = !turn.stopRequested && !!checkpointsFor(turn.id).load();
        if (!rows.length && keepRunOpen && !interruptedWork) {
          // A closed run accepts no proposal (gov.propose_effect), so only now does no receipt mean no write.
          await link.finishRun(h, 'failed');
          crash('run.closed');
          rows = await turnWrites(link, h.run, turn.id);
          if (!rows.length && await settleUnproposedWrites(home, thread.summary.id, h.run, turn.id, projectId)) {
            keepRunOpen = false;
            turn.answer = { text: NOT_WRITTEN, files: recoveredFiles };
            turn.status = 'stopped';
            return;
          }
          turn.answer = { text: 'An original proposal has no confirmed receipt. It was not replayed; its original run and recovery data remain available.', files: recoveredFiles };
          turn.status = 'stopped';
          return;
        }
        if (rows.length && !interruptedWork) {
          turn.status = recoveredStatus(turn, recovered.effects, recovered.files.length);
          turn.answer = { text: turn.completed ? recovered.detail : `This work was interrupted. ${recovered.detail}`, files: recovered.files };
          await link.answer(h, task, turn.answer.text);
          return;
        }
      }
      recoveryReading = false;
      if (checkpointRecovery) crash('recovery.ready');
      const notice = withdrawalNotice([...threads.values()].filter((t) => t.summary.projectId === projectId), material.list(projectId, true));
      if (notice) turn.work.steps.push({ kind: 'note', label: notice });
      const tell = () => parallel.tell(thread, turn);
      const ctx = { ...(restrictedIdentity ? {} : {telemetry: { home, runId: h.run }}), material, projectId, gateway: gateway(link, h, thread.summary.id, turn.id, projectId, controller.signal, checkpointRecovery ? true : undefined), writeDelayMs, signal: controller.signal };
      const identityAdmission = restrictedIdentity ? (work:()=>Promise<unknown>) => link.identities.admitPerson(link.id.person,async()=>{
        if (controller.signal.aborted || !['owner','editor'].includes(await link.call<string>(link.person(),'SELECT gov.identity_project_access($1)',[projectId]) ?? '')) throw new Error('Identity or project access ended.');
        return work();
      }) : undefined;
      // A selected turn runs on its pinned route or not at all; any turn, on a route its history's selected tasks allow (selection/pin.ts).
      const pin = deps.engine ? routeFor(thread, turn.user.settings?.model, turn.selection) : undefined, route = pin && 'route' in pin ? pin.route : null;
      if (checkpointRecovery && (!deps.engine || !route || turn.merge)) throw new Error('The interrupted checkpoint needs its original import path; no producer or substitute turn was started.');
      if (deps.restricted && link.id.person === link.identities.devicePerson && !thread.automationId) assertSharedHistory({ ...thread, turns: resumed ? thread.turns : thread.turns.filter(t => t.id !== turn.id) }, route, threads);
      if (deps.engine && route && !turn.merge) {
        recordCarrier(turn, harnessId, route, !!deps.restricted);
        turn.work.harness = `${deps.engine.label} · ${route.label}`;
      }
      if (turn.merge) { producerStarted = true; await parallel.carryMerge(thread, turn, ctx.gateway, controller.signal); }
      else if (deps.engine && !route) {
        const hint = pin && 'refused' in pin ? pin.refused : routes.settings().hint ?? NO_ROUTE;
        turn.refusal = { reason: 'NOT_AVAILABLE', detail: hint };
        turn.answer = { text: hint, files: recoveredFiles };
        turn.status = 'refused';
      } else if (deps.engine && route) {
        const history = thread.turns.filter((t) => t.id !== turn.id && t.status !== 'running');
        const progress = () => saveThread(thread);
        const recall = restrictedIdentity ? undefined : await memory.forTurn(projectId, turn.user.text, turn.user.settings);
        const selected = turn.selection, dispatched = selected ? () => { selected.ran = recordOf(route); } : undefined;
        const offline = turn.selection?.task.network === false, bounded = boundedSelection(turn.selection);
        const nativeTurn=await nativeTurnForProject(harnessId,harnessPiece?.manifest,link,projectId,restrictedIdentity);
        try{
        const {nativeAccountTools}=nativeTurn;
        if (!nativeAccountTools&&harnessId==='harness-codex') noteSharedCodex(turn);
        producerStarted = true;
        await runHarnessTurn({ ...ctx, nativeAccountTools, identityAdmission, policyAdmission: () => { const policy = admission.check(true); engineDecision(policy, harnessId); }, ...(dispatched ? { dispatched } : {}), ...(recall ? { memory: bounded ? { ...recall, propose: undefined } : recall } : {}), threadId: thread.summary.id, harness: deps.engine, route, credential: async (h) => { if (restrictedIdentity && h !== route.credential) throw new Error('This credential is outside the shared model route.'); return credentials.resolve(h); }, credentials: () => credentials.values(), history, notice, tell, resumed, steerable: (deliver) => parallel.steerable(thread.summary.id, deliver), readOnly: thread.child?.role === 'reviewer' || !!turn.judge, coordination: bounded || restrictedIdentity ? undefined : coordinationFor(thread, turn, h, controller.signal), connectors: offline || restrictedIdentity ? undefined : connectors, recoveredFiles, progress, checkpoints: recovery.store }, turn, entries);
        }finally{await nativeTurn.release();}
      } else {
        // An engine with no words to take is still on the record: the stand-ins go through the same step.
        producerStarted = true;
        tell();
        const saved = { ...ctx, progress: () => saveThread(thread) };
        if (scriptDir) await runScriptedTurn(saved, scriptDir, turn);
        else await runTurn(saved, turn, entries.filter((e) => !isWithdrawn(material.load(e.id) ?? e)));
      }
      terminalRecovery = recovery.terminal;
      if (turn.status === 'done') turn.completed = true;
      if (turn.answer && !terminalRecovery) await link.answer(h, task, turn.answer.text);
    } catch (err) {
      retryRead = recoveryReading && retryableRecoveryError(err);
      if (resumed && recoveryRun?.id) {
        try {
          const { rows } = await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.runs WHERE id = $1', [recoveryRun.id]);
          const closed = rows[0] && ['succeeded', 'failed', 'cancelled'].includes(rows[0].status);
          if (closed) await cancelUncontinuableWrites(link, recoveryRun.id, turn.id);
          const writes = await turnWrites(link, recoveryRun.id, turn.id);
          const recovered = await verifiedRecoveredWrites(link, writes, material, projectId);
          turn.effects = recovered.effects;
          recoveredFiles = recovered.files;
          keepRunOpen = recovered.pending;
          if (closed && await preserveClosedCheckpoint(recoveryContext, recoveryRun.id, () => closeRecovery(thread, turn))) { terminalRecovery = true; keepRunOpen = false; recoveredFiles = turn.answer?.files ?? []; return; }
          // A crash between closing the run and forgetting custody leaves a run nothing can reclaim.
          if (closed && !writes.length && await settleUnproposedWrites(home, thread.summary.id, recoveryRun.id, turn.id, projectId)) {
            turn.status = 'stopped';
            turn.answer = { text: NOT_WRITTEN, files: recoveredFiles };
            return;
          }
        } catch { /* Retain the last known effects; an unavailable read cannot erase uncertainty. */ }
      }
      const refused = !resumed && !producerStarted && (err instanceof SharedEngineRefusal || err instanceof SharedEngineRequired || err instanceof PersonalConversationRequired);
      if (resumed && !producerStarted && err instanceof IdentityRefused) {
        turn.status = turn.completed ? 'done' : 'stopped';
        const detail = 'Recovery did not start. Earlier work and its receipts are kept; inspect them before continuing.';
        turn.work.steps.push({ kind: 'note', label: detail });
        turn.answer ??= { text: detail, files: recoveredFiles };
      } else {
        turn.status = refused?'refused':'stopped';
        if(refused)turn.refusal={reason:'NOT_AVAILABLE',detail:err.message};
        turn.answer = { text: refused?err.message:`The turn failed: ${String(err)}`, files: recoveredFiles };
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      parallel.closed(thread.summary.id);
      if (handle) {
        // A producer error cannot finish away a still-pending original operation. Re-observe
        // even for a fresh turn, since a proposal/claim response may have been lost.
        try {
          if (resumed && turn.stopRequested && checkpointsFor(turn.id).load() && await recovery?.stop()) { terminalRecovery = true; recoveredFiles = turn.answer?.files ?? []; }
          if (resumed && !turn.stopRequested && checkpointsFor(turn.id).load()) {
            // Also cover an importer that threw before reaching its checkpoint clear callback.
            const result = await reconcileReclaimedCustody({ home, thread: thread.summary.id, run: handle.run, turn: turn.id, project: projectId }, link, handle, checkpointsFor(turn.id).load());
            if (result.status !== 'reconciled') throw new Error(`Recovery remains unresolved (${result.status}).`);
          }
          const rows = await turnWrites(link, handle.run, turn.id);
          const durable = await verifiedRecoveredWrites(link, rows, material, projectId);
          keepRunOpen = gateway(link, handle, thread.summary.id, turn.id, projectId, controller.signal).connector?.pending() === true || durable.pending || !!checkpointsFor(turn.id).load() || await unconfirmedCustody(home, thread.summary.id, handle.run, turn.id, projectId, rows);
          if (rows.length) {
            turn.effects = durable.effects;
            const files = new Map((turn.answer?.files ?? []).map((file) => [`${file.materialId}:${file.version}`, file]));
            for (const file of durable.files) files.set(`${file.materialId}:${file.version}`, file);
            if (keepRunOpen) turn.status = 'stopped';
            turn.answer = { text: !keepRunOpen ? turn.answer?.text ?? durable.detail : durable.pending ? durable.detail : `${durable.detail} ${UNRECEIPTED}`, files: [...files.values()] };
          }
        }
        catch { keepRunOpen = true; }
        if (resumed && turn.nativeAccountActivity && turn.unknownOutcome) {
          // Core recovery can confirm only its own receipts, never a vanished native account call.
          turn.status = 'stopped';
          turn.answer = { text: 'Native account activity was interrupted; its outcome is UNKNOWN. Inspect its work steps and reconcile in the source system before another attempt.', files: turn.answer?.files ?? recoveredFiles };
        }
        if (!keepRunOpen) await link.finishRun(handle, turn.status === 'done' ? 'succeeded' : 'failed').catch(() => {});
      }
      if (resumed) await classify(turn, projectId, recoveredFiles);
      // Authentication may finish a Stop while the final receipt/classification
      // reads are awaiting Core. Honour it before withdrawing the live carrier;
      // the earlier recovery check alone leaves that late Stop's cache executable.
      if(resumed&&turn.stopRequested&&checkpointsFor(turn.id).load()){
        try{await recovery?.stop();}catch{ /* Retain unresolved recovery data. */ }
      }
      turn.work.endedAt = now();
      parallel.ended(thread, turn);
      running.delete(thread.summary.id);
      thread.summary.running = false;
      thread.summary.unread = true;
      goalRuns.judged(turn);
      if (!deps.restricted && link.id.person === link.identities.devicePerson && !thread.automationId && !boundedSelection(turn.selection)) await memory.learn(thread, turn).catch(() => {});
      await saveThread(thread);
      proactivity.ended(thread, turn);
      triggers.ended(thread, turn);
      board.ended(thread, turn);
      goalRuns.ended(thread);
      emit({ topic: 'material', id: projectId });
      if (retryRead) watchRecovery(thread, turn);
    }
  }
}
