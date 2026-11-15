// The surface's only door: the platform api port, over Electron IPC or the HTTP bridge.
import type { Refused, RestorePreview, RestoreRequest, RestoreView } from '../../electron/restore';
import type { AiTool, AiToolId, ApiEvent, Args, CapabilityView, ConnectorServer, HeldCall, ConnectorEffectResolution, Method, Receipt, Result } from '@backbone-next/platform';

export interface SharingView { enabled:boolean;address:string;port:number;addresses:string[];origin?:string;fingerprint?:string;notice?:string;engineRefusesColleagues:boolean;engineNotice?:string }
export interface RemoteView {origin:string;connection:'connecting'|'online'|'temporary'|'ended'}
export interface IdentityConfiguration {company:boolean;signedIn:boolean;workspaceWindow?:boolean;remote?:RemoteView}
interface Bridge {
  browserRequest?(request: import('./browser-types').BrowserRequest): Promise<import('./browser-types').BrowserState>;
  onBrowserState?(listener: (state: import('./browser-types').BrowserState) => void): () => void;
  onBrowserFocusAddress?(listener: () => void): () => void;
  remoteSendChecked?(key:string):Promise<void>;
  onSharingSettings?(listener:()=>void):()=>void;
  joinRemoteWorkspace?(link:string,name:string):Promise<Receipt<import('@backbone-next/platform').WorkspacePerson>>;
  leaveRemoteWorkspace?():Promise<{ok:boolean}>;
  sharingView?():Promise<SharingView>;
  configureSharing?(choice:{enabled:boolean;address:string;port:number}):Promise<SharingView>;
  createJoinLink?(role:'admin'|'member'|'guest'):Promise<{link:string}>;
  identityRecoveryStatus?():Promise<{available:boolean;notice?:string}>;
  restoreDeviceAccess?():Promise<{ok:boolean}>;
  listNotices?(): Promise<import('@backbone-next/platform/notices').NoticeEntry[]>;
  readNotice?(id: string): Promise<import('@backbone-next/platform/notices').NoticeText>;
  connectCatalogue?(id: string, preset: string): Promise<unknown>;
  finishCatalogue?(id: string, preset: string): Promise<unknown>;
  disconnectCatalogue?(id: string): Promise<unknown>;
  identityConfiguration?():Promise<IdentityConfiguration>;
  openRemoteWorkspace?():Promise<{ok:boolean}>;
  openSignInWindow?():Promise<{ok:boolean}>;
  acceptInvitation?(invitation:string,name:string):Promise<Receipt<import('@backbone-next/platform').WorkspacePerson>>;
  companySignIn?(invitation?:string):Promise<Receipt<{started:true}>>;
  platform: string;
  macPresence?(): Promise<{ folders: Record<string, 'allowed' | 'denied' | 'unavailable' | 'unknown'>; login: boolean | null }>;
  macFileAccess?(folder: 'Desktop' | 'Documents' | 'Downloads'): Promise<Record<string, 'allowed' | 'denied' | 'unavailable' | 'unknown'>>;
  macFilesAndFolders?(): Promise<void>;
  macFullDiskAccess?(): Promise<void>;
  macLoginItem?(enabled: boolean): Promise<boolean>;
  onMacNewChat?(listener: () => void): () => void;
  telemetrySettings?(): Promise<{ endpoint: string }>;
  configureTelemetry?(request: { endpoint: string; headers?: string }): Promise<{ ok: boolean }>;
  dataFolderStatus?(): Promise<import('../../electron/data-folder-open').FolderStartupProblem | undefined>;
  appInfo?(): Promise<{ packaged: boolean; version: string; dataFolder?: string }>;
  call(method: string, args: unknown): Promise<unknown>;
  onEvent(listener: (e: ApiEvent) => void): () => void;
  setTheme(theme: string): void;
  /** Asks main to show the person the grant; only their click there connects the tool. */
  connectTool?(tool: string): Promise<unknown>;
  configureWakeGate?(request: unknown): Promise<unknown>;
  /** Asks main to show the capability and its hash; only the person's Touch ID or password there signs it. */
  signCapability?(): Promise<unknown>;
  checkedTurn?(threadId: string, turnId: string): Promise<unknown>;
  resolveConnectorEffect?(effect: string, argsHash: string): Promise<unknown>;
  releaseConnectorCall?(effect: string, argsHash: string): Promise<unknown>;
  enableConnectorTools?(serverId: string): Promise<unknown>;
  enableConnector?(serverId: string, tool?: string): Promise<unknown>;
  openConnectorDoor?(serverId: string): Promise<unknown>;
  markConnectorToolRead?(serverId: string, tool: string, asServer?: boolean): Promise<unknown>;
  /** Ends only; it cannot grant or widen a signature. */
  endConnectorSignature?(serverId: string, tool: string): Promise<unknown>;
  /** Asks main to show the person the tool and the server; only their click there signs it to act without asking. */
  signConnectorTool?(serverId: string, tool: string): Promise<unknown>;
  /** Asks main to export this exact version; main shows the save dialog and writes the file. */
  exportDocument?(projectId: string, id: string, version: number, format: ExportFormat): Promise<unknown>;
  /** Asks main to show the folder picker: the export folder inside the one the person chose, and the one-time ticket `backup.export` takes; null if they chose none. */
  chooseExportFolder?(): Promise<{ ticket: string; folder: string } | null>;
  /** One step of restoring a backup into a new data folder (main runs the platform's restore; the page never names a folder to write). */
  restoreBackup?(request: RestoreRequest): Promise<unknown>;
  /** Asks main to show the folder picker for a backup to restore: a ticket for it, or null if they chose none. */
  chooseBackupFolder?(): Promise<unknown>;
  /** The native picker checks an existing data folder and returns only a window-bound opening ID. */
  chooseDataFolder?(): Promise<import('../../electron/data-folder-open').FolderPick | null>;
  /** Asks main to show the folder picker for where the restored data folder goes: a one-time ticket for a new folder inside it, or null. */
  chooseRestorePlace?(): Promise<unknown>;
  /** Drain existing surface writes before main destroys its renderer. */
  beforeClose?(prepare: () => Promise<void>, failed: (message: string) => void): () => void;
}
declare global {
  interface Window {
    backbone?: Bridge;
  }
}

export async function call<M extends Method>(method: M, args: Args<M>): Promise<Result<M>> {
  if (window.backbone) return (await window.backbone.call(method, args)) as Result<M>;
  const request = JSON.stringify({ method, args });
  // keepalive lets a save finish as the page goes; browsers refuse it above 64 KiB.
  const res = await fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: request, keepalive: request.length < 60_000 });
  const body = (await res.json()) as Result<M> | { error: string };
  if (!res.ok) {
    const problem=body as {error:string;kind?:string},error=new Error(problem.error);
    if(problem.kind==='LegacyIdentityUnavailable')error.name=problem.kind;
    throw error;
  }
  return body as Result<M>;
}

export function onEvent(listener: (e: ApiEvent) => void): () => void {
  if (window.backbone) return window.backbone.onEvent(listener);
  const source = new EventSource('/api/events');
  source.onmessage = (m) => listener(JSON.parse(m.data) as ApiEvent);
  return () => source.close();
}

/** Start connecting a tool: the desktop app's main process asks the person, and connects on their click. */
export async function connectTool(tool: AiToolId): Promise<Receipt<AiTool>> {
  if (!window.backbone?.connectTool) return { ok: false, reason: 'NOT_AVAILABLE', detail: 'Connecting AI tools is done in the desktop app.', outcome: 'REFUSED' };
  return (await window.backbone.connectTool(tool)) as Receipt<AiTool>;
}

/** Only the desktop native dialog can authorize a person-rights program. */
export async function configureWakeGate(request: { method: 'schedules.update'; args: Args<'schedules.update'> }): Promise<Receipt<import('@backbone-next/platform').Schedule>> {
  if (!window.backbone?.configureWakeGate) return { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'Script wake gates are configured in the desktop app’s native dialog.' };
  return await window.backbone.configureWakeGate(request) as Receipt<import('@backbone-next/platform').Schedule>;
}

/** Start signing the mail triage capability: the desktop app's main process shows it and asks for the person's presence. */
/** Releasing a held connector call is asked in main, on its exact statement; in a browser it is not available. */
export async function releaseConnectorCall(effect: string, argsHash: string): Promise<Receipt<HeldCall>> {
  if (!window.backbone?.releaseConnectorCall) return { ok: false, reason: 'NOT_AVAILABLE', detail: 'Releasing a call is done in the desktop app.', outcome: 'REFUSED' };
  return (await window.backbone.releaseConnectorCall(effect, argsHash)) as Receipt<HeldCall>;
}
export async function resolveConnectorEffect(effect: string, argsHash: string): Promise<Receipt<ConnectorEffectResolution>> {
  if (!window.backbone?.resolveConnectorEffect) return { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'Resolving an unknown call is done in the desktop app.' };
  return await window.backbone.resolveConnectorEffect(effect, argsHash) as Receipt<ConnectorEffectResolution>;
}
/** Main asks the person before granting a server or tool to every engine. */
export async function enableConnectorTools(serverId: string): Promise<Receipt<ConnectorServer>> {
  if (!window.backbone?.enableConnectorTools) return { ok: false, reason: 'NOT_AVAILABLE', detail: 'Turning a connector on is done by the person in the desktop app.', outcome: 'REFUSED' };
  return (await window.backbone.enableConnectorTools(serverId)) as Receipt<ConnectorServer>;
}

export async function catalogueAction(action: 'connect' | 'finish' | 'disconnect', id: import('@backbone-next/platform').CatalogueId, preset: import('@backbone-next/platform').CataloguePreset = 'reads'): Promise<Receipt<unknown>> {
  const bridge = window.backbone;
  if (!bridge) return { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'Connect catalogue tools in the desktop app.' };
  const run = action === 'connect' ? bridge.connectCatalogue : action === 'finish' ? bridge.finishCatalogue : bridge.disconnectCatalogue;
  if (!run) return { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'The native catalogue connection is unavailable.' };
  return await run(id, preset) as Receipt<unknown>;
}
export async function enableConnector(serverId: string, tool?: string): Promise<Receipt<ConnectorServer>> {
  if (!window.backbone?.enableConnector) return { ok: false, reason: 'NOT_AVAILABLE', detail: 'Turning a connector on is done by the person in the desktop app.', outcome: 'REFUSED' };
  return (await window.backbone.enableConnector(serverId, tool)) as Receipt<ConnectorServer>;
}
export async function openConnectorDoor(serverId: string): Promise<Receipt<ConnectorServer>> {
  if (!window.backbone?.openConnectorDoor) return { ok: false, reason: 'NOT_AVAILABLE', detail: 'Allowing sending is done in the desktop app.', outcome: 'REFUSED' };
  return (await window.backbone.openConnectorDoor(serverId)) as Receipt<ConnectorServer>;
}

/** Desktop ending has a dedicated reduce-only handler; the browser uses the same Host command. */
export async function endConnectorSignature(serverId: string, tool: string): Promise<Receipt<ConnectorServer | { ended: true }>> {
  if (!window.backbone) return call('connectors.set', { serverId, tool: { name: tool, standing: false } });
  if (!window.backbone.endConnectorSignature)
    return { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'The desktop permission ending connection is unavailable.' };
  return await window.backbone.endConnectorSignature(serverId, tool) as Receipt<{ ended: true }>;
}

export async function signConnectorTool(serverId: string, tool: string): Promise<Receipt<ConnectorServer>> {
  if (!window.backbone?.signConnectorTool) return { ok: false, reason: 'NOT_AVAILABLE', detail: 'Letting a tool act without asking is done in the desktop app.', outcome: 'REFUSED' };
  return (await window.backbone.signConnectorTool(serverId, tool)) as Receipt<ConnectorServer>;
}

export async function markConnectorToolRead(serverId: string, tool: string, asServer = false): Promise<Receipt<ConnectorServer>> {
  if (!window.backbone?.markConnectorToolRead) return { ok: false, reason: 'NOT_AVAILABLE', detail: 'Treating a tool as a read is done in the desktop app.', outcome: 'REFUSED' };
  return (await window.backbone.markConnectorToolRead(serverId, tool, asServer)) as Receipt<ConnectorServer>;
}

export async function signCapability(): Promise<Receipt<CapabilityView>> {
  if (!window.backbone?.signCapability) return { ok: false, reason: 'NOT_AVAILABLE', detail: 'Giving permission is done in the desktop app.', outcome: 'REFUSED' };
  return (await window.backbone.signCapability()) as Receipt<CapabilityView>;
}

export type ExportFormat = 'md' | 'html' | 'pdf' | 'slides';
export const canExport = () => !!window.backbone?.exportDocument;

/** Export a document version where the person chooses: the desktop app's main process reads, renders and writes it. */
export async function exportDocument(projectId: string, id: string, version: number, format: ExportFormat): Promise<Receipt<{ saved: boolean }>> {
  if (!window.backbone?.exportDocument) return { ok: false, reason: 'NOT_AVAILABLE', detail: 'Export is done in the desktop app.', outcome: 'REFUSED' };
  return (await window.backbone.exportDocument(projectId, id, version, format)) as Receipt<{ saved: boolean }>;
}

export function setWindowTheme(theme: string) {
  window.backbone?.setTheme(theme);
}

export const isMac = () => (window.backbone?.platform ?? navigator.platform).toLowerCase().startsWith('mac') || /darwin/.test(window.backbone?.platform ?? '');

/** Unwraps a receipt or throws its named reason. */
export function must<T>(r: Receipt<T>): T {
  if (!r.ok) throw new Error(`${r.reason}: ${r.detail}`);
  return r.value;
}

export const clientKey = () => crypto.randomUUID();

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function beforeClose(prepare: () => Promise<void>, failed: (message: string) => void) {
  return window.backbone?.beforeClose?.(prepare, failed) ?? (() => {});
}

/** Where an export may go: only a folder the person picked in the app's own picker, as a one-time ticket. Null when they picked none, or there is no picker. */
export async function chooseExportFolder(): Promise<{ ticket: string; folder: string } | null> {
  if (window.backbone) return window.backbone.chooseExportFolder ? window.backbone.chooseExportFolder() : null;
  const res = await fetch('/api/choose-export-folder', { method: 'POST' });
  return res.ok ? ((await res.json()) as { ticket: string; folder: string } | null) : null;
}

/** Native main shows one question and takes the person's answer. */
export async function checkedTurn(threadId: string, turnId: string): Promise<Receipt<import('@backbone-next/platform').UnknownCheck>> {
  if (!window.backbone?.checkedTurn) return { ok: false, outcome: 'REFUSED', reason: 'NOT_AVAILABLE', detail: 'Open the desktop app to check this outcome.' };
  return await window.backbone.checkedTurn(threadId, turnId) as Receipt<import('@backbone-next/platform').UnknownCheck>;
}

const post = async <T>(path: string, body?: unknown): Promise<T> => {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The request failed (${res.status}).`);
  return (await res.json()) as T;
};

/** The restore wizard's calls. In the desktop app main runs them; in a browser the bridge does. */
export const restore = {
  step<T>(request: RestoreRequest): Promise<T> {
    return window.backbone?.restoreBackup ? window.backbone.restoreBackup(request) as Promise<T> : post<T>('/api/restore', request);
  },
  view: () => restore.step<RestoreView>({ step: 'view' }),
  preview: (ticket: string) => restore.step<{ ok: true; preview: RestorePreview } | Refused>({ step: 'preview', ticket }),
  target: () => restore.step<{ ok: true; ticket: string; folder: string } | Refused>({ step: 'target' }),
  start: (previewId: string, ticket: string) => restore.step<{ ok: true } | Refused>({ step: 'start', previewId, ticket }),
  open: (id: string) => restore.step<import('../../electron/data-folder-open').FolderOpenResult>({step:'open',id}),
  dismiss: () => restore.step<RestoreView>({ step: 'dismiss' }),
  /** The native picker for the backup folder: a one-time-bound ticket for it (the only thing a preview reads), or null if none was chosen. */
  async chooseBackup(): Promise<({ ok: true; ticket: string; folder: string } | Refused) | null> {
    return (window.backbone?.chooseBackupFolder ? window.backbone.chooseBackupFolder() : post('/api/choose-backup-folder')) as Promise<({ ok: true; ticket: string; folder: string } | Refused) | null>;
  },
  /** The native picker for where the new data folder goes: a ticket for a new folder inside it, or null. */
  async choosePlace(): Promise<({ ok: true; ticket: string; folder: string } | Refused) | null> {
    return (window.backbone?.chooseRestorePlace ? window.backbone.chooseRestorePlace() : post('/api/choose-restore-place')) as Promise<({ ok: true; ticket: string; folder: string } | Refused) | null>;
  },
};
