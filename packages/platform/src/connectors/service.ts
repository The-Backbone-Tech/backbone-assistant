import { annotated, blocked, kindOf } from './classification.ts';
import { CatalogueController, applyCataloguePreset } from './catalogue-controller.ts';
import type { CatalogueRuntime } from './catalogue-store.ts';
import type { HomeKeys } from '../keys/vault.ts';
import type { CataloguePreset } from '../api-catalogue.ts';
export { blocked, kindOf } from './classification.ts';
import { governedPolicy, standingDecision, PolicyRefused } from '../policy/index.ts';
import { recoverReplacementOrphans } from './replacement-recovery.ts';
import { argumentView } from './signing-view.ts';
import { prepareGmailSend, gmailSendRefusal, gmailIntentJson } from './gmail-send-arguments.ts';
import { coverageDigest, LEGACY_ARGUMENTS, sendingArgs } from './signature-coverage.ts';
import { observeEffect } from '../composition/telemetry-observations.ts';
// The person's MCP servers behind one governed crossing (docs/contracts/connectors.md). The host
// finds them in the person's configs, lists their tools, and offers an engine only what the person
// enabled, pinned to what they saw: a server that now starts differently, or a tool whose definition
// changed, is off until enabled again. The Host's name rules set an effect floor;
// otherwise the person's word or the server's annotations classify it, defaulting to effect. A read flows, and comes back
// with how complete it is. An effect is proposed in the core under the turn's own run at the class
// that always waits for a person, who answers on its exact statement; while the egress door is
// closed a release is recorded and nothing is sent; with the door open for that server, a released call
// is carried out once as the core's dispatcher; the name list is only a classification floor.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {SIGNATURE_LEDGER_VERSION, STATED_REASONS} from '@backbone/core/db';
import {verifyStandingSignatures} from '../composition/signature-status.ts';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ConnectorServer, ConnectorsView, ConnectorTool, HeldCall, Receipt, ConnectorEffectAnswer, ConnectorEffectResolution, ConnectorEffectQuestion } from '../api.ts';
import type { CoreLink } from '../composition/core.ts';
import type { ConnectorInvocation } from '../ports/harness.ts';
import type { ConnectorMaterialReadRequest, ConnectorMaterialReadOutcome } from '../composition/connector-material-read.ts';
import { assertHomeWriteAdmission, outsideHomeLocks, withHomeLock } from '../composition/home-lock.ts';
import { readJson, writeJson } from '../stub/fsx.ts';
import type { ToolEnv } from '../tools/places.ts';
import { type CallAnswer, type ListedTool, McpSession, redactor } from './client.ts';
import { movesCredentialCache, reachesCredentials, realish } from './credential-args.ts';
import { discover, type Discovered, launchFor, SOURCE_NAMES, type ServerSource } from './discover.ts';
import { holds, holdsStored } from '../memory/plugin-installs.ts';

class SignatureUnavailable extends Error {}
class AmbiguousTools extends Error {}

/** Keep only the Core's finite reason vocabulary, never backend messages or causes. */
const coreDiagnostic = (message: string, error: unknown): Error & { reason: string } => {
  const reason = error && typeof error === 'object' && 'reason' in error ? error.reason : undefined;
  return Object.assign(new Error(message), { reason: typeof reason === 'string' && STATED_REASONS.has(reason) ? reason : 'unclassified' });
};
const ANSWER_UNCONFIRMED = 'The Core answer could not be confirmed. This call stays held locally; check its receipt before trying again.';

export const CONNECTION_UNKNOWN = 'An earlier call to this tool on this connection has an unknown outcome. Its standing signature is paused until you resolve it. This call waits for you; nothing was sent.';

export const TOOL_DISPATCHING = 'An earlier call to this tool is still dispatching. Its outcome has not been recorded. This call was not sent; retry or release it after the earlier call settles.';
const CALL_DISPATCHING = 'This call is still dispatching. Its outcome has not been recorded. It was not sent again.';

export const EGRESS_CLOSED = 'The egress door is closed for this server, so this was recorded and nothing was sent.';
const HELD_NEXT = 'Nothing was sent. It waits for the person, who decides in the app; only they can send it. Do not ask again under other words.';

/**
 * `standing` is the person's signature for this one tool: its calls go out with no question per
 * call. It is for the definition and the door's seal it was given on: while the tool is defined
 * otherwise, or the server starts otherwise or under another account, it does not apply, and it
 * applies again only when exactly what was signed is there. A changed definition found by a listing,
 * a closed door, the tool or server turned off, or the person ending it ends it for good. It is
 * also for the data home it was given in (`home`, its real path). `blockedToo` is
 * retained to preserve unversioned grants; it adds nothing to a versioned grant.
 */
/** `rev` counts every change to the tool's choice (on, off, what it counts as, signed, ended): a question shown before a change is not answered after it. */
interface ToolChoice { enabled: boolean; definition: string; listed: ListedTool; override?: 'read' | 'effect'; standing?: Signature; rev?: number }
type SignatureEndReason = 'person_revoked' | 'definition_changed' | 'connection_removed' | 'home_moved' | 'superseded';
interface Signature { coverageVersion?: 1; signedDefinition?: string; core?: 1; id: string; definition: string; seal: string; home: string; at: string; blockedToo?: true }
/** One signature, as given: a later one for the same tool is another, even on the same definition and seal. */
const sameSignature = (a: Signature | undefined, b: Signature) => !!a && a.id === b.id && a.seal === b.seal && a.definition === b.definition && a.home === b.home && a.coverageVersion === b.coverageVersion && a.signedDefinition === b.signedDefinition;
/**
 * Whose word releases a held call, written down before the core is answered, so a call recovered
 * after a crash goes out on that same word or not at all: the person's own release of this call,
 * or one named signature.
 */
type Approval = { by: 'person' } | { by: 'standing'; signature: Signature };
/** Closing a server's door ends every standing signature given through it: opening it again asks for each anew. */
const closeDoor = (c: ServerChoice, s: Stored) => { delete c.egress; delete c.egressSeal; c.rev = nextGen(s); for (const t of Object.values(c.tools)) delete t.standing; };
const SIGNATURE_ENDED_BEFORE_SEND = 'The standing signature ended before sending. Nothing was sent.';
const STANDING_GONE = 'This call was approved on a standing signature that has since ended, so it was cancelled and nothing was sent. Ask for it again.';
const STANDING_ENDED = 'The standing signature for this tool no longer holds (the tool, how the server starts, its account or its door changed), so this call waits for the person.';
/** `connection` is the core's record of it as the person's own connection, made when they first enable it. */
interface ServerChoice { enabled: boolean; /** The person opened the egress door for this server. */ egress?: true; /** The door's seal: a keyed hash of everything the server starts with, values included, when the door was opened. */ egressSeal?: string; fingerprint: string; listedAt?: string; problem?: string; tools: Record<string, ToolChoice>; connection?: { id: string; slug: string }; /** Counts every change to the server's own choice (on, off, door opened or closed). */ rev?: number }
const ownTool = (choice: ServerChoice | undefined, name: string): ToolChoice | undefined =>
  choice && Object.hasOwn(choice.tools, name) ? choice.tools[name] : undefined;
const CORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `heldTask` is the core's task the host proposes held calls under, made the first time one is held. */
/** A held call keeps the tool definition and the server start it was held against: a release is for that, never for a later one. */
interface StoredHeld extends HeldCall { replacementKey?: string; replacementEffect?: string; dispatchClaim?: string; key?: string; definition?: string; launch?: string; approval?: Approval }
/** What the api shows of a held call: none of the host's own bookkeeping. */
const shownHeld = ({ replacementKey: _replacementKey, replacementEffect: _replacementEffect, dispatchClaim: _claim, key: _key, definition: _d, launch: _l, approval: _a, standingSignatureId: _id, ...h }: StoredHeld): HeldCall => ({
  ...h, ...(_a?.by === 'standing' && CORE_ID.test(_a.signature.id) ? { standingSignatureId: _a.signature.id } : {}),
});
/** `gen` only ever grows, and starts above every revision already in the record: every `rev` of a server or a tool takes its next value under the home lock, so none repeats, even for a tool or server removed and found again. */
interface Stored { signatureEndConflicts?: { id: string; reason: SignatureEndReason; outcome: 'someone_else'; at: string }[]; pendingEnds?: { id: string; reason: SignatureEndReason }[]; servers: Record<string, ServerChoice>; held: StoredHeld[]; heldTask?: string; gen?: number; /** Grows by one with every saved change (see `change`). */ ver?: number }
/** Puts the counter at or above every revision in the record. Done on every change before anything is removed, so a record written before the counter existed cannot lose its highest revision first. */
const seedGen = (s: Stored) => { s.gen = Math.max(s.gen ?? 0, ...Object.values(s.servers).flatMap((c) => [c.rev ?? 0, ...Object.values(c.tools).map((t) => t.rev ?? 0)])); };
const nextGen = (s: Stored) => {
  seedGen(s);
  if (!Number.isSafeInteger(s.gen! + 1)) throw new Error('The revision counter of this data folder is exhausted; nothing was changed.');
  return (s.gen = s.gen! + 1);
};

/** What an engine is offered: one enabled tool of one enabled server. */
export interface OfferedTool {
  /** The name an engine calls it by: letters, digits, `_` and `-`, at most 64. */
  name: string;
  serverId: string;
  /** The core's connection: its id, and the slug its operations are named by (`mcp.<slug>.<tool>`). */
  connection: { id: string; slug: string };
  serverName: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: 'read' | 'effect';
  /** How the server started, and the tool's definition, when this was offered: a call is refused if either is not so now. */
  launch: string;
  definition: string;
}

/** The core's side of one turn's connector calls (composition/document-writes.ts). */
export interface ConnectorCore {
  readObserved(request: ConnectorMaterialReadRequest): Promise<ConnectorMaterialReadOutcome>;
  prepareProtocol(resumed: boolean): Promise<void>;
  reserveBatch(callIds: readonly string[]): Promise<string>;
  recover(): Promise<{pending:boolean}>;
  pending(): boolean;
}

export type ConnectorOutcome =
  | ConnectorMaterialReadOutcome
  | { outcome: 'HELD'; effect: string; detail: string }
  /** The retained effect receipt: verified success, known non-delivery, or UNKNOWN (never resent). */
  | { outcome: 'SENT'; effect: string; state: 'sent' | 'failed' | 'unknown'; detail: string; /** False when the person released this one call themselves and the turn asked again. */ standing: boolean }
  | { outcome: 'REFUSED'; detail: string };

const identityOf = (d: Discovered) => createHash('sha256').update(JSON.stringify(d.launch)).digest('hex');
const sameOffer = (now: OfferedTool, offered: OfferedTool) => now.launch === offered.launch && now.definition === offered.definition;
export const legacyDefinitionOf = (t: ListedTool) => createHash('sha256').update(JSON.stringify([t.name, t.title ?? '', t.description, t.inputSchema, t.annotations])).digest('hex');
export const definitionOf = (t: ListedTool) => t.definitionDigest ?? legacyDefinitionOf(t);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
export const offeredName = (serverName: string, tool: string) => `mcp__${slug(serverName)}__${slug(tool)}`.slice(0, 64);
/** A slug the core takes: a letter first, then lowercase letters, digits and underscores. */
const coreSlug = (name: string) => `c_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`.slice(0, 50);
const now = () => new Date().toISOString();

export function statementOf(serverName: string, tool: string, args: Record<string, unknown>) {
  return `Call ${tool} on ${serverName} with exactly: ${JSON.stringify(args)}`;
}

export interface ConnectorServiceOptions {
  /** Native OAuth uses the Host's vault provider, never ambient or plaintext fallback. */
  keys?: HomeKeys;
  catalogueRuntime?: CatalogueRuntime;
  /** Recheck live Host requirements immediately before a connector effect leaves. */
  policyAdmission?(): void;
  /** A read-only Host inspects choices without opening credentials or reconciling the file. */
  reconcileOnOpen?: boolean;
  home: string;
  env: () => ToolEnv;
  link: () => Promise<CoreLink>;
  emit?: () => void;
  /** How long a tools/call may take; 30 s by default. Startup and listing keep their own budgets. */
  callTimeoutMs?: number;
  sources?: ServerSource[];
  /**
   * The person's stored credentials, which no plugin server's config or manifest may hold. Without it only
   * credential shapes are looked for; when given and unreadable, every plugin server is blocked.
   */
  credentials?: () => Promise<readonly string[]>;
}

const PLUGIN_HOLDS = 'Its plugin\'s config or manifest holds a credential, so it is never started, enabled or offered. The credential is not shown.';
const PLUGIN_UNCHECKED = 'The stored credentials could not be read to check its plugin, so it is not started, enabled or offered now.';
const WITHHELD = '(withheld: it holds a credential)';
/** A reference to a variable (`${API_KEY}`) in a value names where the value comes from; the name itself is still checked. */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** A path a plugin server may name inside its own folder: absolute, with none of the characters a list or a second path is written with. */
const PLAIN_PATH = /^\/[^\s,;:=|"'`<>()[\]{}]*$/;
const MOVES_CACHE = 'It moves its sign-in token cache, or its data folder, through its own config, so it is never started, enabled or offered.';
const REACHES = 'It is started in, or names, a place that holds credentials or sign-in tokens, so it is never started, enabled or offered.';
const ENABLE_FIRST = 'Enable it to list its tools: a plugin\'s server runs its command only once you turn it on.';
/** A string as a server would read it: percent-decoded, a few times over. */
const decodedArg = (s: string) => { let x = s; for (let i = 0; i < 3; i++) { try { const d = decodeURIComponent(x); if (d === x) break; x = d; } catch { break; } } return x; };

export class ConnectorService {
  readonly catalogue: CatalogueController;
  /** One session per server, for exactly the launch it was opened with (values included, in memory only). */
  private readonly enableKey = randomBytes(32);
  private readonly sessions = new Map<string, { identity: string; session: Promise<McpSession> }>();
  private closed = false;
  private readonly endDrains = new Set<Promise<void>>();
  private readonly options: ConnectorServiceOptions;
  /** The stored credentials as last read: undefined before the first read, null when it failed. */
  private stored: readonly string[] | null | undefined;
  /**
   * Plugin server grants seen changed (another launch) or gone, by server id, with the launch they were
   * for: off from the moment they are seen, and kept for the life of the process until the removal is written.
   */
  private readonly revoked = new Map<string, string>();
  constructor(options: ConnectorServiceOptions) {
    this.options = options;
    this.catalogue = new CatalogueController(options.home, options.keys, { service: this, stop: id => this.stopCatalogue(id), admission: () => options.policyAdmission?.(), launch: id => this.lookup(id), session: (id, d) => this.session(id, d) }, options.catalogueRuntime);
    if (options.reconcileOnOpen !== false) void this.ready().catch(() => {});
  }

  /**
   * Read the stored credentials again, which plugin servers are checked against, and write down the end of
   * every plugin server grant whose launch changed or whose server is gone. A failed plugin removal
   * keeps that grant off for the life of the process. A pending Core end is retried before further work;
   * a failure refuses that work while local authority stays removed.
   */
  async ready(): Promise<void> {
    const found = new Map(this.found().map((d) => [d.server.id, d]));
    const s = this.load();
    for (const [id, choice] of Object.entries(s.servers)) {
      if (!choice.enabled || !/^(claude|codex)-plugin:/.test(id)) continue;
      const d = found.get(id);
      if (!d || d.server.fingerprint !== choice.fingerprint) this.revoked.set(id, choice.fingerprint);
    }
    // Old file-only signatures cannot become Core authority. Invalidated Core signatures close
    // durably too, even when no explicit settings mutation discovers the change.
    const invalid = Object.entries(s.servers).some(([id, c]) => Object.entries(c.tools).some(([name, t]) =>
      t.standing && (t.standing.core !== 1 || t.standing.home !== this.canonicalHome() || !found.get(id))));
    if (invalid || s.pendingEnds?.length) await this.change((current) => {
      for (const [id, c] of Object.entries(current.servers)) for (const [name, t] of Object.entries(c.tools)) {
        if (t.standing && (t.standing.core !== 1 || t.standing.home !== this.canonicalHome() || !found.get(id))) delete t.standing;
      }
    }, 'definition_changed');
    if (this.revoked.size) {
      const pending = new Map(this.revoked);
      try {
        await this.change((now) => {
          for (const [id, pin] of pending) {
            const c = now.servers[id];
            if (c && c.fingerprint === pin) { c.enabled = false; closeDoor(c, now); }
          }
        }, 'definition_changed');
        for (const [id, pin] of pending) if (this.revoked.get(id) === pin) this.revoked.delete(id);
      } catch { /* kept: those grants stay off */ }
    }
    await this.checkCredentials();
  }

  /** Blocking is decided before any Core work or diagnostic that can mention configuration. */
  private async checkCredentials(): Promise<void> {
    if (this.options.credentials) { try { this.stored = [...await this.options.credentials()]; } catch { this.stored = null; } }
  }

  /** A plugin server's grant that ended: its launch changed since it was enabled, or its end is not yet written. */
  private grantEnded(d: Discovered, choice: ServerChoice | undefined): boolean {
    if (!d.plugin || !choice?.enabled) return false;
    if (this.revoked.get(d.server.id) === choice.fingerprint) return true;
    if (choice.fingerprint !== d.server.fingerprint) { this.revoked.set(d.server.id, choice.fingerprint); return true; }
    return false;
  }

  /**
   * Why a plugin's server must not be started, for any reason (listing, a call): every check an offer makes,
   * before any process exists. A plugin's config is third-party text. The person's own configs' servers may
   * still be started to list their tools, as before, and are never offered when a check fails.
   */
  private startRefusal(d: Discovered): string | undefined {
    if (!d.plugin) return undefined;
    if (movesCredentialCache(d.launch)) return MOVES_CACHE;
    if (this.rootedInCredentials(d)) return REACHES;
    return this.pluginBlock(d);
  }

  /** The id the api shows: a blocked server's says nothing its config wrote. Unblocked servers keep their own, so grants stay. */
  private shownId(d: Discovered): string {
    return this.pluginBlock(d) ? `${d.server.source}:withheld-${createHash('sha256').update(d.server.id).digest('hex').slice(0, 16)}` : d.server.id;
  }

  /** A server by the id the api showed. */
  private lookup(serverId: string): Discovered | null {
    const direct = launchFor(this.options.home, this.options.env(), serverId);
    if (direct) return direct;
    const source = serverId.slice(0, serverId.indexOf(':')) as ServerSource;
    if (!(source in SOURCE_NAMES) || !serverId.includes(':withheld-')) return null;
    return discover(this.options.home, this.options.env(), [source]).find((d) => this.shownId(d) === serverId) ?? null;
  }

  /**
   * Why a plugin's server is blocked, or nothing: a credential, stored or by its shape, in its name, its
   * config entry (every key and string, a variable's value included) or its plugin's manifests. Checked
   * against the credentials as last read; before they are read, or when they cannot be, it is blocked.
   */
  private pluginBlock(d: Discovered): string | undefined {
    if (!d.plugin) return undefined;
    const exact = this.options.credentials ? this.stored : [];
    if (!exact) return PLUGIN_UNCHECKED;
    const { literal, values } = d.plugin;
    // Names, keys, paths and manifests as written; a value with its references taken out, and each reference's name.
    const words = [...literal, ...values.map((v) => v.replace(REFERENCE, '')), ...values.flatMap((v) => [...v.matchAll(REFERENCE)].map((m) => m[1]))];
    // A stored credential is matched in each value as written too: one may itself look like a reference.
    return words.some((w) => holds(w, exact)) || values.some((v) => holdsStored(v, exact)) || holdsStored(words.join('\n'), exact) ? PLUGIN_HOLDS : undefined;
  }

  private rootedInCredentials(d: Discovered): boolean {
    const env = this.options.env().env;
    const base = d.launch.transport === 'stdio' ? resolve(d.launch.cwd ?? process.cwd()) : undefined;
    // A plugin's own install folder is where its server starts from, not a credential it reads.
    // Exempt only where the argument's real location, links followed, stays inside that install folder's real location.
    const plugin = d.plugin ? realish(d.plugin.root) : undefined;
    const own = (a: string) => { if (!plugin || !PLAIN_PATH.test(a)) return false; const r = realish(a); return r === plugin || r.startsWith(`${plugin}/`); };
    // Each argument is judged where the server would find it: relative ones in its folder, always. A path inside
    // its own folder may also be given as `--flag=<path>` or `file://<path>`; only that path, whole, is exempt.
    const at = (a: string) => (a.startsWith('/') ? a : base ? resolve(base, a) : a);
    // Only a string that reads the same percent-decoded is exempt: an encoded `..`, comma or colon fails closed,
    // and the string is then checked, decoded, as any other.
    const ownArg = (a: string) => {
      if (decodedArg(a) !== a) return false;
      const m = /^(?:--?[A-Za-z0-9][\w-]*=|file:\/\/)(\/.*)$/.exec(a);
      return own(at(a)) || (!!m && own(m[1]));
    };
    const command = d.launch.command && d.launch.command.includes('/') && !this.catalogue.store.internalExecutable(d.launch) ? [d.launch.command] : [];
    // A plugin's variables are checked as its arguments are: a server may read a path it is given in one.
    const values = d.plugin ? Object.values(d.launch.env ?? {}) : [];
    return reachesCredentials([...command, ...(d.launch.args ?? []), ...values].filter((a) => !ownArg(a)).concat(base && !own(base) ? [base] : []), env.HOME, { ...process.env, ...env }, base);
  }

  /** A stdio server resolves relative paths in its own folder; a server over HTTP in one nobody here knows. */
  private reachesCredentials(args: unknown, serverId: string): boolean {
    const env = this.options.env().env;
    const d = launchFor(this.options.home, this.options.env(), serverId);
    const base = d?.launch.transport === 'stdio' ? resolve(d.launch.cwd ?? process.cwd()) : undefined;
    return reachesCredentials(args, env.HOME, { ...process.env, ...env }, base)
      || reachesCredentials(args, undefined, { WORKSPACE_MCP_CREDENTIALS_DIR: join(this.options.home, 'connectors', 'google') }, base);
  }

  private get file() { return join(this.options.home, 'connectors', 'mcp.json'); }
  private load(): Stored { return readJson<Stored>(this.file, { servers: {}, held: [] }); }
  private save(s: Stored) { assertHomeWriteAdmission(this.options.home, join(this.options.home, 'connectors')); writeJson(this.file, s); this.options.emit?.(); }
  /** A Core promise is never awaited under the home lock. A removal gives an already
   * available link one event-loop turn; startup or unavailable Core cannot delay local closure. */
  private requestLink(): Promise<CoreLink | undefined> {
    try { return Promise.resolve(this.options.link()).catch(() => undefined); } catch { return Promise.resolve(undefined); }
  }
  private async linkWithin(pending: Promise<CoreLink | undefined>, ms: number): Promise<CoreLink | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([pending, new Promise<undefined>(r => { timer = setTimeout(() => r(undefined), ms); })]); }
    finally { clearTimeout(timer); }
  }
  private async requireLink(): Promise<CoreLink> {
    const link = await this.linkWithin(this.requestLink(), 2_000);
    if (!link) throw new SignatureUnavailable(`${SIGNATURE_LEDGER_VERSION}: Core is unavailable. Run backbone doctor and try again once this data folder's Core can open.`);
    return link;
  }
  private deferEnds(pending: Promise<CoreLink | undefined>): void {
    // Do not inherit a scope that may finish before the callback. A late link takes a fresh lock.
    outsideHomeLocks(() => { void pending.then(link => {
      if (!link || this.closed) return;
      const drain = this.finishSignatureEnds(link);
      this.endDrains.add(drain);
      void drain.catch(() => {}).finally(() => this.endDrains.delete(drain));
    }); });
  }
  private async change<T>(work: (s: Stored) => T, endReason: SignatureEndReason = 'person_revoked', known?: CoreLink): Promise<T> {
    assertHomeWriteAdmission(this.options.home, join(this.options.home, 'connectors'));
    const prior = this.load();
    const needsCore = !!prior.pendingEnds?.length || Object.values(prior.servers).some(c => Object.values(c.tools).some(t => t.standing?.core === 1));
    const pending = known ? Promise.resolve(known) : needsCore ? this.requestLink() : Promise.resolve(undefined);
    const link = known ?? await this.linkWithin(pending, 0);
    for (let attempt = 0; ; attempt++) {
      const plan = await withHomeLock(this.options.home, async () => {
        assertHomeWriteAdmission(this.options.home, join(this.options.home, 'connectors'));
        const s = this.load(), ver = s.ver ?? 0;
        seedGen(s);
        const before = Object.entries(s.servers).flatMap(([server, c]) => Object.entries(c.tools)
          .flatMap(([name, t]) => t.standing ? [{ server, name, signature: t.standing }] : []));
        const found = new Set(this.found().map(d => d.server.id));
        for (const [server, c] of Object.entries(s.servers)) for (const t of Object.values(c.tools)) {
          if (t.standing && (t.standing.core !== 1 || t.standing.home !== this.canonicalHome() || !found.has(server))) delete t.standing;
        }
        const out = work(s);
        const additions = Object.entries(s.servers).flatMap(([server, c]) => Object.entries(c.tools).flatMap(([name, t]) =>
          t.standing && !before.some(b => b.signature.id === t.standing!.id) ? [{ server, c, name, t }] : []));
        return { s, ver, before, out, additions };
      });
      // A give can commit without a usable local grant. Never wait on Core while holding
      // the home lock; an intervening local change makes this tentative grant unused.
      for (const { server, c, name, t } of plan.additions) {
        if (!c.connection) throw new Error('A signature needs its Core connection. Nothing was signed.');
        if (!link) throw new SignatureUnavailable(`${SIGNATURE_LEDGER_VERSION}: Core is unavailable. Run backbone doctor. Nothing was signed.`);
        await this.signatureLink(link);
        standingDecision(governedPolicy(this.options.home), server);
        const id = await link.call<string>(link.person(), 'SELECT gov.give_connector_signature($1::uuid,$2::text,$3::text)',
          [c.connection.id, name, t.standing!.coverageVersion === 1 ? coverageDigest(t.standing!.signedDefinition!) : t.standing!.definition]).catch(error => { throw coreDiagnostic('The Core signature could not be confirmed. Nothing was signed locally. Run backbone doctor before trying again.', error); });
        t.standing = { ...t.standing!, id, core: 1 };
      }
      const saved = await withHomeLock(this.options.home, async () => {
        for (const { server } of plan.additions) standingDecision(governedPolicy(this.options.home), server);
        if ((this.load().ver ?? 0) !== plan.ver) return false;
        const { s } = plan;
        for (const old of plan.before) {
          const next = ownTool(s.servers[old.server], old.name)?.standing;
          if (old.signature.core !== 1 || next?.id === old.signature.id) continue;
          const d = launchFor(this.options.home, this.options.env(), old.server);
          const reason: SignatureEndReason = old.signature.home !== this.canonicalHome() ? 'home_moved'
            : !d || !s.servers[old.server] ? 'connection_removed'
              : !ownTool(s.servers[old.server], old.name) ? 'definition_changed'
              : next ? 'superseded'
                : old.signature.seal !== this.seal(d) || old.signature.definition !== ownTool(s.servers[old.server], old.name)!.definition
                  ? 'definition_changed' : endReason;
          s.pendingEnds ??= [];
          if (!s.pendingEnds.some(p => p.id === old.signature.id)) s.pendingEnds.push({ id: old.signature.id, reason });
        }
        s.ver = plan.ver + 1;
        this.save(s); // Local closure and its pending end are one admitted synchronous write.
        return true;
      });
      if (saved) {
        if (link) await this.finishSignatureEnds(link);
        else if (plan.s.pendingEnds?.length) this.deferEnds(needsCore ? pending : outsideHomeLocks(() => this.requestLink()));
        return plan.out;
      }
      if (attempt >= 2) throw new Error('The connectors record kept changing while it was being changed; nothing was saved. Try again.');
    }
  }
  /** Inspect through the person's read connection; the installer/status hook is separate. An
   * absent receipt or changed exact profile never becomes authority merely because SQL exists. */
  private async signatureStatus(link: CoreLink) {
    return verifyStandingSignatures(link);
  }

  private async signatureLink(link: CoreLink): Promise<CoreLink> {
    const status = await this.signatureStatus(link);
    if (status.state !== 'verified') throw new SignatureUnavailable(`${SIGNATURE_LEDGER_VERSION}: ${status.reason} Run backbone doctor to check this data folder's standing signatures. Update this data folder's Core, or ask its operator to update it. You can release individual calls yourself meanwhile.`);
    return link;
  }

  /** Retry an end after a lost reply or a process death; never erase a newer file version. */
  private async finishSignatureEnds(link: CoreLink): Promise<void> {
    for (;;) {
      const s = this.load(), pending = s.pendingEnds?.[0];
      if (!pending) return;
      assertHomeWriteAdmission(this.options.home, join(this.options.home, 'connectors'));
      const ver = s.ver ?? 0;
      // A missing/unverified step cannot settle this end yet, but local authority is already
      // removed. Keep the pending item without blocking per-call work on an older home.
      if ((await this.signatureStatus(link)).state !== 'verified') return;
      let conflict = false;
      try {
        await link.call(link.person(), 'SELECT gov.end_connector_signature($1::uuid,$2::text)', [pending.id, pending.reason]);
      } catch (error) {
        const reason = (error as { reason?: string }).reason;
        if (reason !== 'not_found' && reason !== 'someone_else') throw coreDiagnostic('The signature end could not be confirmed. Local authority stays closed and its receipt will be retried. Run backbone doctor.', error);
        conflict = reason === 'someone_else';
      }
      await withHomeLock(this.options.home, async () => {
        if ((this.load().ver ?? 0) !== ver) return;
        if (conflict) {
          s.signatureEndConflicts ??= [];
          if (!s.signatureEndConflicts.some(p => p.id === pending.id))
            s.signatureEndConflicts.push({ id: pending.id, reason: pending.reason, outcome: 'someone_else', at: now() });
        }
        s.pendingEnds = s.pendingEnds!.filter(p => p.id !== pending.id);
        if (!s.pendingEnds.length) delete s.pendingEnds;
        s.ver = ver + 1;
        this.save(s);
      });
    }
  }

  private found(): Discovered[] { return discover(this.options.home, this.options.env(), this.options.sources); }

  private view(d: Discovered, s: Stored): ConnectorServer {
    const choice = s.servers[d.server.id];
    const changed = !!choice && choice.fingerprint !== d.server.fingerprint;
    const block = this.pluginBlock(d);
    const tools = block ? [] : Object.values(choice?.tools ?? {}).map((c): ConnectorTool => ({
      name: c.listed.name,
      ...(c.listed.title ? { title: c.listed.title } : {}),
      description: c.listed.description,
      kind: kindOf(c.listed, c.override),
      annotated: annotated(c.listed),
      ...(c.override ? { override: c.override } : {}),
      enabled: c.enabled && c.definition === definitionOf(c.listed),
      ...(c.definition !== definitionOf(c.listed) ? { changed: true } : {}),
      ...(blocked(c.listed.name) ? { blocklisted: true as const } : {}),
      ...(c.listed.annotations.destructiveHint === true ? { destructive: true as const } : {}),
      ...((sig) => (sig ? { standing: { ...(CORE_ID.test(sig.id) ? { id: sig.id } : {}), at: sig.at, ...(sig.blockedToo ? { blockedToo: true as const } : {}) } } : {}))(this.signed(d, choice, c.listed.name)),
    })).sort((a, b) => a.name.localeCompare(b.name));
    const ended = this.grantEnded(d, choice);
    // A blocked plugin server shows nothing its plugin wrote: the credential may be in any of it.
    const own = block ? { name: WITHHELD, config: WITHHELD, shown: WITHHELD, envNames: [] } : { name: d.server.name, config: d.server.config, shown: d.server.shown, envNames: d.server.envNames };
    return {
      id: this.shownId(d), source: SOURCE_NAMES[d.server.source], transport: d.server.transport, ...own, ...(d.plugin ? { plugin: true as const } : {}), ...(d.launch.catalogue ? { catalogue: d.launch.catalogue.id } : {}),
      enabled: !!choice?.enabled && !changed && !block && !ended, egress: !!choice?.egress && !!choice.enabled && !changed && !block && !ended, ...(changed ? { changed: true } : {}), ...(block ? { blocked: block } : {}),
      tools, ...(choice?.listedAt ? { listedAt: choice.listedAt } : {}), ...(!block && choice?.problem ? { problem: choice.problem } : {}),
    };
  }

  /** Plugin grants whose server is not found now: ended, as a changed launch's is. */
  private noteMissing(found: Discovered[], s: Stored) {
    const ids = new Set(found.map((d) => d.server.id));
    for (const [id, choice] of Object.entries(s.servers)) if (choice.enabled && /^(claude|codex)-plugin:/.test(id) && !ids.has(id)) this.revoked.set(id, choice.fingerprint);
  }

  /** Old held text can contain credentials learned only after the call was held. */
  private shownHeld(h: StoredHeld): HeldCall {
    const d = this.lookup(h.serverId);
    const block = d ? this.pluginBlock(d) : /^(claude|codex)-plugin:/.test(h.serverId) ? PLUGIN_UNCHECKED : undefined;
    if (!block) return shownHeld(h);
    const serverId = d ? this.shownId(d) : `${h.serverId.split(':')[0]}:withheld-${createHash('sha256').update(h.serverId).digest('hex').slice(0, 16)}`;
    return { ...shownHeld(h), serverId, serverName: WITHHELD, tool: WITHHELD, args: {}, statement: WITHHELD, detail: block };
  }

  list(): ConnectorsView {
    const s = this.load();
    const endings = { pending: (s.pendingEnds ?? []).map(p => p.id), conflicts: (s.signatureEndConflicts ?? []).map(p => p.id) };
    return { servers: this.found().map((d) => this.view(d, s)), held: s.held.slice().reverse().map(h => this.shownHeld(h)), egress: 'per-server',
      ...([...endings.pending, ...endings.conflicts].every(id => CORE_ID.test(id)) ? { signatureEndings: endings } : {}) };
  }


  /** Start the server and list its tools. A tool that changed since it was enabled turns off and says so. */
  async refresh(serverId: string): Promise<Receipt<ConnectorServer>> {
    await this.ready();
    const d = this.lookup(serverId);
    if (!d) return { ok: false, reason: 'NOT_FOUND', outcome: 'REFUSED', detail: 'No such server in the person\'s configs now.' };
    serverId = d.server.id;
    // Listing starts it: every check an offer makes comes first, so a server that would fail one is never started.
    const refusal = this.startRefusal(d);
    if (refusal) return { ok: false, reason: 'INVALID', outcome: 'REFUSED', detail: refusal };
    // A plugin's server runs nothing, not even to list its tools, until the person enables it as it starts now.
    if (d.plugin) {
      const choice = this.load().servers[serverId];
      if (!choice?.enabled || choice.fingerprint !== d.server.fingerprint || this.grantEnded(d, choice)) return { ok: false, reason: 'INVALID', outcome: 'REFUSED', detail: ENABLE_FIRST };
    }
    await this.drop(serverId);
    // A listing overtaken by a later one for the same server, or by a change in how the server starts, is not applied anywhere.
    const seq = (this.refreshSeq.get(serverId) ?? 0) + 1;
    this.refreshSeq.set(serverId, seq);
    const overtaken = () => {
      const cur = launchFor(this.options.home, this.options.env(), serverId);
      return this.refreshSeq.get(serverId) !== seq || !cur || identityOf(cur) !== identityOf(d);
    };
    let listed: ListedTool[] | null = null;
    let problem: string | undefined;
    try {
      const session = await this.session(serverId, d);
      listed = await this.listTools(session);
    } catch (error) {
      problem = error instanceof AmbiguousTools ? 'The server listed duplicate tool names; no unambiguous definition was provided.' : 'The tool listing could not be confirmed.';
      if (error instanceof AmbiguousTools) listed = []; // No definition in an ambiguous list carries authority.
      await this.drop(serverId);
    }
    // A representation-only upgrade does not change the connection catalogue or Core authority.
    if (listed && !problem) {
      const repinned = await withHomeLock(this.options.home, async () => {
        if (overtaken()) return undefined;
        const s = this.load(), choice = s.servers[serverId];
        if (!choice || Object.keys(choice.tools).length !== listed.length) return undefined;
        let upgraded = false;
        for (const live of listed) {
          const t = ownTool(choice, live.name);
          if (!t) return undefined;
          const pin = this.upgradeDefinitionPin(s, serverId, live);
          if (!pin && t.definition !== definitionOf(live)) return undefined;
          upgraded ||= !!pin;
        }
        if (!upgraded) return undefined;
        choice.listedAt = now();
        delete choice.problem;
        s.ver = (s.ver ?? 0) + 1;
        this.save(s);
        return this.view(d, s);
      });
      if (repinned) return { ok: true, value: repinned };
    }
    const known = this.load().servers[serverId]?.connection;
    if (known && !overtaken()) await this.recordTools(known.id, listed, problem).catch(() => {});
    const server = await this.change((s) => {
      const was = s.servers[serverId];
      const choice: ServerChoice = was ?? { enabled: false, fingerprint: d.server.fingerprint, tools: {} };
      // Checked again inside the lock: the choices made since are left exactly as they are.
      if (overtaken()) return this.view(d, s);
      if (listed) {
        const tools: Record<string, ToolChoice> = Object.create(null);
        for (const t of listed) {
          this.upgradeDefinitionPin(s, serverId, t);
          const prior = ownTool(choice, t.name);
          // A tool keeps the person's choice only while its definition is what they saw.
          const same = !!prior && prior.definition === definitionOf(t);
          tools[t.name] = prior
            ? { ...prior, listed: t, enabled: prior.enabled && same }
            : { enabled: false, definition: definitionOf(t), listed: t, rev: nextGen(s) };
          // The person's word that a tool only reads was about the tool they saw: a changed tool loses it (a narrowing to effect stays).
          if (prior && !same && tools[t.name].override === 'read') delete tools[t.name].override;
          // A standing signature was for the tool the person saw.
          if (prior && !same) { delete tools[t.name].standing; tools[t.name].rev = nextGen(s); }
        }
        choice.tools = tools;
        choice.listedAt = now();
        if (problem) choice.problem = problem; else delete choice.problem;
      } else choice.problem = problem;
      s.servers[serverId] = choice;
      return this.view(d, s);
    }, 'definition_changed');
    return { ok: true, value: server };
  }

  async set(serverId: string, patch: { preset?: CataloguePreset; enableStamp?: string; enabled?: boolean; egress?: boolean; /** Opening the door or signing a tool: the seal of the server as the person was shown it. */ seal?: string; tool?: { name: string; enabled?: boolean; override?: 'read' | 'effect' | null; /** The person's standing signature for this tool as they were shown it (`stamp`, from toolView), or `false` to end it. */ standing?: false | { stamp: string; blockedToo?: boolean } } }, enableCheck?: () => boolean): Promise<Receipt<ConnectorServer>> {
    try {
    const narrowing = patch.enabled !== true && patch.egress !== true && patch.tool?.enabled !== true && !patch.tool?.standing && patch.tool?.override === undefined;
    if (!narrowing) await this.checkCredentials();
    const d = this.lookup(serverId);
    if (!d) return { ok: false, reason: 'NOT_FOUND', outcome: 'REFUSED', detail: 'No such server in the person\'s configs now.' };
    serverId = d.server.id;
    const refused = (detail: string): Receipt<ConnectorServer> => ({ ok: false, reason: 'INVALID', outcome: 'REFUSED', detail });
    if (patch.preset && (!d.launch.catalogue || !['reads', 'reads-and-effects'].includes(patch.preset) || patch.enabled !== true || !patch.enableStamp || patch.tool || patch.egress !== undefined)) return refused('Invalid catalogue preset.');
    // A blocked plugin server may only be turned off or closed, and no answer about it says its name.
    const block = this.pluginBlock(d);
    if (block && (patch.tool || patch.enabled || patch.egress) &&
      !(narrowing && patch.tool && Object.hasOwn(this.load().servers[serverId]?.tools ?? {}, patch.tool.name))) return refused(block);
    if (patch.tool?.standing) standingDecision(governedPolicy(this.options.home), serverId);
    const grantLink = patch.tool?.standing ? await this.requireLink() : undefined;
    if (!narrowing) await this.ready();
    // Enabling a plugin's server is consent to run its command: it must pass every check a start makes.
    const refusal = patch.enabled ? this.startRefusal(d) : undefined;
    if (refusal) return refused(refusal);
    // The core keeps it as the person's own connection, private material, from the first time it is enabled.
    let registered: { id: string; slug: string } | undefined;
    const was = this.load().servers[serverId];
    if (patch.enabled && (was?.listedAt || d.plugin) && !was?.connection) {
      try { registered = await this.register(d, Object.values(was?.tools ?? {}).map((t) => t.listed)); }
      catch (error) { return { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'Core could not record this connection. Nothing was enabled.' }; }
    }
    const result = await this.change((s): Receipt<ConnectorServer> => {
      if ((patch.enabled === true || patch.tool?.enabled === true) && enableCheck && !enableCheck()) return refused('The connector changed while you were asked; nothing was turned on. Look again.');
      // A plugin's server is enabled before it is listed: listing runs it. Any other is listed first.
      if (d.plugin && patch.enabled && !s.servers[serverId]) s.servers[serverId] = { enabled: false, fingerprint: d.server.fingerprint, tools: {} };
      const choice = s.servers[serverId];
      // A signature that no longer holds as it was given ends here for good, before anything else is decided.
      // The server as it starts now, read inside the lock: this call may have waited while it changed.
      const cur = launchFor(this.options.home, this.options.env(), serverId);
      const currentBlock = cur ? this.pluginBlock(cur) : block;
      if (currentBlock && !narrowing) return refused(currentBlock);
      if (!choice || (!choice.listedAt && !d.plugin)) return refused('List its tools first, so you see what you enable.');
      if (patch.enableStamp !== undefined && (!cur || patch.enableStamp !== this.enableStampFor(cur, choice, patch.tool?.name))) return refused('The connection or tool changed while you were asked. Nothing was enabled; look again.');
      if (patch.enabled !== undefined || patch.egress !== undefined) choice.rev = nextGen(s);
      if (registered && !choice.connection) choice.connection = registered;
      if (patch.enabled !== undefined) {
        // The door is consent to this server as it started when it was opened: turned off, or started otherwise, it closes.
        if (!patch.enabled || choice.fingerprint !== d.server.fingerprint) closeDoor(choice, s);
        choice.enabled = patch.enabled;
        // Enabling is consent to how it starts now: a new grant, whatever ended before.
        if (patch.enabled) {
          choice.fingerprint = d.server.fingerprint; this.revoked.delete(serverId);
          assertHomeWriteAdmission(this.options.home, join(this.options.home, 'connectors'));
          mkdirSync(join(this.options.home, 'connectors'), { recursive: true }); this.seal(d);
        }
      }
      if (patch.egress !== undefined) {
        if (patch.egress && (!choice.enabled || choice.fingerprint !== d.server.fingerprint)) return refused('Enable the server first; the egress door opens only on a server that is on as it starts now.');
        if (patch.egress && patch.seal !== this.seal(d)) return refused('How the server starts, or its account, changed while you were asked; nothing was opened. Look again.');
        if (patch.egress) { choice.egress = true; choice.egressSeal = this.seal(d); } else closeDoor(choice, s);
      }
      if (patch.preset && cur?.launch.catalogue) { closeDoor(choice, s); applyCataloguePreset(cur.launch.catalogue.id, choice.tools, patch.preset, () => nextGen(s)); }
      if (patch.tool) {
        const t = ownTool(choice, patch.tool.name);
        if (!t) return refused(currentBlock ?? `${d.server.name} has no tool named ${patch.tool.name}.`);
        // What a question about this tool was asked on, before this call changes anything.
        const asked = cur ? this.stamp(cur, choice, t) : undefined;
        // A tool whose name or kind is for sending, deleting, paying or publishing is never a read, whoever says so.
        if (patch.tool.override === 'read' && blocked(t.listed.name)) return refused(`${t.listed.name} is the kind of tool that is never a read.`);
        if (patch.tool.override !== undefined) {
          if (patch.tool.override === null) delete t.override; else t.override = patch.tool.override;
          // What the tool counts as changed, so the signature given for it as it was ends.
          delete t.standing;
        }
        if (patch.tool.enabled !== undefined) {
          t.enabled = patch.tool.enabled;
          // Enabling is consent to the definition the person sees now.
          if (patch.tool.enabled) t.definition = definitionOf(t.listed);
          else delete t.standing;
        }
        if (patch.tool.standing === false) delete t.standing;
        else if (patch.tool.standing) {
          standingDecision(governedPolicy(this.options.home), serverId);
          // One signature forms the capability: this tool, as defined now, on this server as it starts now, through its open door.
          if (!cur) return refused('This server is no longer in your configs; nothing was signed.');
          const seal = this.seal(cur);
          if (!choice.enabled || choice.fingerprint !== cur.server.fingerprint || choice.egress !== true || choice.egressSeal !== seal) return refused('Allow sending to this server first; a tool is signed only on a server whose door is open as it starts now.');
          if (patch.seal !== seal) return refused('How the server starts, or its account, changed while you were asked; nothing was signed. Look again.');
          if (!t.enabled || t.definition !== definitionOf(t.listed)) return refused(`Turn ${t.listed.name} on first, as it is defined now.`);
          // The click signs what the person was shown: the same definition, kind, door and choices, with nothing turned off and on, ended or reopened while the question was open.
          if (patch.tool.standing.stamp !== asked) return refused(`${t.listed.name} or its server changed while you were asked; nothing was signed. Look again.`);
          if (kindOf(t.listed, t.override) !== 'effect') return refused(`${t.listed.name} only reads, so it already runs without asking.`);
          t.standing = { coverageVersion: 1, signedDefinition: t.definition, core: 1, id: randomUUID(), definition: t.definition, seal, home: this.canonicalHome(), at: now(), ...(patch.tool.standing.blockedToo === true ? { blockedToo: true as const } : {}) };
        }
        t.rev = nextGen(s);
      }
      return { ok: true, value: this.view(cur ?? d, s) };
    }, patch.tool?.override !== undefined ? 'definition_changed' : 'person_revoked', grantLink);
    if (patch.enabled === false) await this.drop(serverId);
    return result;
    } catch (error) {
      if (error instanceof SignatureUnavailable) return { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: error.message };
      throw error;
    }
  }

  /** Stored-only end: local acknowledgement, never a claim of Core confirmation. */
  async endStoredSignature(serverId: string, tool: string): Promise<Receipt<{ ended: true }>> {
    const id = this.lookup(serverId)?.server.id ?? serverId;
    const found = await this.change(s => {
      const t = ownTool(s.servers[id], tool); if (!t) return false;
      delete t.standing; t.rev = nextGen(s); return true;
    });
    return found ? { ok: true, value: { ended: true } }
      : { ok: false, reason: 'NOT_FOUND', outcome: 'REFUSED', detail: 'No stored tool was found.' };
  }

  /** A per-process opaque question stamp, including complete launch values without publishing
   * a credential digest. Reads create no home key. Another Host/restart needs a new question. */
  enableStamp(serverId: string, tool?: string): string | null {
    const d = this.lookup(serverId);
    return d && !this.pluginBlock(d) ? this.enableStampFor(d, this.load().servers[d.server.id], tool) : null;
  }

  private enableStampFor(d: Discovered, choice: ServerChoice | undefined, tool?: string): string | null {
    if (tool !== undefined && !ownTool(choice, tool)) return null;
    return createHmac('sha256', this.enableKey).update(JSON.stringify([d.launch, choice?.enabled ?? false, choice?.rev ?? 0, tool ?? null,
      Object.entries(choice?.tools ?? {}).map(([name, t]) => [name, t.enabled, t.definition, kindOf(t.listed, t.override), t.rev ?? 0])])).digest('hex');
  }

  /** What an engine may call now: enabled tools of enabled servers that still start as the person saw. */
  offered(): OfferedTool[] {
    const s = this.load();
    const out: OfferedTool[] = [];
    const names = new Set<string>();
    const found = this.found();
    this.noteMissing(found, s);
    for (const d of found) {
      // A grant whose launch changed ends before anything else is looked at, so no later skip hides the change.
      if (this.grantEnded(d, s.servers[d.server.id])) continue;
      // A server that keeps its sign-in tokens somewhere it chose is never offered: the deny list cannot be shown to cover it.
      if (movesCredentialCache(d.launch) && !this.catalogue.store.ownedGoogleCache(d.launch)) continue;
      // Nor one started inside, or pointed at, a credential place: it could serve a file there by a bare name.
      if (this.rootedInCredentials(d)) continue;
      // Nor a plugin's server holding a credential, or not yet checked.
      if (this.pluginBlock(d)) continue;
      const choice = s.servers[d.server.id];
      if (!choice?.enabled || !choice.connection || choice.fingerprint !== d.server.fingerprint) continue;
      for (const c of Object.values(choice.tools)) {
        if (!c.enabled || c.definition !== definitionOf(c.listed)) continue;
        let name = offeredName(d.server.name, c.listed.name);
        for (let i = 2; names.has(name); i++) name = `${offeredName(d.server.name, c.listed.name).slice(0, 60)}_${i}`;
        names.add(name);
        out.push({ name, serverId: d.server.id, connection: choice.connection, serverName: d.server.name, tool: c.listed.name, description: c.listed.description, inputSchema: c.listed.inputSchema, kind: kindOf(c.listed, c.override), launch: identityOf(d), definition: c.definition });
      }
    }
    return out;
  }

  /**
   * One call from a turn. The tool is checked again against the person's choice and the server's
   * live definition first, so a tool swapped since it was enabled is never called.
   */
  async call(tool: OfferedTool, args: Record<string, unknown>, core: ConnectorCore, origin: { threadId: string; turnId: string; seq: number; readOnly?: boolean; invocation?: ConnectorInvocation }, signal: AbortSignal): Promise<ConnectorOutcome> {
    const prepared = prepareGmailSend(tool.tool, structuredClone(args), this.lookup(tool.serverId)?.launch, tool.serverId);
    if (!prepared.ok) return { outcome: 'REFUSED', detail: prepared.detail };
    args = prepared.args;
    await this.ready();
    const discovered = this.lookup(tool.serverId), block = discovered && this.pluginBlock(discovered);
    if (block) return { outcome: 'REFUSED', detail: block };
    // A review or judge turn only reads: a tool that has become an effect since it was offered is refused, not held.
    const holdOrRefuse = (t: OfferedTool): Promise<ConnectorOutcome> => origin.readOnly
      ? Promise.resolve({ outcome: 'REFUSED', detail: `${t.tool} on ${t.serverName} now counts as an action, and this turn only reads, so it was not called.` })
      : this.hold(t, args, { threadId: origin.threadId, turnId: origin.turnId, seq: origin.seq }, prepared.intentArgs);
    let current = this.offered().find((t) => t.serverId === tool.serverId && t.tool === tool.tool);
    if (!current) return { outcome: 'REFUSED', detail: `${tool.tool} on ${tool.serverName} is not enabled now. Nothing was called.` };
    if (this.reachesCredentials(args, tool.serverId)) return { outcome: 'REFUSED', detail: `An argument of ${tool.tool} names a place that holds credentials or sign-in tokens, so it was not called. Do not ask again under other words.` };
    // The offer an engine holds names one definition and one launch: a tool or server changed since then is another one, never called in its
    // place. A changed definition is refused here; a changed launch below, after the live listing has turned off a tool that changed with it.
    if (current.definition !== tool.definition) return { outcome: 'REFUSED', detail: `${tool.tool} on ${tool.serverName} changed since it was offered to this turn, so it was not called. A later turn is offered it as it is now.` };
    const stored = ownTool(this.load().servers[tool.serverId], tool.tool);
    if (stored && stored.listed.definitionDigestVersion !== 1) {
      const d = launchFor(this.options.home, this.options.env(), tool.serverId);
      try {
        if (!d) throw new Error('The server is no longer configured.');
        const live = (await this.listTools(await this.session(tool.serverId, d))).find(t => t.name === tool.tool);
        const upgraded = live && await this.repinDefinition(tool.serverId, live);
        if (upgraded && tool.definition === upgraded.from) tool = { ...tool, definition: upgraded.to };
        current = this.offered().find(t => t.serverId === tool.serverId && t.tool === tool.tool);
        if (!live || !current || definitionOf(live) !== current.definition || current.definition !== tool.definition) {
          await this.retireDefinition(tool.serverId, tool.tool);
          await this.refresh(tool.serverId);
          return { outcome: 'REFUSED', detail: 'The tool definition changed since it was enabled; it was turned off and nothing was called.' };
        }
      } catch (error) {
        if (error instanceof AmbiguousTools) await this.retireDefinition(tool.serverId, tool.tool);
        await this.drop(tool.serverId);
        return { outcome: 'REFUSED', detail: 'The tool definition could not be checked for upgrade; nothing was called.' };
      }
    }
    if (current.kind === 'effect') return holdOrRefuse(current);
    const d = launchFor(this.options.home, this.options.env(), tool.serverId);
    if (!d) return { outcome: 'REFUSED', detail: `${tool.serverName} is no longer in the person's configs. Nothing was called.` };
    let session: McpSession;
    try {
      session = await this.session(tool.serverId, d);
      const live = (await this.listTools(session)).find((t) => t.name === tool.tool);
      const pinned = ownTool(this.load().servers[tool.serverId], tool.tool)?.definition;
      if (!live || definitionOf(live) !== pinned || pinned !== tool.definition) {
        await this.retireDefinition(tool.serverId, tool.tool);
        await this.refresh(tool.serverId);
        return { outcome: 'REFUSED', detail: `${tool.tool} on ${tool.serverName} changed since the person enabled it, so it was turned off and not called. They can look at it and enable it again.` };
      }
    } catch (error) {
      if (error instanceof AmbiguousTools) await this.retireDefinition(tool.serverId, tool.tool);
      await this.drop(tool.serverId);
      return { outcome: 'REFUSED', detail: `${tool.serverName} could not be prepared for a tool call. No tool result was observed and nothing can be said about what exists.` };
    }
    // Everything the person chose is checked again here, after every wait and right before the call
    // goes out: still on, still a read, and the server still starts exactly as this session did.
    const still = this.offered().find((t) => t.serverId === tool.serverId && t.tool === tool.tool);
    const now = launchFor(this.options.home, this.options.env(), tool.serverId);
    if (!still || !sameOffer(still, tool) || !now || identityOf(now) !== tool.launch || identityOf(now) !== this.sessions.get(tool.serverId)?.identity) {
      return { outcome: 'REFUSED', detail: `${tool.tool} on ${tool.serverName} changed while it was being called, so it was not called.` };
    }
    if (still.kind === 'effect') return holdOrRefuse(still);
    const result = await core.readObserved({
      tool, args, invocation: origin.invocation, signal,
      stillOffered: () => {
        const latest = this.offered().find(t => t.serverId === tool.serverId && t.tool === tool.tool);
        const launch = launchFor(this.options.home, this.options.env(), tool.serverId);
        return !!latest && latest.kind === 'read' && sameOffer(latest, tool) && !!launch
          && identityOf(launch) === tool.launch && identityOf(launch) === this.sessions.get(tool.serverId)?.identity;
      },
      perform: () => session.call(tool.tool, args, signal, this.options.callTimeoutMs),
    });
    // The composition has already retained an observed result, or durable dispatch uncertainty,
    // before session cleanup can wait. Neither a diagnostic nor cleanup creates a source.
    if (result.outcome === 'UNKNOWN' || (result.outcome === 'READ' && (result.status === 'timed-out' || result.status === 'failed'))) await this.drop(tool.serverId);
    return result;
  }

  /**
   * Proposed under a short run of the host's own direct grant, not the turn's: an engine's run is
   * capped to the operations its piece declares, and a person's server is none of them. Class 5
   * waits for a person's decision in the core whatever the grant. That decision is asked for each
   * call, unless the person signed this tool beforehand (ToolChoice.standing): then their approval
   * is recorded on that signature and the call goes out at once (settle). The same call from the
   * same turn is the same held call.
   */
  private async hold(tool: OfferedTool, args: Record<string, unknown>, origin: { threadId: string; turnId: string; seq: number }, intentArgs = args): Promise<ConnectorOutcome> {
    assertHomeWriteAdmission(this.options.home, join(this.options.home, 'connectors'));
    const statement = statementOf(tool.serverName, tool.tool, args);
    const keyOf = (input: Record<string, unknown>) => `${origin.turnId}:mcp:${createHash('sha256').update(JSON.stringify([tool.serverId, tool.tool, input])).digest('hex').slice(0, 32)}`;
    const key = keyOf(args); // New calls use normalized content; legacy keys only locate existing receipts.
    const earlier = this.load().held.find(h => h.key === key || h.key === keyOf(intentArgs)
      || intentArgs !== args && h.turnId === origin.turnId && h.serverId === tool.serverId && h.tool === tool.tool && gmailIntentJson(h.args) === gmailIntentJson(args));
    if (earlier) return this.settle(earlier);
    let proposed: Awaited<ReturnType<CoreLink['proposeConnectorEffect']>>;
    try {
      const link = await this.requireLink();
      const consumed = await recoverReplacementOrphans(link, this.load().held);
      if (consumed.length) await this.change(s => { for (const h of s.held) if (consumed.includes(h.effect)) delete h.replacementKey; });
      const h = await link.startRun(await this.heldTask(link));
      try { proposed = await link.proposeConnectorEffect(h, `mcp.${tool.connection.slug}.${tool.tool}`, args, statement, key); }
      finally { await link.finishRun(h, 'succeeded').catch(() => {}); }
    } catch (error) {
      return { outcome: 'REFUSED', detail: 'Core could not record this call. Nothing was sent.' };
    }
    if (proposed.status !== 'awaiting_checker') {
      return { outcome: 'REFUSED', detail: proposed.status === 'denied' ? 'Core refused this call. Nothing was sent.' : 'This call was not held for the person, so it was not sent.' };
    }
    await this.change((s) => {
      if (s.held.some((h) => h.effect === proposed.effect)) return;
      s.held.push({ key, definition: tool.definition, launch: tool.launch, effect: proposed.effect, serverId: tool.serverId, serverName: tool.serverName, tool: tool.tool, args, argsHash: proposed.argsHash, statement,
        threadId: origin.threadId, turnId: origin.turnId, at: now(), state: 'waiting', detail: 'Waiting for the person. Outside writes are closed, so nothing will be sent.' });
    });
    observeEffect(this.options.home, { effect: proposed.effect, ...origin }, 'proposed');
    observeEffect(this.options.home, { effect: proposed.effect, ...origin }, 'held');
    return this.settle(this.load().held.find((h) => h.effect === proposed.effect)!);
  }

  /**
   * What a turn is told about its held call. Under the person's standing signature for the tool a
   * waiting call is released now, on that signature, and its real outcome is returned; a failure to
   * do so leaves it waiting for the person, never sent twice. Without a signature it waits.
   */
  private async settle(held: StoredHeld): Promise<ConnectorOutcome> {
    let h: HeldCall = held;
    // Under a signature, or with a word already written for this call before a crash: decided now, on that word.
    if (h.state === 'waiting' && (held.approval || this.standing(h.serverId, h.tool))) {
      const r = await this.resolve(h.effect, h.argsHash, 'release', true).catch(() => undefined);
      if (r?.ok) h = r.value;
      else if (r) return { outcome: 'HELD', effect: h.effect, detail: r.detail };
    }
    if (h.state === 'sent' || h.state === 'failed' || h.state === 'unknown') return { outcome: 'SENT', effect: h.effect, state: h.state, detail: h.detail, standing: h.standing === true };
    if (h.state === 'waiting') return { outcome: 'HELD', effect: h.effect, detail: [CONNECTION_UNKNOWN, TOOL_DISPATCHING, CALL_DISPATCHING, LEGACY_ARGUMENTS].includes(h.detail) ? h.detail : HELD_NEXT };
    return { outcome: 'REFUSED', detail: h.detail };
  }

  /** The person's standing signature for a tool, only while everything it was given on still holds. */
  private signed(d: Discovered, choice: ServerChoice | undefined, name: string): Signature | undefined {
    const t = ownTool(choice, name);
    try { if (t?.standing) standingDecision(governedPolicy(this.options.home), d.server.id); }
    catch (error) { if (error instanceof PolicyRefused && error.code === 'requirement') return undefined; throw error; }
    if (!choice?.enabled || choice.egress !== true || choice.fingerprint !== d.server.fingerprint || !t?.enabled || t.standing?.core !== 1) return undefined;
    if (t.standing.home !== this.canonicalHome()) return undefined;
    if (t.definition !== definitionOf(t.listed) || t.standing.definition !== t.definition || kindOf(t.listed, t.override) !== 'effect') return undefined;
    const seal = this.existingSeal(d);
    return !!seal && choice.egressSeal === seal && t.standing.seal === seal ? t.standing : undefined;
  }

  private standing(serverId: string, tool: string): Signature | undefined {
    const d = launchFor(this.options.home, this.options.env(), serverId);
    return d ? this.signed(d, this.load().servers[serverId], tool) : undefined;
  }

  private canonicalHome(): string {
    try { return realpathSync(this.options.home); } catch { return resolve(this.options.home); }
  }

  /** What a question about one tool is asked on: its definition and kind, the door's seal, and every change of choice since. */
  private stamp(d: Discovered, choice: ServerChoice, t: ToolChoice): string {
    return createHash('sha256').update(JSON.stringify([this.existingSeal(d), t.definition, kindOf(t.listed, t.override), t.override ?? '', choice.rev ?? 0, t.rev ?? 0])).digest('hex');
  }

  /** Calls being decided now: one decision at a time per call, so none overwrites another's outcome. */
  private deciding = new Set<string>();
  /** The latest listing started for each server: an earlier one that finishes later is dropped. */
  private refreshSeq = new Map<string, number>();

  /** The person's answer, on the exact statement they were shown (its args hash). */
  decide(effect: string, argsHash: string, verdict: 'release' | 'discard'): Promise<Receipt<HeldCall>> {
    return this.resolve(effect, argsHash, verdict, false);
  }

  /** Trusted person boundary only: never exported through ToolHost or Host.call. */
  async unknownQuestion(effect: string, argsHash: string): Promise<Receipt<ConnectorEffectQuestion>> {
    await this.checkCredentials();
    const held = this.load().held.find(h => h.effect === effect);
    const d = held && this.lookup(held.serverId);
    if (!held || held.argsHash !== argsHash) return { ok: false, reason: 'INVALID', outcome: 'REFUSED', detail: 'No such unknown call on that exact statement.' };
    if ((d && this.pluginBlock(d)) || (!d && /^(claude|codex)-plugin:/.test(held.serverId)))
      return { ok: false, reason: 'INVALID', outcome: 'REFUSED', detail: 'This connection is withheld; no statement can be shown.' };
    return { ok: true, value: { effect, argsHash, statement: held.statement } };
  }

  /** Verify the exact person's reconciliation in Core; the editable local receipt alone is not authority. */
  async reconciledTurnEffect(threadId: string, turnId: string, effect: string): Promise<boolean> {
    try {
      const held = this.load().held.find(h => h.effect === effect && h.threadId === threadId && h.turnId === turnId);
      const receipt = held?.resolution;
      if (!held || !receipt || receipt.effect !== effect || receipt.state !== 'recorded' || !receipt.ledger || !['happened', 'did_not_happen'].includes(receipt.answer)) return false;
      const outcome = receipt.answer === 'happened' ? 'succeeded' : 'failed';
      const note = `Person inspection ${receipt.id}: ${receipt.answer}. The original call remains closed and is never resent.`;
      const link = await this.requireLink();
      if (!await link.connectorStatementMatches(effect, held.argsHash, held.args, held.statement)) return false;
      const witness = await link.read<{ seq: string; hash: string }>(link.person(), `SELECT l.seq::text, l.hash FROM app.ledger l JOIN app.effects e
        ON e.workspace_id = l.workspace_id AND e.id::text = l.subject
        WHERE e.id = $1 AND e.args_hash = $2 AND e.note = $3 AND e.status = $4 AND e.settled_by = $5
          AND l.entry_type = 'effect.reconciled' AND l.actor_id = $5
          AND l.payload->>'outcome' = $4 AND gov.ledger_words_match(l.seq, 'note', $3)`, [effect, held.argsHash, note, outcome, link.id.person]);
      return witness.rows.length === 1 && witness.rows[0].seq === receipt.ledger.seq && witness.rows[0].hash === receipt.ledger.hash;
    } catch { return false; }
  }

  /** The person's three answers never dispatch anything. Core is the pause authority; the
   * local record holds the exact intent before crossing and its receipt afterwards. An uncertain
   * answer keeps Core UNKNOWN. A lost reconciliation reply is recovered by its ledger witness,
   * never by repeating a provider call or inventing a positive result. */
  async resolveUnknown(effect: string, argsHash: string, answer: ConnectorEffectAnswer): Promise<Receipt<ConnectorEffectResolution>> {
    const refused = (detail: string): Receipt<ConnectorEffectResolution> => ({ ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail });
    if (this.closed) return refused('The Host is closing. Nothing was resolved.');
    if (!['happened', 'did_not_happen', 'keep_closed'].includes(answer)) return refused('Choose what happened, or keep the outcome unknown and closed.');
    assertHomeWriteAdmission(this.options.home, join(this.options.home, 'connectors'));
    const question = await this.unknownQuestion(effect, argsHash);
    if (!question.ok) return question;
    if (this.deciding.has(effect)) return refused('This call is being decided now. Check its receipt.');
    this.deciding.add(effect);
    try {
      const link = await this.requireLink();
      const { rows } = await link.read<{ status: string; args_hash: string }>(link.person(), 'SELECT status, args_hash FROM app.effects WHERE id = $1', [effect]);
      const row = rows[0];
      if (!row || row.args_hash !== argsHash) return refused('Core holds another statement. Nothing was resolved.');
      const original = this.load().held.find(h => h.effect === effect);
      if (!original || !(await link.connectorStatementMatches(effect, argsHash, original.args, original.statement))) return refused('The retained statement changed. Nothing was resolved.');
      const receipt = await withHomeLock(this.options.home, async () => {
        const s = this.load(), h = s.held.find(h => h.effect === effect);
        if (!h || h.argsHash !== argsHash) return undefined;
        if (h.resolution && h.resolution.answer === answer) return h.resolution;
        if (row.status !== 'unknown' || h.resolution?.state === 'pending') return undefined;
        h.resolution = { id: randomUUID(), effect, answer, at: now(), state: answer === 'keep_closed' ? 'recorded' : 'pending' };
        s.ver = (s.ver ?? 0) + 1; this.save(s);
        return h.resolution;
      });
      if (!receipt) return refused('This outcome is not open for that answer. Check its receipt.');
      if (answer === 'keep_closed') return { ok: true, value: receipt };
      const outcome = answer === 'happened' ? 'succeeded' : 'failed';
      const note = `Person inspection ${receipt.id}: ${answer}. The original call remains closed and is never resent.`;
      if (row.status === 'unknown') {
        // Admission again after waits, before the only effectful crossing. Never under the home lock.
        assertHomeWriteAdmission(this.options.home, join(this.options.home, 'connectors'));
        await link.call(link.person(), 'SELECT gov.reconcile_effect($1, $2, NULL, $3, $4)',
          [effect, outcome, createHash('sha256').update(note).digest('hex'), note]).catch(() => {});
      }
      const witness = await link.read<{ seq: string; hash: string }>(link.person(), `SELECT l.seq::text, l.hash FROM app.ledger l JOIN app.effects e
        ON e.workspace_id = l.workspace_id AND e.id::text = l.subject
        WHERE e.id = $1 AND e.args_hash = $2 AND e.note = $3 AND e.status = $4 AND e.settled_by = $5
          AND l.entry_type = 'effect.reconciled' AND l.actor_id = $5
          AND l.payload->>'outcome' = $4 AND gov.ledger_words_match(l.seq, 'note', $3)`, [effect, argsHash, note, outcome, link.id.person]);
      if (witness.rows.length !== 1) return refused('The resolution could not be confirmed. The original call is never resent; inspect its receipt.');
      const recorded = await withHomeLock(this.options.home, async () => {
        const s = this.load(), h = s.held.find(h => h.effect === effect);
        if (!h || h.resolution?.id !== receipt.id) return undefined;
        h.resolution = { ...receipt, state: 'recorded', ledger: witness.rows[0] };
        h.state = outcome === 'succeeded' ? 'sent' : 'failed';
        h.detail = answer === 'happened' ? 'You confirmed this call happened. It is never sent again.' : 'You confirmed this call did not happen. It is never sent again.';
        s.ver = (s.ver ?? 0) + 1; this.save(s);
        return h.resolution;
      });
      return recorded ? { ok: true, value: recorded } : refused('The local receipt changed. Core history is retained; the original call is never resent.');
    } catch { return refused('The resolution could not be confirmed. Check its receipt; the original call is never resent.'); }
    finally { this.deciding.delete(effect); }
  }

  /**
   * One decision on a held call. `standing` is the host answering on the person's standing
   * signature for the tool, never a caller's claim: the signature is read again here, and without
   * it the call is left waiting.
   */
  private async resolve(effect: string, argsHash: string, verdict: 'release' | 'discard', standing: boolean): Promise<Receipt<HeldCall>> {
    assertHomeWriteAdmission(this.options.home, join(this.options.home, 'connectors'));
    const shown = (h: StoredHeld) => this.shownHeld(h);
    const held = this.load().held.find((h) => h.effect === effect);
    if (!held) return { ok: false, reason: 'NOT_FOUND', outcome: 'REFUSED', detail: 'No such held call.' };
    if (held.argsHash !== argsHash) return { ok: false, reason: 'INVALID', outcome: 'REFUSED', detail: 'That is not the statement this call holds. Nothing was decided.' };
    if (held.state !== 'waiting') return { ok: true, value: shown(held) };
    if (this.deciding.has(effect)) return { ok: true, value: { ...shown(held), detail: 'This call is being decided now; its outcome follows.' } };
    this.deciding.add(effect);
    try {
      // A failure here must release the deciding guard just like any later failure.
      if (verdict === 'release') {
        await this.ready();
        const d = this.lookup(held.serverId), block = d && this.pluginBlock(d);
        if (block) return { ok: false, reason: 'INVALID', outcome: 'REFUSED', detail: block };
      }
      const link = await this.options.link();
      const { rows } = await link.read<{ status: string; decision_id: string | null; args_hash: string }>(link.person(), 'SELECT status, decision_id, args_hash FROM app.effects WHERE id = $1', [effect]);
      const row = rows[0];
      if (!row || row.args_hash !== argsHash) return { ok: false, reason: 'INVALID', outcome: 'REFUSED', detail: 'The core holds another statement for this call. Nothing was decided.' };
      if (verdict === 'release' && !(await link.connectorStatementMatches(effect, argsHash, held.args, held.statement))) return { ok: false, reason: 'INVALID', outcome: 'REFUSED', detail: 'The arguments or statement changed. Nothing was sent; inspect the original proposal.' };
      // Past its decision already (a crash after it went out, before this record was written): the core says what became of it.
      const settled = this.fromCore(row.status, held)
        ?? (row.status === 'cancelled' ? { state: verdict === 'discard' ? 'discarded' as const : 'released' as const, detail: 'It was cancelled before it went out. Nothing was sent.' } : undefined);
      if (settled) return { ok: true, value: await this.record(effect, settled, shown) };
      const refusal = verdict === 'release' && gmailSendRefusal(held.tool, held.args, this.lookup(held.serverId)?.launch, held.serverId);
      if (refusal) return { ok: false, reason: 'INVALID', outcome: 'REFUSED', detail: refusal };
      if (!standing && verdict === 'release') {
        const basis = await link.call<string | null>(link.person(), "SELECT payload->'basis'->>'method' FROM app.ledger WHERE entry_type = 'decision.answered' AND subject = $1", [row.decision_id]);
        if (held.approval?.by === 'standing' || basis === 'standing_signature') return await this.personProposal(link, held).catch(() => ({ ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'The person’s replacement release could not be confirmed. Nothing is retried; inspect its receipt.' }));
      }
      if (standing && verdict !== 'release') return { ok: true, value: { ...shown(held), detail: STANDING_ENDED } };
      // Read Core before taking the local lock. Its crossing remains the authority for
      // the decision; the locked local word is immutable, and send rechecks it after waits.
      let approval: Approval | undefined;
      const { rows: nowRows } = await link.read<{ status: string; decision_id: string | null }>(link.person(), 'SELECT status, decision_id FROM app.effects WHERE id = $1', [effect]);
      const status = nowRows[0]?.status ?? '', decision = nowRows[0]?.decision_id ?? null;
      const waiting = status === 'awaiting_checker' && !!decision;
      // A file-only person approval is a recovery hint, never a fresh person's answer.
      // A genuine lost answer may already be allowed in Core; otherwise only a new person
      // action may complete it. An engine cannot turn a hand-written hint into that action.
      if (standing && held.approval?.by === 'person') {
        const basis = await link.read<{ method: string | null }>(link.person(), "SELECT payload->'basis'->>'method' AS method FROM app.ledger WHERE entry_type = 'decision.answered' AND subject = $1", [decision]);
        if (waiting || basis.rows[0]?.method === 'standing_signature') return { ok: true, value: await this.record(effect, { state: 'waiting', detail: await this.pauseDetail(link, effect) ?? HELD_NEXT }, shown) };
      }
      const qualified = (await this.signatureStatus(link)).state === 'verified';
      if (standing) await this.signatureLink(link);
      const candidate = held.approval?.by === 'standing' ? held.approval.signature : standing ? this.standing(held.serverId, held.tool) : undefined;
      // The local marker cannot widen a legacy signature: Core binds the version and original definition.
      if (standing && candidate && sendingArgs(held.args)) {
        const versioned = candidate.coverageVersion === 1 && typeof candidate.signedDefinition === 'string'
          && (await link.call<boolean>(link.person(), "SELECT EXISTS (SELECT FROM app.ledger WHERE entry_type = 'signature.given' AND subject = $1 AND gov.ledger_words_match(seq, 'definition_digest', $2))", [candidate.id, coverageDigest(candidate.signedDefinition)])) === true;
        if (!versioned && !(candidate.coverageVersion === undefined && candidate.blockedToo === true))
          return { ok: true, value: await this.record(effect, { state: 'waiting', detail: LEGACY_ARGUMENTS }, shown) };
      }
      const paused = standing && verdict === 'release' && !!candidate ? await this.pauseDetail(link, effect) : null;
      const settledHow = await withHomeLock(this.options.home, async (): Promise<'ended' | 'cancelled' | 'paused' | 'go'> => {
        if (verdict === 'release') {
          const s = this.load(), local = s.held.find(h => h.effect === effect)!;
          const written = local.approval;
          if (paused && written?.by !== 'person') return 'paused';
          const current = this.standing(held.serverId, held.tool);
          approval = written ?? (!standing ? { by: 'person' } : current ? { by: 'standing', signature: current } : undefined);
          if (!approval) return 'ended';
          if (standing && approval.by === 'standing' && !qualified) throw new SignatureUnavailable(`${SIGNATURE_LEDGER_VERSION} could not be verified. Run backbone doctor. Update this data folder's Core, or ask its operator to update it. You can release individual calls yourself meanwhile.`);
          if (!standing) local.personReleasedAt = now();
          if (!written || !standing) {
            if (!written) local.approval = approval;
            if (standing && approval.by === 'standing') local.standing = true; else delete local.standing;
            s.ver = (s.ver ?? 0) + 1;
            this.save(s);
          }
          if (standing && approval.by === 'standing' && !sameSignature(current, approval.signature)) return 'cancelled';
        }
        return 'go';
      });
      if (settledHow === 'paused') return { ok: true, value: await this.record(effect, { state: 'waiting', detail: paused! }, shown) };
      if (settledHow === 'cancelled') await link.call(link.person(), 'SELECT gov.cancel_effect($1, $2)', [effect, SIGNATURE_ENDED_BEFORE_SEND]);
      if (settledHow === 'go' && waiting) {
        const note = approval?.by === 'standing' ? `Released on the person's standing signature for ${held.tool} on ${held.serverName}, given ${approval.signature.at}.`
          : verdict === 'release' ? 'Released by the person on its exact statement.' : 'Discarded by the person.';
        if (!qualified) {
          await link.call(link.person(), 'SELECT gov.answer_decision($1, $2, $3, $4)', [decision, argsHash, verdict === 'release' ? 'approved' : 'rejected', note])
            .catch(error => { throw coreDiagnostic(ANSWER_UNCONFIRMED, error); });
        } else await link.call(link.person(), 'SELECT gov.answer_decision_with_basis($1::uuid, $2::text, $3::text, $4::text, $5::jsonb)',
          [decision, argsHash, verdict === 'release' ? 'approved' : 'rejected', note,
            JSON.stringify(approval?.by === 'standing' ? { method: 'standing_signature', signature: approval.signature.id } : { method: 'person' })])
          .catch(error => { throw coreDiagnostic(ANSWER_UNCONFIRMED, error); });
      } else if (settledHow === 'go' && verdict === 'discard' && ['proposed', 'allowed', 'claimed'].includes(status)) {
        await link.call(link.person(), 'SELECT gov.cancel_effect($1, $2)', [effect, 'Discarded by the person.']);
      }
      if (settledHow === 'ended') return { ok: true, value: { ...shown(this.load().held.find((h) => h.effect === effect) ?? held), detail: STANDING_ENDED } };
      if (settledHow === 'cancelled') return { ok: true, value: await this.record(effect, { state: 'released', detail: STANDING_GONE }, shown) };
      const signature = standing && approval?.by === 'standing' ? approval.signature : undefined;
      let result: { state: HeldCall['state']; detail: string } = { state: verdict === 'release' ? 'released' : 'discarded', detail: verdict === 'release' ? EGRESS_CLOSED : 'Discarded by the person. Nothing was sent.' };
      if (verdict === 'discard') {
        // "Discarded, nothing was sent" is said only when the core says so. Another process may have begun to send this call
        // meanwhile: then the core's own word is recorded, and a call still open there stays waiting here.
        const { rows: now } = await link.read<{ status: string }>(link.person(), 'SELECT status FROM app.effects WHERE id = $1', [effect]);
        const status = now[0]?.status ?? '';
        if (!['rejected', 'denied', 'cancelled'].includes(status)) result = this.fromCore(status, held) ?? { state: 'waiting', detail: 'It could not be discarded just now; it is still open in the record and waits for you.' };
      }
      if (verdict === 'release') {
        const { rows: after } = await link.read<{ status: string }>(link.person(), 'SELECT status FROM app.effects WHERE id = $1', [effect]);
        const status = after[0]?.status ?? '';
        const open = this.load().servers[held.serverId]?.egress === true;
        if (['allowed', 'claimed'].includes(status) && open) result = await this.send(link, held, effect, signature);
        else {
          // The person's word is recorded; the crossing is closed, so it ends here, unsent.
          const ended = signature && !sameSignature(this.standing(held.serverId, held.tool), signature);
          const reason = ended ? SIGNATURE_ENDED_BEFORE_SEND : EGRESS_CLOSED;
          if (['proposed', 'awaiting_checker', 'allowed', 'claimed'].includes(status)) await link.call(link.person(), 'SELECT gov.cancel_effect($1, $2)', [effect, reason]);
          if (ended) result = { state: 'released', detail: reason };
          else result = this.fromCore(status, held) ?? result;
          // Another process may have claimed it before this cancel: the core's word, read again, wins.
          result = (await this.coreSays(link, effect, held)) ?? result;
        }
      }
      return { ok: true, value: await this.record(effect, result, shown) };
    } catch (error) {
      if (error instanceof SignatureUnavailable) return { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: error.message };
      throw error;
    } finally {
      this.deciding.delete(effect);
    }
  }

  /** Preserve the standing answer; a fresh person's act gets its own proposal and checked basis. */
  private async personProposal(link: CoreLink, held: StoredHeld): Promise<Receipt<HeldCall>> {
    const reason = 'Replaced by the person’s release of this exact call. Nothing was sent on the standing approval.';
    try { await link.call(link.person(), 'SELECT gov.cancel_effect($1, $2)', [held.effect, reason]); }
    catch { return { ok: true, value: await this.record(held.effect, (await this.coreSays(link, held.effect, held)) ?? { state: 'waiting', detail: 'The original call could not be cancelled. No replacement was released; inspect its receipt.' }, h => this.shownHeld(h)) }; }
    const replacementKey = `person-release:${held.effect}`;
    await this.change(s => { const original = s.held.find(h => h.effect === held.effect); if (original) original.replacementKey = replacementKey; });
    const operation = await link.call<string>(link.person(), 'SELECT operation FROM app.effects WHERE id = $1', [held.effect]);
    const run = await link.startRun(await this.heldTask(link));
    let proposed: Awaited<ReturnType<CoreLink['proposeConnectorEffect']>>;
    try { proposed = await link.proposeConnectorEffect(run, operation, held.args, held.statement, replacementKey); }
    finally { await link.finishRun(run, 'succeeded').catch(() => {}); }
    const saved = await this.change(s => {
      const original = s.held.find(h => h.effect === held.effect);
      if (!original || original.statement !== held.statement || JSON.stringify(original.args) !== JSON.stringify(held.args)) return false;
      original.state = 'released'; original.detail = reason; original.replacementEffect = proposed.effect;
      if (proposed.status !== 'awaiting_checker') return false;
      s.held.push({ effect: proposed.effect, argsHash: proposed.argsHash, args: held.args, statement: held.statement,
        definition: held.definition, launch: held.launch, serverId: held.serverId, serverName: held.serverName, tool: held.tool,
        threadId: held.threadId, turnId: held.turnId, at: now(), state: 'waiting', detail: 'Waiting for the person’s exact release.' });
      return true;
    });
    if (!saved) {
      await link.call(link.person(), 'SELECT gov.cancel_effect($1, $2)', [proposed.effect, 'The retained statement changed before the person’s release. Nothing was sent.']).catch(() => {});
      return { ok: false, reason: 'INVALID', outcome: 'REFUSED', detail: 'The replacement could not retain the exact statement. Nothing was sent; inspect its receipt.' };
    }
    // No stored hint can invoke this continuation: only this still-active person action.
    return this.resolve(proposed.effect, proposed.argsHash, 'release', false);
  }

  private async pauseDetail(link: CoreLink, effect: string): Promise<string | null> {
    const pause = await link.connectorEffectPause(effect);
    return pause === 'unknown' ? CONNECTION_UNKNOWN : pause === 'dispatching' ? TOOL_DISPATCHING : null;
  }

  /** Read again: another process may have carried it out meanwhile, and the core says so. */
  private async coreSays(link: CoreLink, effect: string, held: HeldCall) {
    const { rows } = await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.effects WHERE id = $1', [effect]).catch(() => ({ rows: [] as { status: string }[] }));
    return rows[0] ? this.fromCore(rows[0].status, held) : undefined;
  }

  /** What the core says became of a call already past its decision; undefined while it waits. */
  private fromCore(status: string, held: HeldCall): { state: HeldCall['state']; detail: string } | undefined {
    if (status === 'succeeded') return { state: 'sent', detail: `Sent to ${held.serverName}.` };
    if (status === 'failed') return { state: 'failed', detail: `${held.serverName} answered that it did not do it.` };
    if (status === 'dispatching') return { state: 'waiting', detail: CALL_DISPATCHING };
    if (status === 'unknown') return { state: 'unknown', detail: `Whether ${held.serverName} did it is UNKNOWN. It is never sent again; check it there.` };
    if (status === 'denied' || status === 'rejected') return { state: 'discarded', detail: 'Discarded by the person. Nothing was sent.' };
    return undefined;
  }

  private async record(effect: string, result: { state: HeldCall['state']; detail: string }, shown: (h: StoredHeld) => HeldCall): Promise<HeldCall> {
    const recorded = await this.change((s) => {
      const h = s.held.find((x) => x.effect === effect)!;
      h.state = result.state;
      h.detail = this.shownHeld(h).serverId === h.serverId ? result.detail : this.shownHeld(h).detail;
      return shown(h);
    });
    observeEffect(this.options.home, recorded, recorded.state === 'waiting' ? 'held' : recorded.state);
    return recorded;
  }

  /** The seal of a server as it starts now: what the person is shown when asked to open its door, and must still hold when they click. */
  doorSeal(serverId: string): string | null {
    return this.doorView(serverId)?.seal ?? null;
  }

  /** What the person is shown when asked to open a door, and its seal, from one reading of the server: what they see is what the click seals. */
  doorView(serverId: string): { name: string; shown: string; seal: string } | null {
    const d = this.lookup(serverId);
    // A blocked plugin server has no door, and nothing of it is shown, by whichever id it is asked for.
    const seal = d && this.existingSeal(d);
    return d && seal && !this.pluginBlock(d) ? { name: d.server.name, shown: d.server.shown, seal } : null;
  }

  /**
   * What the person is shown when asked to sign a tool, from one reading: the server and its seal,
   * the tool as it is enabled now and its definition. The click signs exactly these, or nothing.
   */
  toolView(serverId: string, tool: string): { name: string; shown: string; seal: string; description: string; stamp: string; blocklisted: boolean; destructive: boolean } & ReturnType<typeof argumentView> | null {
    const d = this.lookup(serverId);
    const choice = d && !this.pluginBlock(d) ? this.load().servers[d.server.id] : undefined;
    const t = ownTool(choice, tool);
    if (!d || !choice?.enabled || choice.egress !== true || !t?.enabled || t.definition !== definitionOf(t.listed) || kindOf(t.listed, t.override) !== 'effect') return null;
    const seal = this.existingSeal(d); if (!seal) return null;
    return { ...argumentView(t.listed.inputSchema, redactor(d.launch)), name: d.server.name, shown: d.server.shown, seal, description: t.listed.description, stamp: this.stamp(d, choice, t), blocklisted: blocked(t.listed.name), destructive: t.listed.annotations.destructiveHint === true };
  }

  /** Whether the person's word that a tool only reads needs asking for: it is not a read by its own annotations. */
  readNeedsAsking(serverId: string, tool: string): boolean {
    const t = ownTool(this.load().servers[serverId], tool);
    return !t || annotated(t.listed) !== 'read';
  }

  /** Read helpers never repair or create the seal key. Missing/invalid keys suspend authority. */
  private existingSeal(d: Discovered): string | undefined {
    let key: string; try { key = readFileSync(join(this.options.home, 'connectors', '.seal-key'), 'utf8').trim(); } catch { return undefined; }
    return /^[0-9a-f]{64}$/.test(key) ? createHmac('sha256', key).update(JSON.stringify(d.launch)).digest('hex') : undefined;
  }

  /** The door's seal: a keyed hash of how the server starts, its variables' and headers' values included, under a key kept in the data home. */
  private seal(d: Discovered): string {
    const file = join(this.options.home, 'connectors', '.seal-key');
    let key: string;
    try { key = readFileSync(file, 'utf8').trim(); } catch { key = ''; }
    if (!/^[0-9a-f]{64}$/.test(key)) { key = randomBytes(32).toString('hex'); assertHomeWriteAdmission(this.options.home, join(this.options.home, 'connectors')); writeFileSync(file, key, { mode: 0o600 }); }
    return createHmac('sha256', key).update(JSON.stringify(d.launch)).digest('hex');
  }

  /**
   * The egress door: a call the person released, on a server whose door they opened, carried out
   * once as the core's dispatcher (claim, begin, call, observe), as the gateway carries a write. It
   * goes only to the tool definition and server start it was held against, under the door's seal
   * (the same account), and everything is checked again after every wait, the last time with
   * nothing awaited before the call. A server that answered is DONE or FAILED; one that did not is
   * UNKNOWN, and an UNKNOWN is never sent again.
   */
  private async send(link: CoreLink, held: StoredHeld, effect: string, signature?: Signature): Promise<{ state: HeldCall['state']; detail: string }> {
    observeEffect(this.options.home, held, 'released');
    const approved = structuredClone({ args: held.args, statement: held.statement, argsHash: held.argsHash, serverId: held.serverId, tool: held.tool });
    // A cancel that did not take (another process carried it out meanwhile) is not reported as unsent: the core says what happened.
    // Still open in the core: it stays waiting here too, so the person can release or discard it; never shown as ended while it is not.
    const stillOpen = (why: string) => ({ state: 'waiting' as const, detail: `${why} It is still open in the record, so it waits for you.` });
    let policyRefusal = false;
    const cancel = async (why: string) => {
      let reason = why;
      try { if (!policyRefusal && signature && !sameSignature(this.standing(held.serverId, held.tool), signature)) reason = SIGNATURE_ENDED_BEFORE_SEND; }
      catch (error) { policyChanged(error); reason = why = changed; }
      await link.call(link.person(), 'SELECT gov.cancel_effect($1, $2)', [effect, reason]).catch(() => {});
      const { rows } = await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.effects WHERE id = $1', [effect]).catch(() => ({ rows: [] as { status: string }[] }));
      const status = rows[0]?.status ?? '';
      // Unsent only when the core says cancelled. Otherwise the core's own word, if it has one.
      return status === 'cancelled' ? { state: 'released' as const, detail: why } : this.fromCore(status, held) ?? stillOpen(why);
    };
    let changed = `${held.tool} on ${held.serverName}, its definition, how the server starts, its account, its door or your signature for it changed since this call was held, so nothing was sent.`;
    const policyChanged = (error: unknown): false => { policyRefusal = true; if (error instanceof PolicyRefused) changed = `${error.message} Nothing was sent.`; return false; };
    // Everything the person chose, as it stands now, against what this call was held for.
    const stillAsHeld = (): boolean => {
      try {
        governedPolicy(this.options.home); this.options.policyAdmission?.();
        const tool = this.offered().find((t) => t.serverId === held.serverId && t.tool === held.tool);
        const d = launchFor(this.options.home, this.options.env(), held.serverId);
        const saved = this.load(), retained = saved.held.find(h => h.effect === effect);
        const choice = saved.servers[held.serverId];
        const unchanged = !!retained && retained.argsHash === approved.argsHash && retained.statement === approved.statement
          && retained.serverId === approved.serverId && retained.tool === approved.tool && JSON.stringify(retained.args) === JSON.stringify(approved.args);
        return unchanged && !gmailSendRefusal(held.tool, held.args, d?.launch, held.serverId) && !!tool && tool.kind === 'effect' && !!d && tool.definition === held.definition && identityOf(d) === held.launch
          && choice?.egress === true && choice.egressSeal === this.seal(d) && !this.reachesCredentials(held.args, held.serverId)
          // Released on a standing signature: that same signature must still stand, so ending it stops a call on its way out.
          && (!signature || sameSignature(this.signed(d, choice, held.tool), signature));
      } catch (error) { return policyChanged(error); }
    };
    if (!held.definition || !held.launch || !stillAsHeld() || !(await link.connectorStatementMatches(effect, approved.argsHash, approved.args, approved.statement))) return cancel(changed);
    const d = launchFor(this.options.home, this.options.env(), held.serverId)!;
    let session: McpSession;
    try {
      session = await this.session(held.serverId, d);
      const live = (await this.listTools(session)).find((t) => t.name === held.tool);
      const upgraded = live && await this.repinDefinition(held.serverId, live);
      if (upgraded && held.definition === upgraded.from) {
        held = this.load().held.find(h => h.effect === effect)!;
        if (signature?.definition === upgraded.from) signature = { ...signature, definition: upgraded.to };
      }
      if (!live || definitionOf(live) !== held.definition) { await this.retireDefinition(held.serverId, held.tool); await this.refresh(held.serverId); return cancel(changed); }
    } catch (error) {
      if (error instanceof AmbiguousTools) await this.retireDefinition(held.serverId, held.tool);
      await this.drop(held.serverId);
      return cancel('The connection could not be prepared. Nothing was sent.');
    }
    if (!stillAsHeld() || this.sessions.get(held.serverId)?.identity !== held.launch) return cancel(changed);
    let claim: string, freshClaim = false;
    try {
      claim = await link.call<string>(link.system(), 'SELECT gov.claim_effect($1, $2)', [effect, Math.max(60_000, (this.options.callTimeoutMs ?? 30_000) * 2)]);
      freshClaim = true;
    } catch {
      const known = this.load().held.find(h => h.effect === effect)?.dispatchClaim;
      if (!known) return (await this.coreSays(link, effect, held)) ?? stillOpen('The core did not let this call be carried out now; nothing was sent.');
      claim = known;
    }
    if (freshClaim) await this.change(s => { const h = s.held.find(h => h.effect === effect); if (h) h.dispatchClaim = claim; });
    if (!stillAsHeld()) return cancel(changed);
    if (!(await link.beginDispatch(effect, claim, !!signature))) {
      const pause = await this.pauseDetail(link, effect);
      if (pause) return { state: 'waiting', detail: pause };
      return (await this.coreSays(link, effect, held)) ?? stillOpen('The core did not let this call begin; nothing was sent.');
    }
    // Retain only a positive Core dispatch witness. Missing historical data is not fabricated.
    const dispatch = await link.read<{ seq: string; hash: string; at: string }>(link.person(),
      "SELECT seq::text, hash, at::text FROM app.ledger WHERE entry_type = 'effect.dispatched' AND subject = $1 ORDER BY seq LIMIT 1", [effect]).catch(() => ({ rows: [] }));
    if (dispatch.rows[0]) await this.change(s => {
      const h = s.held.find(h => h.effect === effect); if (!h) return;
      h.dispatchedAt = new Date(dispatch.rows[0].at).toISOString();
      h.dispatchReceipt = { seq: dispatch.rows[0].seq, hash: dispatch.rows[0].hash };
    });
    // The last check, with nothing awaited between it and the call: a change now means it is not sent, and the core is told so.
    if (!stillAsHeld() || this.sessions.get(held.serverId) === undefined) {
      await link.observe(effect, claim, 'failed', createHash('sha256').update(`not-sent:${effect}`).digest('hex'), policyRefusal ? changed : 'Not sent: what the person chose changed just before it went.');
      return { state: 'released', detail: changed };
    }
    observeEffect(this.options.home, held, 'sent', 'unknown');
    const answer = await session.call(approved.tool, structuredClone(approved.args), new AbortController().signal, this.options.callTimeoutMs);
    // After invocation, an error reply (including a refusal) does not prove that nothing ran.
    // Only our checks before calling the server can establish non-delivery; never retry on prose.
    const outcome = answer.observed && (answer.status === 'complete' || answer.status === 'partial') ? 'succeeded' : 'unknown';
    if (outcome === 'unknown') await this.drop(held.serverId);
    await link.observe(effect, claim, outcome, createHash('sha256').update(`${answer.status}\n${answer.text}`).digest('hex'), (answer.detail ?? answer.status).slice(0, 300));
    return outcome === 'succeeded' ? { state: 'sent', detail: `Sent to ${held.serverName}${answer.status === 'partial' ? '; its answer was partial' : ''}.` }
      : { state: 'unknown', detail: `${held.serverName} ${answer.reportedTimeout ? 'reported a timeout; the request may have been delivered' : answer.observed ? 'returned an error without proving that nothing ran' : 'gave no answer'}, so whether it happened is UNKNOWN. It is never sent again; check it there.` };
  }

  private async heldTask(link: CoreLink): Promise<string> {
    const known = this.load().heldTask;
    if (known) return known;
    const task = await link.createTask('Calls held for you from your connected tools');
    await this.change((s) => { s.heldTask ??= task; });
    return this.load().heldTask!;
  }

  private async register(d: Discovered, tools: ListedTool[]): Promise<{ id: string; slug: string }> {
    const link = await this.options.link();
    const base = coreSlug(d.server.name);
    for (let n = 1; n < 100; n++) {
      const slug = n === 1 ? base : `${base.slice(0, 46)}_${n}`;
      try {
        const id = await link.call<string>(link.person(), 'SELECT gov.register_connection($1, $2, $3, $4, $5)', [d.server.name, slug, d.server.transport === 'http' ? d.server.shown : null, 'person', 'none']);
        await this.recordTools(id, tools);
        return { id, slug };
      } catch (error) {
        if (!/conflict/.test((error as Error).message)) throw error;
      }
    }
    throw new Error('no free name for this connection');
  }

  private async recordTools(connection: string, tools: ListedTool[] | null, problem?: string) {
    const link = await this.options.link();
    await link.call(link.system(), 'SELECT gov.record_connection_tools($1, $2, $3::jsonb, $4)', [connection, tools ? 'ok' : 'failing',
      JSON.stringify((tools ?? []).map((t) => ({ name: t.name, title: t.title ?? null, input_schema: t.inputSchema }))), problem ?? null]);
  }

  /** Duplicate names cannot identify one pinned operation, even if one definition matches. */
  private async listTools(session: McpSession): Promise<ListedTool[]> {
    // A short execution deadline must not cut off discovery or the live definition check.
    const tools = await session.tools();
    if (new Set(tools.map(t => t.name)).size !== tools.length) throw new AmbiguousTools('The server listed duplicate tool names; no unambiguous definition was provided.');
    return tools;
  }

  /** Representation-only upgrade: the old pin must still prove the live definition. */
  private upgradeDefinitionPin(s: Stored, serverId: string, live: ListedTool): { from: string; to: string } | undefined {
    const t = ownTool(s.servers[serverId], live.name), to = live.definitionDigest;
    if (!t || !to) return undefined;
    if (t.definition === to) {
      if (t.listed.definitionDigestVersion === 1) return undefined;
      t.listed = live;
      return { from: to, to };
    }
    const compatible = !t.listed.definitionDigest ? t.definition === legacyDefinitionOf(live)
      : t.listed.definitionDigestVersion === undefined && t.definition === live.previousDefinitionDigest;
    if (!compatible) return undefined;
    const from = t.definition;
    t.definition = to;
    t.listed = live;
    if (t.standing?.definition === from) t.standing = { ...t.standing, definition: to };
    for (const h of s.held) if (h.serverId === serverId && h.tool === live.name && h.definition === from) {
      h.definition = to;
      if (h.approval?.by === 'standing' && h.approval.signature.definition === from)
        h.approval = { by: 'standing', signature: { ...h.approval.signature, definition: to } };
    }
    return { from, to };
  }

  private repinDefinition(serverId: string, live: ListedTool): Promise<{ from: string; to: string } | undefined> {
    return withHomeLock(this.options.home, async () => {
      const s = this.load(), upgraded = this.upgradeDefinitionPin(s, serverId, live);
      if (upgraded) { s.ver = (s.ver ?? 0) + 1; this.save(s); }
      return upgraded;
    });
  }

  /** One observed change ends authority before another listing can hide that observation. */
  private async retireDefinition(serverId: string, name: string): Promise<void> {
    await this.change(s => {
      const t = ownTool(s.servers[serverId], name);
      if (!t) return;
      t.enabled = false;
      delete t.standing;
      if (t.override === 'read') delete t.override;
      t.rev = nextGen(s);
    }, 'definition_changed');
  }

  private session(serverId: string, d: Discovered): Promise<McpSession> {
    if (this.closed) return Promise.reject(new Error('The host is closing.'));
    // The last word before a process exists, whatever asked for it.
    const refusal = this.startRefusal(d);
    if (refusal) return Promise.reject(new Error(refusal));
    const identity = identityOf(d);
    const open = this.sessions.get(serverId);
    // A server whose config now starts it differently, even only by a variable's value, is a new session: never the old one.
    if (open && open.identity !== identity) { this.sessions.delete(serverId); void open.session.then((x) => x.close(), () => {}); }
    let entry = this.sessions.get(serverId);
    if (!entry) {
      entry = { identity, session: this.catalogue.store.resolve(d.launch).then(launch => McpSession.open(launch)) };
      const made = entry;
      made.session.catch(() => { if (this.sessions.get(serverId) === made) this.sessions.delete(serverId); });
      this.sessions.set(serverId, made);
    }
    return entry.session;
  }

  private async drop(serverId: string) {
    const s = this.sessions.get(serverId);
    this.sessions.delete(serverId);
    if (s) await s.session.then((x) => x.close(), () => {});
  }
  private async stopCatalogue(id: string) {
    try { await this.change(s => { const choice = s.servers[id]; if (choice) { choice.enabled = false; closeDoor(choice, s); } }); }
    finally { await this.drop(id); }
  }

  async close() {
    this.closed = true;
    this.catalogue.store.close();
    await Promise.allSettled([...this.endDrains]);
    await Promise.all([...this.sessions.keys()].map((id) => this.drop(id)));
  }

  /** Whether this home has any choice at all (an engine is offered nothing until the person enables a tool). */
  get used() { return existsSync(this.file); }
}
