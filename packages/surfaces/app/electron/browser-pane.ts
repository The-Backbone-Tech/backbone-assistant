// Personal browsing only. No page content, script execution or engine port crosses this boundary.
import { BrowserWindow, WebContentsView, session, shell, type IpcMainInvokeEvent, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { policyFor } from '@backbone-next/platform/policy';
import { browserPolicyDecision } from './browser-policy';
import { browserAddress, browserResourceAllowed } from './browser-address';
import type { BrowserState, BrowserRequest } from '../src/lib/browser-types';

export function browserPolicyReason(folder: string): string | undefined {
  return browserPolicyDecision(policyFor(folder));
}

const NOTICE_INTERVAL_MS = 5000;
const ADDRESS_REFUSAL = 'Only HTTP and HTTPS pages can open here. Use an address without credentials, backslashes or control characters.';
const ADDRESS_TOO_LONG = 'This address is longer than 8,192 characters, so it cannot be opened.';
/** Why an address was refused: its length is a different reason from its content. */
const addressRefusal = (value: string) => value.length > 8192 ? ADDRESS_TOO_LONG : ADDRESS_REFUSAL;

export class BrowserPane {
  readonly view: WebContentsView;
  private state: BrowserState = { url: '', title: 'Browser', phase: 'empty', back: false, forward: false };
  private visible = false;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  private readonly ownerContents: Electron.WebContents;
  private readonly contents: Electron.WebContents;
  private disposed = false;
  revoked = false;
  private shutdown: Promise<unknown> = Promise.resolve();
  private readonly policyTimer: ReturnType<typeof setInterval>;
  constructor(private readonly win: BrowserWindow, private readonly policy: () => string | undefined) {
    this.ownerContents = win.webContents;
    // No persist: prefix: cookies, cache and page storage die with this app session.
    const isolated = session.fromPartition(`personal-browser-${randomUUID()}`, { cache: false });
    isolated.setPermissionRequestHandler((_contents, permission, callback) => {callback(false);if(permission === 'openExternal') this.notice('Only HTTP and HTTPS pages can open here.');});
    isolated.setPermissionCheckHandler((_contents, permission) => {if(permission === 'openExternal') this.notice('Only HTTP and HTTPS pages can open here.');return false;});
    isolated.setDevicePermissionHandler(() => false);
    isolated.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    isolated.on('will-download', event => { event.preventDefault(); this.notice('Downloads are blocked. Use Open in my browser to save this file.'); });
    isolated.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const reason = this.policy();
      const cancel = !!reason || !browserResourceAllowed(details.url);
      callback({ cancel });
      if (reason) this.revoke(reason);
    });
    this.view = new WebContentsView({ webPreferences: {
      session: isolated, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      navigateOnDragDrop: false, safeDialogs: true, disableDialogs: true,
    } });
    this.contents = this.view.webContents;
    this.view.setVisible(false);
    this.contents.setAudioMuted(true);
    win.contentView.addChildView(this.view);
    const wc = this.contents;
    wc.setWindowOpenHandler(() => { this.notice('New windows are blocked. Open the link in this page or in your browser.'); return { action: 'deny' }; });
    wc.on('will-attach-webview', event => event.preventDefault());
    wc.on('will-navigate', (event, url) => { if (!this.admitNavigation(url)) event.preventDefault(); });
    const frameNavigation = (event: Electron.Event & {url: string; isMainFrame: boolean}) => {
      const reason = this.policy();
      if (reason) { event.preventDefault(); this.revoke(reason); return; }
      if (event.isMainFrame ? !this.admitNavigation(event.url) : !this.frameAddress(event.url)) event.preventDefault();
    };
    wc.on('will-frame-navigate', frameNavigation);
    wc.on('will-redirect', frameNavigation);
    wc.on('select-client-certificate', (event, _url, _certificates, callback) => {
      event.preventDefault();
      // Electron accepts an omitted certificate to decline; its callback type requires one.
      (callback as (certificate?: Electron.Certificate) => void)();
    });
    wc.on('will-prevent-unload', event => event.preventDefault());
    wc.on('certificate-error', (event, _url, _error, _certificate, callback) => { event.preventDefault(); callback(false); this.failed('The page certificate could not be verified.'); });
    wc.on('did-start-loading', () => { this.state = { ...this.state, phase: 'loading', detail: undefined, technical: undefined }; this.publish(); });
    wc.on('did-navigate', (_event, url) => { this.state.url = url; this.state.detail = undefined; this.state.technical = undefined; this.publish(); });
    wc.on('did-navigate-in-page', (_event, url, main) => { if (main) { this.state.url = url; this.publish(); } });
    wc.on('page-title-updated', (_event, title) => { this.state.title = title.slice(0, 200) || 'Browser'; this.publish(); });
    wc.on('did-finish-load', () => { if (this.state.phase === 'loading') this.state.phase = 'ready'; this.publish(); });
    wc.on('did-stop-loading', () => { if (this.state.phase === 'loading') this.state.phase = 'ready'; this.publish(); });
    wc.on('did-fail-load', (_event, code, description, _url, main) => {
      if (!main) return;
      if (code === -3) this.settleAborted();
      else if (code <= -200 && code >= -299) this.failed('The page certificate could not be verified.', String(description || `error ${code}`));
      else this.failed('Could not load this page. Check the address and your connection, then try again. If you submitted a form, its result is not known; check before submitting again.', String(description || `error ${code}`));
    });
    wc.on('render-process-gone', () => this.failed('The page stopped responding. Reload to try again.'));
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if ((input.meta || input.control) && input.key.toLowerCase() === 'r') {
        event.preventDefault(); void this.request({action:'reload'}); return;
      }
      if (input.key === 'Escape' || ((input.meta || input.control) && (input.key.toLowerCase() === 'l' || (input.shift && input.key.toLowerCase() === 'b')))) {
        event.preventDefault(); win.webContents.focus(); win.webContents.send('browser-focus-address');
      }
    });
    win.on('resize', this.hideForResize);
    win.webContents.on('did-start-navigation', this.hideForResize);
    win.once('closed', () => this.dispose());
    this.policyTimer = setInterval(() => { const reason = this.policy(); if (reason) this.revoke(reason); }, 1000);
    this.policyTimer.unref();
  }
  private hideForResize = () => { if (!this.disposed) { this.visible = false; this.view.setVisible(false); if (!this.contents.isDestroyed()) this.contents.setAudioMuted(true); } };
  // A noisy page can ask for the same refused thing many times a second. The same notice that is still
  // showing is not rewritten (and not sent to the window again) for NOTICE_INTERVAL_MS.
  private lastNotice = { detail: '', at: 0 };
  private notice(detail: string) {
    const now = Date.now();
    if (this.state.detail === detail && this.lastNotice.detail === detail && now - this.lastNotice.at < NOTICE_INTERVAL_MS) return;
    this.lastNotice = { detail, at: now };
    this.state.detail = detail; setImmediate(() => this.publish());
  }
  private failed(detail: string, technical?: string) { this.state = { ...this.state, phase: 'failed', detail, technical }; this.publish(); }
  private settleAborted() {
    if (this.disposed || this.contents.isDestroyed() || this.state.phase !== 'loading' || this.contents.isLoading()) return;
    const url = this.contents.getURL();
    this.state = {...this.state, ...(url ? {url} : {}), phase: url ? 'ready' : 'stopped', detail:'Navigation stopped. Check the page before trying again.'};
    this.publish();
  }
  private frameAddress(url: string) {
    return /^https?:\/\//i.test(url) || ['about:blank','about:srcdoc'].includes(url) || /^(data|blob):/.test(url);
  }
  private clearSession() {
    const isolated = this.contents.session;
    if (!this.contents.isDestroyed()) this.contents.close();
    this.shutdown = Promise.all([isolated.closeAllConnections(), isolated.clearStorageData()]);
    void this.shutdown.catch(() => {});
  }
  private revoke(detail: string) {
    if (!this.revoked) {
      this.revoked = true;
      this.clearSession();
    }
    this.state = { ...this.state, phase: 'blocked', detail }; this.publish();
  }
  private refused(detail: string) { this.state = { ...this.state, phase: this.state.url ? this.state.phase : 'blocked', detail }; setImmediate(() => this.publish()); }
  private admitNavigation(url: string) {
    const reason = this.policy();
    if (reason) { this.revoke(reason); return false; }
    // Chromium already canonicalized page navigations. Address-entry limits do not apply here.
    if (!/^https?:\/\//i.test(url)) { this.refused('Only HTTP and HTTPS pages can open here.'); return false; }
    return true;
  }
  private publish() {
    if (this.disposed || this.win.isDestroyed()) return;
    if (!this.contents.isDestroyed()) {
      const history = this.contents.navigationHistory;
      this.state.back = history.canGoBack(); this.state.forward = history.canGoForward();
    }
    const showing = this.visible && ['ready', 'loading'].includes(this.state.phase) && this.bounds.width > 0 && this.bounds.height > 0;
    this.view.setVisible(showing);
    if (!this.contents.isDestroyed()) this.contents.setAudioMuted(!showing);
    this.win.webContents.send('browser-state', this.state);
  }
  async request(request: BrowserRequest): Promise<BrowserState> {
    if (this.disposed) throw new Error('The browser window has closed.');
    if (this.revoked) { await this.shutdown; this.publish(); return { ...this.state }; }
    const wc = this.contents;
    if (request.action === 'layout') {
      const { width, height } = this.win.getContentBounds();
      const supplied = request.bounds;
      const zoom = this.win.webContents.getZoomFactor();
      const r = supplied && {x:supplied.x * zoom,y:supplied.y * zoom,width:supplied.width * zoom,height:supplied.height * zoom};
      if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) throw new Error('Invalid browser bounds.');
      this.bounds = { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.max(0, Math.min(Math.round(r.width), width - Math.max(0, Math.round(r.x)))), height: Math.max(0, Math.min(Math.round(r.height), height - Math.max(0, Math.round(r.y)))) };
      this.visible = request.visible === true;
      this.view.setBounds(this.bounds);
      const reason = this.policy(); if (reason) this.revoke(reason);
    } else if (request.action === 'navigate') {
      if (typeof request.url !== 'string') throw new Error('Enter a page address.');
      if (request.typed === true && request.url.trim() === '') return { ...this.state }; // Nothing was asked for.
      const url = (request.typed === true || /^https?:\/\//i.test(request.url)) ? browserAddress(request.url) : undefined;
      if (url && this.admitNavigation(url)) {
        this.state = { ...this.state, url, title: 'Browser', phase: 'loading', detail: undefined, technical: undefined };
        void wc.loadURL(url).catch(() => { this.settleAborted(); }); // Some cancelled loads emit no did-fail-load.
      } else {
        if (!url) this.refused(addressRefusal(request.url));
        return {...this.state, requestRefused:true};
      }
    } else if (request.action === 'stop') {
      wc.stop(); this.state.phase = 'stopped'; this.state.detail = 'Loading stopped. Reload only if you want to request this page again.';
    } else if (request.action === 'external') {
      const supplied = request.url ?? this.state.url;
      const url = /^https?:\/\//i.test(supplied) ? browserAddress(supplied) : undefined;
      if (url && this.admitNavigation(url)) { await shell.openExternal(url); return { ...this.state, externalDispatched: true }; }
      if (!url) this.refused(/^https?:\/\//i.test(supplied) ? addressRefusal(supplied) : ADDRESS_REFUSAL);
      return {...this.state, requestRefused:true};
    } else if (request.action === 'focus') {
      if (this.visible && this.state.phase === 'ready') wc.focus();
    } else if (request.action === 'back' || request.action === 'forward' || request.action === 'reload') {
      if (this.state.url && this.admitNavigation(this.state.url)) {
        if (request.action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        if (request.action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        if (request.action === 'reload') wc.reload();
      }
    } else if (request.action !== 'state') throw new Error('Invalid browser action.');
    this.publish(); return { ...this.state };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; clearInterval(this.policyTimer);
    this.win.removeListener('resize', this.hideForResize);
    this.ownerContents.removeListener('did-start-navigation', this.hideForResize);
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(this.view);
    if (!this.revoked) this.clearSession();
  }
}

export function registerBrowserPane(refuse: (event: IpcMainInvokeEvent) => void, folder: string, options: {
  unavailable?: (event: IpcMainInvokeEvent) => string | undefined;
  policy?: (folder: string) => string | undefined;
} = {}) {
  const policy = () => (options.policy ?? browserPolicyReason)(folder);
  const panes = new Map<number, BrowserPane>();
  ipcMain.handle('browser-request', (event, request: BrowserRequest) => {
    refuse(event); // Trusted top-level app page only; owner admission follows before creating a view.
    const unavailable = options.unavailable?.(event);
    if (unavailable) return {url:'',title:'Browser',phase:'blocked',back:false,forward:false,detail:unavailable} satisfies BrowserState;
    if (!request || typeof request !== 'object') throw new Error('Invalid browser request.');
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw new Error('Open a local window to browse.');
    let pane = panes.get(win.id);
    if (pane?.revoked && !policy()) { pane.dispose(); panes.delete(win.id); pane = undefined; }
    if (!pane) { pane = new BrowserPane(win, () => options.unavailable?.(event) ?? policy()); panes.set(win.id, pane); win.once('closed', () => panes.delete(win.id)); }
    return pane.request(request);
  });
}
