// The host's public contract: the options it opens with and what it offers its process. The implementation is host.ts.
import type { AiTool, ApiEvent, Args, CapabilityView, ConnectTool, ConnectorServer, HeldCall, Method, Receipt, Result, SignCapability } from '../api.ts';
import type { ServerSource } from '../connectors/discover.ts';
import type { LocalProbe } from '../models/local.ts';
import type { MailConnector, TriageTask } from '../ports/mail.ts';
import type { MaterialFaults } from '../stub/material.ts';
import type { DoorStart, ToolDoors } from '../tools/service.ts';
import type { ToolEnv } from '../tools/places.ts';
import type { TriageService } from '../triage/service.ts';
import type { ImportPlan } from './backup.ts';
import type { PieceUpgrade, PieceUpgradeRecord } from './pieces.ts';
import type { CoreOptions } from './core.ts';
import type { WriteCrashPoint } from './document-writes.ts';

type CrashPoint = WriteCrashPoint;
export interface HostOptions {
  /** Trusted process configuration. A directory externalId is explicitly the configured
   * issuer's subject; names and email addresses are never account-linking evidence. */
  identity?: { company?: import('./identity-oidc.ts').CompanySignInOptions; directory?: { bearer: string; issuer: string } };
  /** The data home. Tests and journeys always pass a fresh one; it is never the default profile. */
  home: string;
  /** Test-only kill boundary after the inspection audit event is flushed. */
  unknownCheckRecorded?: () => void;
  writeDelayMs?: number;
  /** Test-only crash observation; never exposed over the API. */
  projectCreateCut?: (point: 'reserved' | 'started' | 'prepared' | 'recorded') => void;
  /**
   * Where the person's other agents keep memories and skills (`.codex`, `.claude` and `.agents` in their home folder).
   * Unnamed, none is read: only the person's default data home, or a home given BACKBONE_USER_HOME,
   * should name one, so a throwaway or test home never lists the person's own folders.
   */
  memory?: { userHome?: string };
  /** Proactivity's clock and how often it looks for due work; tests move the clock. */
  schedules?: { now?: () => number; tickMs?: number };
  /**
   * Triggers (composition/triggers.ts): how long a burst of file changes or mail notices is gathered
   * (1 s by default), and the webhook endpoint's first port on 127.0.0.1 (a free one by default; later
   * starts keep the one it got).
   */
  triggers?: { debounceMs?: number; webhookPort?: number };
  /** Where local model detection looks on 127.0.0.1 (models/local.ts): the runtimes' usual ports unless a test says. */
  localModels?: Pick<LocalProbe, 'ports' | 'timeoutMs'>;
  /** The task board's first backoff after a rate limit or a server error (1 s by default); tests shorten it. */
  board?: { backoffMs?: number };
  /** Called at each crash point, so a test can act at an exact step instead of after a guessed wait. */
  atPoint?: (point: CrashPoint) => void;
  faults?: MaterialFaults;
  /** A prebuilt core baseline and the PostgreSQL binaries, when an app ships them. */
  baselineSql?: CoreOptions['baselineSql'];
  postgresNative?: CoreOptions['postgresNative'];
  /**
   * What wraps the home's vault of secrets: the Keychain's key (`keychainKeys`) in the desktop app.
   * Without it only a test home, whose vault is already plaintext, opens (keys/vault.ts).
   */
  keys?: CoreOptions['keys'];
  /**
   * The distribution's harness, used when neither the session (BACKBONE_HARNESS) nor the person
   * (`harness` in the home's settings.json) names one: `harness-pi`, or `harness-stub` (the default).
   */
  harness?: string;
  /** Trusted desktop main asks once before granting changed configured content or wider capabilities. */
  confirmPieceUpgrade?: (piece: PieceUpgrade) => Promise<boolean>;
  /** Only packaged desktop main supplies its own resources directory; real paths must contain the piece. */
  bundledResources?: string;
  /** App log supplements the Core registration ledger without changing its SQL payload. */
  pieceUpgradeLog?: (record: PieceUpgradeRecord) => void;
  /**
   * Read model keys the person stored in the macOS Keychain (credentials/keychain.ts), at request time
   * only. The desktop app passes it; tests and journeys never do, so they cannot find a real key and spend.
   */
  keychainRoutes?: boolean;
  /** Native app main explicitly admits an existing data folder’s Team update. */
  allowIdentityUpgrade?:boolean;
  /** Where each piece the host loads keeps its files, by name; a checkout's own folders by default (a bundled app ships copies). */
  pieceDirs?: Record<string, string>;
  /**
   * Connecting the person's AI tools to the MCP door: only a host given this manages them (the
   * desktop app); elsewhere those calls are refused. `door` is the door the app ships, `env` where
   * the tools are looked for (this process's environment by default), `doors` a stand-in for tests.
   */
  tools?: { label?: string; door?: DoorStart; env?: ToolEnv; doors?: ToolDoors };
  /** The person's MCP servers: where their configs are looked for (this process's environment by default), and a call's deadline. */
  connectors?: { env?: ToolEnv; sources?: ServerSource[]; callTimeoutMs?: number };
  /**
   * Serve this home's doors (composition/doors.ts): the door processes the AI tools start hold no
   * secret and reach their grants through this host. On by default for a host given `tools` (the
   * desktop app); `piece` is the door's folder its grants are bound to (the tools' door, else the
   * MCP door's).
   */
  doors?: boolean | { piece?: string };
  /**
   * The mail triage job. The mail module is loaded from its checked folder (a bundled app ships a
   * copy, `dir`) and its sample mailbox lives in the home; tests pass a connector and task of their
   * own, while the module on disk is still what the job's grant is bound to. `scheduleMs` adds the
   * schedule trigger beside new mail.
   */
  mail?: { connector?: MailConnector; task?: TriageTask; dir?: string; scheduleMs?: number };
  /**
   * Open to read: the home is still held, but nothing is recovered, settled, resumed or served, and
   * every method that changes something is refused. Work a kill left stays as it was for a real open.
   */
  readOnly?: boolean;
}

export interface Host {
  /** Trusted native main only; not a Method, engine tool or HTTP endpoint. */
  deviceRecoveryStatus():Promise<{available:boolean;notice?:string}>;
  restoreDeviceAccess(signal?:AbortSignal):Promise<void>;
  /** Trusted desktop main only. No Host.call, model, automation or remote session method. */
  unknownChecks: ReturnType<typeof import('./unknown-checks.ts').createUnknownChecks>;
  /** Trusted native setup only; absent from Host.call, every engine and every transport. */
  connectorCatalogue: {
    connect(id: import('../api-catalogue.ts').CatalogueId, app: import('../api-catalogue.ts').CatalogueApp, open: (url: string) => Promise<void>, preset?: import('../api-catalogue.ts').CataloguePreset): Promise<Receipt<import('../api-catalogue.ts').CatalogueConnection>>;
    finish(id: import('../api-catalogue.ts').CatalogueId): Promise<Receipt<import('../api-catalogue.ts').CatalogueConnection>>;
    question(id: import('../api-catalogue.ts').CatalogueId): Promise<Receipt<{ server: ConnectorServer; stamp: string }>>;
    activate(id: import('../api-catalogue.ts').CatalogueId, preset: import('../api-catalogue.ts').CataloguePreset, stamp: string): Promise<Receipt<ConnectorServer>>;
    disconnect(id: import('../api-catalogue.ts').CatalogueId): Promise<Receipt<import('../api-catalogue.ts').CatalogueDisconnect>>;
  };
  beginCompanySignIn(browser: string): Promise<URL>;
  completeCompanySignIn(callback: URL, browser: string, invitation?: string): Promise<Receipt<{ session: string; person: import('../api-identity.ts').WorkspacePerson }>>;
  directoryRequest(request: Request): Promise<Response>;
  /** Ends only the presented authenticated session; never a device control. */
  signOut(session:string):Promise<Receipt<{ended:true}>>;
  callAuthenticated<M extends Method>(session: string, method: M, args: Args<M>): Promise<Result<M>>;
  acceptInvitation(invitation: string, name: string): Promise<Receipt<{ session: string; person: import('../api-identity.ts').WorkspacePerson }>>;
  /** Readiness captures the starting projects before a network stream opens. */
  onAuthenticated(session: string, listener: (event: ApiEvent) => void): (() => void) & { ready: Promise<void> };
  call<M extends Method>(method: M, args: Args<M>): Promise<Result<M>>;
  /**
   * Grant a tool a permission and write its entry. Never reachable through `call` or any transport:
   * only the process that showed the person this grant and took their click (the app's main) calls it.
   */
  connectTool(request: ConnectTool): Promise<Receipt<AiTool>>;
  /**
   * The person's own word, given in the desktop app's main process after it showed them the exact
   * statement or server (never reachable through the api, the door or the line): release a held
   * connector call, or open the egress door for a server.
   */
  connectorEffectDecisions: NonNullable<import('./api-line.ts').ApiLineOptions['connectorEffects']>;
  endConnectorSignature(serverId: string, tool: string): Promise<Receipt<{ ended: true }>>;
  releaseConnectorCall(effect: string, argsHash: string): Promise<Receipt<HeldCall>>;
  /** Main's enabling question and opaque stamp, including hidden launch values and choice revisions. */
  connectorEnableView(serverId: string, tool?: string): Promise<{ server: ConnectorServer; stamp: string } | null>;
  /** Enables only after main's native confirmation; never reachable through the api or a transport. */
  enableConnector(serverId: string, tool: string | undefined, stamp: string): Promise<Receipt<ConnectorServer>>;
  /** A bounded, exact set of off tools shown together in one native question. */
  connectorToolsEnableView(serverId: string): Promise<{ server: ConnectorServer; tools: string[]; remaining: number; stamp: string } | null>;
  enableConnectorTools(serverId: string, tools: readonly string[], stamp: string): Promise<Receipt<ConnectorServer>>;
  openConnectorDoor(serverId: string, seal: string): Promise<Receipt<ConnectorServer>>;
  /** The seal of a server as it starts now, shown with the question; null when it is not there. */
  connectorDoorSeal(serverId: string): string | null;
  /** What to show when asking to open a door, and its seal, from one reading of the server. */
  connectorDoorView(serverId: string): { name: string; shown: string; seal: string } | null;
  /** The person's word that a tool only reads, when its own annotations do not say so: asked in main. */
  markConnectorToolRead(serverId: string, tool: string, asServer?: boolean): Promise<Receipt<ConnectorServer>>;
  /**
   * The person's standing signature for one tool, given in the app's main process on the server and
   * the tool as they were shown them (`seal`, `stamp`, both from `connectorToolView`): its calls
   * then go out with no question per call. `blockedToo` is accepted for compatibility;
   * new signatures have one meaning. Not a method of the api.
   */
  signConnectorTool(serverId: string, tool: string, seal: string, stamp: string, blockedToo: boolean): Promise<Receipt<ConnectorServer>>;
  /** What to show when asking to sign a tool, with the seal and stamp the click signs, from one reading; null when it cannot be signed now. */
  connectorToolView(serverId: string, tool: string): { name: string; shown: string; seal: string; description: string; stamp: string; blocklisted: boolean; destructive: boolean; argumentNames: string[]; additionalArgumentNames: number; sendingArguments: boolean; argumentWarning?: string } | null;
  /**
   * The owner signs the triage capability they were shown, named by its hash. Never reachable through
   * `call` or any transport: only the process that showed the payload and took the person's Touch ID
   * or device password (the app's main) calls it. A run starts at once under the new grant.
   */
  signCapability(request: SignCapability): Promise<Receipt<CapabilityView>>;
  /**
   * Import an export into this home, which must hold no work: under the home's lock for the whole
   * import, through the host's own methods. Never reachable through `call` or any transport.
   */
  importExport(from: string): Promise<ImportPlan>;
  /** The job itself, for the process that hosts it (main, tests and the measurement); not a transport. */
  readonly triage: TriageService;
  on(listener: (e: ApiEvent) => void): () => void;
  /**
   * Carry on the turns a kill interrupted, once the core is up. Opening never does this, because a
   * resumed turn can call a model. Answers how many it resumed; a later call has none to resume.
   */
  resumeInterrupted(): Promise<number>;
  close(): void;
}
