import { createTurnCarrier } from './turn-carrier.ts';
import {nativeTurnForProject} from './engine-admission.ts';
import {deviceRecoveryControls} from './device-recovery.ts';
import { createMaterialSave } from './material-save.ts';
import { projectUnknownChecks, createUnknownChecks, unknownChecked } from './unknown-checks.ts';
import { turnUnresolved } from './turn-uncertainty.ts';
import { createThreadControl } from './thread-control.ts';
import { afterDeferred, deferPastAdmission } from './admission-tail.ts';
import { identityRequests } from './identity-requests.ts';
import { createPolicyAdmission } from './policy-admission.ts';
import { connectorPerson } from './connector-person.ts';
import { decodeDraft, publicDraft, transitionDraft } from './draft-cas.ts';
import { createKeyedProject } from './project-create.ts';
import { createProjectFiles } from './project-files.ts';
import { createThreadRewind, rewindControl, syncRewindVersions } from './thread-rewind.ts';
import { rewindAdmission, rewindWriteHold } from './rewind-admission.ts';
import { withHomeLock, assertHomeWriteAdmission } from './home-lock.ts';
import {createMaterialWithdrawalDelivery} from './material-withdrawal-delivery.ts';
import { refuseStampedHome } from './home-kernel.ts';
import { requireCompleteHome } from './home-complete.ts';
import { hasOpenWork, workNow } from './work-now.ts';
import { classifyRecovered, replay, taintedReads } from './withdrawal.ts';
// Composition: wires the api port to its implementation. The core (packages/core, reached through
// core.ts) holds identity, tasks, runs, the conversation, what the agent read, and every write the
// agent makes, through the effect gateway, with the person's Saves as versions of its documents.
// The files under the data home hold the work material's bytes and the thread projection the app
// reads. The agent is the harness configuration names: harness-pi (Pi behind the Harness port, its
// every write through the gateway) for the app, or the labelled stub harness that tests default to.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AiTool, ApiEvent, Args, ConnectTool, Draft, MaterialEntry, Method, ModelSettings, Project, Receipt, Result, Thread, ThreadCard, ThreadSummary, Turn, TurnSelection, TurnSettings } from '../api.ts';
import { lineDiff } from '../stub/diff.ts';
import { isIntermediate, readJson, sha256, writeAtomic, writeJson } from '../stub/fsx.ts';
import { HARNESS_LABEL } from '../stub/harness.ts';
import { isText, isWithdrawn, MaterialStore, type MaterialFaults, type MaterialImport } from '../stub/material.ts';
import { SCRIPTED_LABEL } from '../stub/scripted.ts';
import { stopPersonalDatabaseAt } from '@backbone/core/db';
import { CredentialStore } from '../credentials/store.ts';
import { macosKeychain } from '../credentials/keychain.ts';
export { personKeychainRoutes } from '../credentials/keychain.ts';
import { Vault } from '../keys/vault.ts';
import { ModelRoutes, NO_ROUTE } from '../models/route.ts';
import { detectLocalModels, type LocalProbe } from '../models/local.ts';
import type { HarnessTurn, HarnessV1, ModelRoute } from '../ports/harness.ts';
import { CoreLink, type CoreOptions, type RunHandle } from './core.ts';
import { createIdentityHost } from './identity-host.ts';
import { serveDoors } from './doors.ts';
import { sweepInterruptedDispatches } from './gateway.ts';
import { type Checkpoint } from './harness-turn.ts';
import { createSideWiring } from './sidechat-wiring.ts';
import { verifiedWrittenVersion, type StoredWrite } from './recovered-writes.ts';
import { turnWrites, originalTurnRun, type WriteCrashPoint } from './document-writes.ts';
import { createParallelWork } from './parallel-work.ts';
import { createProactivity } from './proactivity.ts';
import { choose } from '../selection/choose.ts';
import { inventory } from '../selection/inventory.ts';
import { asShown, continuedSelection, historyRefusal, pinFor, pinnedRoute, replayOf, turnRoute, withNamedModel } from '../selection/pin.ts';
import { codexCheck } from './doctor.ts';
import { AppChanges, createTriggers } from './triggers.ts';
import { createMemory } from './memory.ts';
import { createGoalRuns } from './goal-runs.ts';
import { createTaskBoard } from './task-board.ts';
import { searchThreads } from './thread-search.ts';
import { createConnectorReadDecisions } from './connector-read-decisions.ts';
import { ThreadJournal, type StoredThread } from './thread-journal.ts';
import { saveThreadProjection, custodyRun, unconfirmedCustody } from './thread-custody.ts';
import { ownHome, prepareHome, priorHomeRelease, homeRelease, trackHomeRelease, waitToRemoveHome } from './home-owner.ts';
import { checkpointRepairNotice, createRecoveryRepair } from './checkpoint-repair.ts';
import { checkpointRun, createRecoveryRetries, discoverRecovery, inspectCheckpoint, projectRecoverySummary, retryCheckpoint, recoveryRetentionReason } from './checkpoint-recovery.ts';
import { BackupRefused, importHome, type ImportPlan } from './backup.ts';
import { outboxExecutor } from './outbox.ts';
import { loadPiece, PIECES, pieceOnDisk, registerPiece } from './pieces.ts';
import { importPiece, releaseSnapshots, snapshotPiece } from './snapshot.ts';
import { createToolConnections, type DoorStart, type ToolDoors } from '../tools/service.ts';
import { defaultToolEnv, type ToolEnv } from '../tools/places.ts';
import { connectorEnabling, setConnectorFromApi } from './connector-settings.ts';
import { ConnectorService } from '../connectors/service.ts';
import type { ServerSource } from '../connectors/discover.ts';
import type { CapabilityView, ConnectorServer, HeldCall, SignCapability, TriageView } from '../api.ts';
import type { MailConnector, MailModule, TriageTask } from '../ports/mail.ts';
import { viewOf } from '../triage/brief.ts';
import { summaryOf } from '../triage/capability.ts';
import { TriageRefused, TriageService } from '../triage/service.ts';
import type { Host, HostOptions } from './host-types.ts';
import { createHostReads, READS } from './host-reads.ts';
export { deniedFoldersOf } from './denied-folders.ts';
import { deniedFoldersOf } from './denied-folders.ts';
export type { Host, HostOptions } from './host-types.ts';
export { requireCompleteHome, HomeIncomplete } from './home-complete.ts';
/** The engines a configuration may name. The stub (no model called) is not an engine: it is the default for tests. */
// Each is a piece: the platform imports its module only from its checked folder, after the check
// (no static import), and calls the named factory.
// The terminal's output reaches the renderer, so the app's own secrets stay out of its environment.
const withoutSecrets = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).filter(([name]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)));
import { selectedHarness, setEngine } from './engine-settings.ts';
import { hostToolsOnly, HARNESSES, harnessConfiguration, loadHarness, closeHarness, removeHarnessState } from './harnesses.ts';
type StoredProject = Project & { dir: string };
type CrashPoint = WriteCrashPoint;
const refused = <T>(reason: 'NOT_FOUND' | 'NOT_A_REPOSITORY' | 'NOT_AVAILABLE' | 'INVALID' | 'STALE_BASE', detail: string): Receipt<T> => ({ ok: false, reason, detail, outcome: 'REFUSED' });
const now = () => new Date().toISOString();
/** How often the host looks for dispatches a dead door left behind. */
const SWEEP_MS = 5_000;
const READ_ONLY = 'This data home was opened read-only.';
const CLOSING = 'This app is closing; nothing was read, changed, signed or sent.';
import { turnAdmissions, type TurnAdmissionOptions } from './turn-admission.ts';
export function createHost(options: HostOptions): Host {
  const { home, readOnly = false } = options;
  if (readOnly) { assertHomeWriteAdmission(home); requireCompleteHome(home); }
  refuseStampedHome(home);
  prepareHome(home,readOnly);
  const writeDelayMs = options.writeDelayMs ?? Number(process.env.BACKBONE_STUB_WRITE_DELAY_MS ?? 0);
  const faults: MaterialFaults = { saveDelayMs: Number(process.env.BACKBONE_STUB_SAVE_DELAY_MS ?? 0), ...options.faults };
  if (!readOnly) mkdirSync(join(home, 'threads'), { recursive: true });
  const listeners = new Set<(e: ApiEvent) => void>();
  const emit = (e: ApiEvent) => listeners.forEach((l) => l(e));
  const running = new Map<string, AbortController>();
  const carriedTurns = new WeakMap<AbortController, Turn>();
  const registerCarrier = (controller: AbortController, turn: Turn) => { carriedTurns.set(controller, turn); };
  let sweeper: NodeJS.Timeout | undefined;
  let closing = false, withdrawalReady = false;
  let withdrawalDelivery:ReturnType<typeof createMaterialWithdrawalDelivery>|undefined;
  /** Turns still being carried: closing waits for them, so none writes after the host is gone. */
  const inflight = new Set<Promise<void>>();
  const carriers = new Map<string, Promise<void>>();
  const recoveryRetries = createRecoveryRetries();
  const projectsPath = join(home, 'projects.json');
  let projects = readJson<StoredProject[]>(projectsPath, []);
  const projectDir = (id: string) => join(home, 'projects', projects.find((p) => p.id === id)?.dir ?? id);
  /** What the app itself writes and moves at each projected path, so a file trigger knows its own changes. */
  const appChanges = new AppChanges();
  const material = new MaterialStore(home, faults, (entry, bytes) => {
    if (entry.projection === 'managed') return;
    const target = join(projectDir(entry.projectId), entry.name);
    if (existsSync(target)) chmodSync(target, 0o644);
    appChanges.wrote(target, bytes);
    writeAtomic(target, bytes);
    if (entry.class === 'original') chmodSync(target, 0o444);
  }, (entry) => {
    if (entry.projection === 'managed') return null;
    // Asked only when the folder's file is about to be moved aside or back (withdraw, restore, hold).
    const target = join(projectDir(entry.projectId), entry.name);
    appChanges.moved(target);
    return target;
  }, !readOnly, () => withdrawalDelivery?.request());
  const threads = new Map<string, StoredThread>();
  const interrupted: { thread: StoredThread; turn: Turn }[] = [];
  // Configuration layers, the narrowest first: the session, the person, the distribution, the platform.
  const harnessId = selectedHarness(home, options.harness);
  const admission = createPolicyAdmission(home, harnessId, () => harnessConfig.options, options.keys, () => host, readOnly);
  const harnessRegistrationInfo = HARNESSES[harnessId], harnessConfig = harnessConfiguration(home, harnessRegistrationInfo);
  admission.check();
  const extraDenies = [...deniedFoldersOf(home, harnessId), ...(harnessRegistrationInfo?.ownsModel && (harnessConfig.options as { environment?: string })?.environment !== 'person-rights' ? [resolve(home)] : [])];
  // A harness is a piece: its files must be the content its manifest declares, under the identity
  // this configuration fixes, before anything else; then (below) a standing registration the person
  // granted, and only then is its module imported, from that folder. Its runs are bound to it.
  const harnessPiece = HARNESSES[harnessId] ? pieceOnDisk(options.pieceDirs?.[harnessId] ?? PIECES[harnessId].dir, PIECES[harnessId].id) : undefined;
  let harnessRegistration: string | null = null;
  let engine: HarnessV1 | undefined;
  let nativeProblem: string | undefined;
  const scriptDir = harnessId === 'scripted' ? process.env.BACKBONE_SCRIPT_DIR : undefined;
  // The master key is in the home's vault, which the core link opens with the host's keys.
  const credentials = new CredentialStore(home, async () => (await core).vault.masterKey(), options.keychainRoutes ? macosKeychain() : undefined);
  const routes = new ModelRoutes(home, credentials, process.env, !!harnessRegistrationInfo?.codexRoute, !!options.keychainRoutes, harnessConfig.route, harnessConfig.blocked);
  const harnessLabel = () => (engine ? `${engine.label} · ${routes.resolve()?.label ?? 'no model set up'}` : scriptDir ? SCRIPTED_LABEL : HARNESS_LABEL);
  let crashAt = process.env.BACKBONE_CRASH_AT as CrashPoint | undefined;
  let crashSeen = 0;
  const crashOccurrence = Number(process.env.BACKBONE_CRASH_OCCURRENCE ?? 1);
  const crash = (point: CrashPoint) => {
    options.atPoint?.(point);
    if (crashAt === point && ++crashSeen === crashOccurrence) process.kill(process.pid, 'SIGKILL');
  };
  const journal = new ThreadJournal(home);
  const sourceReads = createConnectorReadDecisions({ home, material, journal, threads, projectDir, crash, core: () => core,
    currentPiece: () => harnessRegistration, busy: (id) => running.has(id) || side.isRunning(id) || !!(threads.get(id) && parallel.parentRunning(threads.get(id)!)),
    saveThread: (thread) => saveThread(thread), hasCheckpoint: (id) => !!checkpointsFor(id).load(), narrow: (...args) => parallel.guard(...args) });
  let staleFiles: string[] = [];
  /** Files in, journal truth out. Only what the journal holds open is interrupted. */
  const loadThreads = () => {
    threads.clear();
    interrupted.length = 0;
    for (const f of readdirSync(join(home, 'threads')).filter((f) => f.endsWith('.json'))) {
      let t: StoredThread;
      try { t = readJson<StoredThread>(join(home, 'threads', f), null as unknown as StoredThread); }
      catch { throw new Error('Stored conversation metadata could not be read; the original file is preserved.'); }
      threads.set(t.summary.id, t);
    }
    staleFiles = journal.rebuild(threads, {readOnly}); sourceReads.reload();
    // A turn that was running when the process died is resumed once the core is up (below).
    for (const t of threads.values()) for (const turn of t.turns.filter((x) => x.status === 'running')) interrupted.push({ thread: t, turn });
  };
  // Now, so a damaged home fails at once; again once the home is held, since a closing host may still append.
  loadThreads();
  // One host per home, held before anything here treats the home as a killed host's. A refused
  // host never gets a link, so every call fails with why. The checks above have changed nothing.
  let ownsHome = false;
  const owner = priorHomeRelease(home).then(async () => {
    const release = await ownHome(home, {readOnly});
    ownsHome = true;
    return async () => { try { await release(); } finally { ownsHome = false; } };
  });
  // The core: started (or reused) for this data home. A write a kill left mid-dispatch is observed
  // UNKNOWN (never resent), and a Save the core missed is recorded as the version it is.
  let knowledgeNotice: string | undefined;
  const core = owner.then(async () => {
    await admission.ready();
    loadThreads();
    parallel.replayed();
    if (!readOnly) {
      // Re-project each current version into its project folder (a kill may have landed between commit and copy).
      for (const p of projects) for (const e of material.list(p.id, true)) material.load(e.id);
      material.settleProjections();
    }
    // Closed before its core opened: opening stops here, and the close settles with nothing to close.
    if (closing) throw new Error('The host closed while it was opening.');
    return CoreLink.open({ home, baselineSql: options.baselineSql, postgresNative: options.postgresNative, keys: options.keys, readOnly, keychainRoutes:options.keychainRoutes,allowIdentityUpgrade:options.allowIdentityUpgrade });
  }).then(async (link) => {
    knowledgeNotice = link.knowledgeNotice;
    if (link.materialGuard.state === 'paused') process.stderr.write(`[core] ${JSON.stringify({ materialGuard: link.materialGuard })}\n`);
    withdrawalDelivery=createMaterialWithdrawalDelivery({
      home,material,workspace:link.id.workspace,writable:()=>withdrawalReady&&!readOnly&&ownsHome&&!closing&&!importing,
      record:event=>link.confirmMaterialWithdrawal(event),changed:id=>emit({topic:'material',id}),
    });
    if (readOnly||(link.identityStatus.state!=='verified'&&!(await link.legacyDeviceOnly()))) return link;
    if(!link.deviceAvailable){
      // Mount only code whose exact registration already stands. A signed-in
      // owner obtains their own carrier; no removed-device grant is renewed.
      if(harnessPiece){const mounted=await loadHarness(link,harnessPiece,home,harnessRegistrationInfo,harnessConfig,extraDenies, undefined, undefined, undefined, true);engine=mounted.engine;harnessRegistration=mounted.registration;}
      return link;
    }
    // Only a writable owner prepares the credential master; diagnostic/Core opens never do.
    try { if (ownsHome && !closing) await link.vault.masterKey(); }
    catch {
      try { await link.close(); }
      finally { throw new Error("This home's keys could not be prepared; nothing was started."); }
    }
    // Custody reads the file, so a thread only the journal still has gets one back before anything else.
    for (const id of staleFiles) rmSync(join(home, 'threads', `${id}.json`), { force: true });
    for (const [id, t] of threads) if (!existsSync(join(home, 'threads', `${id}.json`))) writeJson(join(home, 'threads', `${id}.json`), t);
    if (harnessPiece) {
      // Nothing runs on a harness whose content is not registered and granted: every call waits for this, and fails with it.
      try {
        const loaded = await loadHarness(link, harnessPiece, home, harnessRegistrationInfo, harnessConfig, extraDenies, options.confirmPieceUpgrade, options.bundledResources, options.pieceUpgradeLog);
        engine = loaded.engine;
        harnessRegistration = loaded.registration;
      } catch (error) {
        await link.close();
        throw error;
      }
    }
    // A dispatch a kill cut short is settled by inspection, never by sending it again: written if
    // the document holds exactly its words as a new version, UNKNOWN otherwise. A write only
    // claimed is left for its resumed turn to carry on.
    for (const held of await link.heldClaims()) {
      // Only the host's own document writes here; other dispatches are swept below.
      if (held.status !== 'dispatching' || !held.document) continue;
      const { rows } = await link.read<StoredWrite & { key: string }>(link.system(), 'SELECT id, status, args, idempotency_key AS key FROM app.effects WHERE id = $1', [held.effect]);
      const row = rows[0];
      const thread = row && [...threads.values()].find((thread) => thread.turns.some((turn) => row.key === `${turn.id}:${row.args.title}`));
      const projectId = thread?.summary.projectId;
      const landed = row && projectId ? await verifiedWrittenVersion(link, row, material, projectId) : null;
      if (landed) await link.observe(held.effect, held.claim, 'succeeded', held.sha256, 'Found the exact expected version on inspection after a restart.');
      else await link.observe(held.effect, held.claim, 'unknown', sha256(`interrupted:${held.effect}`), 'The app stopped during this write.');
    }
    // A door's dispatch whose dispatcher went silent is settled by inspection once its own dispatch
    // claim has lapsed (the core decides), at start and then every few seconds, so it surfaces as
    // UNKNOWN even if the door never returns.
    const doorExecutors = { 'outbox.write': outboxExecutor(home) };
    const sweep = () => sweepInterruptedDispatches(link, doorExecutors).catch(() => 0);
    await sweep();
    sweeper = setInterval(() => void sweep().then((n) => n ? triage.reconcilePending().then(() => emit({ topic: 'triage' })) : undefined).catch(() => {}), SWEEP_MS);
    sweeper.unref();
    for (const p of projects) {
      for (const e of material.list(p.id, true)) {
        if (!isText(e)) continue;
        const known = await link.documentVersion(e.id);
        if (known === null) continue;
        for (const v of e.versions.filter((x) => x.n > known && x.by === 'person')) {
          await link.reviseDocument(e.id, Buffer.from(material.bytes(e.id, v.n)).toString('utf8'));
        }
      }
    }
    // Discover from original records; a transient read failure stays eligible for explicit recovery.
    for (const thread of threads.values()) for (const turn of thread.turns) if (await discover(thread, turn, link)) watchRecovery(thread, turn);
    // A stopped importer can retain unfinished work. Sweep only checkpoints no stored turn owns.
    if (existsSync(join(home, 'checkpoints'))) {
      const live = new Set([...threads.values()].flatMap(thread => thread.turns.map(turn => turn.id)));
      for (const name of readdirSync(join(home, 'checkpoints'))) if (!live.has(name.replace(/\.json$/, ''))) await checkpointsFor(name.replace(/\.json$/, '')).clear();
    }
    for (const thread of threads.values()) {
      for (const turn of thread.turns.filter((t) => t.unclassified?.length)) { await classify(turn, thread.summary.projectId, turn.unclassified!); await saveThread(thread); }
    }
    await parallel.recover(link);
    // Before any turn resumes: a card whose worker a kill interrupted is held or ready again, never resent blindly.
    await board.recover();
    withdrawalReady=true;withdrawalDelivery.request();
    return link;
  });
  // A host that could not open is over, so the home does not wait for its close.
  core.catch(() => {
    trackHomeRelease(home, owner.then((release) => release(), () => {}));
  });
  const doorPiece = (typeof options.doors === 'object' ? options.doors.piece : undefined) ?? options.tools?.door?.piece;
  // A host that connects AI tools serves their doors too: a connected tool's door has nowhere else to go.
  const doors = !readOnly && (options.doors ?? !!options.tools) ? core.then(() => serveDoors({ home, link: () => core, admit: async () => { await admission.ready(); admission.check(true); }, piece: doorPiece })) : undefined;
  doors?.catch(() => {});
  const gateway = sourceReads.gateway;
  const saveThread = async (t: StoredThread) => {
    t.summary.updatedAt = now();
    await saveThreadProjection(home, t);
    emit({ topic: 'threads', id: t.summary.id });
  };
  const closeRecovery = async (thread: StoredThread, turn: Turn) => {
    turn.work.endedAt = now(); parallel.ended(thread, turn); await saveThread(thread); crash('recovery.saved');
  };
  const discover = (thread: StoredThread, turn: Turn, link: CoreLink) => discoverRecovery({ home, threadId: thread.summary.id, projectId: thread.summary.projectId, taskId: thread.task ?? '', turn, link, material, store: checkpointsFor(turn.id) }, thread, interrupted,
    { closed: () => closeRecovery(thread, turn), save: () => saveThread(thread), ended: () => parallel.ended(thread, turn), now });
  function watchRecovery(thread: StoredThread, turn: Turn) {
    if (closing || readOnly || !inspectCheckpoint(checkpointsFor(turn.id)).checkpoint) return;
    recoveryRetries.add(turn.id, async () => {
      if (closing || threads.get(thread.summary.id) !== thread || !thread.turns.includes(turn)) return false;
      const state = inspectCheckpoint(checkpointsFor(turn.id)); if (state.problem || !state.checkpoint) return false;
      if (running.has(thread.summary.id)) return true;
      const link = await core; if (closing) return false;
      return retryCheckpoint({ home, threadId: thread.summary.id, projectId: thread.summary.projectId, taskId: thread.task ?? '', turn, link, material, store: checkpointsFor(turn.id) }, thread,
        { running, register: registerCarrier, closing: () => closing, busy: () => running.has(thread.summary.id) || side.isRunning(thread.summary.id) || parallel.parentRunning(thread) || (parallel.subagents(thread)?.active ?? 0) > 0, piece: () => harnessRegistration, save: () => saveThread(thread), closed: () => closeRecovery(thread, turn) });
    });
  }
  function card(t: StoredThread): ThreadCard {
    const project = projects.find((p) => p.id === t.summary.projectId);
    const changes = { added: 0, removed: 0, files: 0 };
    const touched = new Set<string>();
    const sources = new Map<string, { materialId: string; name: string; version: number }>();
    for (const turn of t.turns) {
      for (const a of turn.user.attachments) sources.set(a.materialId, a);
      for (const f of turn.answer?.files ?? []) {
        if (!turn.merge && !turn.effects.some((e) => e.outcome === 'DONE' && e.target === f.name)) continue;
        const d = versionDiff(f.materialId, f.version);
        if (d) {
          changes.added += d.added;
          changes.removed += d.removed;
          touched.add(f.materialId);
        }
      }
    }
    changes.files = touched.size;
    return { project: project?.name ?? '', changes, subagents: parallel.subagents(t), sources: [...sources.values()] };
  }
  function versionDiff(id: string, version: number) {
    const e = material.load(id);
    if (!e || !isText(e)) return null;
    const after = Buffer.from(material.bytes(id, version)).toString('utf8');
    const before = version > 1 ? Buffer.from(material.bytes(id, version - 1)).toString('utf8') : '';
    return lineDiff(e.name, before, after);
  }
  const summaryView = async (t: StoredThread) => projectRecoverySummary(t.summary, t.turns, checkpointsFor, running.has(t.summary.id), await core, t.task,
    async turn => checkpointRun({ home, threadId: t.summary.id, projectId: t.summary.projectId, taskId: t.task ?? '', turn, link: await core, material, store: checkpointsFor(turn.id) }));
  const view = async (t: StoredThread): Promise<Thread> => {
    const goalRun = goalRuns.view(t.summary.id);
    const turns = projectUnknownChecks(t, connectors.list().held, !readOnly && !closing && !importing && await identity.canCheckThread(t),
      turn => turn.status === 'stopped' && !t.summary.running && !running.has(t.summary.id) ? checkpointRepairNotice(home, turn.id) : undefined);
    return { summary: await summaryView(t), turns, sideTurns: t.sideTurns, card: card(t), rewinds: t.rewinds, rewindPending: t.rewindPending, ...parallel.projection(t), ...(goalRun ? { goalRun } : {}) };
  };
  function newTurn(text: string, side: boolean, attachments: Turn['user']['attachments'], settings?: Turn['user']['settings']): Turn {
    return { id: randomUUID(), side, user: { text, attachments, settings, at: now() }, work: { startedAt: now(), steps: [], harness: harnessLabel() }, effects: [], status: 'running' };
  }
  function draftPath(key: string) {
    return join(home, 'drafts', `${sha256(key).slice(0, 32)}.json`);
  }
  const { linkedPath, filesOf } = createProjectFiles({ findProject: (id) => projects.find((p) => p.id === id), projectDir, material });
  /** Carry the original run under its renewed lease; finish only after durable work is settled.
   * Retained connector observations keep their identities and need the person's explicit choice. */
  function carry(link: CoreLink, thread: StoredThread, turn: Turn, entries: MaterialEntry[], controller: AbortController, run: Promise<RunHandle>, resumed = false, recoveryRun?: { id?: string }) {
    return createTurnCarrier({ home, material, threads, running, inflight, carriers, parallel, admission, memory, goalRuns, proactivity, triggers, board, gateway, connectors, routes, credentials, get engine() { return engine; }, harnessId, harnessPiece, scriptDir, writeDelayMs, checkpointsFor, closeRecovery, projectDir, crash, routeFor, coordinationFor, saveThread, classify, emit, watchRecovery })(link, thread, turn, entries, controller, run, resumed, recoveryRun);
  }
  /** `continuing`: a chosen task as a turn with these settings runs it, a model they name kept, or why not. `routeFor`: the route a turn would run on now, refused if a selected task in its or its parents' history forbids it (`carries`). Both selection/pin.ts. */
  const continuing = (thread: StoredThread, settings: TurnSettings, base: TurnSelection | undefined): { selection?: TurnSelection } | { refused: string } => (base ? withNamedModel(base, settings.model, !!thread.child?.model) : {});
  function routeFor(thread: StoredThread, model: string | undefined, selection: TurnSelection | undefined): (NonNullable<ReturnType<typeof turnRoute>> & { carries?: string }) | null {
    const decided = turnRoute(selection, model, routes.resolve() ?? null, !!thread.child?.model);
    let why: string | null | false = null;
    for (let t: StoredThread | undefined = thread; t && !why; t = t.child ? threads.get(t.child.parentThreadId) : undefined) why = !!decided && 'route' in decided && historyRefusal(decided.route, t.turns);
    return why ? { refused: why, carries: why } : decided;
  }
  const { side, ready: sideReady } = createSideWiring({ core, routes, continuing, routeFor,
    engine: () => engine, threads: () => threads.values(), mayRecover: () => !readOnly && !closing,
    coreDeps: { link: async () => core, piece: () => harnessRegistration, save: saveThread, gateway, ownsHome: () => ownsHome && !readOnly, closing: () => closing },
    chatDeps: { home, material, policyAdmission: () => admission.check(true), thread: (id) => threads.get(id), save: saveThread, closing: () => closing, credential: async (handle) => credentials.resolve(handle),
      recall: async (projectId, text, settings) => (await memory.forTurn(projectId, text, settings)) ?? undefined },
  });
  /** Core preparation runs outside the home lock; only local reservation holds it. `launch` starts work after. A follow-up continues the chat's chosen task (selection/pin.ts); `selection` is one recorded (solutions.run, a goal run) or none (schedules, triggers). */
  const { requestedStop, stoppingRequests, inStartRequest, activeRequests, request } = identityRequests({
    home, stopMark: id => parallel.stopMark(id), call: (session, method, args) => identity.call(session, method, args),
    closing: () => closing,
    enter(method) {
      if(method!=='host.status'&&method!=='settings.policy.get')admission.check();
      if(closing&&method!=='host.status')throw new Error(CLOSING);
      if(importing)throw new Error('An import holds this home: no other call runs until it ends.');
      if(!READS.has(method)&&method!=='memory.get'&&method!=='host.status'&&method in handlers)usedFor??=method;
      inFlight++;
    },
    leave: () => { inFlight--; },
  });
  const serializeAdmission=turnAdmissions(home);
  async function admit(args:Args<'turns.send'>,how:TurnAdmissionOptions={}) {
    const stopMark=how.stopMark??(args.threadId?parallel.stopMark(args.threadId):0);
    if(!inStartRequest.getStore()?.active)await stoppingRequests.wait(args.threadId);
    return serializeAdmission(()=>admitTurn(args,{...how,stopMark}));
  }
  async function admitTurn({ threadId, projectId, text, attachments, settings, clientKey, continues, afterTurnId }: Args<'turns.send'>, how: TurnAdmissionOptions = {}): Promise<{ result: Result<'turns.send'>; launch?: () => void }> {
    let launch: (() => void) | undefined;
    const stopMark = how.stopMark ?? (threadId ? parallel.stopMark(threadId) : 0);
    let made: string | undefined; const drop = () => { const left = made && threads.get(made); if (left && !left.turns.length) threads.delete(made!); }; // A chat made here goes again if no turn was reserved in it.
    const result = await (async (): Promise<Result<'turns.send'>> => {
      if (harnessConfig.blocked) return refused('NOT_AVAILABLE', harnessConfig.blocked);
      if (closing) return refused('NOT_AVAILABLE', 'The app is closing, so nothing new starts. Your message is kept.');
      if (harnessRegistrationInfo?.requiresFull && settings.permission !== 'full') return refused('NOT_AVAILABLE', 'This native trial requires Full access within the prepared project workspace. No model call was made.');
      const link = await core;
      if (!projects.some((p) => p.id === projectId)) return refused('NOT_FOUND', 'No such project.');
      const entries = attachments.map((id) => material.load(id)).filter((e) => !!e);
      if (entries.length !== attachments.length || entries.some((entry) => entry.projectId !== projectId)) return refused('INVALID', 'Use files from the active project.');
      const gone = entries.find((e) => isWithdrawn(e) || e.held || e.recovery);
      if (gone) return refused('INVALID', gone.recovery ? `${gone.name} is an inspection copy, not imported work; it cannot be attached.` : gone.held ? `${gone.name} is held for your decision; it cannot be attached.` : `${gone.name} was withdrawn; it cannot be attached.`);
      if (!text.trim()) return refused('INVALID', 'A message needs words; nothing was sent.'); // Core keeps only worded messages; a first message makes its chat, so a retry finds that chat by its key.
      let t = threadId ? threads.get(threadId) : [...threads.values()].find((known) => known.clientKeys.includes(clientKey));
      if (t && t.summary.projectId !== projectId) return refused('INVALID', 'Use the active chat project.');
      if (threadId && !t) return refused('NOT_FOUND', `No thread ${threadId}.`);
      if (!t) {
        const id = randomUUID();
        t = { summary: { id, projectId, title: text.trim().split('\n')[0].slice(0, 60) || 'New thread', pinned: false, unread: false, archived: false, running: false, updatedAt: now() }, turns: [], sideTurns: [], clientKeys: [] };
        made = id;
      }
      const thread = t, existing = made === undefined;
      const snapshot={project:thread.summary.projectId,task:thread.task,title:thread.summary.title,turns:thread.turns.map(turn=>turn.id).join(',')};
      const rewound = thread.rewinds?.flatMap(record => record.turns.filter((_, i) => record.clientKeys?.[i] === clientKey))[0];
      if (rewound) return { ok: true, value: { threadId: thread.summary.id, turnId: rewound.id } };
      const prior = thread.turns.find((_, i) => thread.clientKeys[i] === clientKey);
      if (prior) return { ok: true, value: { threadId: thread.summary.id, turnId: prior.id } };
      if (afterTurnId && thread.turns.at(-1)?.id !== afterTurnId) return refused('STALE_BASE', 'The conversation moved on. No continuation was started.');
      const rewindHold = rewindAdmission(threads.values(), projectId, thread.summary.id);
      if (rewindHold) return refused('NOT_AVAILABLE', rewindHold);
      if(threadId&&parallel.stopMark(threadId)!==stopMark)return refused('NOT_AVAILABLE','This work was stopped before preparation. Your message is kept.');
      if (thread.summary.running || running.has(thread.summary.id)) return refused('NOT_AVAILABLE', 'A turn is already running in this thread; stop it or wait.');
      if (interrupted.some((entry) => entry.thread === thread)) return refused('NOT_AVAILABLE', 'An interrupted turn in this thread has not been resumed yet.');
      const beyond = parallel.refuseTurn(thread, settings);
      if (beyond) return beyond;
      settings = parallel.settingsFor(thread, settings);
      const chosen = continuing(thread, settings, how.selection === undefined ? continuedSelection(thread.turns) : how.selection ?? undefined);
      if ('refused' in chosen) return refused('NOT_AVAILABLE', chosen.refused);
      const goes = engine && routeFor(thread, settings.model, chosen.selection);
      if (goes && goes.carries) return refused('NOT_AVAILABLE', goes.carries); // other route refusals are the turn's, at its start
      if (!asShown(chosen.selection, continues)) return refused('NOT_AVAILABLE', 'The route this chat\'s task runs on changed since you were shown it, so nothing was sent. Ask again to be shown it as it is now.');
      if (thread.task) for (const original of thread.turns) {
        const saved = inspectCheckpoint(checkpointsFor(original.id));
        if (saved.problem) return refused('NOT_AVAILABLE', saved.problem);
        if (saved.checkpoint) {
          try {
            const run = await checkpointRun({ home, threadId: thread.summary.id, projectId, taskId: thread.task, turn: original, link, material, store: checkpointsFor(original.id) });
            const open = run && (await link.read(link.system(), "SELECT id FROM app.runs WHERE id = $1 AND status IN ('queued', 'running', 'waiting')", [run])).rows.length > 0;
            if (!open) {
              launch = () => { if (!closing) resume(link, thread, original); };
              return refused('NOT_AVAILABLE', 'Saved work is being reconciled from its closed original run. Your unsent message is kept.');
            }
          } catch { return refused('NOT_AVAILABLE', 'Saved recovery data needs inspection. It is retained; other conversations can continue.'); }
          launch = () => { if (!closing) resume(link, thread, original); };
          return refused('NOT_AVAILABLE', 'Saved pieces are being recovered before new work starts. Your unsent message is kept.');
        }
        const run = await custodyRun(home, thread.summary.id, original.id, thread.summary.projectId)
          ?? await originalTurnRun(link, thread.task, original.id);
        const rows = run ? await turnWrites(link, run, original.id) : [];
        if (rows.some((row) => ['proposed', 'awaiting_checker', 'allowed', 'claimed'].includes(row.status))
          || await unconfirmedCustody(home, thread.summary.id, run, original.id, thread.summary.projectId, rows)) {
          if (run) launch = () => { if (!closing) resume(link, thread, original); };
          return refused('NOT_AVAILABLE', 'An original write is being recovered before new work starts. Your unsent message is kept.');
        }
      }
      const turn = newTurn(text, false, entries.map((e) => ({ materialId: e.id, name: e.name, version: e.current })), settings);
      if (afterTurnId) turn.restartOf = afterTurnId;
      if (thread.personId && thread.personId !== link.id.person) return refused('NOT_AVAILABLE', 'Start your own conversation in this shared project.');
      const task = thread.task ?? await link.createTask(thread.summary.title,projectId);
      if(thread.task)await link.bindProjectTask(projectId,task);
      // Preparation can retain a private Core conversation line if local state changes.
      // It starts no run; the local key is committed only after revalidation below.
      if (!how.queued) await link.say(task, text);
      const controller = new AbortController();
      const reserved=await withHomeLock<Result<'turns.send'> | null>(home,async()=>{
        if(threadId&&stoppingRequests.has(threadId))return refused('NOT_AVAILABLE','A Stop is still finishing. Your message is kept.');
        if (closing || !projects.some(p=>p.id===projectId)) return refused('NOT_AVAILABLE','The project is no longer available. Your message is kept.');
        const rewindHold = rewindAdmission(threads.values(), projectId, thread.summary.id);
        if (rewindHold) return refused('NOT_AVAILABLE', rewindHold);
        if (afterTurnId && thread.turns.at(-1)?.id !== afterTurnId) return refused('STALE_BASE', 'The conversation moved on. No continuation was started.');
        const invalid=how.validate?.();
        if (invalid) return refused('NOT_AVAILABLE',invalid);
        if ((existing && threads.get(thread.summary.id)!==thread) || thread.summary.projectId!==snapshot.project || thread.task!==snapshot.task || thread.summary.title!==snapshot.title || thread.turns.map(turn=>turn.id).join(',')!==snapshot.turns || thread.summary.running || running.has(thread.summary.id)) return refused('NOT_AVAILABLE','The conversation changed during preparation. Your message is kept.');
        if (thread.personId && thread.personId!==link.id.person) return refused('NOT_AVAILABLE','Start your own conversation in this shared project.');
        if (attachments.some((id,i)=>{const current=material.load(id);return !current || current.projectId!==projectId || current.current!==entries[i].current || isWithdrawn(current) || current.held || current.recovery;})) return refused('NOT_AVAILABLE','An attached file changed during preparation. Your message is kept.');
        if (threadId && parallel.stopMark(threadId)!==stopMark) return refused('NOT_AVAILABLE','This work was stopped; nothing was started. Your message is kept.');
        if (how.stillWanted && !how.stillWanted()) return refused('NOT_AVAILABLE','You stopped this work, so this message stays queued.');
        const carried=replay(thread.turns.filter(t=>t.status!=='running'),material,projectId);
        turn.reads=carried.inherited;
        if(carried.unknown)turn.unknownSources=true;
        if(chosen.selection)turn.selection=chosen.selection;
        how.prepare?.(turn);
        thread.personId??=link.id.person;thread.automationId??=link.id.automationId;thread.task=task;
        if(!existing)threads.set(thread.summary.id,thread);
        parallel.reserve(thread,turn,clientKey,how.queued);
        running.set(thread.summary.id,controller);registerCarrier(controller,turn);
        how.reserved?.(thread.summary.id,turn.id);
        await (how.queued?saveThread(thread).catch(()=>{}):saveThread(thread));
        return null;
      });
      if(reserved)return reserved;
      if(how.queued)await link.say(task,text).catch(()=>{turn.work.steps.push({kind:'note',label:'These words could not be added to the core conversation record.'});});
      // The run is queued and claimed before the send returns; the agent then works in the background.
      const run = parallel.runFor(link, thread);
      await run.catch(() => {});
      // An admission that finishes once close has begun starts no worker: the reserved turn is left as a
      // kill at this moment would leave it, and the next opening carries it on.
      launch = () => { if (!closing) void carry(link, thread, turn, entries, controller, run); };
      return { ok: true, value: { threadId: thread.summary.id, turnId: turn.id } };
    })().catch((error: unknown) => { drop(); throw error; }); if (!result.ok) drop();
    return { result, ...(launch ? { launch } : {}) };
  }
  /** Resume a turn a kill interrupted: once its run's lease has lapsed, claim the same run again. */
  function resume(link: CoreLink, thread: StoredThread, turn: Turn) {
    if (running.has(thread.summary.id)) return;
    parallel.orphanSteers(thread, turn);
    if (turn.nativeAccountActivity) {
      // The native client is gone and has no gateway receipt to settle. Preserve the only
      // observed work and narrow every continuation before any recovery can start.
      turn.unknownOutcome = true;
      turn.unknownEvidence = { connectorEffects: turn.unknownEvidence?.connectorEffects ?? [], other: true };
      turn.work.steps.push({ kind: 'note', label: 'Native account activity was interrupted when the app stopped; its outcome is UNKNOWN. Inspect the source system before another attempt.' });
    } else turn.work.steps = [];
    // Said on the turn, so a run it belongs to can tell a kill from the person's Stop.
    turn.interrupted = true;
    // Keep the last projection until durable gateway recovery replaces it. A failed
    // recovery query or early preflight must never erase an earlier UNKNOWN.
    thread.summary.running = true;
    const controller = new AbortController();
    running.set(thread.summary.id, controller);
    registerCarrier(controller, turn);
    emit({ topic: 'threads', id: thread.summary.id });
    const entries = turn.user.attachments.map((a) => material.load(a.materialId)).filter((e) => !!e);
    const recoveryRun: { id?: string } = {};
    const handle = (async () => {
      const saved = inspectCheckpoint(checkpointsFor(turn.id));
      if (saved.problem) throw new Error(saved.problem);
      const sourceRun = sourceReads.originalRun({ workspace: link.id.workspace, project: thread.summary.projectId, thread: thread.summary.id, turn: turn.id });
      const run = saved.checkpoint ? await checkpointRun({ home, threadId: thread.summary.id, projectId: thread.summary.projectId, taskId: thread.task ?? '', turn, link, material, store: checkpointsFor(turn.id) })
        : sourceRun ?? await custodyRun(home, thread.summary.id, turn.id, thread.summary.projectId) ?? await originalTurnRun(link, thread.task ?? '', turn.id) ?? await link.openRun(thread.task ?? '');
      if (!run || (sourceRun && sourceRun !== run)) throw new Error('The original run could not be verified; no replacement run was started.');
      recoveryRun.id = run;
      return link.reclaimRun(run, harnessRegistration);
    })();
    void carry(link, thread, turn, entries, controller, handle, true, recoveryRun);
  }
  const unresolvedTurn = (id: string, turn: Turn) => turnUnresolved(id, turn, (thread, turnId, effect) => connectors.reconciledTurnEffect(thread, turnId, effect), connectors.list().held);
  const threadControl = createThreadControl({
    get: args => host.call('threads.get', args), stop: args => host.call('turns.stop', args), send: args => host.call('turns.send', args),
    settled: id => carriers.get(id) ?? Promise.resolve(),
    unresolved: unresolvedTurn,
    canRestart: turn => turn.nativeAccountActivity && turn.status !== 'done' && !unknownChecked(turn)
      ? 'Native account activity needs inspection before another attempt. Check its work steps and the source system, then use “I checked this myself” in the conversation before continuing; nothing was replayed.'
      : turn.work.harness.startsWith('ACP') && !unknownChecked(turn) ? 'ACP cannot attest every native action after interruption. Inspect its work and send a deliberate new message; nothing was replayed.' : true,
  });
  const parallel = createParallelWork({
    restart: args => threadControl.restart(args),
    requestedStop: () => requestedStop.getStore(),
    home, threads, running, registerCarrier, material, journal,
    interrupted: (thread) => interrupted.some((entry) => entry.thread === thread),
    link: () => core,
    piece: () => harnessRegistration,
    native: () => !!harnessRegistrationInfo?.nativeCoordination,
    steers: () => !!engine?.steers,
    closing: () => closing,
    async models() {
      await core;
      const any = [1, 2, 3, 4, 5] as const;
      if (!engine) return [{ id: 'stub', efforts: any }];
      if (harnessRegistrationInfo?.nativeCatalog) {
        if (!engine.listModels) throw new Error('this engine has no model catalog');
        return engine.listModels();
      }
      const route = routes.resolve();
      if (!route) throw new Error(routes.settings().hint ?? NO_ROUTE);
      return engine.listModels ? engine.listModels(route, (handle) => credentials.resolve(handle)) : [{ id: route.model, efforts: any }];
    },
    routeModel: () => (engine ? routes.resolve()?.model : undefined),
    admit,
    newTurn: (text, settings) => newTurn(text, false, [], settings),
    saveThread,
    carry: (link, thread, turn, controller, run) => void carry(link, thread, turn, [], controller, run),
    emptied: (id) => emit({ topic: 'threads', id }),
    agentRole: (name, brief) => memory.agentRole(name, brief),
  });
  /** A turn's coordination; one that is no child may also add cards to its board. */
  const coordinationFor = (thread: StoredThread, turn: Turn, h: RunHandle, signal: AbortSignal) => {
    const coordination = parallel.coordination(thread, turn, h, signal);
    // The card is bound to the mandate this run was delegated, read when it is added.
    const mandate = async () => { const link = await core; return link.call<string | null>(link.system(), 'SELECT mandate_id FROM app.runs WHERE id = $1', [h.run]); };
    const messageCard = (request: Parameters<typeof board.messageCard>[2]) => board.messageCard(thread, turn, request, signal);
    return thread.child ? { ...coordination, messageCard } : { ...coordination, messageCard, addCard: (request: Parameters<typeof board.addCard>[2]) => board.addCard(thread, turn, request, { signal, mandate }) };
  };
  const board = createTaskBoard({
    home, threads, readOnly, emit,
    closing: () => closing,
    now: Date.now,
    backoffMs: options.board?.backoffMs ?? 1_000,
    startWorker: (request) => parallel.startWorker(request),
    admit: (args, how) => admit(args, how),
    stopTurn: (thread, turn) => parallel.stopTurn(thread, turn),
    mayHaveWritten: async (thread, turn) => turn.effects.length > 0 || !!(await custodyRun(home, thread.summary.id, turn.id, thread.summary.projectId)),
    withdrawn: (turn) => taintedReads(turn, (id) => material.load(id)).length > 0,
    peerSteer: (threadId, turnId, text, sources, key) => parallel.peerSteer(threadId, turnId, text, sources, key),
  });
  const memory = createMemory({
    home, threads, material, emit,
    // The person's own skill and memory folders are read only from a user home the caller names.
    userHome: options.memory?.userHome,
    projectExists: (id) => projects.some((p) => p.id === id),
    credentials: () => credentials.values(),
    now: options.schedules?.now ?? Date.now,
    brief: (item) => proactivity.note(item),
    unbrief: (keys) => proactivity.unnote(keys),
    locked: (fn) => withHomeLock(home, fn),
    judge: (request) => judgeMemory(request),
    closing: () => closing,
  });

  /**
   * Memory consolidation's model turn: the home's engine on its configured route, never a fixed one, as
   * a bare turn (no tool of any kind, nothing staged or written; only its answer kept). An engine that
   * cannot run one is not asked. Stopped when the host closes.
   */
  const judging = new Set<HarnessTurn>();
  async function judgeMemory({ system, text }: { system: string; text: string }): Promise<string | null> {
    const route = engine && routes.resolve();
    if (!engine?.bare || !route || closing) return null;
    const turn = engine.start(
      { system, threadId: 'memory-consolidation', turnId: randomUUID(), text, history: [], attachments: [], effort: 2, resumed: false, readOnly: true, bare: true },
      { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'Nothing is written while memory is consolidated.' }) }, route, credential: (h) => credentials.resolve(h) },
    );
    judging.add(turn);
    try {
      for await (const _ of turn.events) { /* Only the answer is used. */ }
      const outcome = await turn.outcome;
      return outcome.status === 'done' && !closing ? outcome.answer : null;
    } finally {
      judging.delete(turn);
    }
  }
  const goalRuns = createGoalRuns({
    home, threads, emit, material,
    closing: () => closing,
    ready: core,
    admit: (args, how) => admit(args, how),
    selectionFor: (thread, settings) => continuing(thread, settings, continuedSelection(thread.turns)),
    childrenRunning: (t) => parallel.subagents(t).active > 0,
  });
  const proactivity = createProactivity({
    home, threads, readOnly, emit,
    now: options.schedules?.now ?? Date.now,
    tickMs: options.schedules?.tickMs ?? 30_000,
    // A tick waits for the home and core: admission locks the home, and taking the home needs that lock.
    ready: core,
    closing: () => closing,
    projectExists: (id) => projects.some((p) => p.id === id),
    material,
    admit: (args, how) => admit(args, { ...how, selection: null }), // runs as allowed, never on a chat's later choice
    daily: () => memory.daily(),
  });

  const tools = options.tools
    ? createToolConnections({ home, ...options.tools, core: { baselineSql: options.baselineSql, postgresNative: options.postgresNative, keys: options.keys }, link: () => core })
    : null;
  const noTools = refused<never>('NOT_AVAILABLE', 'Connecting AI tools is done in the desktop app.');
  const toolsChanged = <T>(r: Receipt<T>) => (emit({ topic: 'tools' }), r);
  // What a stopped connect, disconnect or failed revoke left is finished at start, revoking first.
  if (tools && !readOnly) void core.then(() => tools.recover()).then((n) => n && emit({ topic: 'tools' }), () => {});

  function createProject(name: string, kind: Project['kind'], clientKey: string = randomUUID()): Promise<Receipt<Project>> {
    return createKeyedProject({home,list:()=>projects,save:next=>{writeJson(projectsPath,next);projects=next;},emit:id=>emit({topic:'projects',id}),cut:options.projectCreateCut},name,kind,clientKey);
  }

  // The mail module, as a piece: its files checked against its manifest, registered by the person
  // when they connect (later loads need that standing registration), and only then imported, from
  // its checked snapshot. Its connector is made once per digest, so its watchers and state stay put.
  const mailDir = options.mail?.dir ?? PIECES['connector-mail'].dir;
  let mailModule: { digest: string; loaded: Promise<{ connector: MailConnector; task: TriageTask }> } | undefined;
  async function mail(opts: { register?: boolean } = {}) {
    const link = await core;
    const piece = pieceOnDisk(mailDir, PIECES['connector-mail'].id);
    const registration = opts.register ? await registerPiece(link, piece) : (await loadPiece(link, piece)).registration;
    if (mailModule?.digest !== piece.digest) {
      const loaded = (async () => {
        const injected = options.mail?.connector && options.mail.task;
        const module = injected ? null : await importPiece<MailModule>(snapshotPiece(piece, home));
        return { connector: options.mail?.connector ?? module!.createMailConnector({ home }), task: options.mail?.task ?? module!.readTask() };
      })();
      mailModule = { digest: piece.digest, loaded };
      loaded.catch(() => (mailModule = undefined));
    }
    const { connector, task } = await mailModule.loaded;
    return { connector, task, registration, piece: { id: piece.manifest.id, version: piece.manifest.version, digest: piece.digest } };
  }
  const connectors = new ConnectorService({
    keys: options.keys,
    policyAdmission: () => admission.check(true),
    reconcileOnOpen: !readOnly,
    home,
    env: () => options.connectors?.env ?? options.tools?.env ?? defaultToolEnv(),
    link: () => core,
    emit: () => emit({ topic: 'connectors' }),
    credentials: () => credentials.values(),
    ...(options.connectors?.sources ? { sources: options.connectors.sources } : {}),
    ...(options.connectors?.callTimeoutMs ? { callTimeoutMs: options.connectors.callTimeoutMs } : {}),
  });
  const enabling = connectorEnabling(home, () => options.connectors?.env ?? options.tools?.env ?? defaultToolEnv(), connectors, () => emit({ topic: 'connectors' }), () => !closing && !readOnly && !importing);
  const triage = new TriageService({
    home,
    link: () => core,
    material,
    project: async (name) => {
      const existing = projects.find(p => p.name === name && p.kind === 'folder');
      if (existing) return existing.id;
      const result = await createProject(name, 'folder');
      if (!result.ok) throw Object.assign(new Error(result.detail), { outcome: result.reason === 'PROJECT_CREATE_FAILED' ? 'UNKNOWN' : result.outcome });
      return result.value.id;
    },
    engine: () => engine,
    nativeAccountTurn: async project=>nativeTurnForProject(harnessId,harnessPiece?.manifest,await core,project),
    route: () => routes.resolve(),
    credential: (h) => credentials.resolve(h),
    tool: () => (engine && harnessPiece ? { id: harnessPiece.manifest.id, version: harnessPiece.manifest.version, digest: harnessPiece.digest } : null),
    mail,
    emit: () => emit({ topic: 'triage' }),
    writeDelayMs,
  });
  const triggers = createTriggers({
    home, threads, readOnly, emit, appChanges,
    now: options.schedules?.now ?? Date.now,
    tickMs: options.schedules?.tickMs ?? 30_000,
    debounceMs: options.triggers?.debounceMs ?? 1_000,
    webhookPort: options.triggers?.webhookPort ?? 0,
    ready: core,
    closing: () => closing,
    projectExists: (id) => projects.some((p) => p.id === id),
    projectDir,
    admit: (args, how) => admit(args, { ...how, selection: null }), // likewise
    report: proactivity.report,
    seal: (value, label) => credentials.put(value, label),
    unseal: (handle) => credentials.resolve(handle),
    revoke: (handle) => credentials.revoke(handle),
    // New mail, as triage hears it: the connected mailbox's watch, once the mail module is loaded.
    watchMail: async (listener) => (triage.stored.connection ? (await mail()).connector.watch(listener) : null),
  });

  // A job a kill cut short is closed as interrupted; new mail (and the schedule, if set) wakes it.
  void core.then(async () => {
    if (readOnly || !triage.stored.connection) return;
    await triage.recover();
    triage.listen(options.mail?.scheduleMs);
  }).catch(() => {});

  async function triageView(): Promise<TriageView> {
    const conn = triage.stored.connection;
    const offer = conn ? await triage.offer().catch(() => null) : null;
    const writes = conn ? await mail().then((m) => m.connector.writes, () => 'gated' as const) : 'gated';
    return viewOf(triage.stored, await triage.effects(), {
      available: !!engine,
      running: triage.isRunning(),
      writes,
      offer: offer && { hash: offer.hash, summary: summaryOf(offer.payload), widening: offer.widening, again: triage.current()?.state === 'suspended' && triage.current()?.hash === offer.hash },
    });
  }
  const triageRefused = (error: unknown): Receipt<never> => {
    const unknown = error instanceof Error && 'outcome' in error && error.outcome === 'UNKNOWN';
    const detail = error instanceof Error ? error.message : String(error);
    if (unknown) return { ok: false, reason: 'NOT_AVAILABLE', outcome: 'UNKNOWN', detail };
    return refused<never>(error instanceof TriageRefused ? 'NOT_AVAILABLE' : 'INVALID', detail);
  };

  const hasDraft = (id: string) => !!readJson<{ text?: string } | null>(draftPath(`edit:${id}`), null)?.text;
  const inProject = (projectId: string) => [...threads.values()].filter((t) => t.summary.projectId === projectId);
  const checkpointsFor = (turnId: string) => {
    const path = join(home, 'checkpoints', `${turnId}.json`);
    return { load: () => readJson<Checkpoint | null>(path, null), save: async (checkpoint: Checkpoint) => writeJson(path, checkpoint), clear: async () => rmSync(path, { force: true }) };
  };
  const classify = (turn: Turn, projectId: string, files: import('../api.ts').FileLink[]) => classifyRecovered(turn, material, files,
    (entry) => hasOpenWork(inProject(projectId), entry, hasDraft), (run) => withHomeLock(home, run));
  const nowIn = (projectId: string) => {
    const threadsHere = inProject(projectId);
    const now = workNow(threadsHere, material.list(projectId, true), hasDraft);
    now.notices = [...(knowledgeNotice?[{code:'knowledge-source-guard' as const,message:knowledgeNotice}]:[]),...(withdrawalDelivery?.notices(projectId)??[])];
    // A change a connected tool asked for in this project waits on the person too.
    const here = new Set(threadsHere.map((t) => t.summary.id));
    for (const h of connectors.list().held) {
      if (h.state !== 'waiting' || !h.threadId || !here.has(h.threadId)) continue;
      now.needsYou.push({ kind: 'connector', threadId: h.threadId, title: `${h.serverName}: ${h.tool}`, detail: `${h.statement} Release or discard it in Settings › Connected tools.` });
    }
    return now;
  };
  /** The routes here and a reasoned choice for a task (selection/choose.ts, inventory.ts). */
  const selectFor = async (task: Args<'solutions.options'>) => {
    const local = await detectLocalModels(options.localModels);
    const codex = harnessRegistrationInfo?.ownsModel ? { status: 'warn' as const, detail: 'not checked for this agent-owned route' } : codexCheck();
    // One snapshot with no wait inside it: the route the choice was made on is the one it is pinned to.
    const { route: configured, settings: stored } = routes.snapshot();
    const settings = { ...stored, ...(nativeProblem ? { hint: nativeProblem } : {}), harness: engine?.label ?? harnessLabel() };
    return { selection: choose(inventory({ codex, settings, local }), task), local, configured };
  };

  /**
   * A document with its text versions, in order, as the person's own: what an import into a new home
   * adds, and nothing else. Never on the api, so no transport or renderer reaches it.
   */
  /** An import into this home is running; the first method that changed anything; calls in flight. */
  let importing = false;
  let usedFor: string | null = null;
  let inFlight = 0;
  const importDocument = (projectId: string, name: string, mediaType: string, versions: readonly (string | Uint8Array)[], layout?: MaterialImport): Promise<Receipt<MaterialEntry>> => withHomeLock(home, async () => {
    if (!projects.some((p) => p.id === projectId)) return refused('NOT_FOUND', 'No such project.');
    const result = await material.importDocument(projectId, name, mediaType, versions, layout);
    if (result.ok) emit({ topic: 'material', id: projectId });
    return result;
  });

  const keepRecovery = createRecoveryRepair({ home, core: () => core, material, thread: id => threads.get(id), running, registerCarrier, store: checkpointsFor, closed: closeRecovery, save: saveThread, changed: id => emit({ topic: 'material', id }), busy: thread => closing || side.isRunning(thread.summary.id) || parallel.parentRunning(thread) || (parallel.subagents(thread)?.active ?? 0) > 0 });
  const reads = createHostReads({ home, options, core, material, threads, running, routes, connectors, credentials, sourceReads, harnessConfig, harnessRegistrationInfo, harnessLabel, projectDir, draftPath, versionDiff, summaryView, view, nowIn, selectFor, filesOf, linkedPath,
    get projects() { return projects; }, get engine() { return engine; }, get nativeProblem() { return nativeProblem; }, set nativeProblem(problem) { nativeProblem = problem; } });
  const identity = createIdentityHost({home,readOnly,configuration:options.identity,link:()=>core,projects:()=>projects,threads,summary:summaryView,material,piece:()=>harnessRegistration,
    nativeEngine:()=>!hostToolsOnly(harnessId,harnessPiece?.manifest),emit,dispatch,
    abort:(person,automation)=>{for(const thread of threads.values())if((person && thread.personId===person)||(automation && thread.automationId===automation))running.get(thread.summary.id)?.abort();},
    on:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}});
  const rewind = createThreadRewind({ home, material, threads, journal, projectDir, unresolved: unresolvedTurn, sync: async revisions => syncRewindVersions(await core, revisions), save: saveThread, changed: id => emit({ topic: 'material', id }), retention: async t => recoveryRetentionReason(home, await core, t, checkpointsFor), busy: t => closing || [...threads.values()].some(other => other.summary.projectId === t.summary.projectId && (other.summary.running || running.has(other.summary.id) || side.isRunning(other.summary.id) || other.turns.some(turn => !!checkpointsFor(turn.id).load()))) || parallel.hasChildren(t) || parallel.parentRunning(t) || goalRuns.view(t.summary.id)?.status === 'running' });
  const handlers: { [M in Method]: (a: Args<M>) => Promise<Result<M>> | Result<M> } = {
    ...identity.handlers,
    'threads.rewindPreview': rewind.preview,
    'threads.rewindFinish': args => {
      const action = rewind.finish(args), settled = action.then(() => {}, () => {});
      inflight.add(settled); void settled.finally(() => inflight.delete(settled)); return action;
    },
    'threads.rewind': args => {
      const action = rewind.apply(args), settled = action.then(() => {}, () => {});
      inflight.add(settled); void settled.finally(() => inflight.delete(settled)); return action;
    },
    'turns.keepRecovery': args => {
      const action = keepRecovery(args), settled = action.then(() => {}, () => {});
      inflight.add(settled); void settled.finally(() => inflight.delete(settled));
      return action;
    },
    ...reads.handlers,
    'projects.create': ({ name, kind, clientKey }) => {
      if (!name.trim()) return refused('INVALID', 'A project needs a name.');
      return createProject(name, kind, clientKey);
    },
    ...parallel.handlers,
    ...proactivity.handlers,
    ...triggers.handlers,
    ...memory.handlers,
    ...goalRuns.handlers,
    ...board.handlers,
    'threads.search': ({ query }) => searchThreads(threads.values(), query),
    'host.status': async () => {
      try {
        await owner;
        return { owns: true };
      } catch (error) {
        const daemon = readJson<{ pid?: number; since?: string } | null>(join(home, 'daemon.json'), null);
        const live = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
        return {
          owns: false, detail: error instanceof Error ? error.message : String(error),
          ...(daemon?.pid && live(daemon.pid) ? { heldBy: { kind: 'daemon' as const, pid: daemon.pid, since: daemon.since ?? '' } } : {}),
        };
      }
    },
    'threads.update': async ({ id, patch }) => {
      const t = threads.get(id);
      if (!t) return refused<never>('NOT_FOUND', `No thread ${id}.`);
      const snapshot = JSON.stringify(t);
      const moving = patch.projectId && patch.projectId !== t.summary.projectId;
      const available = (): Receipt<never> | undefined => {
        if (patch.projectId && !projects.some(p => p.id === patch.projectId)) return refused<never>('NOT_FOUND', 'No such project.');
        if (moving) {
          if (t.child || parallel.hasChildren(t)) return refused<never>('NOT_AVAILABLE', 'A parent and its children stay in one project.');
          const stored = readJson<StoredThread | null>(join(home, 'threads', `${id}.json`), null);
          if (t.summary.running || running.has(id) || stored?.summary.running) return refused<never>('NOT_AVAILABLE', 'Stop the running work before moving its conversation.');
        }
      };
      const unavailable = available(); if (unavailable) return unavailable;
      if (moving) {
        const link=await core;
        const held = await recoveryRetentionReason(home,link,t,checkpointsFor);
        if (held) return refused<never>('NOT_AVAILABLE', held);
        if(t.task)await link.bindProjectTask(patch.projectId!,t.task);
      }
      return withHomeLock(home, async () => {
        // Core inspection cannot hold the home. Preserve any intervening local edit.
        if (threads.get(id) !== t || JSON.stringify(t) !== snapshot) return moving&&t.task?{ok:false,reason:'NOT_AVAILABLE',outcome:'UNKNOWN',detail:'The project binding was recorded but the conversation changed. Inspect it before trying again.'}:refused<never>('NOT_AVAILABLE', 'The conversation changed. Try again.');
        const unavailable = available(); if (unavailable) return unavailable;
        t.summary = { ...t.summary, ...patch };
        if (!t.summary.section) delete t.summary.section;
        await saveThread(t);
        return { ok: true, value: t.summary };
      });
    },
    'threads.delete': async ({ id }) => {
      const thread = threads.get(id);
      if (!thread) return refused<never>('NOT_FOUND', `No thread ${id}.`);
      const snapshot = JSON.stringify(thread);
      const available = (): Receipt<never> | undefined => {
        const stored = readJson<StoredThread | null>(join(home, 'threads', `${id}.json`), null);
        if (thread.summary.running || running.has(id) || stored?.summary.running) return refused<never>('NOT_AVAILABLE', 'Stop the running work before deleting its conversation.');
        if (side.isRunning(id)) return refused<never>('NOT_AVAILABLE', 'Stop the side question or wait for its recovery before deleting this conversation.');
        if (thread.sideTurns.some(turn => turn.sideRecoveryPending)) return refused<never>('NOT_AVAILABLE', 'A side run is still awaiting reconciliation; its recovery identity must be kept.');
        if (parallel.parentRunning(thread)) return refused<never>('NOT_AVAILABLE', 'Its parent has a turn running, which may still ask for this child. Stop it or wait.');
        if (parallel.hasChildren(thread)) return refused<never>('NOT_AVAILABLE', "Delete this conversation's child threads first; their receipts stay reachable through it.");
        if (parallel.hasQueue(thread)) return refused<never>('NOT_AVAILABLE', 'A message is waiting in this conversation. Send or remove it first.');
      };
      const unavailable = available(); if (unavailable) return unavailable;
      const link = await core;
      const held = await recoveryRetentionReason(home, link, thread, checkpointsFor);
      if (held) return refused<never>('NOT_AVAILABLE', held);
      await parallel.revoke(link, thread);
      return withHomeLock(home, async () => {
        // Revocation may remain committed if a concurrent edit prevents deletion.
        if (threads.get(id) !== thread || JSON.stringify(thread) !== snapshot) return refused<never>('NOT_AVAILABLE', 'The conversation changed. Try again.');
        const unavailable = available(); if (unavailable) return unavailable;
        // Deleting a thread removes the conversation; its material stays with the project.
        parallel.forget(thread);
        emit({ topic: 'threads', id });
        return { ok: true, value: { id } };
      });
    },
    'turns.send': async (args) => {
      const stopMark=requestedStop.getStore() ?? (args.threadId?parallel.stopMark(args.threadId):0);
      const admitted=await admit(args,{stopMark});
      admitted.launch?.();
      return admitted.result;
    },
    'turns.stop': async ({ threadId, turnId }) => {
      if (turnId && threads.get(threadId)?.turns.at(-1)?.id !== turnId) return refused('STALE_BASE', 'The conversation moved on. No newer turn was stopped.');
      const c = running.get(threadId);
      const stored = threads.get(threadId);
      const turn = (c&&carriedTurns.get(c))??stored?.turns.findLast(turn=>turn.status==='running');
      if (stored && turn) parallel.stopTurn(stored, turn);
      // It acts at once; the save can wait on a dispatch that holds the lock, and only then is it acknowledged.
      if (stored) parallel.pauseQueue(stored);
      // The board's pool holds with its chat; its running workers are stopped with the other children.
      board.stopped(threadId);
      c?.abort();
      // Stopped now; saved after the identity admission ends, and acknowledged once saved (admission-tail.ts).
      const childrenStopped = parallel.stopChildren(threadId);
      return deferPastAdmission(async (): Promise<Result<'turns.stop'>> => { const children = await childrenStopped;
        if (stored && (turn?.stopRequested || parallel.hasQueue(stored))) await saveThread(stored); return { ok: true, value: { stopped: !!turn || children > 0 } }; }, childrenStopped);
    },
    'sidechat.ask': async (args) => { await sideReady; return side.ask(args); },
    'sidechat.stop': (args) => side.stop(args),
    'material.attach': ({ projectId, name, base64, mediaType, relativePath }) => withHomeLock(home, async () => {
      if (!projects.some((p) => p.id === projectId)) return refused('NOT_FOUND', 'No such project.');
      if (relativePath !== undefined) {
        const result = material.attachSource(projectId, relativePath, mediaType, Buffer.from(base64, 'base64'));
        if (result.ok) emit({ topic: 'material', id: projectId });
        return result;
      }
      const clean = name.split(/[\\/]/).pop() ?? '';
      if (!clean || isIntermediate(clean)) return refused('INVALID', 'That file name cannot be attached.');
      const finalName = material.freeName(projectId, clean);
      const entry = material.create(projectId, finalName, mediaType, Buffer.from(base64, 'base64'), 'original', 'person');
      emit({ topic: 'material', id: projectId });
      return { ok: true, value: entry };
    }),
    'material.save': createMaterialSave({ home, core, material, threads, changed: id => emit({ topic: 'material', id }) }),
    'material.lifecycle': ({ id, version, state, lifecycle }) => withHomeLock(home, async () => {
      const changed = (entry: MaterialEntry) => { emit({ topic: 'material', id: entry.projectId }); return { ok: true as const, value: entry }; };
      const entry = material.load(id);
      if (!entry) return refused('NOT_FOUND', `No material ${id}.`);
      if (entry.recovery && state !== 'retired') return refused('INVALID', 'This is an unimported recovery copy, not an authorised output. You can inspect or retire it.');
      if (entry.current !== version) return refused('STALE_BASE', `${entry.name} is at v${entry.current}; you saw v${version}. Nothing changed.`);
      if ((state === 'withdrawn' || entry.held || entry.lifecycle) && lifecycle !== (entry.lifecycle ?? 0)) return refused('STALE_BASE', `${entry.name} changed since you saw it. Nothing changed.`);
      if (entry.held && state === 'retired' && hasOpenWork(inProject(entry.projectId), entry, hasDraft)) return refused('INVALID', `${entry.name} has a person's work or unfinished work behind it; release it or leave it held.`);
      if (entry.held && state !== 'withdrawn') return changed(material.mark(id, { hidden: state === 'retired', held: undefined, ...(state === 'kept' ? { kept: true } : {}) }));
      if (isWithdrawn(entry)) {
        if (state === 'current') return changed(material.restore(id));
        if (state === 'withdrawn') memory.purgeSource(id); // Finish pending cleanup before acknowledging a retry.
        return state === 'withdrawn' ? { ok: true, value: entry } : refused('INVALID', `${entry.name} is withdrawn; restore it first.`);
      }
      if (state === 'withdrawn') {
        // Retire's guard keeps a person's work in view and stays; this is the person ending access, which
        // nothing unresolved may delay. It hides no unresolved work: that view is read from the threads.
        if (entry.class !== 'original') return refused('INVALID', `Only an attached original can be withdrawn; ${entry.name} is not one.`);
        const out = material.withdraw(id);
        side.sourceWithdrawn(entry.projectId, id); // Stop affected side reads now; no external runtime or Core settlement is awaited.
        memory.purgeSource(id); // Under this same lock: every memory made with it leaves now, not when memory is next read.
        return changed(out);
      }
      if (state === 'current') return changed(material.mark(id, { hidden: false }));
      if (state === 'kept') return changed(material.mark(id, { hidden: false, kept: true, unsure: undefined, folderConflict: undefined }));
      if (!nowIn(entry.projectId).temporary.some((d) => d.id === id)) return refused('INVALID', `${entry.name} has a person's work or unfinished work behind it; it stays.`);
      return changed(material.mark(id, { hidden: true }));
    }),
    'drafts.put': (args) => withHomeLock(home, async (lost) => {
      const path = draftPath(args.key);
      const prior = decodeDraft(readJson<unknown>(path, null), args.key);
      const next = transitionDraft(prior, args, now());
      if (next.state === 'stale') return refused('STALE_BASE', 'This draft changed since it was read. Your unsaved text is still here; review the saved draft before trying again.');
      if (next.state === 'conflict') return refused('INVALID', 'This draft operation is invalid or its identity was used for different contents.');
      if (!next.replay) { if (lost.aborted) throw new Error('Draft lock was lost'); writeJson(path, next.record); }
      return {ok:true, value:publicDraft(next.record)};
    }),
    'terminal.run': ({ projectId, command }) =>
      new Promise((resolve) => {
        if (!projects.some((p) => p.id === projectId)) return resolve(refused('NOT_FOUND', 'No such project.'));
        execFile('/bin/sh', ['-c', command], { cwd: projectDir(projectId), timeout: 30_000, encoding: 'utf8', env: withoutSecrets(process.env) }, (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
          resolve({ ok: true, value: { command, output: stdout + stderr, code } });
          emit({ topic: 'material', id: projectId });
        });
      }),
    'solutions.run': async ({ projectId, threadId, text, attachments = [], task, settings, clientKey }) => {
      // Stop's generation is taken before anything waits, as turns.send does: a Stop meanwhile starts nothing.
      const stopMark = requestedStop.getStore() ?? (threadId ? parallel.stopMark(threadId) : 0), replay = () => replayOf(threads.values(), threadId, clientKey, projectId);
      // A key already used is answered with its turn at every exit, never a new choice, even one admitted meanwhile.
      if (replay()) return replay()!;
      const { selection, local, configured } = await selectFor(task);
      const none = (detail: string): Result<'solutions.run'> => replay() ?? { ok: true, value: { selection, started: null, detail } };
      const choice = selection.choice;
      if (!choice) return none(selection.limitation ?? 'No route can do this task here.');
      // A route runs on its engine: Codex on the Codex harness, a model route or local model on Pi. This home runs one.
      const needs = choice.route.kind === 'agent-engine' ? 'harness-acp' : choice.route.kind === 'native-engine' ? 'harness-codex' : choice.route.kind === 'code-only' ? null : 'harness-pi';
      if (needs !== harnessId) return none(needs ? `The best route here is ${choice.route.label}, which runs on ${needs === 'harness-codex' ? 'the Codex engine' : 'Pi'}; this home runs ${harnessLabel()}. Choose that engine to run it, or a route this engine has.` : `The best route is ${choice.route.label}, a maintained tool; running tools directly is not built yet.`);
      const pin = pinFor(choice.route, choice.reasons, task, local, configured); // pinned on the turn as it is admitted: that route runs, never the configured default
      if ('refused' in pin) return none(pin.refused);
      let launch: (() => void) | undefined;
      const recorded = { ...pin.selection, options: selection };
      const moved=pinnedRoute(pin.selection,routes.resolve());
      if('refused'in moved)return none(moved.refused);
      const admitted=await admit({projectId,threadId,text,attachments,settings,clientKey},{stopMark,selection:recorded,validate:()=>{const current=pinnedRoute(pin.selection,routes.resolve());return 'refused'in current?current.refused:undefined;}});
      const sent=admitted.result;launch=admitted.launch;
      launch?.();
      if (!sent.ok) return replay() ?? sent;
      const started = threads.get(sent.value.threadId)?.turns.find((t) => t.id === sent.value.turnId)?.selection;
      if (started?.options !== selection) return replay()!;
      return { ok: true, value: { selection, started: { threadId: sent.value.threadId, turnId: sent.value.turnId }, detail: `Started on ${choice.route.label} (${started.pinned.label}): ${started.reasons.join('; ')}.` } };
    },
    'settings.engine.put': ({ engine }) => setEngine(home, engine, () => emit({ topic: 'settings' })),
    'settings.model.put': async ({ change }) => {
      try {
        const value: ModelSettings = { ...(await routes.change(change)), harness: engine?.label ?? harnessLabel() };
        emit({ topic: 'settings' });
        return { ok: true, value };
      } catch (err) {
        return refused('INVALID', err instanceof Error ? err.message : 'That change could not be made.');
      }
    },
    'viewer.put': ({ prefs }) => {
      writeJson(join(home, 'viewer.json'), prefs);
      return prefs;
    },
    'tools.list': () => (tools ? tools.list() : { available: false, tools: [], offer: null }),
    'tools.disconnect': async (a) => (tools ? toolsChanged(await tools.disconnect(a)) : noTools),
    'triage.get': () => triageView(),
    'triage.connect': async () => {
      try {
        await triage.connect();
        return { ok: true, value: await triageView() };
      } catch (error) {
        return triageRefused(error);
      }
    },
    'triage.run': async () => {
      if (!triage.stored.connection) return refused('NOT_AVAILABLE', 'Connect the mailbox first.');
      if (!engine) return refused('NOT_AVAILABLE', 'The job needs the app\'s engine and a model; set one up in Settings.');
      void triage.run('person').catch(() => {});
      return { ok: true, value: await triageView() };
    },
    'triage.stop': () => ({ ok: true, value: { stopped: triage.stop() } }),
    'triage.undo': async ({ effect }) => {
      try {
        const row = await triage.undo(effect);
        const item = (await triageView()).brief.proposed.find((p) => p.effect === row.id);
        return item ? { ok: true, value: item } : refused('NOT_FOUND', 'No undo receipt.');
      } catch (error) { return triageRefused(error); }
    },
    'triage.decide': async ({ effect, verdict }) => {
      try {
        await triage.decide(effect, verdict);
        const item = [...(await triageView()).brief.proposed].find((p) => p.effect === effect);
        return item ? { ok: true, value: item } : refused('NOT_FOUND', 'No such proposal.');
      } catch (error) {
        return triageRefused(error);
      }
    },
    'connectors.resolveRead': (args) => sourceReads.resolveRead(args),
    'connectors.refresh': ({ serverId }) => connectors.refresh(serverId),
    // Over the api only what takes authority away: turning off, closing a door, discarding. Opening a
    // door, enabling and releasing a call are the person's, in the app's main process.
    'connectors.set': (args) => setConnectorFromApi(connectors, args),
    'connectors.decide': async ({ effect, argsHash, verdict }) => {
      if (verdict === 'release') return refused('NOT_AVAILABLE', 'Only the person releases a call, in the desktop app, where it shows them the exact statement.');
      try { await core; } catch (error) { return refused('NOT_AVAILABLE', (error as Error).message); }
      return connectors.decide(effect, argsHash, verdict);
    },
    'triage.disconnect': async () => {
      try {
        await triage.disconnect();
        return { ok: true, value: await triageView() };
      } catch (error) {
        return triageRefused(error);
      }
    },
  };

  function connectorView<T>(read: () => T): T {
    if (closing) throw new Error(CLOSING);
    return read();
  }
  async function dispatch<M extends Method>(method:M,args:Args<M>):Promise<Result<M>> {
      if (method !== 'host.status' && method !== 'settings.policy.get') admission.check();
      if (closing && method !== 'host.status') throw new Error(CLOSING); // before argument lookup, home ownership or Core
      if (importing) throw new Error('An import holds this home: no other call runs until it ends.');
      const h = handlers[method] as ((a: unknown) => unknown) | undefined;
      if (!h) throw new Error(`Unknown api method ${String(method)}`);
      if (!READS.has(method) && method !== 'memory.get' && method !== 'host.status') usedFor ??= method;
      inFlight++;
      // dispatch is reached only after identity and resource authorization.
      const endStop=method==='turns.stop'?stoppingRequests.begin((args as Args<'turns.stop'>).threadId):undefined;let deferred=false;
      try {
        // Whether this host owns its home is answered without it: on a home held elsewhere every other call fails with why.
        if (method !== 'host.status' && method !== 'settings.policy.get') { await core; await admission.ready(); }
        if (closing && method !== 'host.status') throw new Error(CLOSING);
        if (readOnly && !READS.has(method)) return refused('NOT_AVAILABLE', READ_ONLY) as Result<typeof method>;
        const rewindHold = !READS.has(method) && !rewindControl(method, args) && rewindWriteHold(threads.values(), method, args);
        if (rewindHold) return refused('NOT_AVAILABLE', rewindHold) as Result<typeof method>;
        const result = await h(args); deferred = afterDeferred(result, () => { endStop?.(); inFlight--; }); // in flight and stopping until saved
        return result as Result<typeof method>;
      } finally {
        if (!deferred) { endStop?.(); inFlight--; }
      }
  }
  const host: Host = {
    unknownChecks: createUnknownChecks({ home, threads, journal, admit: (id, work) => identity.admitDeviceThread(id, work),
      ready: async () => {
        const link = await core;
        const { rows } = await link.read<{ name: string }>(link.person(), 'SELECT name FROM app.principals WHERE id = $1', [link.id.person]);
        return { person: link.id.person, name: rows[0]?.name };
      },
      unavailable: () => closing || readOnly || importing,
      held: () => connectors.list().held, save: saveThread,
      reconciled: (thread, turn, effect) => connectors.reconciledTurnEffect(thread, turn, effect),
      enter: checking => { if (checking) usedFor ??= 'person unknown inspection'; inFlight++; return () => { inFlight--; }; },
      checked: thread => board.checked(thread), recorded: options.unknownCheckRecorded,
    }),
    ...connectorPerson({ connectors, owner, core,
      unavailable: () => closing ? CLOSING : readOnly ? READ_ONLY : importing ? 'An import holds this home; connector decisions are closed.' : undefined,
      enter: () => { usedFor ??= 'person connector decision'; inFlight++; return () => { inFlight--; }; },
    }),
    connectorToolsEnableView: (serverId) => connectorView(() => enabling.toolsView(serverId)),
    enableConnectorTools: async (serverId, tools, stamp) => closing || readOnly ? refused('NOT_AVAILABLE', closing ? CLOSING : READ_ONLY) : enabling.enableTools(serverId, tools, stamp),
    connectorEnableView: (serverId, tool) => connectorView(() => enabling.view(serverId, tool)),
    async enableConnector(serverId, tool, stamp) {
      return closing || readOnly ? refused('NOT_AVAILABLE', closing ? CLOSING : READ_ONLY)
        : enabling.enable(serverId, tool, stamp);
    },
    connectorDoorSeal(serverId) {
      return connectorView(() => connectors.doorSeal(serverId));
    },
    connectorDoorView: (serverId) => connectorView(() => connectors.doorView(serverId)),
    connectorToolView: (serverId, tool) => connectorView(() => connectors.toolView(serverId, tool)),
    async importExport(from) {
      // Only on a host opened for the import (backbone restore, into a new home it holds alone): one used
      // for anything else, or with a call in flight, is refused; while it runs, every other call is.
      if (importing || closing) throw new BackupRefused('NOT_AVAILABLE', closing ? CLOSING : 'An import is already running in this home.');
      if (usedFor) throw new BackupRefused('INVALID', `This home's host was used for something else (${usedFor}) before the import. Import with backbone restore, into a new home.`);
      if (inFlight) throw new BackupRefused('INVALID', 'A call is in flight on this home, so the import did not start. Import with backbone restore, into a new home.');
      importing = true;
      try {
        await core;
        if (readOnly) throw new BackupRefused('NOT_AVAILABLE', READ_ONLY);
        return await withHomeLock(home, (lost) => importHome({ from, home, signal: lost, api: {
          call: (method, args) => (handlers[method] as (a: unknown) => unknown)(args) as never,
          addDocument: importDocument,
          proposeSkill: memory.proposeImported,
          importMemory: memory.importText,
          hasSkills: () => {
            const root = join(home, 'skills');
            if (!existsSync(root)) return false;
            // A skill, or any folder of them (.proposed, .archive, .edits): their record files aside.
            return readdirSync(root, { withFileTypes: true }).some((e) => (!e.name.startsWith('.') ? true : e.isDirectory() && e.name !== '.lock' && readdirSync(join(root, e.name)).length > 0));
          },
        } }));
      } finally {
        importing = false; withdrawalDelivery?.request();
      }
    },
    async connectTool(request) {
      if (closing) return refused('NOT_AVAILABLE', CLOSING); await core; // refused before an opening core is waited on, and after
      if (closing || readOnly) return refused('NOT_AVAILABLE', closing ? CLOSING : READ_ONLY);
      return tools ? toolsChanged(await tools.connect(request)) : noTools;
    },
    triage,
    async signCapability(request) {
      if (closing) return refused('NOT_AVAILABLE', CLOSING); await core; // refused before an opening core is waited on, and after
      if (closing || readOnly) return refused('NOT_AVAILABLE', closing ? CLOSING : READ_ONLY); // a dialog answered after close signs nothing
      try {
        await triage.sign(request);
      } catch (error) {
        return triageRefused(error);
      }
      // Signing starts the function: the job runs at once under the new grant.
      if (!closing) void triage.run('person').catch(() => {});
      const capability = (await triageView()).capability;
      return capability ? { ok: true, value: capability } : refused('NOT_AVAILABLE', 'Nothing was signed.');
    },
    ...deviceRecoveryControls({core:()=>core,ready:()=>admission.ready(),writable:()=>!readOnly&&!closing,inflight}),
    call: (method,args) => request(undefined,method,args),
    callAuthenticated: (session,method,args) => request(session,method,args),
    acceptInvitation: identity.acceptInvitation,
    signOut: identity.signOut,
    onAuthenticated: identity.onAuthenticated,
    beginCompanySignIn: identity.beginCompanySignIn,
    completeCompanySignIn: identity.completeCompanySignIn,
    directoryRequest: identity.directoryRequest,
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async resumeInterrupted() {
      if (closing) return 0; await admission.ready(); const link = await core;
      if (readOnly || closing) return 0;
      recoveryRetries.enable();
      const turns = interrupted.splice(0);
      for (const { thread, turn } of turns) {
        await stoppingRequests.wait(thread.summary.id);
        if(stoppingRequests.has(thread.summary.id))continue;
        try { await identity.resumeAsActor(thread,async()=>{ resume(link,thread,turn); }); }
        catch { /* Retain the interrupted receipt; revoked work starts no replacement run. */ }
      }
      // Sending can call a model, so a message left waiting goes here and never at opening.
      await parallel.drainAll();
      // The board's workers can call a model too: they start here, never at opening.
      await board.resume();
      // So can a goal run's next turn.
      goalRuns.resume();
      return turns.length;
    },
    close() {
      if (closing) return;
      closing = true;
      void admission.close().catch(() => {});
      side.close();
      clearInterval(sweeper);
      proactivity.close();
      triggers.close();
      board.close();
      for (const c of running.values()) c.abort();
      for (const t of judging) t.stop();
      triage.close();
      void connectors.close();
      listeners.clear();
      // The doors stop first, so no door's call runs on a link being closed.
      // Admission drains first (it refuses once closing, and starts nothing once close has begun); then a
      // final pass aborts and waits for every worker, so none runs past the core's close.
      const admissions = Promise.allSettled([host.unknownChecks.whenIdle(), sourceReads.close(), withdrawalDelivery?.close(), recoveryRetries.close(), doors?.then((d) => d.close()), triage.whenIdle(), proactivity.whenIdle(), side.whenIdle()]);
      const workers = admissions.then(async () => {
        await Promise.allSettled([...activeRequests]);
        for (const c of running.values()) c.abort();
        while (inflight.size) await Promise.allSettled([...inflight]);
        await closeHarness(engine);
      });
      CoreLink.closeWhenOpen(home, workers.then(() => core));
      // The home goes last, once nothing of this host can touch it. A refused host holds nothing.
      const released = owner.then(async (release) => { try { await CoreLink.whenClosed(home); } finally { await release(); } }, () => {});
      trackHomeRelease(home, released);
    },
  };
  return host;
}
/** Resolves once this process's host of the home has stopped its server. */
export const hostClosed = async (home: string) => {
  const results = await Promise.allSettled([CoreLink.whenClosed(home), homeRelease(home)]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
};
/**
 * Remove a disposable home after all owners and independent scopes have stopped. Drain this
 * process's Host/Core, stop its leftover server, then remove it; a local close is no global proof.
 */
export async function removeDataHome(home: string): Promise<void> {
  await waitToRemoveHome(home,()=>hostClosed(home));
  await stopPersonalDatabaseAt(join(home, 'pg'));
  releaseSnapshots(home);
  Vault.forget(home);
  await removeHarnessState(home);
  // Retried: a late lock or write landing while the folder is removed otherwise leaves it behind.
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
export { HomeOwned } from './home-owner.ts';
export { canonicalHome } from '../doors/protocol.ts';
export { claudeCheck, codexCheck, postgresCheck, pnpmCheck, sharedMemoryCheck, type MachineCheck } from './doctor.ts';
export type { ThreadSummary };
