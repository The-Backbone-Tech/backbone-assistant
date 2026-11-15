import { registerBrowserPane } from './browser-pane';
import { confirmUnknownCheck } from './unknown-check';
import { listNotices, readNotice } from '@backbone-next/platform/notices';
import { governedPolicy, keyDecision, PolicyRefused } from '@backbone-next/platform/policy';
// Electron main hosts the platform composition, carries the api port over IPC, and owns the native
// confirmations a renderer cannot give itself, including tools, signatures and script wake gates.
// It also owns the one file write a person asks for from the
// window: exporting a document where they choose (export-document.ts).
import { app, BrowserWindow, dialog, type IpcMainEvent, type IpcMainInvokeEvent, ipcMain, Menu, nativeTheme, powerSaveBlocker, safeStorage } from 'electron';
import { readFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { METHODS, type Method } from '@backbone-next/platform';
import { configureTelemetry, telemetryView } from './telemetry-settings.ts';
import { startConfiguredTelemetry } from '@backbone-next/platform/composition/telemetry';
import { createHost, hostClosed, personKeychainRoutes, requireCompleteHome } from '@backbone-next/platform/composition';
import { appSharing, observeSharing, closeSharedHost, computerAddresses } from './shared-listener.ts';
import { serveIdentityApi } from '@backbone-next/platform/composition/identity-http';
import { sharedCertificate } from '@backbone-next/platform/composition/shared-certificate';
import { remoteWorkspace } from '@backbone-next/platform/remote/workspace';
import { makeJoinLink, RemoteError } from '@backbone-next/platform/remote/client';
import { RendererIdentitySessions } from './identity-session.ts';
import { companyBrowserSignIn } from './identity-company.ts';
import {assertHomeWriteAdmission} from '@backbone-next/platform/composition/home-lock';
import { ApiLineAttachmentBudget, ApiLineProjectBudget, type ApiLineServer, serveApiLine } from '@backbone-next/platform/composition/api-line';
import { exportDestinations, rendererExport } from '@backbone-next/platform/composition/backup';
import { checkFolderStorage, createDataFolderOpener, folderChoiceRefusal, folderStartupProblem, folderVisibleResult, launchDataFolder, reportBeforeExit, secondLaunchAction } from './data-folder-open.ts';
import { answerRestore, createRestorer } from './restore.ts';
import { homeKeyProvider } from '@backbone-next/platform/system-keys';
import { keychainKeys, plaintextKeys } from '@backbone-next/platform/keys';
import { brand } from '../src/brand';
import { confirmLine } from './api-line';
import { confirmAndConnect } from './connect-tool';
import { confirmEnable, confirmOpen, confirmRead, confirmRelease, confirmResolution, confirmStanding, confirmToolsEnable } from './connector-confirm';
import { connectCatalogue, finishCatalogue, disconnectCatalogue } from './connector-catalogue';
import { endConnectorSignature } from './end-signature';
import { exportDocument } from './export-document';
import { keepAwake } from './keep-awake';
import { chooseNativeRoute } from './native-route';
import { confirmAndSign } from './sign-capability';
import { trustedSender } from './sender';
import { callFromRenderer } from './renderer-api.ts';
import { confirmWakeGate } from './wake-gate.ts';
import { pieceUpgradeDialog, upgradeAnswer, upgradeQuestionPage } from './piece-upgrade.ts';
import { registerMacPresence, updateSharingPresence } from './mac-presence.ts';

// A test or journey passes BACKBONE_HOME so it never touches the default profile.
const defaultHome = join(app.getPath('userData'), 'backbone');
const home = process.env.BACKBONE_HOME ?? defaultHome;
const dataFolder = home === defaultHome ? undefined : home;
const reportFolder = (result: object) => { if (process.connected && process.send) process.send(result, () => {}); };
try{governedPolicy(home);assertHomeWriteAdmission(home,join(home,'electron'));}
catch(error){reportFolder({state:'failed',detail:error instanceof Error?error.message:String(error)});dialog.showErrorBox('Data folder unavailable',error instanceof Error?error.message:String(error));app.exit(1);process.exit(1);}
app.setPath('userData', join(home, 'electron'));

// One app per data home: Electron's single-instance lock, keyed by the user-data folder set just
// above. A second launch on the same home stops before it touches anything, and the first comes
// forward. Other processes (the door's own grant and revoke) take the data home's lock instead.
const singleOwner = app.requestSingleInstanceLock();
if (!singleOwner) {
  reportBeforeExit({state:'already-open'}, process.connected && process.send ? (result, done) => { process.send!(result, done); } : undefined, () => { app.exit(0); process.exit(0); });
}
// A duplicate instance runs no startup work while its final IPC report drains.
if (singleOwner) {
app.on('second-instance', () => {
  const existing = BrowserWindow.getAllWindows()[0];
  const action = secondLaunchAction(!!existing, app.isReady(), !!quitting || quitReady);
  const win = action === 'open' ? open() : action === 'focus' ? existing : undefined;
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// The core's baseline and PostgreSQL binaries ship with the app (scripts/build.mjs, package.mjs).
const unpacked = (path: string) => path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
const baselineFile = join(__dirname, 'baseline.sql');
const pieceDirs = { 'harness-pi': join(__dirname, '..', 'pieces', 'harness-pi'), 'harness-codex': join(__dirname, '..', 'pieces', 'harness-codex'), 'harness-acp': join(__dirname, '..', 'pieces', 'harness-acp') };
const postgresNative = app.isPackaged ? join(process.resourcesPath, 'postgres', 'native') : join(__dirname, '..', 'postgres', 'native');
// Packaged, the door's files sit beside the archive (scripts/package.mjs): another process runs them.
const doorPiece = unpacked(join(__dirname, '..', 'pieces', 'mcp'));
// The door inside the app, as VS Code's `code` command and Docker Desktop's MCP entries are: a script
// in the app's resources (scripts/build.mjs) that runs the shipped door with the app's own runtime as
// Node. Every tool entry starts it; when the app moves or updates, the entries are rewritten at start.
const doorCommand = app.isPackaged ? join(process.resourcesPath, 'bin', 'backbone-mcp') : join(__dirname, '..', 'bin', 'backbone-mcp');
const page = join(__dirname, '..', 'renderer', 'index.html');
// The home's vault of secrets is wrapped by the Keychain's key (Electron safeStorage, asked for once
// the app is ready), so no file in the home holds a password or a key in the clear. A packaged app
// takes nothing else, and so refuses a test home; a development build takes plaintext keys only
// when told to (BACKBONE_KEYS=plaintext, as the journeys' test homes are).
const ready = <T>(f: () => Promise<T>) => app.whenReady().then(f);
// Startup stages on stderr: entry, then settlement with the elapsed time and, on failure, a fixed code
// for the error's class. Never a message, a value read or written, or a path.
const started = Date.now();
const stage = <T>(name: string, run: () => Promise<T>): Promise<T> => {
  process.stderr.write(`[startup] +${Date.now() - started}ms ${name} begun\n`);
  return run().then(
    (v) => { process.stderr.write(`[startup] +${Date.now() - started}ms ${name} settled\n`); return v; },
    (e: unknown) => {
      // A fixed code from the error's class only: a message can carry what was being read.
      const code = e instanceof Error && /^(PieceRefused|KeysRefused)$/.test(e.name) ? e.name : 'Error';
      process.stderr.write(`[startup] +${Date.now() - started}ms ${name} failed ${code}\n`);
      throw e;
    },
  );
};
const keys =
  !app.isPackaged && process.env.BACKBONE_KEYS === 'plaintext'
    ? plaintextKeys()
    : keychainKeys({
        isAsyncEncryptionAvailable: () => stage('keychain availability', () => ready(() => safeStorage.isAsyncEncryptionAvailable())),
        encryptStringAsync: (text) => stage('keychain encrypt', () => ready(() => safeStorage.encryptStringAsync(text))),
        decryptStringAsync: (sealed) => stage('keychain decrypt', () => ready(() => safeStorage.decryptStringAsync(sealed))),
        getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend(),
      });
keyDecision(governedPolicy(home), keys.holder);
chooseNativeRoute(home);
const companyConfiguration = process.env.BACKBONE_IDENTITY_ISSUER ? {
  issuer:process.env.BACKBONE_IDENTITY_ISSUER,clientId:process.env.BACKBONE_IDENTITY_CLIENT_ID ?? '',redirectUri:process.env.BACKBONE_IDENTITY_REDIRECT_URI ?? '',
  ...(process.env.BACKBONE_IDENTITY_CLIENT_SECRET ? {clientSecret:process.env.BACKBONE_IDENTITY_CLIENT_SECRET} : {}),
  allowLoopbackHttp:process.env.BACKBONE_IDENTITY_TEST_LOOPBACK==='1',
} : undefined;
let pendingUpgrade: AbortController | undefined;
let withdrawingUpgrade = false;
const host = createHost({
  allowIdentityUpgrade:true,
  identity:{company:companyConfiguration},
  home,
  keys,
  baselineSql: readFileSync(baselineFile, 'utf8'),
  postgresNative,
  // The app's engine: Pi behind the Harness port. The model route is the person's to set in Settings.
  harness: 'harness-pi',
  // The person's own skill and memory folders: read for their default profile, or for a home that
  // names a user home with BACKBONE_USER_HOME; a home given by BACKBONE_HOME alone reads none.
  ...(process.env.BACKBONE_USER_HOME || !process.env.BACKBONE_HOME ? { memory: { userHome: process.env.BACKBONE_USER_HOME || homedir() } } : {}),
  // A key the person stored in the Keychain under backbone-openrouter routes Pi through OpenRouter, read per request.
  keychainRoutes: personKeychainRoutes(process.env),
  // Its files ship beside the bundle (scripts/build.mjs); the platform checks them against its registration.
  pieceDirs,
  // Settings › Assistants using this app: the door the tools start (it checks its own files).
  tools: { label: brand.name, door: { command: doorCommand, piece: doorPiece } },
  // The doors the tools start hold no secret: they reach their grants through this process, the
  // only one holding the home's keys, over a socket only the person's user can open.
  doors: { piece: doorPiece },
  // The mail triage job's connector ships beside the bundle too, checked before it loads.
  mail: { dir: join(__dirname, '..', 'pieces', 'connector-mail') },
  // Bundle provenance is trusted main-process state, never a renderer or settings claim.
  ...(app.isPackaged ? { bundledResources: process.resourcesPath } : {}),
  pieceUpgradeLog: record => { process.stderr.write(`[piece update] ${JSON.stringify(record)}\n`); },
  confirmPieceUpgrade: async piece => {
    const question = new AbortController();
    pendingUpgrade = question;
    try {
      return await ready(async () => {
        if (question.signal.aborted) return false;
        const wording = pieceUpgradeDialog(brand.name, piece);
        // On macOS a sheet rejected the installer's Apple quit event while it was open.
        // A separate non-modal window lets every quit route reach before-quit.
        const win = new BrowserWindow({ width: 580, height: 440, title: 'Engine update', webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
        return await new Promise<boolean>(resolve => {
          let done = false;
          const finish = (response: number) => {
            if (done) return;
            done = true;
            question.signal.removeEventListener('abort', abort);
            if (!win.isDestroyed()) win.destroy();
            resolve(upgradeAnswer(response, question.signal.aborted));
          };
          const abort = () => finish(1);
          question.signal.addEventListener('abort', abort, { once: true });
          win.on('closed', () => finish(1));
          win.webContents.on('will-navigate', (event, url) => {
            event.preventDefault();
            if (url === 'https://backbone.invalid/allow') finish(0);
            else if (url === 'https://backbone.invalid/decline') finish(1);
          });
          win.webContents.on('before-input-event', (_event, input) => { if (input.type === 'keyDown' && input.key === 'Escape') finish(1); });
          void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(upgradeQuestionPage(wording.message, wording.detail))}`).catch(() => finish(1));
        });
      });
    } finally { if (pendingUpgrade === question) pendingUpgrade = undefined; }
  },
});
const telemetry = startConfiguredTelemetry(host, home, keys).catch(async error => {
  reportFolder({state:'failed',detail:error instanceof Error?error.message:String(error)});
  host.close(); await hostClosed(home).catch(() => {});
  if (withdrawingUpgrade) return;
  if (error instanceof PolicyRefused) dialog.showErrorBox('Managed policy refused', error.message);
  app.exit(1); throw error;
});
// Opening never resumes; the app carries on what a kill interrupted.
void telemetry.then(() => host.resumeInterrupted()).catch(() => {});
// The command line's way in: a named part of the api, on a socket only the person's user can open,
// once this process really holds the home and its core is up. Each asked write waits for the person's click here.
let line: ApiLineServer | undefined;
let lineEnded = false;
const projectCreationBudget = new ApiLineProjectBudget();
const attachmentBudget = new ApiLineAttachmentBudget();
void telemetry.then(() => stage('core (first call)', () => host.call('projects.list', {})))
  .then(() => (lineEnded ? undefined : stage('api line', () => serveApiLine({ home, attachmentBudget, attachment: companyConfiguration ? 'signed-in-app' : true, projectCreationBudget, projectCreation: companyConfiguration ? 'signed-in-app' : true, call: (method, args) => host.call(method, args), connectorEffects: host.connectorEffectDecisions, unknownChecks: host.unknownChecks, confirm: (ask, signal) => confirmLine(ask, signal) }))))
  .then((served) => { if (lineEnded) void served?.close(); else line = served; })
  .catch(() => {}); // With no line the command line says the app is not reachable; the app itself goes on.

// Electron's security checklist, item 17: every handler answers only this app's own top-level page.
const fromOurPage = (e: IpcMainEvent | IpcMainInvokeEvent) => trustedSender(e.senderFrame, pathToFileURL(page).href);
const remote = telemetry.then(()=>remoteWorkspace(home,keys));
const identitySessions = new RendererIdentitySessions(host,()=>remote,!!companyConfiguration);
const sharing = observeSharing(telemetry.then(async () => appSharing(home, keys, {
  addresses: computerAddresses,
  engineBringsOwnTools: () => host.engineBringsOwnTools(),
  sharedEngineNotice: () => host.sharedEngineNotice(),
  start: async (address, port) => {
    const tls = await sharedCertificate(home, keys);
    const listener = await serveIdentityApi({host, address, port, tls});
    return {...listener, fingerprint: tls.fingerprint};
  },
}))).then(value=>{updateSharingPresence(value.view().origin);return value;});
const companySignIn = companyBrowserSignIn(host,identitySessions,companyConfiguration?.redirectUri);
const refusePage = (e: IpcMainEvent | IpcMainInvokeEvent) => {
  if (!fromOurPage(e)) throw new Error('Refused: only this app\'s own page may call it.');
};
const refuseOthers = (e: IpcMainEvent | IpcMainInvokeEvent) => {
  refusePage(e);
  if (!identitySessions.deviceOwner(e.sender.id)) throw new Error('This operation requires the local device owner.');
};
registerBrowserPane(refusePage, home, {unavailable: event =>
  identitySessions.remoteView(event.sender.id) ? 'Browser is not available in a joined workspace. Pages belong to the local device owner.' :
  companyConfiguration ? 'Browser is not available in a company configuration. Company policy does not define personal browser access.' :
  identitySessions.deviceOwner(event.sender.id) ? undefined : 'Browser is not available here. Pages belong to the local device owner.'});
async function localAdministrator(e:IpcMainInvokeEvent,ownerOnly=false){
  refusePage(e);
  if(identitySessions.remoteView(e.sender.id))throw new Error('Manage this computer from its local window.');
  const identity=await identitySessions.call(e.sender.id,'identity.get',{});
  if(!identity.ok||!(ownerOnly?identity.value.person.role==='owner':['owner','admin'].includes(identity.value.person.role)))throw new Error('A workspace administrator is required.');
}
ipcMain.handle('sharing-view',async e=>{await localAdministrator(e);return (await sharing).view();});
ipcMain.handle('sharing-configure',async(e,choice:unknown)=>{refuseOthers(e);await localAdministrator(e,true);const view=await (await sharing).configure(choice);updateSharingPresence(view.origin);return view;});
ipcMain.handle('sharing-invite',async(e,role:unknown)=>{
  await localAdministrator(e);
  if(!['admin','member','guest'].includes(String(role)))throw new Error('Choose an invitation role.');
  const view=(await sharing).view();
  if(!view.enabled||!view.origin||!view.fingerprint)throw new Error('Turn sharing on before creating a join link.');
  const receipt=await identitySessions.call(e.sender.id,'identity.invite',{role:role as 'admin'|'member'|'guest'});
  if(!receipt.ok)throw new Error('Invitation could not be confirmed. Check People and roles before trying again.');
  return {link:makeJoinLink({origin:view.origin,fingerprint:view.fingerprint,invitation:receipt.value.token})};
});
ipcMain.handle('identity-recovery-status',e=>{refuseOthers(e);return host.deviceRecoveryStatus();});
ipcMain.handle('identity-restore-device',async e=>{
  refuseOthers(e);await identitySessions.restoreDeviceAccess(e.sender.id);
  if (!quitting && !quitReady) { app.relaunch();app.quit(); } return {ok:true};
});
ipcMain.handle('identity-configuration',e=>{refusePage(e);return{company:!!companyConfiguration,signedIn:identitySessions.signedIn(e.sender.id),remote:identitySessions.remoteView(e.sender.id),workspaceWindow:identitySessions.workspaceWindow(e.sender.id)};});
ipcMain.handle('identity-workspace-window',e=>{refusePage(e);open(false,false,true,e.sender.id);return{ok:true};});
ipcMain.handle('identity-window',e=>{refusePage(e);open(false, false);return{ok:true};});
ipcMain.handle('identity-accept',(e,invitation:unknown,name:unknown)=>{
  refusePage(e);if(typeof invitation!=='string'||typeof name!=='string')throw new Error('An invitation and name are required.');
  return identitySessions.join(e.sender.id,invitation,name);
});
ipcMain.handle('identity-join-remote',(e,link:unknown,name:unknown)=>{
  refusePage(e);if(identitySessions.deviceOwner(e.sender.id))throw new Error('Open a workspace sign-in window first.');
  if(typeof link!=='string'||typeof name!=='string')throw new Error('A join link and name are required.');
  return identitySessions.joinRemote(e.sender.id,link,name);
});
ipcMain.handle('remote-send-checked',async(e,key:unknown)=>{refusePage(e);if(typeof key!=='string'||!key||key.length>256)throw new Error('Invalid submission key.');await identitySessions.releaseRemoteSend(e.sender.id,key);});
ipcMain.handle('identity-leave-remote',async e=>{refusePage(e);await identitySessions.leaveRemote(e.sender.id);return{ok:true};});
ipcMain.handle('identity-company',(e,invitation:unknown)=>{refusePage(e);if(invitation!==undefined&&typeof invitation!=='string')throw new Error('Invalid invitation.');return companySignIn.begin(e.sender.id,invitation);});
const exportTickets = exportDestinations();
// Restore a backup into a new data folder, through the same operation `backbone restore` runs. The new
// data folder is opened with this app's own keys, so the app can open it when the person starts it there.
const folders = createDataFolderOpener({
  currentFolder: home,
  check: (target) => {
    checkFolderStorage(realpathSync(target), assertHomeWriteAdmission);
    requireCompleteHome(target);
    const stamp = JSON.parse(readFileSync(join(target, 'kernel.json'), 'utf8'));
    if (stamp.kernel !== 'core') throw new Error('This data folder uses a format this build cannot open.');
  },
  launch: (target) => launchDataFolder(target, { executable: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged, env: process.env }),
});
const restorer = createRestorer({
  folders,
  home,
  unavailable: () => companyConfiguration ? 'This app is set up by your company, which keeps data folders under its own control. Ask your administrator to restore a backup.' : undefined,
  openHost: (target) => createHost({ home: target, keys, baselineSql: readFileSync(baselineFile, 'utf8'), postgresNative, harness: 'harness-pi', pieceDirs }),
});
ipcMain.handle('backup-restore', (e, request: unknown) => { refuseOthers(e); return answerRestore(restorer, request, e.sender.id); });
ipcMain.handle('telemetry-settings', (e) => { refuseOthers(e); return telemetryView(home); });
ipcMain.handle('telemetry-configure', (e, request: unknown) => { refuseOthers(e); return configureTelemetry(home, keys, request); });
const noticesDirectory = join(__dirname, '..', 'notices');
ipcMain.handle('notices-list', e => { refuseOthers(e); return listNotices(noticesDirectory); });
ipcMain.handle('notices-read', (e, id: unknown) => { refuseOthers(e); if (typeof id !== 'string') throw new Error('Invalid notice id.'); return readNotice(noticesDirectory, id); });
ipcMain.handle('app-info', (e) => {
  refusePage(e);
  return { packaged: app.isPackaged, version: app.getVersion(), ...(dataFolder ? { dataFolder } : {}) };
});
ipcMain.handle('api', async (e, method: Method, args: unknown) => {
  refusePage(e);
  if (!METHODS.includes(method)) throw new Error(`Unknown api method ${method}`);
  // An export goes only to the folder the person picked in main's own picker: the renderer gives the
  // one-time ticket that picker issued to this window, never a path.
  if (method === 'backup.export') {
    refuseOthers(e);
    const given = rendererExport(exportTickets, args, e.sender.id);
    return 'to' in given ? host.call('backup.export', given) : given;
  }
  try {return await callFromRenderer({call:(method,args)=>identitySessions.call(e.sender.id,method,args)}, method, args);}
  catch(error){
    // Electron serializes thrown Errors without their outcome fields. Preserve the
    // known send outcome in the typed receipt so refusal never becomes uncertainty.
    if(method==='turns.send'&&error instanceof RemoteError&&!error.accessEnded)return {ok:false,reason:'NOT_AVAILABLE',outcome:error.outcome,detail:error.message};
    throw error;
  }
});
ipcMain.handle('wake-gate-confirm', (e, request: unknown) => {
  refuseOthers(e);
  const win = BrowserWindow.fromWebContents(e.sender);
  return confirmWakeGate(host, request, options => win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
});
// The renderer may only ask for the confirmation to start; main shows the grant and takes the click.
ipcMain.handle('tools-connect', (e, tool: unknown) => {
  refuseOthers(e);
  return confirmAndConnect(host, BrowserWindow.fromWebContents(e.sender), tool);
});
// The same for signing the mail triage capability: main shows the payload and its hash, and asks
// for the person's Touch ID or device password; the renderer never signs.
ipcMain.handle('triage-sign', (e) => {
  refuseOthers(e);
  return confirmAndSign(host, BrowserWindow.fromWebContents(e.sender));
});
// Releasing a held call and allowing sending to a server: main shows the exact words and takes the click.
ipcMain.handle('unknown-check', (e, request: unknown) => {
  refuseOthers(e);
  const win = BrowserWindow.fromWebContents(e.sender);
  return confirmUnknownCheck(host, request, options => win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options), brand.name, identitySessions.deviceSignal(e.sender.id));
});
ipcMain.handle('connector-resolve', (e, request: unknown) => {
  refuseOthers(e);
  return confirmResolution(host, BrowserWindow.fromWebContents(e.sender), request);
});
ipcMain.handle('connector-release', (e, request: unknown) => {
  refuseOthers(e);
  return confirmRelease(host, BrowserWindow.fromWebContents(e.sender), request);
});
// Ending is reduce-only and needs no question. Diagnostics return as data rather than IPC rejections.
ipcMain.handle('connector-signature-end', (e, serverId: unknown, tool: unknown) => {
  refuseOthers(e);
  return endConnectorSignature(host, serverId, tool);
});
// The folder for an export, picked by the person in the native picker: the renderer gets the new
// export folder inside it to show, and a one-time ticket bound to it, which `backup.export` takes.
ipcMain.handle('choose-export-folder', async (e) => {
  refuseOthers(e);
  const window = BrowserWindow.fromWebContents(e.sender);
  const options = { title: 'Choose where the export goes', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
  const chosen = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  const picked = chosen.canceled ? undefined : chosen.filePaths[0];
  if (!picked) return null;
  // Bound to this window and to the folder as it is now: another window, or the folder swapped for a link, is refused.
  return exportTickets.issue(picked, e.sender.id);
});
// A backup to restore, and a place for the new data folder, are picked by the person here, in the native picker.
ipcMain.handle('choose-backup-folder', async (e) => {
  refuseOthers(e);
  const window = BrowserWindow.fromWebContents(e.sender);
  const options = { title: 'Choose the backup folder', message: 'The folder an export made, the one that holds manifest.json', properties: ['openDirectory'] as 'openDirectory'[] };
  const chosen = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  const picked = chosen.canceled ? undefined : chosen.filePaths[0];
  return picked ? restorer.source(picked, e.sender.id) : null;
});
ipcMain.handle('choose-data-folder', async (e) => {
  refuseOthers(e);
  const refusal = folderChoiceRefusal(!!companyConfiguration);
  if (refusal) return refusal;
  const window = BrowserWindow.fromWebContents(e.sender);
  const options = {title:'Open another data folder',properties:['openDirectory'] as 'openDirectory'[]};
  const chosen = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return chosen.canceled || !chosen.filePaths[0] ? null : folders.pick(chosen.filePaths[0], e.sender.id);
});
// Read the original Core refusal rather than the identity bootstrap's generic pause.
async function startupProblem() {
  try { await host.call('projects.list', {}); return undefined; }
  catch (error) {
    let provider: ReturnType<typeof homeKeyProvider>;
    try { provider = homeKeyProvider(home); } catch { provider = null; }
    return folderStartupProblem(error, provider);
  }
}
ipcMain.handle('data-folder-status', async e => {
  refuseOthers(e);
  const problem = await startupProblem();
  return problem && problem.kind !== 'startup' ? problem : undefined;
});
// The isolated page says it has painted a startup outcome. Main owns the verdict.
ipcMain.on('data-folder-visible', async (e, failed: unknown) => {
  if (!fromOurPage(e) || !process.connected) return;
  try {
    const status = await host.call('host.status', {});
    const problem = status.owns ? await startupProblem() : undefined;
    reportFolder(folderVisibleResult({owns:status.owns,readSucceeded:!problem,failed:failed===true,problem}));
  } catch(error) { reportFolder({state:'failed',detail:folderStartupProblem(error).detail}); }
});
ipcMain.handle('choose-restore-place', async (e) => {
  refuseOthers(e);
  const window = BrowserWindow.fromWebContents(e.sender);
  const options = { title: 'Choose where the restored data folder goes', message: 'A new folder is made inside the one you choose', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
  const chosen = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  const picked = chosen.canceled ? undefined : chosen.filePaths[0];
  return picked ? restorer.target(picked, e.sender.id) : null;
});
ipcMain.handle('connector-read', (e, request: unknown) => {
  refuseOthers(e);
  return confirmRead(host, BrowserWindow.fromWebContents(e.sender), request);
});
ipcMain.handle('connector-standing', (e, request: unknown) => {
  refuseOthers(e);
  return confirmStanding(host, BrowserWindow.fromWebContents(e.sender), request);
});
ipcMain.handle('connector-enable-tools', (e, serverId: unknown) => {
  refuseOthers(e);
  return confirmToolsEnable(host, BrowserWindow.fromWebContents(e.sender), serverId);
});
ipcMain.handle('connector-enable', (e, request: unknown) => {
  refuseOthers(e);
  return confirmEnable(host, BrowserWindow.fromWebContents(e.sender), request);
});
ipcMain.handle('catalogue-connect', (e, request: unknown) => { refuseOthers(e); return connectCatalogue(host, BrowserWindow.fromWebContents(e.sender), request); });
ipcMain.handle('catalogue-finish', (e, request: unknown) => { refuseOthers(e); return finishCatalogue(host, BrowserWindow.fromWebContents(e.sender), request); });
ipcMain.handle('catalogue-disconnect', (e, id: unknown) => { refuseOthers(e); return disconnectCatalogue(host, id); });
ipcMain.handle('connector-open', (e, serverId: unknown) => {
  refuseOthers(e);
  return confirmOpen(host, BrowserWindow.fromWebContents(e.sender), serverId);
});
// Export names a material, the version shown and a format; main reads, renders, asks where and writes.
ipcMain.handle('document-export', (e, request: unknown) => {
  refuseOthers(e);
  return exportDocument(host, BrowserWindow.fromWebContents(e.sender), request);
});
ipcMain.on('theme', (e, theme: 'light' | 'dark' | 'system') => {
  if (fromOurPage(e) && ['light', 'dark', 'system'].includes(theme)) nativeTheme.themeSource = theme;
});
// A goal running on its own keeps the computer awake until it pauses or ends (keep-awake.ts).
const releaseAwake = keepAwake(host, powerSaveBlocker);

// OpenCode's shutdown pattern: finish pending persistence before re-quitting on the next tick.
// Here the durable draft store is already in the host; the renderer must first drain its queue.
type CloseRequest = { token: string; promise: Promise<boolean>; finish(ok: boolean): void };
const pendingClose = new Map<number, CloseRequest>();
let quitReady = false;
let quitting: Promise<void> | undefined;

function prepareClose(win: BrowserWindow): Promise<boolean> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve(true);
  const contents = win.webContents;
  const id = contents.id;
  const prior = pendingClose.get(id);
  if (prior) return prior.promise;
  const token = randomUUID();
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((r) => { resolve = r; });
  const destroyed = () => finish(false);
  const timer = setTimeout(() => finish(false), 10_000);
  function finish(ok: boolean) {
    if (pendingClose.get(id)?.token !== token) return;
    pendingClose.delete(id);
    clearTimeout(timer);
    contents.removeListener('destroyed', destroyed);
    if (!ok && !contents.isDestroyed()) contents.send('workspace-close-failed', 'Some changes could not be saved. This window stayed open; try closing again.');
    resolve(ok);
  }
  pendingClose.set(id, { token, promise, finish });
  contents.once('destroyed', destroyed);
  try { contents.send('workspace-prepare-close', token); } catch { finish(false); }
  return promise;
}

ipcMain.on('workspace-close-ready', (event, token: unknown, ok: unknown) => {
  if (!fromOurPage(event)) return;
  const request = pendingClose.get(event.sender.id);
  if (request && request.token === token) request.finish(ok === true);
});

// Reload is a navigation too: wait for the same durable draft drain used by window close.
const reloading = new Set<number>();
async function reloadSafely(win: BrowserWindow) {
  if (win.isDestroyed() || reloading.has(win.id)) return;
  reloading.add(win.id);
  try {
    if (await prepareClose(win) && !win.isDestroyed()) win.webContents.reload();
  } finally { reloading.delete(win.id); }
}

let mainWindow: BrowserWindow | undefined;
function open(deviceOwner = !companyConfiguration, primary = true, restoreRemote = false, workspaceSource?:number) {
  const win = new BrowserWindow({
    width: Number(process.env.BACKBONE_WINDOW_WIDTH ?? 1440),
    height: Number(process.env.BACKBONE_WINDOW_HEIGHT ?? 900),
    minWidth: 320,
    minHeight: 480,
    title: dataFolder ? `${brand.name} — ${dataFolder}` : brand.name,
    // Standard Electron/macOS chrome: real window controls share the app's 42px bar.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 13 } } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1c' : '#fbfaf7',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  if (dataFolder) win.on('page-title-updated', event => { event.preventDefault(); });
  const identityWindowId = win.webContents.id;
  const identityWindow={id:identityWindowId,prepare:()=>prepareClose(win),
    reload:async()=>{await win.webContents.executeJavaScript('sessionStorage.clear()');win.webContents.reload();},
    failed:()=>{if(!win.isDestroyed())win.webContents.send('workspace-close-failed','Account change was not confirmed. Your current window and edits are kept.');},
    event:(event:import('@backbone-next/platform').ApiEvent)=>{if(!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send('api-event',event);}};
  try {
    if(workspaceSource!==undefined)identitySessions.bindWorkspace(identityWindow,workspaceSource);
    else identitySessions.bind(identityWindow,deviceOwner,restoreRemote);
  } catch(error){win.destroy();throw error;}
  win.once('closed',()=>identitySessions.forget(identityWindowId));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('before-input-event', (event, input) => {
    const reloadKey = input.type === 'keyDown' && ((input.key.toLowerCase() === 'r' && (input.meta || input.control) && !input.alt) || (input.key === 'F5' && !input.alt));
    if (reloadKey) { event.preventDefault(); void reloadSafely(win); }
  });
  win.on('close', (event) => {
    if (quitReady) return;
    event.preventDefault();
    void prepareClose(win).then((ok) => { if (ok && !win.isDestroyed()) win.destroy(); });
  });
  if (primary) mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = undefined; });
  if(restoreRemote)void identitySessions.restoreRemote(identityWindowId).then(()=>win.loadFile(page)).catch(()=>win.loadFile(page));
  else void win.loadFile(page);
  return win;
}

Menu.setApplicationMenu(
  Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label:'File',submenu:[{label:'Join a workspace…',click:(_item,win)=>{try{const source=win instanceof BrowserWindow?win:mainWindow;if(!source)throw new Error('Open your local window first.');open(false,false,true,source.webContents.id);}catch(error){dialog.showErrorBox('Workspace sign-in',error instanceof Error?error.message:String(error));}}}, {type:'separator'}, {role:'close'}] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { id: 'safe-reload', label: 'Reload', accelerator: 'CmdOrCtrl+R', click: (_item, win) => { if (win instanceof BrowserWindow) void reloadSafely(win); } },
      { id: 'safe-force-reload', label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: (_item, win) => { if (win instanceof BrowserWindow) void reloadSafely(win); } },
      { type: 'separator' }, { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
  ]),
);

void app.whenReady().then(async () => { registerMacPresence(refuseOthers, () => mainWindow, open, () => !!quitting || quitReady, brand.name); if (!mainWindow && !quitReady) open(); const saved=await remote.catch(()=>undefined);if(!quitReady&&!quitting){try{if(!companyConfiguration&&saved?.owner()==='device owner'&&saved.connection())open(false,false,true);}catch{open(false,false);}} });
// Closing the window never stops a task (R-UX-DOCK-01): on macOS the app and its turns keep running.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  // macOS can send this before the app is ready (an early Dock click): the first window is opened by
  // whenReady below, and a window made sooner throws, whose uncaught dialog then held the whole start.
  if (!app.isReady()) return;
  if (!quitting && !quitReady && !mainWindow) open();
});
app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  if (quitting) return;
  identitySessions.close();
  if (pendingUpgrade) {
    withdrawingUpgrade = true;
    quitReady = true;
    pendingUpgrade.abort();
    companySignIn.close();
    lineEnded = true;
    releaseAwake();
    void (async()=>{await Promise.race([restorer.drain(),new Promise(resolve=>setTimeout(resolve,10_000))]);await closeSharedHost(sharing,host);await Promise.race([hostClosed(home),new Promise(resolve=>setTimeout(resolve,3_000))]);})().catch(()=>{}).finally(()=>app.exit(0));
    return;
  }
  quitting = (async () => {
    const ready = await Promise.all(BrowserWindow.getAllWindows().map(prepareClose));
    // A failed flush keeps a window open to try again; with no window left, nothing can retry.
    if (!ready.every(Boolean) && BrowserWindow.getAllWindows().some((win) => !win.isDestroyed())) return;
    lineEnded = true;
    await line?.close();
    await (await sharing).close();
    releaseAwake();
    await telemetry.then(value=>value?.close(),()=>{});
    companySignIn.close();
    // A flushed renderer must leave before Host shutdown refuses live view refreshes.
    // Otherwise its live subscriptions refresh against a Host that now refuses calls.
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
    // A restore that is running finishes first, as the current host does: its result is then kept for the next start.
    await Promise.race([restorer.drain(), new Promise((r) => setTimeout(r, 60_000))]);
    host.close(); // Existing host shutdown/recovery ownership is unchanged; close() returns void.
    quitReady = true;
    // Every window has flushed. Exit directly once the host has stopped, or after a bound: a second
    // app.quit() can stall in Electron's shutdown with this process's timers no longer running.
    await Promise.race([hostClosed(home), new Promise((r) => setTimeout(r, 5_000))]);
    app.exit(0);
  })().catch(() => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.webContents.isDestroyed()) win.webContents.send('workspace-close-failed', 'The app could not finish closing. Your work is still open; try again.');
  }).finally(() => { quitting = undefined; if (!quitReady) identitySessions.reopen(); });
});

} // singleOwner
