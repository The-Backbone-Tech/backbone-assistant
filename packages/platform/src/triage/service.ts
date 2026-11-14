import { triagePolicyFor } from './policy.ts';
// The mail triage job: a named job ("mail-triage") with two triggers, new mail and a schedule, run
// through the harness, every act through the core's gateway with a receipt. For each request it
// reads the message, asks the engine for a triage note, drafts a reply as working material, and
// proposes a label or a move. The person forms it once (capability.ts); before that it only reads.
//
// Who decides what: the model writes a note; this file's code turns the note into effects, from
// closed lists only (note.ts); the connector classifies each effect from the effect itself; the
// core routes, refuses, holds and records every one. A reply goes to the requester the message
// itself names, a label or move waits for the person's one click, and writes to the mailbox stay
// gated: an accepted proposal waits, unapplied, until the door's conformance is accepted.
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { MaterialEntry } from '../api.ts';
import type { HarnessV1, ModelRoute, ToolHost } from '../ports/harness.ts';
import type { ClassifiedOperation, MailConnector, MailLabel, MailMessage, MailRequest, MailSummary, TriageTask } from '../ports/mail.ts';
import { withHomeLock } from '../composition/home-lock.ts';
import { CoreLink, CoreRefusal, type RunHandle } from '../composition/core.ts';
import { readJson, sha256, writeJson } from '../stub/fsx.ts';
import type { MaterialStore } from '../stub/material.ts';
import { type Axis, type CapabilityPayload, type CapabilityRecord, ceilingOf, JOB_CLASSES, offerFor, operationsOf, type Pin, widenings } from './capability.ts';
import { beginItem, draftNameConflict, loadItems, retainDraft, sameMailbox, saveItem, unsettledDraft } from './items.ts';
import { loadRuns, saveRun } from './runs.ts';
import { reconcileMailboxUnknowns } from './recovery.ts';
import { undoWords } from './words.ts';
import { mailboxAnchor, rememberMailbox } from './mailboxes.ts';
import {bindMailboxProject,prepareMailboxProject} from './identity-project.ts';
import { readEffects, uncertainMail } from './receipts.ts';
import { writeEntitled } from './entitlement.ts';
import { addressesIn, headerAddresses, messageFile, NOTE_FILE, parseNote, requestText, rfc822, type TriageNote } from './note.ts';

export const JOB = 'mail-triage';
const RUN_LEASE_MS = 6_000;
const DAY = 86_400_000;
const CONNECTION_DAYS = 30;
/** The core refusals that mean the job's authority is gone: the run stops. */
const GONE = new Set(['revoked', 'not_in_run', 'stale', 'not_claimable', 'denied']);
/** Refusals of an effect the capability names: a breach the door records, which suspends the capability. */
const BREACH = new Set(['outside_piece', 'above_piece_ceiling', 'no_carrier', 'piece_unregistered']);

export interface Connection {
  provider: string;
  account: string;
  label: string;
  connectedAt: string;
  registration: { id: string; piece: string; version: string; digest: string };
  agent: string;
  task: string;
  projectId: string;
  /** The read-only grant connecting gives (safe without configuration): reads, nothing else. */
  mandate: string;
  intentHash?: string;
  entitled: boolean;
  detail: string;
}

export interface Item {
  mailbox?: { provider: string; account: string; registration: string };
  id: string;
  version: string;
  from: { name: string; address: string };
  subject: string;
  date: string;
  run?: string;
  /** Monotonic run-admission order, independent of wall-clock corrections. */
  order?: number;
  revision?: number;
  read?: string;
  note?: TriageNote;
  noteError?: string;
  draft?: { effect: string; document: string; name: string };
  proposal?: { effect: string; operation: string; summary: string; recovery: string | null; undo: string | null; undoRequest?: MailRequest | null; binding?: { provider: string; account: string; registration: string }; undoEffect?: string };
  needsYou?: string;
  startedAt?: string;
  endedAt?: string;
  done: boolean;
}

export interface RunRecord {
  run: string;
  order?: number;
  trigger: 'new-mail' | 'schedule' | 'person';
  capability: string | null;
  startedAt: string;
  endedAt?: string;
  outcome?: 'done' | 'stopped' | 'revoked' | 'suspended' | 'refused' | 'failed';
  reason?: string;
  handled: number;
  modelTurns: number;
}

export interface Stored {
  connection: Connection | null;
  disconnecting?: boolean;
  connecting?: boolean;
  /** Task history survives detaching or replacing a connection. */
  tasks?: string[];
  wakePending?: boolean;
  /** Owner Stop persists even if the process dies before the run can close. */
  stoppedByPerson?: boolean;
  capabilities: CapabilityRecord[];
  /** A widening someone proposed (never the renderer): what the next signature would sign. */
  pending: CapabilityPayload | null;
  /** A fresh capability as first offered, kept so what is shown stays what is signed. */
  offered?: CapabilityPayload | null;
  items: Record<string, Item>;
  restorations?: Record<string, Item>;
  bindings?: Record<string, { provider: string; account: string; registration: string }>;
  runs: RunRecord[];
}

/** What the job needs from the host: the core, the material store, the engine and its route, the connector. */
export interface TriageDeps {
  home: string;
  link: () => Promise<CoreLink>;
  material: MaterialStore;
  /** The project drafts live in, made once by the host. */
  project(name: string): string | Promise<string>;
  engine(): HarnessV1 | undefined;
  nativeAccountTurn?(project:string):Promise<{nativeAccountTools:boolean;release():Promise<void>}>;
  route(): ModelRoute | null;
  credential(handle: string): Promise<string>;
  /** The engine's own pin (its registration), or null when the host has none. */
  tool(): Pin | null;
  /**
   * The mail module: its connector, its task, its piece as checked on disk and its registration.
   * With `register`, the person registers the piece first (their Connect); otherwise it must
   * already stand, and a module whose files changed is refused.
   */
  mail(options?: { register?: boolean }): Promise<{ connector: MailConnector; task: TriageTask; piece: Pin; registration: { id: string; piece: string; version: string; digest: string } }>;
  emit(): void;
  writeDelayMs?: number;
}

export class TriageRefused extends Error {}

interface AuthorityFence { generation: number; revision?: number; capabilities?: CapabilityRecord[]; connection?: Connection | null; connecting?: boolean; disconnecting?: boolean; revocations?: Record<string, { requestedAt: string; reason: string }> }

const now = () => new Date().toISOString();
const uuidOf = (seed: string) => createHash('sha256').update(seed).digest('hex').replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/, '$1-$2-4$3-8$4-$5');
const fmt = (a: { name: string; address: string }) => (a.name ? `${a.name} <${a.address}>` : a.address);
const fileName = (s: string) => s.replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

export interface EffectRow {
  id: string;
  status: string;
  route_reason: string | null;
  args: Record<string, unknown>;
  args_hash: string;
  decision_id: string | null;
  operation: string;
  mandate_id: string | null;
  expected_version: string | null;
  note?: string | null;
}

export class TriageService {
  private readonly deps: TriageDeps; private readonly policy: ReturnType<typeof triagePolicyFor>;
  private readonly path: string;
  private state: Stored;
  private running: Promise<RunRecord> | null = null;
  private controller: AbortController | null = null;
  private unwatch: (() => void) | null = null;
  /** Why the job's authority ended while a run was in flight: recorded as that run's outcome. */
  private ending: { outcome: 'revoked' | 'suspended' | 'stopped'; reason: string } | null = null;
  private schedule: NodeJS.Timeout | undefined;
  private wake: NodeJS.Timeout | undefined;
  private changingAuthority = false;
  private authorityEpoch = 0;
  private authorityDepth = 0;
  private authorityRevision = -1;
  private runGeneration: number | null = null;
  private ownedRuns = new Set<RunRecord>();
  private ownedItems = new Set<Item>();
  private dispatchEpoch = 0;
  private grantChanges = new Set<Promise<unknown>>();
  private closed = false;
  private listening = false;
  private recovery: Promise<void> | null = null;
  private probing: Promise<void> | null = null;

  constructor(deps: TriageDeps) {
    this.deps = deps; this.policy = triagePolicyFor(deps.home);
    this.path = join(deps.home, 'triage', 'state.json');
    this.state = readJson<Stored>(this.path, { connection: null, capabilities: [], pending: null, items: {}, runs: [] });
    this.hydrateAuthority();
    this.current();
    this.state.runs = loadRuns(deps.home, this.state.runs, []);
    Object.assign(this.state, loadItems(deps.home, this.state, this.state));
  }
  private save() {
    if (this.authorityDepth) {
      const fence = this.authorityFence();
      this.authorityRevision = (fence.revision ?? 0) + 1;
      writeJson(join(this.deps.home, 'triage', 'authority', 'fence.json'), { ...fence, revision: this.authorityRevision, capabilities: this.state.capabilities, connection: this.state.connection, connecting: !!this.state.connecting, disconnecting: !!this.state.disconnecting });
    } else this.hydrateAuthority();
    const disk = readJson<Stored>(this.path, this.state);
    this.state.bindings = { ...disk.bindings, ...this.state.bindings };
    this.state.tasks = [...new Set([...(disk.tasks ?? []), ...(this.state.tasks ?? []), ...(this.state.connection ? [this.state.connection.task] : [])])];
    for (const run of this.ownedRuns) { saveRun(this.deps.home, run); if (run.endedAt) this.ownedRuns.delete(run); }
    this.state.runs = loadRuns(this.deps.home, this.state.runs, disk.runs, this.ownedRuns);
    for (const item of this.ownedItems) saveItem(this.deps.home, item);
    Object.assign(this.state, loadItems(this.deps.home, this.state, disk, this.ownedItems));
    writeJson(this.path, this.state);
    this.deps.emit();
  }

  get stored(): Readonly<Stored> {
    this.current();
    this.state.stoppedByPerson = this.stoppedByPerson();
    Object.assign(this.state, loadItems(this.deps.home, this.state, readJson<Stored>(this.path, this.state), this.ownedItems));
    this.state.runs = loadRuns(this.deps.home, this.state.runs, readJson<Stored>(this.path, this.state).runs, this.ownedRuns);
    return this.state;
  }

  isRunning(): boolean {
    return !!this.running;
  }

  /** Resolves once no run is in flight (the host waits for it before closing its link). */
  async whenIdle(): Promise<void> {
    do {
      await this.recovery;
      await this.probing;
      await this.running?.catch(() => {});
      if (this.wake) await new Promise((r) => setTimeout(r, 10));
    } while (this.recovery || this.probing || this.running || this.wake);
  }

  // ---- Connecting: reads only -------------------------------------------------------------

  /**
   * The person connects the mailbox. Their Connect registers the mail module as it is on disk; then
   * the entitlement check runs and fails closed: nothing is read or granted. Otherwise the person
   * classifies the module's reads in the workspace's catalogue (as the connector classifies them),
   * and grants a worker of theirs a read-only mandate bound to the module: safe without configuration.
   */
  async connect(): Promise<Connection> {
    if (this.state.connecting || this.state.disconnecting || this.current()?.endPending) throw new TriageRefused('Authority termination or connection is pending.');
    const epoch = this.authorityEpoch, was = this.state.connection, generation = this.authorityGeneration();
    return this.trackGrant(() => this.withAuthority(generation, async () => {
      this.checkSharedAuthority(was);
      const check = () => { if (epoch !== this.authorityEpoch || this.state.disconnecting) throw new TriageRefused('The connection changed or was disconnected during formation.'); };
      check();
      const { connector, registration } = await this.deps.mail({ register: true });
      const entitlement = await connector.entitlement().catch((e: unknown) => ({ ok: false, detail: `The entitlement check could not run (${String(e)}); nothing was read.` }));
      if (!entitlement.ok) throw new TriageRefused(entitlement.detail);
      const link = await this.deps.link();
      check();
      if (was && (was.account !== connector.account || was.provider !== connector.provider)) throw new TriageRefused('Disconnect the previous mailbox before replacing it.');
      if (was && (await this.mandateStands(link, was.mandate))) { check(); await bindMailboxProject(link,was.projectId,was.task); check(); return was; }
      const me = link.person(), reads = ['mail.list', 'mail.read', 'mail.labels'];
      await link.call(me, 'SELECT * FROM gov.classify_operations($1::jsonb)', [JSON.stringify([
        ...reads.map((operation) => ({ operation, class: 1, external: true, description: 'A read of the connected mailbox, classified by its connector.' })),
        ...['mail.label', 'mail.move'].map((operation) => ({ operation, class: 3, external: true, undo: operation, description: 'A version-bound mailbox change with a confirmed inverse.' })),
      ])]);
      const prior = was ?? mailboxAnchor(this.deps.home, link.id.workspace, connector);
      const agent = prior?.agent ?? await link.call<string>(me, 'SELECT gov.create_agent($1, $2)', ['Mail triage', 'worker']);
      const {task,projectId}=await prepareMailboxProject(link,prior,`Mail triage (${connector.provider}: ${connector.account})`,name=>this.deps.project(name));
      const intent = JSON.stringify({ job: JOB, phase: 'before-formation', account: connector.account, formation: randomUUID() });
      const intentHash = await link.call<string>(me, 'SELECT sec.args_hash($1::jsonb)', [intent]);
      check();
      this.bumpAuthorityGeneration();
      const made: Connection = { provider: connector.provider, account: connector.account, label: connector.label, connectedAt: now(), registration, agent, task, projectId, mandate: '', intentHash, entitled: true, detail: entitlement.detail };
      rememberMailbox(this.deps.home, link.id.workspace, made);
      this.state.connection = made;
      this.state.connecting = true;
      this.rememberTask(task);
      this.save();
      try {
        made.mandate = await link.call<string>(me,
          `SELECT gov.issue_mandate($1, NULL, '"*"', '"*"', '"*"', $2::jsonb, 1::smallint, NULL, NULL, NULL, NULL, $3, 'piece', $4::jsonb, $5)`,
          [agent, JSON.stringify(reads), new Date(Date.now() + CONNECTION_DAYS * DAY), intent, registration.id]);
        this.save();
        check();
        delete this.state.connecting;
        this.save();
        this.listen();
        return made;
      } catch (error) {
        this.state.disconnecting = true;
        this.save();
        throw error;
      }
    }));
  }

  /** The new-mail trigger, and the schedule when one is set. */
  listen(scheduleMs?: number) {
    if (this.closed || this.state.connecting || this.state.disconnecting || !this.state.connection || this.unwatch || this.listening) return;
    this.listening = true;
    void this.deps.mail().then(({ connector }) => {
      if (this.closed || this.state.connecting || this.state.disconnecting || !this.state.connection) return;
      this.unwatch = connector.watch(() => this.requestWake());
    }, () => {}).finally(() => { this.listening = false; });
    if (scheduleMs) {
      this.schedule = setInterval(() => void this.run('schedule').catch(() => {}), scheduleMs);
      this.schedule.unref();
    }
  }

  close() {
    this.closed = true;
    this.dispatchEpoch++;
    if (this.running && !this.controller?.signal.aborted) { this.state.wakePending = true; this.save(); }
    this.unwatch?.();
    clearInterval(this.schedule);
    clearTimeout(this.wake);
    this.wake = undefined;
    this.controller?.abort();
  }

  /** The person disconnects: every grant this job holds is revoked; the mailbox is left as it is. */
  async disconnect(): Promise<void> {
    const reason = 'Revoked: the person disconnected the mailbox.';
    this.authorityEpoch++;
    this.state.disconnecting = true;
    if (this.state.connection) writeJson(this.connectionEndingPath(this.state.connection), true);
    if (this.state.connection) this.rememberTask(this.state.connection.task);
    this.ending = { outcome: 'revoked', reason };
    this.stopRun();
    this.save();
    const link = await this.deps.link();
    // Authority ends first, in the core: the run stops and what was not sent is cancelled.
    for (const cap of this.state.capabilities) await this.end(link, cap, 'revoked', reason);
    await Promise.allSettled([...this.grantChanges]);
    // A reply in flight may have supplied a new grant after the first enumeration.
    for (const cap of this.state.capabilities) await this.end(link, cap, 'revoked', reason);
    await this.withAuthority(undefined, async () => {
      this.bumpAuthorityGeneration();
      const conn = this.state.connection;
      if (conn) rememberMailbox(this.deps.home, link.id.workspace, conn);
      const roots = conn?.intentHash ? (await link.read<{ id: string }>(link.person(), 'SELECT id FROM app.mandates WHERE intent_hash = $1', [conn.intentHash])).rows.map((r) => r.id) : [];
      for (const id of new Set([conn?.mandate, ...roots].filter((id): id is string => !!id))) await link.call(link.person(), 'SELECT gov.revoke_mandate($1)', [id]);
    });
    this.controller?.abort();
    await this.running?.catch(() => {});
    this.unwatch?.();
    this.unwatch = null;
    await this.withAuthority(undefined, async () => {
      this.state.connection = null;
      delete this.state.disconnecting; delete this.state.connecting;
      this.save();
    });
  }

  // ---- Formation ---------------------------------------------------------------------------

  current(): CapabilityRecord | null {
    this.hydrateAuthority();
    const c = this.state.capabilities.at(-1) ?? null;
    const terminal = c && this.authorityFence().revocations?.[`${c.payload.id}@${c.payload.version}`];
    if (c && terminal) c.terminalRevocation = terminal;
    if (c) this.applyEnding(c);
    if (c?.terminalRevocation && !c.endPending) c.state = 'revoked';
    if (c && c.state === 'active' && Date.parse((c.effective ?? c.payload).expiresAt) <= Date.now()) c.state = 'expired';
    return c;
  }

  /** The pins as they are now: the engine, the route's model, the adapter on disk and the task. */
  private async pins(): Promise<{ model: { route: string; model: string }; tool: Pin; adapter: Pin; configuration: string } | null> {
    const tool = this.deps.tool();
    const route = this.deps.route();
    if (!tool || !route) return null;
    const { piece, task } = await this.deps.mail();
    return { model: { route: `${route.kind}:${route.provider}`, model: route.model }, tool, adapter: piece, configuration: `sha256:${sha256(JSON.stringify(task))}` };
  }

  /**
   * What the next signature would sign, with its hash as the core computes it: a fresh capability,
   * the same one again after a suspension, a later version when a pin moved, or a widening someone
   * proposed. Null when the active capability already covers everything.
   */
  async offer(): Promise<{ payload: CapabilityPayload; hash: string; widening: Axis[] } | null> {
    const conn = this.state.connection;
    if (!conn) return null;
    const pins = await this.pins();
    if (!pins) return null;
    const link = await this.deps.link();
    const cap = this.current();
    if (this.state.connecting || this.state.disconnecting || cap?.endPending) return null;
    const base = { tenant: link.id.workspace, owner: { id: link.id.person, name: await this.ownerName(link) }, account: conn.account, ...pins };
    let payload: CapabilityPayload;
    if (this.state.pending) payload = this.state.pending;
    else if (!cap || cap.state === 'revoked' || cap.state === 'expired') {
      // The same offer while nothing it pins moved and it has days to run; a new one otherwise.
      const kept = this.state.offered;
      const fresh = offerFor(base);
      const still = kept && kept.scope.account === base.account && kept.tenant === base.tenant && !widenings(kept, { ...kept, pins: fresh.pins }).length
        && Date.parse(kept.expiresAt) - Date.now() > 29 * DAY && !this.state.capabilities.some((c) => c.payload.id === kept.id);
      payload = still ? kept : fresh;
      if (!still) {
        this.state.offered = fresh;
        this.save();
      }
    } else {
      const again = offerFor({ ...base, previous: cap.payload });
      const moved = widenings(cap.payload, { ...cap.payload, pins: again.pins }).length > 0;
      if (cap.state === 'active' && !moved) return null;
      payload = moved ? { ...again, expiresAt: cap.payload.expiresAt, budget: cap.payload.budget } : cap.payload;
    }
    payload = structuredClone(payload);
    const hash = await link.call<string>(link.person(), 'SELECT sec.args_hash($1::jsonb)', [JSON.stringify(payload)]);
    return { payload, hash, widening: cap && cap.state !== 'revoked' && cap.state !== 'expired' ? widenings(cap.payload, payload) : [] };
  }
  private async ownerName(link: CoreLink): Promise<string> {
    const { rows } = await link.read<{ name: string }>(link.person(), 'SELECT name FROM app.principals WHERE id = $1', [link.id.person]);
    return rows[0]?.name ?? 'You';
  }

  /** A widening proposed for the next signature (tests and platform code; never an api method). */
  propose(next: CapabilityPayload) {
    this.state.pending = structuredClone(next);
    this.save();
  }

  /**
   * The owner signs the payload they were shown, named by its hash. Only the app's main process
   * calls this, after its own window and the person's Touch ID or device password: it is not a
   * method of any transport. The core issues the grant only to a person acting outside any run.
   */
  async sign(request: { hash: string; presence: 'touch-id' | 'device-password' }): Promise<CapabilityRecord> {
    if (this.changingAuthority || this.state.connecting || this.state.disconnecting || this.current()?.endPending) throw new TriageRefused('An authority change is pending; finish it before signing.');
    this.changingAuthority = true;
    this.stopRun();
    try {
      await this.whenIdle();
      const epoch = this.authorityEpoch, connection = this.state.connection, generation = this.authorityGeneration();
      return await this.signNow(request, epoch, connection, generation);
    } finally { this.authorityChanged(); }
  }
  private async signNow(request: { hash: string; presence: 'touch-id' | 'device-password' }, epoch: number, connection: Connection | null, generation: number): Promise<CapabilityRecord> {
    const offer = await this.offer();
    if (!offer) throw new TriageRefused('There is nothing to sign: the capability already stands, or the mailbox is not connected.');
    if (offer.hash !== request.hash) throw new TriageRefused('What was shown is not what would be signed now (it changed meanwhile); nothing was signed.');
    const conn = this.state.connection!;
    const link = await this.deps.link();
    const { connector } = await this.deps.mail();
    // Re-signing needs live underlying authority: the connection's grant and the account's entitlement.
    if (!(await this.mandateStands(link, conn.mandate))) throw new TriageRefused('The mailbox connection no longer stands; connect it again first.');
    const entitlement = await connector.entitlement();
    if (!entitlement.ok) throw new TriageRefused(entitlement.detail);
    this.checkAuthority(epoch, connection);
    const cap = this.current();
    const same = cap && cap.payload.id === offer.payload.id && cap.payload.version === offer.payload.version;
    if (same && (cap.state === 'revoked' || cap.terminalRevocation)) throw new TriageRefused('This capability was revoked; nothing revives it. Form a new one.');
    if (Date.parse(offer.payload.expiresAt) <= Date.now()) throw new TriageRefused('This capability has expired; form a new one.');
    const p = offer.payload;
    this.assertModes(p);
    this.assertBudget(p);
    return this.trackGrant(() => this.withAuthority(generation, async () => {
    this.checkSharedAuthority(conn, cap);
    this.checkAuthority(epoch, connection);
    // Terminate the previous version before creating any replacement authority.
    if (cap && !same && cap.state === 'active') await this.end(link, cap, 'revoked', `Superseded by version ${p.version}.`);
    this.checkAuthority(epoch, connection);
    this.bumpAuthorityGeneration();
    const formation = { state: 'suspended' as const, reason: 'Formation verification was interrupted.' };
    const record: CapabilityRecord = same && cap ? cap : { payload: p, hash: offer.hash, mandate: '', mandates: [], signedAt: now(), signedWith: request.presence, state: 'suspended' };
    if (!same) this.state.capabilities.push(record);
    record.endPending = formation;
    record.state = 'suspended';
    this.save();
    const window = this.dailyWindow(p);
    try {
      await this.revokeGrants(link, record);
      const mandate = await link.call<string>(
        link.person(),
        `SELECT gov.issue_mandate($1, NULL, '"*"', '"*"', '"*"', $2::jsonb, $3::smallint, NULL, NULL, NULL, $4, $5, 'piece', $6::jsonb, $7)`,
        [conn.agent, JSON.stringify(operationsOf(p)), ceilingOf(p), Math.max(0, p.budget.effectsPerDay - await this.effectsToday(link, record)), new Date(window.expiresAt), JSON.stringify(p), conn.registration.id],
      );
      record.mandate = mandate;
      record.mandates.push(mandate);
      this.save();
      const recorded = await link.call<string>(link.person(), 'SELECT intent_hash FROM app.mandates WHERE id = $1', [mandate]);
      if (recorded !== offer.hash) {
        await link.call(link.person(), 'SELECT gov.revoke_mandate($1)', [mandate]);
        throw new TriageRefused('The core recorded another payload than the one signed; the grant was revoked at once.');
      }
      this.checkAuthority(epoch, connection);
      if (record.endPending !== formation || this.state.disconnecting) throw new TriageRefused('Authority ended while formation was being verified.');
      record.state = 'active';
      record.window = window;
      record.signedAt = now();
      record.signedWith = request.presence;
      delete record.endPending;
      // A re-signature is explicit approval of the displayed payload; its reset is separate from unsigned renewal.
      delete record.effective;
      delete record.reason;
      this.state.pending = null;
      this.state.offered = null;
      this.save();
      return record;
    } catch (error) {
      await this.end(link, record, record.endPending?.state ?? (this.current()?.state === 'revoked' ? 'revoked' : 'suspended'), record.endPending?.reason ?? 'Formation could not be verified.');
      throw error;
    }
    }));
  }
  private checkAuthority(epoch: number, connection: Connection | null) {
    if (epoch !== this.authorityEpoch || !connection || this.state.connection !== connection || this.state.disconnecting) throw new TriageRefused('The connection or authority changed during formation.');
  }
  private trackGrant<T>(work: () => Promise<T>): Promise<T> {
    const pending = work().finally(() => { this.grantChanges.delete(pending); });
    this.grantChanges.add(pending);
    return pending;
  }

  /** The locked authority journal owns capabilities; run/item snapshots are projections. */
  private hydrateAuthority() {
    if (this.authorityDepth) return;
    const fence = this.authorityFence();
    if (this.authorityRevision === (fence.revision ?? 0)) return;
    this.authorityRevision = fence.revision ?? 0;
    if ('connection' in fence) this.state.connection = fence.connection ?? null;
    if ('connecting' in fence) this.state.connecting = fence.connecting;
    if ('disconnecting' in fence) this.state.disconnecting = fence.disconnecting;
    if (!fence.capabilities) return;
    const local = new Map(this.state.capabilities.map((c) => [`${c.payload.id}@${c.payload.version}`, c]));
    this.state.capabilities = fence.capabilities.map((saved) => {
      const cap = local.get(`${saved.payload.id}@${saved.payload.version}`) ?? saved;
      for (const key of Object.keys(cap)) if (!(key in saved)) delete (cap as unknown as Record<string, unknown>)[key];
      return Object.assign(cap, saved);
    });
  }
  private endingPath(cap: CapabilityRecord, state: 'suspended' | 'revoked') {
    return join(this.deps.home, 'triage', 'authority', 'endings', `${cap.payload.id}-${cap.payload.version}-${state === 'revoked' ? state : cap.mandate || 'formation'}.json`);
  }
  private applyEnding(cap: CapabilityRecord) {
    type Intent = { requestedAt: string; reason: string; confirmed?: boolean };
    const revoked = readJson<Intent | null>(this.endingPath(cap, 'revoked'), null);
    const suspended = readJson<Intent | null>(this.endingPath(cap, 'suspended'), null);
    const intent = revoked ?? suspended;
    if (!intent) return;
    if (revoked) cap.terminalRevocation = revoked;
    cap.state = revoked?.confirmed ? 'revoked' : 'suspended';
    if (intent.confirmed) delete cap.endPending;
    else if (!cap.endPending || (revoked && cap.endPending.state !== 'revoked')) cap.endPending = { state: revoked ? 'revoked' : 'suspended', reason: intent.reason };
    cap.reason = intent.reason;
  }
  private authorityFence(): AuthorityFence {
    return readJson<AuthorityFence>(join(this.deps.home, 'triage', 'authority', 'fence.json'), { generation: 0 });
  }
  private authorityGeneration(): number { return this.authorityFence().generation; }
  private bumpAuthorityGeneration(cap?: CapabilityRecord) {
    const fence = this.authorityFence();
    if (cap?.terminalRevocation) {
      fence.revocations ??= {};
      fence.revocations[`${cap.payload.id}@${cap.payload.version}`] = cap.terminalRevocation;
    }
    writeJson(join(this.deps.home, 'triage', 'authority', 'fence.json'), { ...fence, generation: fence.generation + 1 });
  }

  private stoppedByPerson(): boolean {
    return readJson<{ stopped: boolean }>(join(this.deps.home, 'triage', 'stop.json'), { stopped: !!this.state.stoppedByPerson }).stopped;
  }

  private withAuthority<T>(expected: number | undefined, work: () => Promise<T>): Promise<T> {
    return withHomeLock(join(this.deps.home, 'triage', 'authority'), async () => {
      if (expected !== undefined && expected !== this.authorityGeneration()) throw new TriageRefused('Authority changed in another consumer; reload before continuing.');
      this.hydrateAuthority();
      this.authorityDepth++;
      try { return await work(); } finally { this.authorityDepth--; }
    });
  }

  private connectionEndingPath(conn: Connection) {
    return join(this.deps.home, 'triage', 'authority', 'connection-endings', `${conn.intentHash ?? conn.mandate}.json`);
  }

  private checkSharedAuthority(connection: Connection | null, cap?: CapabilityRecord | null) {
    const disk = readJson<Stored>(this.path, this.state), current = disk.capabilities.at(-1);
    const terminal = current && this.authorityFence().revocations?.[`${current.payload.id}@${current.payload.version}`];
    if (current && terminal) { current.terminalRevocation = terminal; if (!current.endPending) current.state = 'revoked'; }
    if ((connection && readJson<boolean>(this.connectionEndingPath(connection), false)) || disk.disconnecting || disk.connection?.mandate !== connection?.mandate || (cap !== undefined && (cap ? current?.mandate !== cap.mandate || current.state !== cap.state || !!current.terminalRevocation !== !!cap.terminalRevocation || !!current.endPending : !!current))) throw new TriageRefused('Authority changed in another consumer; reload before continuing.');
  }

  private authorityChanged() {
    this.changingAuthority = false;
    if (this.state.wakePending && !this.stoppedByPerson() && this.current()?.state === 'active') this.requestWake(0);
  }

  /** A change without a signature: refused when it widens on any axis; a narrowing replaces the live daily grant. */
  async change(next: CapabilityPayload): Promise<CapabilityRecord> {
    next = structuredClone(next);
    if (this.changingAuthority || this.state.disconnecting) throw new TriageRefused('An authority change is already pending.');
    this.changingAuthority = true;
    const epoch = this.authorityEpoch, connection = this.state.connection;
    try { return await this.changeNow(next, epoch, connection); } finally { this.authorityChanged(); }
  }

  private async changeNow(next: CapabilityPayload, epoch: number, connection: Connection | null): Promise<CapabilityRecord> {
    const cap = this.current();
    if (!cap || cap.state !== 'active') throw new TriageRefused('No capability stands to change.');
    this.assertBudget(next);
    const wider = widenings(cap.effective ?? cap.payload, next);
    if (wider.length) throw new TriageRefused(`This widens the capability (${wider.join(', ')}); it needs a new signature.`);
    this.assertModes(next);
    this.stopRun();
    await this.whenIdle();
    if (cap.state !== 'active' || cap.endPending) throw new TriageRefused('The capability no longer stands.');
    const link = await this.deps.link();
    this.checkAuthority(epoch, connection);
    return this.rotateWindow(link, cap, next, epoch, connection!);
  }

  private assertModes(p: CapabilityPayload) {
    if (p.classes.some((c) => !JOB_CLASSES.some((known) => known.operation === c.operation && known.effectClass === c.effectClass))) throw new TriageRefused('The declared operation class does not match the job’s classification.');
    if (p.classes.some((c) => !['act', 'propose'].includes(c.mode) || (c.mode === 'propose' && (c.effectClass <= ceilingOf(p) || ['mail.list', 'mail.read', 'mail.labels', 'workspace.write_document'].includes(c.operation))))) throw new TriageRefused('This per-operation checker mode cannot be represented by the job’s grant. Remove the operation or stop the job instead.');
  }

  private assertBudget(p: CapabilityPayload) {
    if (!p.budget || p.budget.renewal !== 'daily' || ![p.budget.effectsPerDay, p.budget.modelTurnsPerDay].every((v) => Number.isSafeInteger(v) && v >= 0)) throw new TriageRefused('Daily budgets must be nonnegative finite safe integers.');
  }

  private dailyWindow(p: CapabilityPayload) {
    const day = now().slice(0, 10);
    return { day, expiresAt: new Date(Math.min(Date.parse(`${day}T00:00:00.000Z`) + DAY, Date.parse(p.expiresAt))).toISOString() };
  }

  private async effectsToday(link: CoreLink, cap: CapabilityRecord): Promise<number> {
    const { rows } = await link.read<{ spent: number }>(link.person(), `WITH RECURSIVE grants AS (
      SELECT id FROM app.mandates WHERE intent_hash = ANY($1::text[])
      UNION SELECT m.id FROM app.mandates m JOIN grants g ON m.parent_id = g.id
    ) SELECT count(*)::int AS spent FROM app.effects
      WHERE (mandate_id IN (SELECT id FROM grants) OR task_id = ANY($3::uuid[])) AND created_at >= $2::timestamptz
        AND status NOT IN ('denied', 'cancelled')`, [[...new Set([...this.state.capabilities.map((c) => c.hash), cap.hash])], `${now().slice(0, 10)}T00:00:00.000Z`, [...new Set([...(this.state.tasks ?? []), ...(this.state.connection ? [this.state.connection.task] : [])])]]);
    return rows[0]?.spent ?? 0;
  }

  /** Revoke the old window before counting spend: no parallel consumer can enlarge it. */
  private rotateWindow(link: CoreLink, cap: CapabilityRecord, next: CapabilityPayload, epoch: number, connection: Connection): Promise<CapabilityRecord> {
    const generation = this.authorityGeneration();
    return this.trackGrant(() => this.withAuthority(generation, async () => {
      this.checkAuthority(epoch, connection);
      this.checkSharedAuthority(connection, cap);
      this.assertModes(next); this.assertBudget(next);
      if (cap.state !== 'active' || widenings(cap.effective ?? cap.payload, next).length) throw new TriageRefused('This widens changed authority; it needs a new signature.');
      this.bumpAuthorityGeneration();
      const pending = { state: 'suspended' as const, reason: 'Daily authority replacement was interrupted.' };
      cap.endPending = pending;
      cap.state = 'suspended';
      this.save();
      try {
        await this.revokeGrants(link, cap);
        const spent = await this.effectsToday(link, cap);
        this.checkAuthority(epoch, connection);
        if (cap.endPending !== pending || cap.terminalRevocation) throw new TriageRefused('Authority ended during daily renewal.');
        const window = this.dailyWindow(next);
        const mandate = await link.call<string>(link.person(),
          `SELECT gov.issue_mandate($1, NULL, '"*"', '"*"', '"*"', $2::jsonb, $3::smallint, NULL, NULL, NULL, $4, $5, 'piece', $6::jsonb, $7)`,
          [connection.agent, JSON.stringify(operationsOf(next)), ceilingOf(next), Math.max(0, next.budget.effectsPerDay - spent), new Date(window.expiresAt), JSON.stringify(cap.payload), connection.registration.id]);
        cap.mandates.push(mandate);
        cap.mandate = mandate;
        this.save();
        this.checkAuthority(epoch, connection);
        if (cap.endPending !== pending || cap.terminalRevocation) throw new TriageRefused('Authority ended during daily renewal.');
        const hash = await link.call<string>(link.person(), 'SELECT intent_hash FROM app.mandates WHERE id = $1', [mandate]);
        if (hash !== cap.hash) throw new TriageRefused('The daily grant did not preserve the signed payload.');
        this.checkAuthority(epoch, connection);
        if (cap.endPending !== pending || cap.terminalRevocation) throw new TriageRefused('Authority ended during daily renewal.');
        cap.window = window;
        cap.effective = structuredClone(next);
        cap.state = 'active';
        delete cap.endPending;
        delete cap.reason;
        this.save();
        return cap;
      } catch (error) {
        await this.end(link, cap, cap.terminalRevocation ? 'revoked' : 'suspended', 'Daily authority replacement could not be confirmed.');
        throw error;
      }
    }));
  }

  /** An anomaly, breach or corruption suspends the capability: its grant ends now, pending releases are voided. */
  async suspend(reason: string): Promise<void> {
    const cap = this.current();
    if (!cap || cap.state !== 'active') return;
    this.authorityEpoch++;
    this.ending = { outcome: 'suspended', reason };
    this.stopRun();
    await this.end(this.deps.link(), cap, 'suspended', reason);
    await Promise.allSettled([...this.grantChanges]);
    await this.end(this.deps.link(), cap, 'suspended', reason);
    this.controller?.abort();
  }

  /** The person revokes the capability: final. */
  async revoke(reason = 'Revoked by the person.'): Promise<void> {
    const cap = this.current();
    if (!cap || cap.state === 'revoked') return;
    this.authorityEpoch++;
    this.ending = { outcome: 'revoked', reason };
    this.stopRun();
    await this.end(this.deps.link(), cap, 'revoked', reason);
    await Promise.allSettled([...this.grantChanges]);
    await this.end(this.deps.link(), cap, 'revoked', reason);
    this.controller?.abort();
  }

  private async end(pendingLink: CoreLink | Promise<CoreLink>, cap: CapabilityRecord, state: 'suspended' | 'revoked', reason: string) {
    if (state === 'revoked' || cap.state === 'revoked') cap.terminalRevocation ??= { requestedAt: now(), reason };
    const endingPath = this.endingPath(cap, cap.terminalRevocation ? 'revoked' : state);
    const intent = readJson<{ requestedAt: string; reason: string; confirmed?: boolean }>(endingPath, { requestedAt: now(), reason });
    writeJson(endingPath, intent);
    const pending = { state: cap.terminalRevocation ? 'revoked' as const : state, reason: cap.terminalRevocation?.reason ?? reason };
    cap.endPending = pending;
    cap.state = 'suspended';
    cap.reason = `Authority termination pending: ${pending.reason}`;
    this.save();
    const link = await pendingLink;
    await this.withAuthority(undefined, async () => {
    if (state === 'revoked') cap.terminalRevocation ??= { requestedAt: intent.requestedAt, reason };
    cap.endPending = pending; cap.state = 'suspended';
    this.bumpAuthorityGeneration(cap);
    this.save();
    await this.revokeGrants(link, cap);
    writeJson(endingPath, { ...intent, confirmed: true });
    // A later termination owns its own confirmation. An older suspend can neither
    // clear that pending record nor overwrite a completed terminal revocation.
    if (cap.endPending === pending) {
      cap.state = cap.terminalRevocation ? 'revoked' : pending.state;
      cap.reason = cap.terminalRevocation?.reason ?? pending.reason;
      delete cap.endPending;
    } else if (cap.terminalRevocation && !cap.endPending) {
      cap.state = 'revoked';
      cap.reason = cap.terminalRevocation.reason;
    }
    this.save();
    });
  }

  private async revokeGrants(link: CoreLink, cap: CapabilityRecord) {
    // The signed hash also finds a root whose issuance reply was lost.
    const { rows } = await link.read<{ id: string }>(link.person(), 'SELECT id FROM app.mandates WHERE intent_hash = $1', [cap.hash]);
    for (const id of new Set([...cap.mandates, cap.mandate, ...rows.map((r) => r.id)].filter(Boolean))) {
      await link.call(link.person(), 'SELECT gov.revoke_mandate($1)', [id]);
    }
  }

  private async mandateStands(link: CoreLink, mandate: string): Promise<boolean> {
    const { rows } = await link.read<{ ok: boolean }>(link.person(), 'SELECT revoked_at IS NULL AND expires_at > now() AS ok FROM app.mandates WHERE id = $1', [mandate]);
    return !!rows[0]?.ok;
  }

  // ---- The job -----------------------------------------------------------------------------

  /** Run the job once. One run at a time; a trigger while it runs is retained for the next pass. */
  run(trigger: RunRecord['trigger']): Promise<RunRecord> {
    if (this.closed) return Promise.reject(new TriageRefused('This host is closed.'));
    if (this.running) {
      if (trigger !== 'person') { this.state.wakePending = true; this.save(); }
      return this.running;
    }
    if (this.changingAuthority || this.state.disconnecting || (this.stoppedByPerson() && trigger !== 'person')) {
      if (trigger !== 'person' && !this.stoppedByPerson()) { this.state.wakePending = true; this.save(); }
      return Promise.reject(new TriageRefused('The job is stopped or changing authority.'));
    }
    if (trigger === 'person') { writeJson(join(this.deps.home, 'triage', 'stop.json'), { stopped: false }); this.state.stoppedByPerson = false; }
    this.state.wakePending = false;
    this.save();
    clearTimeout(this.wake);
    this.wake = undefined;
    this.ending = null;
    this.runGeneration = this.authorityGeneration();
    this.controller = new AbortController();
    let completed = false;
    this.running = this.carry(trigger, this.controller.signal).then((record) => {
      completed = record.outcome === 'done';
      return record;
    }).finally(() => {
      this.running = null;
      this.controller = null;
      this.runGeneration = null;
      this.ownedItems.clear();
      this.ownedRuns.clear();
      if (completed && this.state.wakePending && !this.closed && !this.state.disconnecting) this.requestWake(0);
    });
    return this.running;
  }

  /** The person's Stop: the model turn stops, nothing new starts, an effect in flight is observed. */
  stop(): boolean {
    writeJson(join(this.deps.home, 'triage', 'stop.json'), { stopped: true });
    this.state.stoppedByPerson = true;
    return this.stopRun();
  }

  private stopRun(): boolean {
    this.dispatchEpoch++;
    const pending = !!this.controller || !!this.wake;
    clearTimeout(this.wake);
    this.wake = undefined;
    this.state.wakePending = false;
    this.save();
    this.controller?.abort();
    return pending;
  }

  private requestWake(delay = 200) {
    if (this.closed || this.state.connecting || this.state.disconnecting || !this.state.connection) return;
    this.state.wakePending = true;
    this.save();
    if (this.running || this.changingAuthority || this.stoppedByPerson()) return;
    clearTimeout(this.wake);
    this.wake = setTimeout(() => {
      this.wake = undefined;
      void this.run('new-mail').catch(() => {});
    }, delay);
    this.wake.unref();
  }

  private rememberTask(task: string) {
    this.state.tasks = [...new Set([...(this.state.tasks ?? []), task])];
  }

  private checkRun(signal: AbortSignal) {
    signal.throwIfAborted();
    const cap = this.current();
    const ending = !!cap && (cap.state !== 'active' || !!cap.endPending);
    const conn = this.state.connection;
    const disconnecting = !!conn && readJson<boolean>(this.connectionEndingPath(conn), false);
    if (ending || disconnecting || this.stoppedByPerson() || (this.runGeneration !== null && this.runGeneration !== this.authorityGeneration())) {
      this.ending = this.stoppedByPerson() ? { outcome: 'stopped', reason: 'Stopped by the person in another consumer.' } : { outcome: 'revoked', reason: 'Authority changed in another consumer.' };
      this.controller?.abort();
      signal.throwIfAborted();
      throw new CoreRefusal('revoked', this.ending.reason);
    }
  }

  private async carry(trigger: RunRecord['trigger'], signal: AbortSignal): Promise<RunRecord> { this.policy.check();
    if (this.changingAuthority || this.state.connecting || this.state.disconnecting || this.current()?.endPending) throw new TriageRefused('Authority termination or change is pending; the job is stopped.');
    const conn = this.state.connection;
    if (!conn) throw new TriageRefused('Connect the mailbox first.');
    const link = await this.deps.link();
    const engine = this.deps.engine();
    const route = this.deps.route();
    if (!engine || !route) throw new TriageRefused('The job needs a model: set one up in Settings.');
    const record: RunRecord = { run: '', trigger, capability: null, startedAt: now(), handled: 0, modelTurns: 0 };
    const refuse = (reason: string) => {
      record.outcome = 'refused';
      record.reason = reason;
      record.endedAt = now();
      this.state.runs.push(record);
      this.save();
      return record;
    };
    let loaded: Awaited<ReturnType<TriageDeps['mail']>>;
    try {
      loaded = await this.deps.mail();
    } catch (error) {
      // The module's files are not the registered content (tampered, or an update nobody accepted): corruption.
      await this.suspend(`The mail module is not the content that was signed: ${error instanceof Error ? error.message : String(error)}`);
      return refuse('The mail module changed on disk; connect again to accept it, then sign again.');
    }
    const { connector, task } = loaded;
    const entitlement = await connector.entitlement().catch(() => ({ ok: false, provider: connector.provider, account: connector.account, missing: ['a working entitlement check'], detail: 'The entitlement check could not run.' }));
    let cap = this.current();
    if (!entitlement.ok) {
      if (cap?.state === 'active') await this.suspend(`The account no longer grants what the capability needs: ${entitlement.detail}`);
      return refuse(entitlement.detail);
    }
    if (loaded.registration.id !== conn.registration.id || loaded.registration.digest !== conn.registration.digest || loaded.registration.version !== conn.registration.version || loaded.registration.piece !== conn.registration.piece || connector.provider !== conn.provider || connector.account !== conn.account || entitlement.provider !== conn.provider || entitlement.account !== conn.account) {
      if (cap?.state === 'active') await this.suspend('The loaded connector or entitlement names another mailbox account.');
      return refuse('The loaded mailbox does not match the signed connection; reconnect the intended account.');
    }
    if (cap?.state === 'active') {
      const pins = await this.pins();
      const moved = pins ? widenings(cap.payload, { ...cap.payload, pins }) : ['pinned version'];
      if (moved.length) return refuse('A pinned revision changed (the model, the engine, the connector or its configuration); sign the capability again before the job acts.');
    } else if (cap) return refuse(`The capability is ${cap.state}; the job is stopped.`);
    const effective = cap?.effective ?? cap?.payload;
    if (effective) {
      try { this.assertModes(effective); this.assertBudget(effective); }
      catch (error) { const reason = error instanceof Error ? error.message : String(error); await this.suspend(reason); return refuse(reason); }
    }
    if (effective && (effective.scope.account !== conn.account || !effective.scope.folders.includes('INBOX') || !effective.destinations.accounts.includes(conn.account))) return refuse('The effective capability no longer includes this inbox/account.');
    if (cap && cap.window?.day !== now().slice(0, 10)) {
      this.checkRun(signal);
      await this.rotateWindow(link, cap, cap.effective ?? cap.payload, this.authorityEpoch, conn);
      this.runGeneration = this.authorityGeneration();
      this.checkRun(signal);
    }
    await this.reconcilePending();
    this.checkRun(signal);
    const mandate = cap?.mandate ?? conn.mandate;
    record.capability = cap ? `${cap.payload.id}@${cap.payload.version}` : null;
    let h: RunHandle;
    try {
      h = await this.withAuthority(this.runGeneration ?? undefined, async () => {
        this.checkRun(signal);
        if (await link.openRun(conn.task)) throw new TriageRefused('Another consumer is already running this job.');
        this.checkRun(signal);
        record.order = (this.authorityFence().revision ?? 0) + 1;
        const held = await link.startRunUnder(conn.task, conn.agent, mandate, conn.registration.id);
        record.run = held.run;
        this.ownedRuns.add(record);
        this.state.runs.push(record);
        this.save();
        return held;
      });
    } catch (error) {
      return refuse(error instanceof CoreRefusal ? `The grant does not stand (${error.reason}).` : String(error));
    }
    const heartbeat = setInterval(() => void link.renewRun(h).catch(() => {}), RUN_LEASE_MS / 3);
    heartbeat.unref();
    const controls = setInterval(() => {
      try { this.checkRun(signal); } catch { this.controller?.abort(); }
    }, 50);
    controls.unref();
    try {
      const labels = (await this.readThrough(link, h, connector, { op: 'labels' }, [], signal)) as MailLabel[];
      const listed = (await this.readThrough(link, h, connector, { op: 'list' }, labels, signal)) as { messages: MailSummary[] };
      for (const summary of listed.messages) {
        if (signal.aborted) break;
        const item = this.state.items[summary.id];
        if (item?.done && sameMailbox(item, conn) && item.version === summary.version && !(await this.voided(link, item))) continue;
        if (this.turnsToday() >= ((cap?.effective ?? cap?.payload)?.budget.modelTurnsPerDay ?? 50)) {
          record.outcome = 'stopped';
          record.reason = 'The day\'s budget of model turns is spent; the rest waits for tomorrow.';
          break;
        }
        await this.handle(link, h, connector, task, engine, route, labels, summary, record, signal);
        if (item?.done || this.state.items[summary.id]?.done) record.handled++;
        this.save();
        this.ownedItems.clear();
        if (record.outcome === 'stopped') break;
      }
      if (signal.aborted) {
        record.outcome = this.ending?.outcome ?? 'stopped';
        record.reason = this.ending?.reason ?? 'Stopped by the person.';
      }
      record.outcome ??= 'done';
    } catch (error) {
      const reason = error instanceof CoreRefusal ? error.reason : '';
      if (!signal.aborted && BREACH.has(reason)) await this.suspend(`The door refused an effect the capability names (${reason}).`);
      if (signal.aborted) {
        record.outcome = this.ending?.outcome ?? 'stopped';
        record.reason = this.ending?.reason ?? 'Stopped by the person.';
      } else if (this.ending) {
        record.outcome = this.ending.outcome;
        record.reason = this.ending.reason;
      } else if (GONE.has(reason)) {
        record.outcome = 'revoked';
        record.reason = `The job's grant no longer stands (${reason}).`;
      } else {
        record.outcome = 'failed';
        record.reason = error instanceof Error ? error.message : String(error);
      }
    } finally {
      clearInterval(heartbeat);
      clearInterval(controls);
      if (signal.aborted) {
        try { await this.cancelPending(link, h.run, 'The job stopped before dispatch.'); }
        catch (error) {
          record.outcome = 'failed';
          record.reason = 'Cancellation could not be confirmed; authority is suspended pending recovery.';
          const current = this.current();
          if (current) {
            // end() journals the pending termination before trying the unavailable core.
            await this.end(link, current, 'suspended', record.reason).catch(() => {});
          } else {
            this.state.disconnecting = true;
          }
          this.save();
          throw error;
        }
      }
      try { await link.finishRun(h, record.outcome === 'done' ? 'succeeded' : 'failed'); }
      catch (error) {
        if (!(await this.closedInCore(link, h.run).catch(() => false))) {
          record.outcome = 'failed';
          record.reason = 'Run termination could not be confirmed; recovery is required.';
          const current = this.current();
          if (current) await this.end(link, current, 'suspended', record.reason).catch(() => {});
          this.save();
          throw error;
        }
      }
      record.endedAt = now();
      this.save();
    }
    return record;
  }

  /** One read through the gateway: classified by the connector, a class-1 effect, carried and observed. */
  private async readThrough(link: CoreLink, h: RunHandle, connector: MailConnector, request: MailRequest, labels: MailLabel[], signal: AbortSignal): Promise<unknown> {
    this.checkRun(signal);
    const c = connector.classify(request, labels);
    if (!c.ok || !c.value.read) throw new TriageRefused(`The connector refused a read: ${c.ok ? 'not a read' : c.reason}`);
    const id = await this.proposeEffect(link, h, 'mail', c.value, null, `${h.run}:${c.value.operation}:${sha256(JSON.stringify(c.value.args)).slice(0, 24)}`, signal);
    const row = await this.effect(link, id);
    if (row.status !== 'allowed') throw new CoreRefusal(row.route_reason ?? 'denied', `the gateway did not let the read through (${row.route_reason ?? row.status})`);
    this.checkRun(signal);
    const claim = await link.claimEffect(id);
    this.checkRun(signal);
    if (!(await link.beginDispatch(id, claim))) throw new CoreRefusal('revoked', 'the grant ended before the read');
    try { this.checkRun(signal); } catch (error) {
      await link.observe(id, claim, 'failed', sha256(`stopped-before-read:${id}`), 'Stopped before the provider read began.');
      throw error;
    }
    try {
      const value = request.op === 'list' ? await connector.list() : request.op === 'read' ? await connector.read(request.id) : await connector.labels();
      await link.observe(id, claim, 'succeeded', sha256(JSON.stringify(value)), null);
      return value;
    } catch (error) {
      // A read changes nothing at the provider: a failed one simply did not happen.
      await link.observe(id, claim, 'failed', sha256(`read-failed:${id}`), 'The provider did not answer the read.');
      throw error;
    }
  }

  private async proposeEffect(link: CoreLink, h: RunHandle, tool: string, op: Pick<ClassifiedOperation, 'operation' | 'effectClass' | 'external' | 'args' | 'summary'>, expectedVersion: string | null, key: string, signal: AbortSignal): Promise<string> {
    this.checkRun(signal);
    return link.call<string>(link.runOf(h), `SELECT gov.propose_effect($1, $2, NULL, $3, $4, NULL, NULL, $5::smallint, $6, $7::jsonb, $8, $9, $10)`, [
      h.run,
      h.fence,
      tool,
      op.operation,
      op.effectClass,
      op.external,
      JSON.stringify(op.args),
      op.summary,
      expectedVersion,
      key,
    ]);
  }

  /** Stop cancels unstarted releases; an already dispatched/UNKNOWN effect is only observed. */
  private async cancelPending(link: CoreLink, run: string, reason: string) {
    const { rows } = await link.read<{ id: string; status: string }>(link.system(), 'SELECT id, status FROM app.effects WHERE run_id = $1', [run]);
    for (const row of rows) {
      if (!['proposed', 'awaiting_checker', 'allowed', 'claimed'].includes(row.status)) continue;
      try { await link.call(link.person(), 'SELECT gov.cancel_effect($1, $2)', [row.id, reason]); }
      catch (error) {
        const latest = await this.effect(link, row.id);
        if (['proposed', 'awaiting_checker', 'allowed', 'claimed'].includes(latest.status)) throw error;
      }
    }
  }

  private async effect(link: CoreLink, id: string): Promise<EffectRow> {
    const { rows } = await link.read<EffectRow>(link.system(), 'SELECT id, status, route_reason, args, args_hash, decision_id, operation, mandate_id, expected_version, note FROM app.effects WHERE id = $1', [id]);
    return rows[0];
  }

  /**
   * The task's effect of this operation with exactly these arguments, if one still counts: adopted,
   * never proposed twice. A cancelled one (its grant ended) or one refused before formation does
   * not count; one the person discarded does, and stays discarded.
   */
  private async existing(link: CoreLink, operation: string, args: Record<string, unknown>): Promise<EffectRow | null> {
    const { rows } = await link.read<EffectRow>(
      link.system(),
      `SELECT id, status, route_reason, args, args_hash, decision_id, operation, mandate_id, expected_version FROM app.effects
        WHERE task_id = ANY($1::uuid[]) AND operation = $2 AND args_hash = sec.args_hash($3::jsonb) AND repeat_of IS NULL
          AND (status NOT IN ('cancelled', 'denied') OR (status = 'denied' AND decision_id IS NOT NULL)) ORDER BY created_at DESC LIMIT 1`,
      [operation === 'workspace.write_document' ? [...new Set([...(this.state.tasks ?? []), this.state.connection!.task])] : [this.state.connection!.task], operation, JSON.stringify(args)],
    );
    return rows[0] ?? null;
  }

  /** A request handled before whose draft or proposal no longer counts (its grant ended, or it was refused before formation). */
  private async voided(link: CoreLink, item: Item): Promise<boolean> {
    for (const id of [item.draft?.effect, item.proposal?.effect]) {
      if (!id) continue;
      const row = await this.effect(link, id);
      if (row && (row.status === 'cancelled' || (row.status === 'denied' && !row.decision_id))) return true;
    }
    return false;
  }

  /** Dispatch reservations survive a kill and are independent of a stale run snapshot. */
  private turnsToday(day = now().slice(0, 10)): number {
    const spent = readJson<Record<string, number>>(join(this.deps.home, 'triage', 'usage', 'model.json'), {});
    const legacy = this.state.runs.filter((r) => r.startedAt.startsWith(day)).reduce((n, r) => n + r.modelTurns, 0);
    return Math.max(spent[day] ?? 0, legacy);
  }

  private reserveModelTurn(limit: number): Promise<boolean> {
    return withHomeLock(join(this.deps.home, 'triage', 'usage'), async () => {
      const day = now().slice(0, 10);
      const path = join(this.deps.home, 'triage', 'usage', 'model.json');
      const spent = readJson<Record<string, number>>(path, {});
      const used = this.turnsToday(day);
      if (used >= limit) return false;
      spent[day] = used + 1;
      writeJson(path, spent);
      return true;
    });
  }

  private async handle(
    link: CoreLink, h: RunHandle, connector: MailConnector, task: TriageTask, engine: HarnessV1, route: ModelRoute,
    labels: MailLabel[], summary: MailSummary, record: RunRecord, signal: AbortSignal,
  ) {
    this.checkRun(signal);
    const listed = beginItem(this.state, summary, this.state.connection!, h.run, record.order);
    this.ownedItems.add(listed); this.save();
    const message = (await this.readThrough(link, h, connector, { op: 'read', id: summary.id }, labels, signal)) as MailMessage;
    this.checkRun(signal);
    if (message.id !== summary.id) throw new TriageRefused('The provider returned a different message; no note or change is reused.');
    this.ownedItems.delete(listed);
    const item = beginItem(this.state, message, this.state.connection!, h.run, record.order);
    this.ownedItems.add(item); this.save();
    item.read = h.run;
    // What was read is recorded as it was, from outside the workspace: the run is marked untrusted.
    await link.call(link.system(), "SELECT gov.record_source('message', $1, $2, NULL, $3, NULL)", [`mail:${message.id}@${message.version}`, rfc822(message), h.run]);
    if (!item.note) {
      this.checkRun(signal);
      if (!(await this.reserveModelTurn((this.current()?.effective ?? this.current()?.payload)?.budget.modelTurnsPerDay ?? 50))) {
        record.outcome = 'stopped';
        record.reason = 'The day’s budget of model turns is spent; the rest waits for tomorrow.';
        return;
      }
      const standing = await link.call<string>(link.runOf(h), 'SELECT gov.run_standing($1)', [h.run]);
      if (standing !== 'ok') throw new CoreRefusal('revoked', `The job cannot continue (${standing}).`);
      this.checkRun(signal);
      record.modelTurns++;
      this.save();
      this.checkRun(signal);
      const thought = await this.think(engine, route, task, labels, connector.now?.() ?? new Date().toISOString(), message, h.run, signal);
      if (signal.aborted) return;
      if (!thought.ok) {
        item.noteError = thought.reason;
        item.needsYou = `The model's note could not be used (${thought.reason}).`;
        item.done = true;
        item.endedAt = now();
        return;
      }
      item.note = thought.note;
      this.save();
    }
    const note = item.note;
    const addresses = addressesIn(message);
    const requesterOk = addresses.has(note.requester.address);
    if (!requesterOk) item.needsYou = `The note names a requester (${note.requester.address}) the message does not carry; no reply was drafted.`;
    else if (!headerAddresses(message).has(note.requester.address)) item.needsYou = `The requester (${note.requester.address}) comes from the message's text, not its headers. Check the address before using the draft.`;
    if (note.suspicious) item.needsYou = `Marked suspicious: ${note.reason || 'it asks to move money, credentials or data'}. Check it yourself.`;
    if (note.reply && requesterOk) await this.draft(link, h, item, message, note, signal);
    if (signal.aborted) return;
    await this.proposeChange(link, h, connector, item, message, note, labels, signal);
    item.done = true;
    item.endedAt = now();
  }

  /** One harness turn for one message: its only file is the message, its only write the note. */
  private async think(engine: HarnessV1, route: ModelRoute, task: TriageTask, labels: MailLabel[], now: string, message: MailMessage, run: string, signal: AbortSignal): Promise<{ ok: true; note: TriageNote } | { ok: false; reason: string }> {
    this.checkRun(signal);
    const file = messageFile(message.id);
    let written: TriageNote | null = null;
    let lastProblem = '';
    const tools: ToolHost = {
      list: async () => [{ name: file, version: 1, by: 'person', class: 'original', mediaType: 'message/rfc822' }],
      read: async (name) => (name === file ? { name: file, version: 1, by: 'person', class: 'original', mediaType: 'message/rfc822', text: rfc822(message) } : null),
      write: async (name, body) => {
        if (name !== NOTE_FILE) return { outcome: 'REFUSED', detail: `Only ${NOTE_FILE} can be written in this job.` };
        const parsed = parseNote(body, task, labels);
        if (!parsed.ok) {
          lastProblem = parsed.reason;
          return { outcome: 'REFUSED', detail: `${parsed.reason}. Write ${NOTE_FILE} again in the exact format.` };
        }
        written = parsed.note;
        return { outcome: 'DONE', name: NOTE_FILE, version: 1 };
      },
    };
    this.policy.check(engine, route);
    // The mailbox project can be shared after connection. Recheck every message.
    const project=this.state.connection?.projectId;
    const nativeTurn=project?await this.deps.nativeAccountTurn?.(project):undefined;
    try{
    const nativeAccountTools=nativeTurn?.nativeAccountTools??false;
    const turn = engine.start(
      { system: `You triage one email at a time. Read the message file you are given, then write ${NOTE_FILE} in the exact format asked for. Do nothing else.`, threadId: `${JOB}-${run}`, turnId: `${message.id}@${message.version}`, text: requestText(task, labels, message.id, now), history: [], attachments: [file], effort: 2, resumed: false, ...(!nativeAccountTools?{nativeAccountTools:false as const}:{}), stillAllowed: () => this.policy.allowed(engine, route) },
      { tools, route, credential: (h) => this.deps.credential(h) },
    );
    const stop = () => turn.stop();
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    for await (const _ of turn.events) {
      // The note arrives through the ToolHost; nothing else in the stream acts.
    }
    const outcome = await turn.outcome;
    signal.removeEventListener('abort', stop);
    if (written) return { ok: true, note: written };
    // A model that answered with the note instead of writing it: the same parser, the same lists.
    const fromAnswer = parseNote(outcome.answer, task, labels);
    if (fromAnswer.ok) return fromAnswer;
    return { ok: false, reason: outcome.status === 'failed' ? `the model could not be reached: ${outcome.error ?? 'no reason'}` : lastProblem || fromAnswer.reason };
    }finally{await nativeTurn?.release();}
  }

  /** The reply as working material, through the gateway: addressed by this code to the requester alone. */
  private async draft(link: CoreLink, h: RunHandle, item: Item, message: MailMessage, note: TriageNote, signal: AbortSignal) {
    this.checkRun(signal);
    const conn = this.state.connection!;
    if (unsettledDraft(await this.effects(), message, conn)) { item.needsYou = 'An earlier draft is unresolved (possibly UNKNOWN); check its mailbox identity and receipt before drafting again.'; return; }
    const name = `${fileName(`Reply to ${note.requester.name || note.requester.address}`)} (${message.id}).md`;
    const conflict = draftNameConflict(this.deps.material, conn.projectId, name);
    if (conflict) { item.needsYou = conflict; return; }
    const document = uuidOf(`${conn.projectId}\0${conn.provider}\0${conn.account}\0${JOB}\0${message.id}`);
    const content = `To: ${fmt(note.requester)}\nSubject: Re: ${message.subject.replace(/[\r\n]+/g, ' ').replace(/^(re:\s*)+/i, '')}\nIn reply to: ${message.id}\n\n${note.reply}\n`;
    const args = { mailbox: { provider: conn.provider, account: conn.account }, document_id: document, title: name, content_sha256: sha256(content), base_version: null, message: message.id, message_version: message.version, to: note.requester.address };
    item.draft = { effect: '', document, name };
    const adopted = await this.existing(link, 'workspace.write_document', args);
    const id = adopted?.id ?? (await this.proposeEffect(link, h, 'write', { operation: 'workspace.write_document', effectClass: 2, external: false, args, summary: `Draft a reply to ${fmt(note.requester)}` }, message.version, `${h.run}:draft:${message.id}@${message.version}`, signal));
    item.draft.effect = id;
    this.save();
    const row = adopted ?? (await this.effect(link, id));
    if (row.status === 'denied' && BREACH.has(row.route_reason ?? '')) throw new CoreRefusal(row.route_reason!, 'the door refused an effect the capability names');
    if (row.status !== 'allowed' && row.status !== 'claimed') return; // done, refused, UNKNOWN or held: its receipt says so
    const held = row.status === 'claimed' ? (await link.heldClaims()).find((c) => c.effect === id) : undefined;
    if (row.status === 'claimed' && !held) return;
    const claim = held?.claim ?? (await link.claimEffect(id));
    this.checkRun(signal);
    if (process.env.BACKBONE_CRASH_AT === 'triage.draft.claimed') process.kill(process.pid, 'SIGKILL');
    if (!(await link.beginDispatch(id, claim))) return;
    try { this.checkRun(signal); } catch (error) {
      await link.observe(id, claim, 'failed', sha256(`stopped-before-draft:${id}`), 'Stopped before the material write began.');
      throw error;
    }
    if (process.env.BACKBONE_CRASH_AT === 'triage.draft.begun') process.kill(process.pid, 'SIGKILL');
    if (this.deps.writeDelayMs) await new Promise<void>((r) => {
      const t = setTimeout(r, this.deps.writeDelayMs);
      signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
    });
    try { this.checkRun(signal); } catch { /* A dispatch already began: observe it below. */ }
    if (signal.aborted) {
      await link.observe(id, claim, 'unknown', sha256(`stopped:${id}`), 'Stopped during the draft\'s write.');
      return;
    }
    const result = retainDraft(this.deps.material, conn.projectId, document, name, content);
    if ('reason' in result) {
      item.needsYou = result.reason;
      await link.observe(id, claim, 'failed', sha256(`retained:${document}`), result.reason); return;
    }
    await link.writeDocument(id, document, name, content);
    await link.observe(id, claim, 'succeeded', result.entry.versions.at(-1)!.sha256, null);
  }

  /** The label or move the note asks for, classified by the connector and proposed: it waits for the person. */
  private async proposeChange(link: CoreLink, h: RunHandle, connector: MailConnector, item: Item, message: MailMessage, note: TriageNote, labels: MailLabel[], signal: AbortSignal) {
    this.checkRun(signal);
    const add: string[] = [];
    const remove: string[] = [];
    const label = note.label ? labels.find((l) => l.name === note.label) : undefined;
    if (label && !message.labels.includes(label.id)) add.push(label.id);
    if (note.move === 'Archive' && message.labels.includes('INBOX')) remove.push('INBOX');
    if (note.move === 'Spam') {
      add.push('SPAM');
      if (message.labels.includes('INBOX')) remove.push('INBOX');
    }
    if (!add.length && !remove.length) return;
    const c = connector.classify({ op: 'modify', id: message.id, version: message.version, add, remove }, labels);
    if (!c.ok) {
      item.needsYou ??= `The connector refused the change the note asked for (${c.reason}).`;
      return;
    }
    if (uncertainMail(await this.effects(), this.state.bindings, c.value, this.state.connection!)) { item.needsYou = 'An earlier mailbox change is unresolved or UNKNOWN; it is not proposed again.'; return; }
    const adopted = await this.existing(link, c.value.operation, c.value.args);
    const id = adopted?.id ?? (await this.proposeEffect(link, h, 'mail', c.value, message.version, `${h.run}:change:${message.id}@${message.version}`, signal));
    const change = c.value.args as Extract<MailRequest, { op: 'modify' }>;
    const undo = undoWords({ add: change.remove, remove: change.add }, labels);
    item.proposal = { effect: id, operation: c.value.operation, summary: c.value.summary, recovery: c.value.recovery, undo, binding: { provider: connector.provider, account: connector.account, registration: this.state.connection!.registration.id } };
    this.state.bindings ??= {}; this.state.bindings[id] = item.proposal.binding!;
    this.save();
    const row = adopted ?? (await this.effect(link, id));
    if (row.status === 'denied' && BREACH.has(row.route_reason ?? '')) throw new CoreRefusal(row.route_reason!, 'the door refused an effect the capability names');
  }

  // ---- The person's answers ----------------------------------------------------------------

  /**
   * Accept or discard one proposal, bound to the exact change shown (its arguments' hash). While
   * writes are gated an accepted change waits, allowed and unapplied; with them open (tests only)
   * it is carried out once, and an outcome nobody can tell is settled by a provider probe.
   */
  async decide(effect: string, verdict: 'accept' | 'discard'): Promise<EffectRow> {
    const epoch = this.dispatchEpoch, generation = this.authorityGeneration();
    const link = await this.deps.link();
    const row = await this.effect(link, effect);
    if (!row || !row.operation.startsWith('mail.')) throw new TriageRefused('No such proposal.');
    const owned = [...Object.values(this.state.items), ...Object.values(this.state.restorations ?? {})].find((i) => i.proposal?.effect === effect);
    const { connector, registration } = await this.deps.mail();
    this.checkMailboxBinding(owned?.proposal?.binding, connector, registration);
    if (verdict === 'accept' && connector.writes === 'open' && !(await writeEntitled(connector))) throw new TriageRefused('The mailbox write entitlement is unavailable or incomplete.');
    if (row.status !== 'awaiting_checker' || !row.decision_id) throw new TriageRefused('This proposal is not waiting for an answer.');
    await link.call(link.person(), 'SELECT gov.answer_decision($1, $2, $3, $4)', [row.decision_id, row.args_hash, verdict === 'accept' ? 'approved' : 'rejected', verdict === 'accept' ? 'Accepted in the brief.' : 'Discarded in the brief.']);
    if (verdict === 'accept' && connector.writes === 'open') await this.apply(link, connector, effect, epoch, generation, registration);
    this.save();
    return this.effect(link, effect);
  }

  /** The person's explicit undo uses the existing governed, single-use undo crossing. */
  async undo(effect: string): Promise<EffectRow> {
    const epoch = this.dispatchEpoch, generation = this.authorityGeneration();
    if (this.stoppedByPerson()) throw new TriageRefused('The job was stopped; resume it before requesting recovery.');
    const link = await this.deps.link();
    if (!(await this.effects()).has(effect)) throw new TriageRefused('No such mailbox receipt.');
    const row = await this.effect(link, effect);
    if (row.status !== 'succeeded') throw new TriageRefused('Only a confirmed completed change can be undone.');
    let saved: { recovery?: { request: MailRequest; provider: string; account: string; registration: string } } = {};
    try { saved = JSON.parse(row.note ?? '{}'); } catch { /* Older receipts carry no executable inverse. */ }
    const recovery = saved.recovery;
    if (!recovery?.request || recovery.request.op !== 'modify') throw new TriageRefused('No confirmed inverse is recorded for this change.');
    if (this.state.restorations?.[effect]) throw new TriageRefused('Undo was already requested; inspect its receipt.');
    const { connector, registration } = await this.deps.mail();
    this.checkMailboxBinding(recovery, connector, registration);
    if (!(await this.mailboxReadsStand(link, epoch, generation)) || !(await writeEntitled(connector)) || this.interrupted(epoch, generation)) throw new TriageRefused('The mailbox authority ended or the job stopped.');
    const c = connector.classify(recovery.request, await connector.labels());
    if (!c.ok || c.value.operation !== row.operation) throw new TriageRefused('The confirmed inverse is outside this operation’s recovery.');
    const cap = this.current();
    const effective = cap?.effective ?? cap?.payload;
    if (!cap || cap.state !== 'active' || !effective || !operationsOf(effective).includes(c.value.operation) || !effective.destinations.accounts.includes(connector.account) || effective.scope.account !== connector.account || !effective.scope.folders.includes('INBOX')) throw new TriageRefused('The current capability does not include this recovery.');
    if (this.interrupted(epoch, generation)) throw new TriageRefused('Authority ended before recovery was proposed.');
    const original = Object.values(this.state.items).find((i) => i.proposal?.effect === effect);
    const id = await link.call<string>(link.person(), 'SELECT gov.propose_undo($1, $2::jsonb, $3, $4, $5)', [effect, JSON.stringify(c.value.args), `Undo: ${c.value.summary}`, recovery.request.version, `triage:undo:${effect}`]);
    this.state.restorations ??= {};
    this.state.restorations[effect] = {
      id: recovery.request.id, version: recovery.request.version,
      from: original?.from ?? { name: 'Earlier mailbox work', address: '' }, subject: original?.subject ?? 'Restore mailbox change', date: now(), done: true,
      proposal: { effect: id, operation: c.value.operation, summary: `Undo: ${c.value.summary}`, recovery: null, undo: null, binding: recovery },
    };
    this.state.bindings ??= {}; this.state.bindings[id] = recovery;
    if (original?.proposal) { original.proposal.undoEffect = id; saveItem(this.deps.home, original); }
    saveItem(this.deps.home, this.state.restorations[effect], effect);
    this.save();
    if (connector.writes === 'open') await this.apply(link, connector, id, epoch, generation, registration);
    return this.effect(link, id);
  }

  private checkMailboxBinding(binding: { provider: string; account: string; registration: string } | undefined, connector: MailConnector, registration: Connection['registration']) {
    const conn = this.state.connection;
    if (!binding || !conn || readJson<boolean>(this.connectionEndingPath(conn), false) || this.state.disconnecting || binding.provider !== connector.provider || binding.account !== connector.account || conn.provider !== binding.provider || conn.account !== binding.account || conn.registration.id !== binding.registration || registration.id !== binding.registration || registration.piece !== conn.registration.piece || registration.version !== conn.registration.version || registration.digest !== conn.registration.digest) throw new TriageRefused('This change belongs to another or disconnected mailbox registration.');
  }

  private interrupted(epoch: number, generation: number): boolean {
    const disk = readJson<Stored>(this.path, this.state);
    return epoch !== this.dispatchEpoch || generation !== this.authorityGeneration() || this.closed || this.current()?.state !== 'active' || !!this.current()?.endPending || this.stoppedByPerson() || !!disk.stoppedByPerson || !!disk.disconnecting || disk.connection?.mandate !== this.state.connection?.mandate;
  }

  private async mailboxReadsStand(link: CoreLink, epoch: number, generation: number): Promise<boolean> {
    const cap = this.current(), conn = this.state.connection;
    return !this.interrupted(epoch, generation) && !!cap && !!conn && await this.mandateStands(link, cap.mandate) && await this.mandateStands(link, conn.mandate) && !this.interrupted(epoch, generation);
  }

  /** Carry out an allowed mailbox change once (only when writes are open). */
  private async apply(link: CoreLink, connector: MailConnector, effect: string, epoch: number, generation: number, registration: Connection['registration']) {
    const row = await this.effect(link, effect);
    if (row.status !== 'allowed') return;
    const item = [...Object.values(this.state.items), ...Object.values(this.state.restorations ?? {})].find((i) => i.proposal?.effect === effect);
    this.checkMailboxBinding(item?.proposal?.binding, connector, registration);
    const interrupted = () => this.interrupted(epoch, generation);
    if (interrupted()) { await link.call(link.person(), 'SELECT gov.cancel_effect($1, $2)', [effect, 'Authority changed before dispatch.']); return; }
    if (!(await this.mailboxReadsStand(link, epoch, generation))) { await link.call(link.person(), 'SELECT gov.cancel_effect($1, $2)', [effect, 'Mailbox authority ended before dispatch.']); return; }
    if (!(await writeEntitled(connector))) throw new TriageRefused('The mailbox write entitlement is unavailable or incomplete.');
    const labels = await connector.labels();
    const c = connector.classify(row.args as MailRequest, labels);
    if (!c.ok) throw new TriageRefused(c.reason);
    const claim = await link.claimEffect(effect);
    this.checkMailboxBinding(item?.proposal?.binding, connector, registration);
    if (interrupted()) { await link.call(link.person(), 'SELECT gov.cancel_effect($1, $2)', [effect, 'Stopped before dispatch.']); return; }
    if (!(await link.beginDispatch(effect, claim))) return;
    if (interrupted()) { await link.observe(effect, claim, 'failed', sha256(`stopped:${effect}`), 'Stopped before the mailbox write began.'); return; }
    try {
      if (!(await writeEntitled(connector))) throw new TriageRefused('The mailbox write entitlement is unavailable or incomplete.');
      this.checkMailboxBinding(item?.proposal?.binding, connector, registration);
      if (interrupted()) throw new TriageRefused('Authority changed before the mailbox call.');
    } catch (error) { await link.observe(effect, claim, 'failed', sha256(`not-started:${effect}`), 'The mailbox call did not begin.'); throw error; }
    try {
      const r = await connector.apply({ ...c.value, operationKey: effect });
      const inverse = r.outcome === 'succeeded' && r.undo?.op === 'modify' && r.undo.id === (row.args as { id: string }).id && r.undo.version !== row.expected_version ? r.undo : null;
      const checked = inverse ? connector.classify(inverse, labels) : null;
      const restoring = Object.values(this.state.restorations ?? {}).includes(item!);
      const confirmed = !restoring && checked?.ok && checked.value.operation === row.operation ? inverse : null;
      if (r.outcome === 'succeeded' && item?.proposal) {
        item.proposal.undoRequest = confirmed;
        item.proposal.undo = confirmed ? undoWords(confirmed, labels) : null;
        if (!confirmed) item.proposal.recovery = null;
        if (!confirmed && r.undo === undefined) item.needsYou = 'The provider confirmed the change without a confirmed inverse; exact undo is unavailable.';
      }
      if (item) { const restored = Object.entries(this.state.restorations ?? {}).find(([, i]) => i === item); saveItem(this.deps.home, item, restored?.[0]); }
      this.save();
      const note = r.outcome === 'succeeded' ? JSON.stringify({ recovery: confirmed ? { request: confirmed, ...item!.proposal!.binding } : null }) : null;
      await link.observe(effect, claim, r.outcome, r.evidence, note);
    } catch {
      await link.observe(effect, claim, 'unknown', sha256(`no-answer:${effect}`), JSON.stringify({ binding: item?.proposal?.binding, reason: 'The provider did not answer; it may or may not have applied the change. It is never sent again.' }));
      if (item?.proposal) { item.proposal.undoRequest = null; item.proposal.undo = null; item.proposal.recovery = null; const restored = Object.entries(this.state.restorations ?? {}).find(([, i]) => i === item); saveItem(this.deps.home, item, restored?.[0]); this.save(); }
      await this.reconcile(effect);
    }
  }

  /** Settle an UNKNOWN mailbox change by a provider probe, never by sending it again. Returns the outcome. */
  async reconcile(effect: string): Promise<string> {
    const epoch = this.dispatchEpoch, generation = this.authorityGeneration();
    const link = await this.deps.link();
    const row = await this.effect(link, effect);
    if (row.status !== 'unknown') return row.status;
    const item = [...Object.values(this.state.items), ...Object.values(this.state.restorations ?? {})].find((i) => i.proposal?.effect === effect);
    let binding = this.state.bindings?.[effect] ?? item?.proposal?.binding;
    if (!binding) { try { const note = JSON.parse(row.note ?? '{}'); binding = note.binding ?? note.recovery; } catch { /* No bound observation. */ } }
    const { connector, registration } = await this.deps.mail();
    try { this.checkMailboxBinding(binding, connector, registration); } catch { return 'unknown'; }
    if (!(await this.mailboxReadsStand(link, epoch, generation))) return 'unknown';
    const c = connector.classify(row.args as MailRequest, await connector.labels());
    if (!c.ok) return row.status;
    try { this.checkMailboxBinding(binding, connector, registration); } catch { return 'unknown'; }
    if (!(await this.mailboxReadsStand(link, epoch, generation))) return 'unknown';
    const seen = await connector.probe({ ...c.value, operationKey: effect }).catch(() => ({ landed: null, evidence: sha256(`probe-failed:${effect}`) }));
    if (seen.landed === null) return 'unknown';
    return link.call<string>(link.system(), 'SELECT gov.reconcile_effect($1, $2, NULL, $3, $4)', [
      effect,
      seen.landed ? 'succeeded' : 'failed',
      seen.evidence,
      seen.landed ? 'Found applied by a provider probe.' : 'Found not applied by a provider probe.',
    ]);
  }

  reconcilePending(): Promise<void> {
    return this.probing ??= reconcileMailboxUnknowns(() => this.effects(), (id) => this.reconcile(id)).finally(() => { this.probing = null; });
  }

  /** Every effect the job's task holds, for the brief. */
  async effects(): Promise<Map<string, EffectRow & { decision_status: string | null; created_at: Date }>> {
    return readEffects(await this.deps.link(), this.state);
  }

  /**
   * After a restart: a run a kill left open is claimed again once its lease lapses and closed as
   * interrupted; its record says so. The next run carries on from the first request not done, and
   * a draft cut mid-write was settled by the host's inspection (written, or UNKNOWN), never rewritten.
   */
  recover(): Promise<void> {
    if (!this.recovery) this.recovery = this.recoverNow().finally(() => { this.recovery = null; });
    return this.recovery;
  }

  private async closedInCore(link: CoreLink, run: string): Promise<boolean> {
    const { rows } = await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.runs WHERE id = $1', [run]);
    return !!rows[0] && ['succeeded', 'failed', 'cancelled'].includes(rows[0].status);
  }

  private async recoverNow(): Promise<void> {
    const current = this.current();
    if (current?.state === 'active') {
      try { this.assertModes(current.effective ?? current.payload); this.assertBudget(current.effective ?? current.payload); }
      catch (error) { await this.suspend(error instanceof Error ? error.message : String(error)); }
    }
    this.state.runs = loadRuns(this.deps.home, this.state.runs, readJson<Stored>(this.path, this.state).runs);
    for (const cap of this.state.capabilities) {
      if (cap.endPending) await this.end(await this.deps.link(), cap, cap.endPending.state, cap.endPending.reason);
    }
    if (this.state.disconnecting || this.state.connecting) await this.disconnect();
    const tasks = [...new Set([...(this.state.tasks ?? []), ...(this.state.connection ? [this.state.connection.task] : [])])];
    if (tasks.length) {
      const link = await this.deps.link();
      const { rows } = await link.read<{ id: string; created_at: Date }>(link.system(), `SELECT id, created_at FROM app.runs WHERE task_id = ANY($1::uuid[]) AND status IN ('queued','running','waiting')`, [tasks]);
      for (const row of rows) if (!this.state.runs.some((r) => r.run === row.id)) {
        const record: RunRecord = { run: row.id, trigger: 'schedule', capability: null, startedAt: row.created_at.toISOString(), handled: 0, modelTurns: 0 };
        this.state.runs.push(record); saveRun(this.deps.home, record);
      }
    }
    await this.reconcilePending();
    const open = this.state.runs.filter((r) => r.run && !r.endedAt);
    const resume = !this.stoppedByPerson() && (open.length > 0 || this.state.wakePending);
    if (!open.length) {
      if (resume && this.current()?.state === 'active') this.requestWake(0);
      return;
    }
    const link = await this.deps.link();
    let liveHolder = false;
    for (const r of open) {
      try {
        const h = await link.reclaimRun(r.run, this.state.connection?.registration.id ?? null);
        await link.finishRun(h, 'failed');
      } catch (error) {
        if (error instanceof CoreRefusal && error.reason === 'not_claimable') {
          const { rows } = await link.read<{ live: boolean }>(link.system(), `SELECT status = 'running' AND lease_expires_at > clock_timestamp() AS live FROM app.runs WHERE id = $1`, [r.run]);
          if (rows[0]?.live) { liveHolder = true; continue; }
        }
        if (!(await this.closedInCore(link, r.run).catch(() => false))) {
          const cap = this.current();
          if (cap) await this.end(link, cap, 'suspended', 'Interrupted run termination is unconfirmed.').catch(() => {});
          throw error;
        }
      }
      r.outcome = this.stoppedByPerson() ? 'stopped' : 'failed';
      r.reason = this.stoppedByPerson() ? 'Stopped by the person before the app exited.' : 'Interrupted: the app stopped during this run.';
      r.endedAt = now();
      saveRun(this.deps.home, r);
    }
    this.save();
    if (resume && !liveHolder && this.current()?.state === 'active' && !this.current()?.endPending) this.requestWake(0);
  }
}
