// The only bridge the renderer gets: call the api port, hear its events, set the window theme, and
// ask main to start connecting a tool or signing a capability (main shows the person what they
// grant and takes their confirmation; the renderer never grants or signs), or to export a document
// version (main asks where and writes; the renderer never holds a path).
import { contextBridge, ipcRenderer } from 'electron';

let pendingMacNewChat = false;
let macNewChatListener: (() => void) | undefined;
ipcRenderer.on('mac-new-chat', () => { if (macNewChatListener) macNewChatListener(); else pendingMacNewChat = true; });

const closing = new Set<{ prepare(): Promise<void>; failed(message: string): void }>();
ipcRenderer.on('workspace-prepare-close', (_event, token: string) => {
  void Promise.all([...closing].map((listener) => Promise.resolve().then(() => listener.prepare()))).then(
    () => ipcRenderer.send('workspace-close-ready', token, true),
    () => ipcRenderer.send('workspace-close-ready', token, false),
  );
});
ipcRenderer.on('workspace-close-failed', (_event, message: string) => {
  for (const listener of closing) listener.failed(message);
});

// Observe the actual rendered startup result; no folder or authority crosses this notification.
window.addEventListener('DOMContentLoaded', () => {
  const observer = new MutationObserver(() => {
    const failed = !!document.querySelector('[data-startup-failed=true]');
    if (failed || document.querySelector('[data-ready=true]')) { observer.disconnect(); ipcRenderer.send('data-folder-visible', failed); }
  });
  observer.observe(document.documentElement, { childList:true, subtree:true, attributes:true, attributeFilter:['data-ready','data-startup-failed'] });
});

contextBridge.exposeInMainWorld('backbone', {
  browserRequest: (request: unknown) => ipcRenderer.invoke('browser-request', request),
  onBrowserState: (listener: (state: unknown) => void) => { const handler = (_event: unknown, state: unknown) => listener(state); ipcRenderer.on('browser-state', handler); return () => ipcRenderer.removeListener('browser-state', handler); },
  onBrowserFocusAddress: (listener: () => void) => { const handler = () => listener(); ipcRenderer.on('browser-focus-address', handler); return () => ipcRenderer.removeListener('browser-focus-address', handler); },
  remoteSendChecked:(key:string)=>ipcRenderer.invoke('remote-send-checked',key),
  onSharingSettings:(listener:()=>void)=>{const handler=()=>listener();ipcRenderer.on('mac-sharing-settings',handler);return()=>ipcRenderer.removeListener('mac-sharing-settings',handler);},
  sharingView:()=>ipcRenderer.invoke('sharing-view'),
  configureSharing:(choice:unknown)=>ipcRenderer.invoke('sharing-configure',choice),
  createJoinLink:(role:string)=>ipcRenderer.invoke('sharing-invite',role),
  identityRecoveryStatus:()=>ipcRenderer.invoke('identity-recovery-status'),
  restoreDeviceAccess:()=>ipcRenderer.invoke('identity-restore-device'),
  joinRemoteWorkspace:(link:string,name:string)=>ipcRenderer.invoke('identity-join-remote',link,name),
  leaveRemoteWorkspace:()=>ipcRenderer.invoke('identity-leave-remote'),
  identityConfiguration:()=>ipcRenderer.invoke('identity-configuration'),
  openRemoteWorkspace:()=>ipcRenderer.invoke('identity-workspace-window'),
  openSignInWindow:()=>ipcRenderer.invoke('identity-window'),
  acceptInvitation:(invitation:string,name:string)=>ipcRenderer.invoke('identity-accept',invitation,name),
  companySignIn:(invitation?:string)=>ipcRenderer.invoke('identity-company',invitation),
  platform: process.platform,
  macPresence: () => ipcRenderer.invoke('mac-presence'),
  macFileAccess: (folder: string) => ipcRenderer.invoke('mac-file-access', folder),
  macFilesAndFolders: () => ipcRenderer.invoke('mac-files-and-folders'),
  macFullDiskAccess: () => ipcRenderer.invoke('mac-full-disk-access'),
  macLoginItem: (enabled: boolean) => ipcRenderer.invoke('mac-login-item', enabled),
  onMacNewChat: (listener: () => void) => { macNewChatListener = listener; if (pendingMacNewChat) { pendingMacNewChat = false; listener(); } return () => { if (macNewChatListener === listener) macNewChatListener = undefined; }; },
  telemetrySettings: () => ipcRenderer.invoke('telemetry-settings'),
  configureTelemetry: (request: { endpoint: string; headers?: string }) => ipcRenderer.invoke('telemetry-configure', request),
  listNotices: () => ipcRenderer.invoke('notices-list'),
  readNotice: (id: string) => ipcRenderer.invoke('notices-read', id),
  dataFolderStatus: () => ipcRenderer.invoke('data-folder-status'),
  appInfo: () => ipcRenderer.invoke('app-info'),
  call: (method: string, args: unknown) => ipcRenderer.invoke('api', method, args),
  onEvent: (listener: (e: unknown) => void) => {
    const handler = (_: unknown, e: unknown) => listener(e);
    ipcRenderer.on('api-event', handler);
    return () => ipcRenderer.removeListener('api-event', handler);
  },
  setTheme: (theme: string) => ipcRenderer.send('theme', theme),
  connectTool: (tool: string) => ipcRenderer.invoke('tools-connect', tool),
  connectCatalogue: (id: string, preset: string) => ipcRenderer.invoke('catalogue-connect', { id, preset }),
  finishCatalogue: (id: string, preset: string) => ipcRenderer.invoke('catalogue-finish', { id, preset }),
  disconnectCatalogue: (id: string) => ipcRenderer.invoke('catalogue-disconnect', id),
  configureWakeGate: (request: unknown) => ipcRenderer.invoke('wake-gate-confirm', request),
  signCapability: () => ipcRenderer.invoke('triage-sign'),
  checkedTurn: (threadId: string, turnId: string) => ipcRenderer.invoke('unknown-check', { threadId, turnId }),
  resolveConnectorEffect: (effect: string, argsHash: string) => ipcRenderer.invoke('connector-resolve', { effect, argsHash }),
  releaseConnectorCall: (effect: string, argsHash: string) => ipcRenderer.invoke('connector-release', { effect, argsHash }),
  enableConnectorTools: (serverId: string) => ipcRenderer.invoke('connector-enable-tools', serverId),
  enableConnector: (serverId: string, tool?: string) => ipcRenderer.invoke('connector-enable', { serverId, tool }),
  openConnectorDoor: (serverId: string) => ipcRenderer.invoke('connector-open', serverId),
  markConnectorToolRead: (serverId: string, tool: string, asServer?: boolean) => ipcRenderer.invoke('connector-read', { serverId, tool, asServer }),
  endConnectorSignature: (serverId: string, tool: string) => ipcRenderer.invoke('connector-signature-end', serverId, tool),
  signConnectorTool: (serverId: string, tool: string) => ipcRenderer.invoke('connector-standing', { serverId, tool }),
  exportDocument: (projectId: string, id: string, version: number, format: string) => ipcRenderer.invoke('document-export', { projectId, id, version, format }),
  chooseExportFolder: () => ipcRenderer.invoke('choose-export-folder'),
  restoreBackup: (request: unknown) => ipcRenderer.invoke('backup-restore', request),
  chooseBackupFolder: () => ipcRenderer.invoke('choose-backup-folder'),
  chooseDataFolder: () => ipcRenderer.invoke('choose-data-folder'),
  chooseRestorePlace: () => ipcRenderer.invoke('choose-restore-place'),
  beforeClose: (prepare: () => Promise<void>, failed: (message: string) => void) => {
    const listener = { prepare, failed };
    closing.add(listener);
    return () => closing.delete(listener);
  },
});
