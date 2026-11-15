// Controller tests execute production source with inert Electron surfaces. Native paths have
// separate Electron specs; these events also cover hardware-dependent callbacks without devices.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { transformWithOxc } from 'vite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const handlers = new Map<string, Function>();
let current: FakeContents;
let createdPreferences: Record<string,unknown>;
let permissionRequest: Function | undefined;
let check: Function | undefined, device: Function | undefined, display: Function | undefined, filter: Function | undefined;
let cleared = 0, connections = 0;
const newSession = () => Object.assign(new EventEmitter(), {
  setPermissionRequestHandler: (fn: Function) => {permissionRequest=fn;},
  setPermissionCheckHandler: (fn: Function) => {check = fn;},
  setDevicePermissionHandler: (fn: Function) => {device = fn;},
  setDisplayMediaRequestHandler: (fn: Function) => {display = fn;},
  webRequest: {onBeforeRequest: (_: object, fn: Function) => {filter = fn;}},
  closeAllConnections: async () => {connections++;}, clearStorageData: async () => {cleared++;},
});
let isolated: ReturnType<typeof newSession>;
class FakeContents extends EventEmitter {
  session = isolated;
  navigationHistory = {canGoBack: () => false, canGoForward: () => false};
  destroyed = false; muted = false; loading = false; pendingLoad: (()=>Promise<void>) | undefined; loaded = ''; reloads = 0;
  close() {this.destroyed = true;}
  isDestroyed() {return this.destroyed;}
  setAudioMuted(value: boolean) {this.muted = value;}
  setWindowOpenHandler(_: Function) {}
  stop() {}
  focus() {}
  reload() {this.reloads++;}
  getURL() {return this.loaded;}
  isLoading() {if(this.destroyed)throw Error('Renderer was destroyed');return this.loading;}
  loadURL(url: string) {this.loaded = url; return this.pendingLoad?.() ?? Promise.resolve();}
}
const owner = Object.assign(new EventEmitter(), {send: () => {}, focus: () => {}, getZoomFactor: () => 1});
const newWindow = () => Object.assign(new EventEmitter(), {id:1, webContents:owner, isDestroyed: () => false,
  getContentBounds: () => ({width:1440,height:900}), contentView:{addChildView: () => {}, removeChildView: () => {}}});
let win = newWindow();
const fake = {
  BrowserWindow: {fromWebContents: () => win},
  WebContentsView: class {webContents = current = new FakeContents(); constructor(options:{webPreferences:Record<string,unknown>}) {createdPreferences=options.webPreferences;} setVisible(_: boolean) {} setBounds(_: object) {}},
  session:{fromPartition: () => (isolated = newSession())}, shell:{openExternal: async () => {}},
  ipcMain:{handle: (key: string, fn: Function) => handlers.set(key,fn)},
};
(globalThis as any).__browserElectron = fake;
const paneUrl=new URL('../electron/browser-pane.ts',import.meta.url);
const transformed=await transformWithOxc(readFileSync(paneUrl,'utf8'),fileURLToPath(paneUrl),{lang:'ts'});
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return {url:'test:electron',shortCircuit:true};
    if (specifier === '@backbone-next/platform/policy') return {url:'test:policy',shortCircuit:true};
    if (specifier.startsWith('./browser-') && context.parentURL?.includes('/electron/')) return next(`${specifier}.ts`,context);
    return next(specifier,context);
  },
  load(url, context, next) {
    if (url === 'test:electron') return {format:'module',shortCircuit:true,source:'export const {BrowserWindow,WebContentsView,session,shell,ipcMain}=globalThis.__browserElectron;'};
    if (url === 'test:policy') return {format:'module',shortCircuit:true,source:'export const policyFor=()=>globalThis.__browserPolicyResult??({status:"none"});'};
    if (url.endsWith('/electron/browser-pane.ts')) return {format:'module',shortCircuit:true,source:transformed.code};
    return next(url,context);
  },
});
const {BrowserPane,registerBrowserPane} = await import('../electron/browser-pane.ts');
const event = (fields = {}) => ({defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...fields});
const pane = () => {permissionRequest=undefined;check=undefined;device=undefined;display=undefined;filter=undefined;win=newWindow();return new BrowserPane(win as any, () => undefined);};

test('a requested client identity is refused even when certificates are offered', () => {
  const p = pane();
  try {
    const e = event(); let answer: unknown = 'not answered';
    current.emit('select-client-certificate',e,'https://local.test',[{subjectName:'Test identity'}],(certificate: unknown) => {answer=certificate;});
    assert.equal(e.defaultPrevented,true); assert.equal(answer,undefined);
  } finally {p.dispose();}
});
test('an invalid server certificate is refused by the explicit handler',async()=>{
  const p=pane();
  try {
    const e=event();let answer:unknown;
    current.emit('certificate-error',e,'https://local.test','bad certificate',{},(value:unknown)=>{answer=value;});
    assert.equal(e.defaultPrevented,true);assert.equal(answer,false);
    assert.match((await p.request({action:'state'})).detail!,/certificate/);
  } finally {p.dispose();}
});
test('a page cannot prevent unload and an aborted load settles', async () => {
  const p = pane();
  try {
    const e = event(); current.emit('will-prevent-unload',e); assert.equal(e.defaultPrevented,true);
    await p.request({action:'navigate',url:'http://localhost:5173'});
    current.emit('did-fail-load',{},-3,'ERR_ABORTED',current.loaded,true);
    assert.notEqual((await p.request({action:'state'})).phase,'loading');
  } finally {p.dispose();}
});
test('frame and redirect refusals preserve a loaded page and local document frames', async () => {
  const p = pane();
  try {
    await p.request({action:'navigate',url:'https://example.test'}); current.emit('did-finish-load');
    const attachment=event();current.emit('will-attach-webview',attachment);assert.equal(attachment.defaultPrevented,true);
    for (const name of ['will-frame-navigate','will-redirect']) {
      const bad = event({url:'custom://refused',isMainFrame:false}); current.emit(name,bad,'custom://refused',false); assert.equal(bad.defaultPrevented,true,name);
      assert.equal((await p.request({action:'state'})).phase,'ready');
      for (const url of ['about:blank','about:srcdoc','data:text/html,hello','blob:https://example.test/id']) {
        const local = event({url,isMainFrame:false}); current.emit(name,local,url,false); assert.equal(local.defaultPrevented,false,url);
      }
    }
    for (const url of ['custom:5173','file:///etc/passwd','ws://localhost:5173']) {const e=event();current.emit('will-navigate',e,url);assert.equal(e.defaultPrevented,true,url);}
    const top = event(); current.emit('will-navigate',top,'mailto:person@example.test'); assert.equal(top.defaultPrevented,true);
    const state = await p.request({action:'navigate',url:'mailto:person@example.test'});
    assert.equal(state.phase,'ready'); assert.match(state.detail!,/HTTP/);
    const external = await p.request({action:'external',url:'mailto:person@example.test'});
    assert.equal(external.phase,'ready'); assert.equal(external.externalDispatched,undefined);
  } finally {p.dispose();}
});
test('session handlers deny checks, devices and display capture and filter non-web resources', () => {
  const p = pane();
  try {
    let permission:unknown;permissionRequest?.(current,'notifications',(value:unknown)=>{permission=value;});assert.equal(permission,false);
    assert.equal(check?.(current,'geolocation','https://example.test',{}),false);
    assert.equal(device?.({deviceType:'usb',origin:'https://example.test'}),false);
    let sources:unknown; display?.({},(value: unknown) => {sources=value;}); assert.deepEqual(sources,{});
    for (const [url,expected] of [['custom://subresource',true],['file:///etc/passwd',true],['ws://localhost:5173/live',false],['wss://example.test/live',false],['data:image/png;base64,AA',false]] as const) {
      let result:unknown; filter?.({url},(value:unknown) => {result=value;}); assert.deepEqual(result,{cancel:expected},url);
    }
  } finally {p.dispose();}
});
test('hidden pages are muted, page reload stays in the page and disposal clears storage and connections', async () => {
  const p = pane(); const before = {cleared,connections};
  assert.equal(current.muted,true);
  await p.request({action:'navigate',url:'http://localhost:5173'}); current.emit('did-finish-load');
  await p.request({action:'layout',visible:true,bounds:{x:0,y:0,width:400,height:300}}); assert.equal(current.muted,false);
  await p.request({action:'layout',visible:false,bounds:{x:0,y:0,width:400,height:300}}); assert.equal(current.muted,true);
  const e = event(); current.emit('before-input-event',e,{type:'keyDown',key:'r',meta:true}); assert.equal(e.defaultPrevented,true); assert.equal(current.reloads,1);
  p.dispose(); await Promise.resolve(); assert.equal(cleared,before.cleared+1); assert.equal(connections,before.connections+1);
});
test('the canonical validated address is exactly the address loaded', async () => {
  const p=pane();
  try {
    for (const [input,url] of [['localhost:5173','http://localhost:5173/'],['example.test/path','https://example.test/path'],['https://例え.テスト/資料','https://xn--r8jz45g.xn--zckzah/%E8%B3%87%E6%96%99']]) {
      const state=await p.request({action:'navigate',url:input,typed:true});assert.equal(current.loaded,url);assert.equal(state.url,url);
    }
  } finally {p.dispose();}
});
test('production registration uses the policy reader and revokes an idle page',async()=>{
  (globalThis as any).__browserPolicyResult={status:'none'};
  registerBrowserPane(()=>{},'test-folder');
  const invoke=handlers.get('browser-request')!;
  await invoke({sender:owner},{action:'navigate',url:'http://localhost:5173'});
  const retired=current;
  current.emit('did-finish-load');
  (globalThis as any).__browserPolicyResult={status:'verified',policy:{}};
  await new Promise(resolve=>setTimeout(resolve,1100));
  assert.equal(retired.destroyed,true);
  const state=await invoke({sender:owner},{action:'state'});
  assert.equal(state.phase,'blocked');assert.match(state.detail,/Managed policy/);
  (globalThis as any).__browserPolicyResult={status:'none'};
  await invoke({sender:owner},{action:'navigate',url:'http://localhost:5173'});
  assert.notEqual(current,retired);
  win.emit('closed');
  delete (globalThis as any).__browserPolicyResult;
});
test('production IPC checks the trusted sender before owner refusal',()=>{
  registerBrowserPane(()=>{throw Error('foreign sender');},'test-folder',{unavailable:()=> 'owner only'});
  assert.throws(()=>handlers.get('browser-request')!({sender:owner},{action:'state'}),/foreign sender/);
});
test('production IPC returns a reason to non-owner windows without creating a view', async () => {
  registerBrowserPane(() => {},'test-folder',{unavailable:()=> 'Browser is not available here. Pages belong to the local device owner.'});
  const previous=current;
  const state = await handlers.get('browser-request')!({sender:owner},{action:'navigate',url:'https://example.test'});
  assert.equal(current,previous,'no view is created for a non-owner');
  assert.equal(state.phase,'blocked'); assert.match(state.detail,/local device owner/);
});
// Hooks remain installed through tests so dynamically resolved source keeps the inert ports.
process.once('exit', () => hook.deregister());

test('superseding a pending navigation keeps the new address loading without a false stop notice',async()=>{
  const p=pane();let rejectFirst!:(error:Error)=>void;
  try {
    current.pendingLoad=()=>new Promise((_resolve,reject)=>{rejectFirst=reject;});
    await p.request({action:'navigate',url:'https://example.test/first'});
    current.pendingLoad=undefined;
    await p.request({action:'navigate',url:'https://example.test/second'});
    current.loading=true;
    current.emit('did-fail-load',{},-3,'ERR_ABORTED','https://example.test/first',true);
    rejectFirst(Error('ERR_ABORTED'));await Promise.resolve();await Promise.resolve();
    const state=await p.request({action:'state'});
    assert.equal(state.phase,'loading');assert.equal(state.url,'https://example.test/second');assert.equal(state.detail,undefined);
    current.loading=false;current.emit('did-navigate',{},state.url);current.emit('did-finish-load');
    assert.equal((await p.request({action:'state'})).detail,undefined);
  } finally {p.dispose();}
});
test('typed addresses normalize hosts while confirmed answer links require an explicit web scheme',async()=>{
  const p=pane();
  try {
    const refused=await p.request({action:'navigate',url:'localhost:5173'});
    assert.equal(refused.requestRefused,true);assert.equal(current.loaded,'');
    const external=await p.request({action:'external',url:'example.test/path'});
    assert.equal(external.requestRefused,true);assert.equal(external.externalDispatched,undefined);
    await p.request({action:'navigate',url:'localhost:5173',typed:true});assert.equal(current.loaded,'http://localhost:5173/');
  } finally {p.dispose();}
});
test('Chromium web navigations and frames are not limited by the typed-address length cap',()=>{
  const p=pane();
  try {
    const url='https://example.test/auth?state='+ 'x'.repeat(8200);
    const main=event();current.emit('will-navigate',main,url);assert.equal(main.defaultPrevented,false);
    for(const name of ['will-redirect','will-frame-navigate']) {
      const frame=event({url,isMainFrame:false});current.emit(name,frame,url,false);assert.equal(frame.defaultPrevented,false);
    }
  } finally {p.dispose();}
});

test('disposing a pending page does not touch a destroyed renderer',async()=>{
  const p=pane();let rejectLoad!:(error:Error)=>void;
  current.pendingLoad=()=>new Promise((_resolve,reject)=>{rejectLoad=reject;});
  await p.request({action:'navigate',url:'https://example.test/pending'});
  p.dispose();rejectLoad(Error('ERR_ABORTED'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(current.destroyed,true);
});

test('external-protocol permission refusal explains a link without hiding its page',async()=>{
  const p=pane();
  try {
    for(const probe of ['request','check']) {
      await p.request({action:'navigate',url:'https://example.test'});current.emit('did-finish-load');
      let denied:unknown;
      if(probe==='request')permissionRequest!(current,'openExternal',(value:unknown)=>{denied=value;});
      else denied=check!(current,'openExternal','https://example.test',{});
      assert.equal(denied,false);
      const state=await p.request({action:'state'});assert.equal(state.phase,'ready');assert.match(state.detail!,/Only HTTP and HTTPS/);
    }
  } finally {p.dispose();}
});

test('the created view receives every hardened preference, including drag navigation',()=>{
  const p=pane();
  try {
    const {session:actual,...settings}=createdPreferences;
    assert.equal(actual,current.session);
    assert.deepEqual(settings,{nodeIntegration:false,nodeIntegrationInSubFrames:false,nodeIntegrationInWorker:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,navigateOnDragDrop:false,safeDialogs:true,disableDialogs:true});
  } finally {p.dispose();}
});

test('an empty typed address is not a request: nothing is refused and nothing is shown', async () => {
  const p = pane();
  try {
    for (const blank of ['', '   ']) {
      const state = await p.request({ action: 'navigate', url: blank, typed: true });
      assert.equal(state.phase, 'empty'); assert.equal(state.detail, undefined); assert.equal(state.requestRefused, undefined);
      assert.equal(current.loaded, '');
    }
  } finally { p.dispose(); }
});

test('a page that fails to load gets a plain sentence; the network error code is kept apart for Details', async () => {
  const p = pane();
  try {
    await p.request({ action: 'navigate', url: 'https://example.test/gone' });
    current.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.test/gone', true);
    const state = await p.request({ action: 'state' });
    assert.equal(state.phase, 'failed');
    assert.doesNotMatch(state.detail!, /ERR_|-105/); assert.match(state.detail!, /could not load/i);
    assert.equal(state.technical, 'ERR_NAME_NOT_RESOLVED');
    await p.request({ action: 'navigate', url: 'https://example.test/again' });
    assert.equal((await p.request({ action: 'state' })).technical, undefined);
  } finally { p.dispose(); }
});

test('an address too long for Open in my browser is refused for its length, not for another reason', async () => {
  const p = pane();
  try {
    const long = 'https://example.test/?q=' + 'x'.repeat(8200);
    const state = await p.request({ action: 'external', url: long });
    assert.equal(state.requestRefused, true);
    await new Promise(resolve => setImmediate(resolve));
    const after = await p.request({ action: 'state' });
    assert.match(after.detail!, /8,192/); assert.doesNotMatch(after.detail!, /credentials|backslashes/);
    const bad = await p.request({ action: 'external', url: 'https://user:pw@example.test/' });
    await new Promise(resolve => setImmediate(resolve));
    assert.match((await p.request({ action: 'state' })).detail!, /credentials/);
    assert.equal(bad.requestRefused, true);
  } finally { p.dispose(); }
});

test('the same refusal notice from a noisy page is shown once within the interval and again after it', async () => {
  const p = pane();
  const realNow = Date.now; let clock = 1_000_000; Date.now = () => clock;
  try {
    await p.request({ action: 'navigate', url: 'https://example.test' }); current.emit('did-finish-load');
    let publishes = 0; const send = owner.send; owner.send = () => { publishes++; };
    const noisy = () => { permissionRequest!(current, 'openExternal', () => {}); };
    noisy(); await new Promise(resolve => setImmediate(resolve)); const first = publishes;
    for (let i = 0; i < 20; i++) noisy();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(publishes, first, 'repeats inside the interval publish nothing');
    clock += 10_000; noisy(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(publishes, first + 1, 'after the interval the notice is shown again');
    owner.send = send;
  } finally { Date.now = realNow; p.dispose(); }
});

test('a certificate failure keeps its certificate sentence and the code behind Details', async () => {
  const p = pane();
  try {
    await p.request({ action: 'navigate', url: 'https://example.test/' });
    current.emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://example.test/', true);
    const state = await p.request({ action: 'state' });
    assert.match(state.detail!, /certificate/); assert.equal(state.technical, 'ERR_CERT_AUTHORITY_INVALID');
  } finally { p.dispose(); }
});
