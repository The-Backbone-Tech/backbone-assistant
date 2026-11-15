import { expect, test, _electron, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { build } from 'vite';
import { join } from 'node:path';
import { startScriptedModel } from '@backbone-next/platform/testing';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';
import { api, appDir, repoRoot } from './journey';

const executablePath = createRequire(import.meta.url)('electron') as string;
test('a person browses beside work with isolated pages and recovers using the keyboard', async () => {
  const home = freshDataHome('browser-pane');
  let app: ElectronApplication | undefined;
  let fail = true;
  let socketRequests = 0;
  const launchFiles = mkdtempSync(join(tmpdir(),'browser-launch-'));
  writeFileSync(join(launchFiles,'main.cjs'),`const {protocol}=require('electron');protocol.registerSchemesAsPrivileged([{scheme:'pane-test',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);require(${JSON.stringify(join(appDir,'dist/electron/main.cjs'))});`);
  const counts = new Map<string,number>();
  const server = createServer((request, response) => {
    counts.set(request.url!, (counts.get(request.url!) ?? 0) + 1);
    if (request.url === '/fail' && fail) { response.destroy(); return; }
    if (request.url === '/redirect-file') {response.writeHead(302,{Location:'file:///etc/passwd'});response.end();return;}
    if (request.url === '/slow') return;
    if (request.url === '/download') { response.writeHead(200, { 'Content-Disposition': 'attachment; filename="test.txt"' }); response.end('test'); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<title>${request.url === '/two' ? 'Second page' : 'Local preview'}</title><style>body{font:16px system-ui;padding:32px;color:#263238;background:#fafafa}a,button{margin-right:16px}</style><h1>Local preview</h1><p>A page beside your work.</p><a href="/two">Second page</a><a target="_blank" href="/two">New window</a><a href="/download">Download</a><a href="file:///etc/passwd">Local file</a><button onclick="Notification.requestPermission().then(x=>document.querySelector('output').textContent=x)">Permission</button><output></output><iframe srcdoc="<h2>Local frame</h2>"></iframe><a href="mailto:person@example.test">Email</a><button onclick="onbeforeunload=e=>{e.preventDefault();e.returnValue=''}">Keep page</button>`);
  });
  server.on('upgrade',(request,socket)=>{
    socketRequests++;
    const accept=createHash('sha1').update(request.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    const message=Buffer.from('live reload ready');socket.end(Buffer.concat([Buffer.from([0x81,message.length]),message]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const certificates = mkdtempSync(join(tmpdir(),'browser-cert-'));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(certificates,'key.pem'),'-out',join(certificates,'cert.pem'),'-subj','/CN=localhost','-days','1'],{stdio:'ignore'});
  const tls = createHttpsServer({key:readFileSync(join(certificates,'key.pem')),cert:readFileSync(join(certificates,'cert.pem'))},(_request,response)=>response.end('Untrusted certificate'));
  await new Promise<void>(resolve=>tls.listen(0,'127.0.0.1',resolve));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(certificates,'client-key.pem'),'-out',join(certificates,'client-cert.pem'),'-subj','/CN=localhost','-days','1'],{stdio:'ignore'});
  const clientCert=readFileSync(join(certificates,'client-cert.pem'));
  const pin=createHash('sha256').update(new X509Certificate(clientCert).publicKey.export({type:'spki',format:'der'})).digest('base64');
  let peerCertificate:object|undefined;
  const clientTls=createHttpsServer({key:readFileSync(join(certificates,'client-key.pem')),cert:clientCert,ca:clientCert,requestCert:true,rejectUnauthorized:false},(request,response)=>{
    peerCertificate=(request.socket as import('node:tls').TLSSocket).getPeerCertificate();response.end('<h1>No client identity</h1>');
  });
  await new Promise<void>(resolve=>clientTls.listen(0,'127.0.0.1',resolve));

  const model = await startScriptedModel('browser-fixture', () => ({text:`Here is your [Local preview](${origin}). [Email citation](mailto:answer@example.test).`}));
  try {
    app = await _electron.launch({ executablePath, args: [join(launchFiles,'main.cjs'),`--ignore-certificate-errors-spki-list=${pin}`], env: { ...process.env, BACKBONE_HOME: home, BACKBONE_USER_HOME:'', BACKBONE_IDENTITY_ISSUER:'', BACKBONE_IDENTITY_CLIENT_SECRET:'', BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID:model.model, BACKBONE_WINDOW_WIDTH: '1440', BACKBONE_WINDOW_HEIGHT: '900' } });
    const page = await app.firstWindow();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    const project = await api<{ok:boolean;value:{id:string}}>(page, 'projects.create', {name:'Browser preview',kind:'folder'});
    const sent = await api<{ok:boolean;value:{threadId:string}}>(page,'turns.send',{projectId:project.value.id,text:'Show me the local preview link',attachments:[],settings:{permission:'full',model:model.model,effort:3,runsOn:'this-computer',mode:'chat'},clientKey:crypto.randomUUID()});
    expect(sent.ok).toBe(true);
    await expect.poll(async () => (await api<{value:{summary:{running:boolean}}}>(page,'threads.get',{id:sent.value.threadId})).value.summary.running).toBe(false);
    const prefs = await api<Record<string, unknown>>(page, 'viewer.get', {});
    await api(page,'viewer.put',{prefs:{...prefs,theme:'light',selectedThreadId:sent.value.threadId,selectedProjectId:project.value.id,pane:{open:true,tabs:[{id:'launcher',kind:'launcher'}],active:'launcher'}}});
    await page.reload();
    await page.getByRole('option',{name:/Browser/}).click();
    const address = page.getByRole('textbox',{name:'Page address'});
    await expect(address).toBeFocused();
    await expect(page.getByText('Pages you open here are yours; the assistant does not see them')).toBeVisible();
    await app.evaluate(async ({BrowserWindow,session},origin) => {
      await session.defaultSession.cookies.set({url:origin,name:'app-secret',value:'private'});
      const seed = new BrowserWindow({show:false,webPreferences:{session:session.defaultSession,nodeIntegration:false,sandbox:true}});
      await seed.loadURL(origin);
      await seed.webContents.executeJavaScript("localStorage.setItem('app-private','private')");
      seed.destroy();
    },origin);
    await address.fill(origin.replace('http://','')); await address.press('Enter');
    await expect(address).toHaveValue(`${origin}/`);
    await expect(page.getByRole('tab',{name:'Local preview'})).toBeVisible();
    // A second app page has the bridge but no local-owner identity; a foreign page is refused first.
    const otherWindow=await app.evaluate(async ({BrowserWindow},preload)=>{
      const owner=BrowserWindow.getAllWindows()[0];
      const other=new BrowserWindow({show:false,webPreferences:{preload,sandbox:true,contextIsolation:true}});
      try {
        await other.loadURL(owner.webContents.getURL());
        const result=await other.webContents.executeJavaScript('Promise.resolve().then(()=>window.backbone.browserRequest({action:"navigate",url:"https://example.test"})).catch(error=>({error:error.message}))');
        await other.loadURL('data:text/html,foreign');
        const foreign=await other.webContents.executeJavaScript('Promise.resolve().then(()=>window.backbone.browserRequest({action:"state"})).then(()=>"allowed",error=>error.message)');
        return {result,foreign,views:other.contentView.children.filter(v=>'webContents' in v&&(v as Electron.WebContentsView).webContents!==other.webContents).length};
      } finally {other.destroy();owner.focus();}
    },join(appDir,'dist/electron/preload.cjs'));
    expect(otherWindow.result.phase).toBe('blocked');expect(otherWindow.result.detail).toContain('local device owner');
    expect(otherWindow.foreign).toContain('only this app');expect(otherWindow.views).toBe(0);

    const guest = app.context().pages().find(p => p !== page && p.url().startsWith(origin));
    expect(guest, 'Electron exposes the actual embedded renderer').toBeTruthy();
    const web = guest!;
    expect(web.url()).toBe(await address.inputValue());
    await expect(web.getByRole('heading',{name:'Local preview'})).toBeVisible();
    const shotDir = process.env.BACKBONE_BROWSER_EVIDENCE ?? join(repoRoot,'evidence','browser-pane');
    mkdirSync(shotDir,{recursive:true});
    const shot = (name:string) => nativeScreenshot(app!,page,join(shotDir,`${name}.png`));
    await shot('page-light-1440');
    console.log('browser proof: initial page screenshot');
    await expect(web.frameLocator('iframe').getByRole('heading',{name:'Local frame'})).toBeVisible();
    await web.getByRole('button',{name:'Keep page'}).click();

    await web.getByRole('link',{name:'Second page',exact:true}).click();
    await expect(page.getByRole('tab',{name:'Second page'})).toBeVisible();
    await page.getByRole('button',{name:'Back',exact:true}).click();
    await expect(address).toHaveValue(`${origin}/`);
    await address.focus(); await address.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab'); await expect(page.getByRole('button',{name:'Forward',exact:true})).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(address).toHaveValue(`${origin}/two`);
    console.log('browser proof: page navigation');
    const before = counts.get('/two')!;
    await page.getByRole('button',{name:'Reload',exact:true}).focus();
    await expect(page.getByRole('tooltip')).toContainText('Reload');
    await expect(page.getByRole('tooltip')).toContainText('R');
    await page.getByRole('button',{name:'Reload',exact:true}).click();
    await expect.poll(() => counts.get('/two')).toBeGreaterThan(before);
    await page.getByRole('button',{name:'Close Second page',exact:true}).click();
    await expect.poll(()=>app!.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];return (win.contentView.children.find(v=>'webContents' in v&&(v as Electron.WebContentsView).webContents!==win.webContents) as Electron.WebContentsView).webContents.isAudioMuted();})).toBe(true);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+B' : 'Control+Shift+B');
    await expect(address).toBeFocused();
    await expect(address).toHaveValue(`${origin}/two`);
    await expect(page.getByRole('button',{name:'Back',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'Back',exact:true}).focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+B' : 'Control+Shift+B');
    await expect(address).toBeFocused();
    await expect.poll(()=>app!.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];return (win.contentView.children.find(v=>'webContents' in v&&(v as Electron.WebContentsView).webContents!==win.webContents) as Electron.WebContentsView).webContents.isAudioMuted();})).toBe(false);
    // Escape from untrusted content returns to the app without exposing an IPC object.
    await page.getByRole('button',{name:'Open in my browser',exact:true}).focus();
    await page.keyboard.press('Tab');
    await expect.poll(() => app!.evaluate(({webContents}) => webContents.getFocusedWebContents()?.getURL())).toBe(`${origin}/two`);
    const appMarker=await page.evaluate(()=>{const marker=crypto.randomUUID();Object.assign(window,{browserAppMarker:marker});return marker;});
    const beforeShortcut = counts.get('/two')!;
    await app.evaluate(({webContents}) => {const wc=webContents.getFocusedWebContents()!;wc.sendInputEvent({type:'keyDown',keyCode:'R',modifiers:[process.platform==='darwin'?'meta':'control']});wc.sendInputEvent({type:'keyUp',keyCode:'R'});});
    await expect.poll(() => counts.get('/two')).toBeGreaterThan(beforeShortcut);
    expect(await page.evaluate(() => document.querySelector('[data-ready=true]') !== null)).toBe(true);
    // CDP keyboard injection bypasses Electron's native before-input event.
    await app.evaluate(({webContents}) => {const page=webContents.getFocusedWebContents()!;page.sendInputEvent({type:'keyDown',keyCode:'ESC'});page.sendInputEvent({type:'keyUp',keyCode:'ESC'});});
    await expect(address).toBeFocused();
    await address.press('Shift+Tab'); await expect(page.getByRole('button',{name:'Reload',exact:true})).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(page.getByRole('button',{name:'Back',exact:true})).toBeFocused();
    await address.focus(); await address.press('Tab'); await expect(page.getByRole('button',{name:'Open in my browser',exact:true})).toBeFocused();
    const boundary = await web.evaluate(() => ({bridge:typeof (window as unknown as {backbone:unknown}).backbone,require:typeof (window as unknown as {require:unknown}).require,opener:window.opener,cookies:document.cookie,storage:localStorage.getItem('app-private')}));
    expect(boundary).toEqual({bridge:'undefined',require:'undefined',opener:null,cookies:'',storage:null});
    const settings = await app.evaluate(({BrowserWindow}) => {
      const win = BrowserWindow.getAllWindows()[0];
      const child = win.contentView.children.find(v => 'webContents' in v && (v as Electron.WebContentsView).webContents !== win.webContents) as Electron.WebContentsView;
      const prefs = (child.webContents as Electron.WebContents & {getLastWebPreferences():Electron.WebPreferences}).getLastWebPreferences();
      return {node:prefs.nodeIntegration,isolation:prefs.contextIsolation,sandbox:prefs.sandbox,preload:prefs.preload ?? '',sameSession:child.webContents.session === win.webContents.session,webSecurity:prefs.webSecurity,insecure:prefs.allowRunningInsecureContent,subframes:prefs.nodeIntegrationInSubFrames,workers:prefs.nodeIntegrationInWorker,webview:prefs.webviewTag,drag:prefs.navigateOnDragDrop,dialogs:prefs.disableDialogs,safeDialogs:prefs.safeDialogs};
    });
    expect(settings).toEqual({node:false,isolation:true,sandbox:true,preload:'',sameSession:false,webSecurity:true,insecure:false,subframes:false,workers:false,webview:false,drag:undefined,dialogs:true,safeDialogs:true});
    expect(await web.evaluate(async () => (await navigator.permissions.query({name:'geolocation'})).state)).toBe('denied');
    await web.getByRole('link',{name:'New window'}).click();
    await expect(page.getByText(/New windows are blocked/)).toBeVisible();
    expect(app.context().pages()).toHaveLength(2);
    await web.getByRole('button',{name:'Permission'}).click();
    await expect(web.locator('output')).toHaveText('denied');
    await app.evaluate(({BrowserWindow}) => {const win=BrowserWindow.getAllWindows()[0]; const view=win.contentView.children.find(v=>'webContents' in v && (v as Electron.WebContentsView).webContents!==win.webContents) as Electron.WebContentsView; view.webContents.session.once('will-download',event=>{(globalThis as unknown as {browserDownloadBlocked:boolean}).browserDownloadBlocked=event.defaultPrevented;});});
    await web.getByRole('link',{name:'Download',exact:true}).click();
    await expect(page.getByText(/Downloads are blocked/)).toBeVisible();
    expect(await app.evaluate(()=>(globalThis as unknown as {browserDownloadBlocked:boolean}).browserDownloadBlocked)).toBe(true);
    const permissions = await web.evaluate(async () => {
      const media = async (constraints:MediaStreamConstraints) => {try {await navigator.mediaDevices.getUserMedia(constraints);return 'allowed';} catch {return 'denied';}};
      const location = new Promise<string>(resolve => navigator.geolocation.getCurrentPosition(() => resolve('allowed'),() => resolve('denied')));
      const clipboard = navigator.clipboard.readText().then(() => 'allowed',() => 'denied');
      return Promise.all([media({video:true}),media({audio:true}),location,clipboard]);
    });
    expect(permissions).toEqual(['denied','denied','denied','denied']);
    console.log('browser proof: permission requests');
    expect(await web.evaluate(async () => {
      const socket = new WebSocket(location.origin.replace('http:','ws:')+'/live');
      return new Promise<string>(resolve=>{socket.onmessage=event=>resolve(event.data);socket.onerror=()=>resolve('socket refused');});
    })).toBe('live reload ready');
    expect(socketRequests).toBe(1);
    console.log('browser proof: websocket');
    // A privileged, CORS-enabled custom subresource is loadable by Chromium. Only the pane filter refuses it.
    await app.evaluate(async ({BrowserWindow,session},origin)=>{
      const win=BrowserWindow.getAllWindows()[0];
      const guest=win.contentView.children.find(v=>'webContents' in v&&(v as Electron.WebContentsView).webContents!==win.webContents) as Electron.WebContentsView;
      (globalThis as any).browserCustomRequests=0;
      guest.webContents.session.protocol.handle('pane-test',()=>{(globalThis as any).browserCustomRequests++;return new Response('resource',{headers:{'Access-Control-Allow-Origin':'*'}});});
      const control=session.fromPartition('browser-resource-control');
      control.protocol.handle('pane-test',()=>new Response('resource',{headers:{'Access-Control-Allow-Origin':'*'}}));
      const probe=new BrowserWindow({show:false,webPreferences:{session:control,sandbox:true}});
      try {await probe.loadURL(origin);if(await probe.webContents.executeJavaScript('fetch("pane-test://asset/value").then(r=>r.text())')!=='resource')throw Error('Invalid resource control');}
      finally {probe.destroy();await control.clearStorageData();}
    },origin);
    expect(await web.evaluate(()=>fetch('pane-test://asset/value').then(r=>r.text(),()=> 'refused'))).toBe('refused');
    expect(await app.evaluate(()=>(globalThis as any).browserCustomRequests)).toBe(0);
    console.log('browser proof: custom resource');

    await web.getByRole('link',{name:'Local file'}).click();
    await expect.poll(() => web.url()).toBe(`${origin}/two`);
    await address.fill('file:///etc/passwd'); await address.press('Enter');
    await expect(page.getByText('Only HTTP and HTTPS pages can open here.')).toBeVisible();
    await expect(address).toHaveValue('file:///etc/passwd');
    await app.evaluate(({shell}) => { (globalThis as unknown as {browserExternalCalls:string[]}).browserExternalCalls=[]; shell.openExternal=async url => {(globalThis as unknown as {browserExternalCalls:string[]}).browserExternalCalls.push(url);}; });
    await page.getByRole('button',{name:'Local preview',exact:true}).click();
    await page.getByRole('dialog',{name:'Open link'}).getByRole('button',{name:'Open in my browser'}).click();
    await expect(page.getByRole('dialog',{name:'Open link'})).toBeHidden();
    expect(await app.evaluate(() => (globalThis as unknown as {browserExternalCalls:string[]}).browserExternalCalls)).toEqual([`${origin}/`]);
    await page.getByRole('button',{name:'Local preview',exact:true}).click();
    await page.getByRole('button',{name:'Open beside',exact:true}).click();
    await expect(web.getByRole('heading',{name:'Local preview'})).toBeVisible();
    await page.getByRole('button',{name:'Local preview',exact:true}).click();
    await expect.poll(() => app!.evaluate(({BrowserWindow}) => {const win=BrowserWindow.getAllWindows()[0];return (win.contentView.children.find(v=>'webContents' in v && (v as Electron.WebContentsView).webContents!==win.webContents) as Electron.WebContentsView).getVisible();})).toBe(false);
    await page.getByRole('dialog',{name:'Open link'}).getByRole('button',{name:'Cancel',exact:true}).click();
    await expect.poll(() => app!.evaluate(({BrowserWindow}) => {const win=BrowserWindow.getAllWindows()[0];return (win.contentView.children.find(v=>'webContents' in v && (v as Electron.WebContentsView).webContents!==win.webContents) as Electron.WebContentsView).getVisible();})).toBe(true);
    // Closing the dialog returns focus to the link that opened it a moment after the dialog has left the page.
    // The keys that follow wait for that return; sent earlier, the return lands between them and Enter reopens the dialog.
    await expect(page.getByRole('button',{name:'Local preview',exact:true})).toBeFocused();
    await address.focus(); await address.press('Tab'); await expect(page.getByRole('button',{name:'Open in my browser',exact:true})).toBeFocused(); await page.keyboard.press('Enter');
    // The toolbar button has no dialog to close, so the recorded call is the only acknowledgement of its request.
    await expect.poll(() => app!.evaluate(() => (globalThis as unknown as {browserExternalCalls:string[]}).browserExternalCalls)).toEqual([`${origin}/`,`${origin}/`]);
    await page.evaluate(() => {const alert=document.createElement('div');alert.role='alert';alert.className='fixed';alert.textContent='Test closing alert';alert.id='test-fixed-alert';document.body.append(alert);});
    await expect.poll(() => app!.evaluate(({BrowserWindow}) => {const win=BrowserWindow.getAllWindows()[0];return (win.contentView.children.find(v=>'webContents' in v && (v as Electron.WebContentsView).webContents!==win.webContents) as Electron.WebContentsView).getVisible();})).toBe(false);
    await page.evaluate(() => document.getElementById('test-fixed-alert')!.remove());
    await address.fill(`${origin}/fail`); await address.press('Enter');
    await expect(page.getByRole('button',{name:'Retry',exact:true})).toBeVisible();
    await expect(address).toHaveValue(`${origin}/fail`);
    await shot('failed-light-1440');
    console.log('browser proof: failed screenshot');
    await page.getByRole('button',{name:'Dark theme',exact:true}).click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await shot('failed-dark-1440');
    fail = false;
    await page.getByRole('button',{name:'Retry',exact:true}).click();
    await expect(web.getByRole('heading',{name:'Local preview'})).toBeVisible();
    await shot('page-dark-1440');
    await address.fill(`${origin}/redirect-file`);await address.press('Enter');
    await expect(page.getByRole('button',{name:'Retry',exact:true})).toBeVisible();
    expect(web.url()).not.toMatch(/^file:/);
    await address.fill(`https://127.0.0.1:${(tls.address() as {port:number}).port}`);await address.press('Enter');
    await expect(page.getByRole('alert').filter({hasText:/certificate|ERR_CERT/})).toBeVisible();
    await expect(web.getByText('Untrusted certificate')).toHaveCount(0);
    await address.fill(`https://127.0.0.1:${(clientTls.address() as {port:number}).port}`);await address.press('Enter');
    await expect(web.getByRole('heading',{name:'No client identity'})).toBeVisible();
    expect(peerCertificate).toEqual({});
    await address.fill(origin);await address.press('Enter');
    await expect(web.getByRole('heading',{name:'Local preview',exact:true})).toBeVisible();
    console.log('browser proof: TLS identity fixture');
    await address.fill(`${origin}/slow`); await address.press('Enter');
    await expect(page.getByText('Loading page…')).toBeVisible();
    await shot('loading-dark-1440');
    await page.getByRole('button',{name:'Light theme',exact:true}).click();
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    await shot('loading-light-1440');
    await address.focus(); await address.press('Shift+Tab');
    await expect(page.getByRole('button',{name:'Stop loading',exact:true})).toBeFocused(); await page.keyboard.press('Enter');
    await expect(page.getByText('Loading stopped',{exact:true})).toBeVisible();
    await address.fill(origin); await address.press('Enter');
    await expect(web.getByRole('heading',{name:'Local preview'})).toBeVisible();
    const native = await app.browserWindow(page);
    await native.evaluate(win => win.setSize(375,812));
    await expect(address).toBeVisible();
    await expect.poll(() => app!.evaluate(({BrowserWindow}) => {const win=BrowserWindow.getAllWindows()[0];return (win.contentView.children.find(v=>'webContents' in v && (v as Electron.WebContentsView).webContents!==win.webContents) as Electron.WebContentsView).getBounds().width;})).toBe(Math.round((await page.getByLabel('Page content; press Escape to return to the address').boundingBox())!.width));
    await shot('page-light-375');
    console.log('browser proof: narrow screenshot');
    await page.getByRole('button',{name:'Close pane',exact:true}).click();
    await native.evaluate(win => win.setSize(1440,900));
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+B' : 'Control+Shift+B');
    await expect(address).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    const refused = await page.evaluate(async () => window.backbone!.browserRequest!({action:'navigate',url:'mailto:answer@example.test'}));
    expect(refused.phase).toBe('ready');
    expect(refused.detail).toContain('HTTP');
    console.log('browser proof: page link and answer IPC refused');
    await page.getByRole('button',{name:'Email citation',exact:true}).click();
    const refusedDialog=page.getByRole('dialog',{name:'Open link'});
    await refusedDialog.getByRole('button',{name:'Open beside',exact:true}).click();
    await expect(refusedDialog.getByRole('alert')).toContainText('Only HTTP and HTTPS');
    expect(await page.evaluate(async()=>(await window.backbone!.browserRequest!({action:'state'})).phase)).toBe('ready');
    await refusedDialog.getByRole('button',{name:'Cancel',exact:true}).click();
    await expect(page.getByTestId('browser-tab').getByRole('status').filter({hasText:'Only HTTP and HTTPS'})).toBeVisible();
    console.log('browser proof: answer dialog refused');
    expect(await web.evaluate(()=>document.querySelector('h1')?.textContent)).toBe('Local preview');

    // Electron leaves CDP's utility world pending after a refused external protocol.
    // Read the existing main world and native view after this final click.
    await web.getByRole('link',{name:'Email',exact:true}).click({noWaitAfter:true});
    await expect.poll(()=>page.evaluate(()=>document.querySelector('[data-testid="browser-tab"] [role="status"]')?.textContent)).toContain('Only HTTP and HTTPS');
    const afterMail=await page.evaluate(()=>window.backbone!.browserRequest!({action:'state'}));
    expect(afterMail.phase).toBe('ready');expect(afterMail.url).toBe(`${origin}/`);
    expect(await web.evaluate(()=>document.querySelector('h1')?.textContent)).toBe('Local preview');
    await expect.poll(()=>app!.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];return (win.contentView.children.find(v=>'webContents' in v&&(v as Electron.WebContentsView).webContents!==win.webContents) as Electron.WebContentsView).getVisible();})).toBe(true);
    expect(await page.evaluate(()=>(window as any).browserAppMarker)).toBe(appMarker);


  } finally {
    console.log('browser proof: cleanup start');await app?.close();console.log('browser proof: app closed'); await model.close();console.log('browser proof: model closed'); clientTls.closeAllConnections();await new Promise<void>(resolve=>clientTls.close(()=>resolve()));console.log('browser proof: client TLS closed');rmSync(launchFiles,{recursive:true,force:true});tls.closeAllConnections(); await new Promise<void>(resolve=>tls.close(()=>resolve())); console.log('browser proof: TLS closed');rmSync(certificates,{recursive:true,force:true}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); console.log('browser proof: server closed');await removeDataHome(home);console.log('browser proof: data removed');
  }
});


test('managed policy blocks browsing and revokes an already running page', async () => {
  const scratch = mkdtempSync(join(tmpdir(),'browser-policy-'));
  const home = freshDataHome('browser-policy');
  let app: ElectronApplication | undefined;
  let requests = 0;
  let streamClosed = false;
  let idleClosed = false;
  const server = createServer((request,response) => {
    requests++;
    if (request.url === '/idle') {response.setHeader('Connection','keep-alive');request.socket.once('close',()=>{idleClosed=true;});response.end('idle connection');return;}
    if (request.url === '/stream') {response.writeHead(200,{'Content-Type':'text/event-stream'});response.write('data: hello\n\n');request.on('close',() => {streamClosed=true;});return;}
    response.setHeader('Content-Type','text/html');response.end('<title>Running page</title><h1>Running page</h1><script>fetch("/stream"); setInterval(()=>fetch("/tick"),50)</script>');
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    await build({configFile:false,logLevel:'silent',build:{ssr:join(appDir,'electron/browser-pane.ts'),outDir:join(scratch,'bundle'),target:'node22',rollupOptions:{external:['electron'],output:{format:'cjs',entryFileNames:'browser.cjs'}}},ssr:{noExternal:true}});
    writeFileSync(join(scratch,'main.cjs'), `
      const {app,BrowserWindow,ipcMain}=require('electron');
      const {registerBrowserPane}=require(${JSON.stringify(join(scratch,'bundle/browser.cjs'))});
      require(${JSON.stringify(join(appDir,'dist/electron/main.cjs'))});
      globalThis.browserPolicyFixture={blocked:true,install(){
        const win=BrowserWindow.getAllWindows()[0];
        ipcMain.removeHandler('browser-request');
        registerBrowserPane((event)=>{if(event.sender!==win.webContents||event.senderFrame.parent)throw Error('Refused');},'test-folder',{
          policy:()=>this.blocked?'Managed policy is active. Personal browsing is blocked because this policy does not define permitted browser network access.':undefined
        });
      }};
    `);
    app = await _electron.launch({executablePath,args:[join(scratch,'main.cjs')],env:{...process.env,BACKBONE_HOME:home,BACKBONE_USER_HOME:'',BACKBONE_IDENTITY_CLIENT_SECRET:'',BACKBONE_KEYS:'plaintext',BACKBONE_HARNESS:'harness-stub',BACKBONE_MODEL_ENDPOINT:'',BACKBONE_WINDOW_WIDTH:'1440',BACKBONE_WINDOW_HEIGHT:'900'}});
    const page = await app.firstWindow();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    const project = await api<{value:{id:string}}>(page,'projects.create',{name:'Policy preview',kind:'folder'});
    const prefs = await api<Record<string,unknown>>(page,'viewer.get',{});
    await app.evaluate(() => (globalThis as unknown as {browserPolicyFixture:{install():void}}).browserPolicyFixture.install());
    await api(page,'viewer.put',{prefs:{...prefs,theme:'light',selectedProjectId:project.value.id,pane:{open:true,tabs:[{id:'browser',kind:'browser'}],active:'browser'}}});
    await page.reload();
    const address = page.getByRole('textbox',{name:'Page address'});
    await address.fill(origin); await address.press('Enter');
    await expect(page.getByText(/Personal browsing is blocked/)).toBeVisible();
    expect(requests).toBe(0);
    const shotDir = process.env.BACKBONE_BROWSER_EVIDENCE ?? join(repoRoot,'evidence','browser-pane');
    mkdirSync(shotDir,{recursive:true});
    const shot = (name:string) => nativeScreenshot(app!,page,join(shotDir,`${name}.png`));
    await shot('policy-refused-light-1440');
    await page.getByRole('button',{name:'Dark theme',exact:true}).click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await shot('policy-refused-dark-1440');
    // Recreate with the same production controller after policy is removed.
    await app.evaluate(() => {const fixture=(globalThis as unknown as {browserPolicyFixture:{blocked:boolean;install():void}}).browserPolicyFixture;fixture.blocked=false;});
    await address.press('Enter');
    await expect(page.getByRole('tab',{name:'Running page'})).toBeVisible();
    await expect.poll(()=>requests).toBeGreaterThan(2);
    const guest = app.context().pages().find(p=>p!==page && p.url().startsWith(origin))!;
    await guest.evaluate(() => localStorage.setItem('pane-private','private'));
    await app.evaluate(async ({BrowserWindow,net},origin) => {
      const win=BrowserWindow.getAllWindows()[0];
      const view=win.contentView.children.find(v=>'webContents' in v&&(v as Electron.WebContentsView).webContents!==win.webContents) as Electron.WebContentsView;
      const isolated=view.webContents.session;
      (globalThis as any).browserOldSession=isolated;
      await isolated.cookies.set({url:origin,name:'pane-private',value:'private'});
      await new Promise<void>((resolve,reject)=>{const request=net.request({session:isolated,url:origin+'/idle'});request.on('response',response=>{response.on('data',()=>{});response.on('end',resolve);});request.on('error',reject);request.end();});
    },origin);
    expect(idleClosed,'the session connection is still open before revocation').toBe(false);
    await app.evaluate(() => {(globalThis as unknown as {browserPolicyFixture:{blocked:boolean}}).browserPolicyFixture.blocked=true;});
    await expect(page.getByText(/Personal browsing is blocked/)).toBeVisible();
    await expect.poll(()=>guest.isClosed()).toBe(true);
    await expect.poll(()=>streamClosed).toBe(true);
    await expect.poll(()=>idleClosed).toBe(true);
    await page.evaluate(()=>window.backbone!.browserRequest!({action:'state'})); // Join the production cleanup promise.
    expect(await app.evaluate(async () => (globalThis as any).browserOldSession.cookies.get({}))).toEqual([]);
    await app.evaluate(() => {(globalThis as any).browserPolicyFixture.blocked=false;});
    await address.press('Enter');
    await expect(page.getByRole('tab',{name:'Running page'})).toBeVisible();
    const recreated=app.context().pages().find(p=>p!==page&&!p.isClosed()&&p.url().startsWith(origin))!;
    expect(await recreated.evaluate(()=>({storage:localStorage.getItem('pane-private'),cookies:document.cookie}))).toEqual({storage:null,cookies:''});
    // Inspect the retired session itself, so unique-partition recreation cannot hide a missed clear.
    expect(await app.evaluate(async ({BrowserWindow},origin)=>{
      const probe=new BrowserWindow({show:false,webPreferences:{session:(globalThis as any).browserOldSession,sandbox:true}});
      try {await probe.loadURL(origin);return await probe.webContents.executeJavaScript('localStorage.getItem("pane-private")');}
      finally {probe.destroy();}
    },origin)).toBe(null);
  } finally {
    await app?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await removeDataHome(home);rmSync(scratch,{recursive:true,force:true});
  }
});


test('a company window refuses Browser with a reason before sign-in',async()=>{
  const home=freshDataHome('browser-company');
  const issuer=createServer((_request,response)=>{response.writeHead(503);response.end();});
  await new Promise<void>(resolve=>issuer.listen(0,'127.0.0.1',resolve));
  let app:ElectronApplication|undefined;
  try {
    app=await _electron.launch({executablePath,args:[appDir],env:{...process.env,BACKBONE_HOME:home,BACKBONE_USER_HOME:'',BACKBONE_IDENTITY_CLIENT_SECRET:'',BACKBONE_KEYS:'plaintext',BACKBONE_HARNESS:'harness-stub',BACKBONE_MODEL_ENDPOINT:'',BACKBONE_IDENTITY_ISSUER:`http://127.0.0.1:${(issuer.address() as {port:number}).port}`,BACKBONE_IDENTITY_CLIENT_ID:'browser-fixture',BACKBONE_IDENTITY_REDIRECT_URI:'http://127.0.0.1:1/callback',BACKBONE_IDENTITY_TEST_LOOPBACK:'1'}});
    const page=await app.firstWindow();
    await page.waitForFunction(()=>!!window.backbone?.browserRequest);
    const state=await page.evaluate(()=>window.backbone!.browserRequest!({action:'navigate',url:'https://example.test'}));
    expect(state.phase).toBe('blocked');expect(state.detail).toContain('company configuration');
    expect(await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];return win.contentView.children.filter(v=>'webContents' in v&&(v as Electron.WebContentsView).webContents!==win.webContents).length;})).toBe(0);
  } finally {await app?.close();issuer.closeAllConnections();await new Promise<void>(resolve=>issuer.close(()=>resolve()));await removeDataHome(home);}
});

// Electron's page capture omits native child views. Compose the two real captures at
// the enforced native bounds; no page DOM or app styles are changed for the image.
async function nativeScreenshot(app: ElectronApplication, page: import('@playwright/test').Page, path: string) {
  const expected = path.includes('loading-') ? 'loading' : path.includes('failed-') ? 'failed' : path.includes('policy-refused-') ? 'blocked' : 'ready';
  await expect.poll(() => page.evaluate(async () => (await window.backbone!.browserRequest!({action:'state'})).phase)).toBe(expected);
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  if (expected === 'ready') for (const guest of app.context().pages().filter(other => other !== page && /^https?:/.test(other.url()))) {
    await guest.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  const capture = () => app.evaluate(async ({BrowserWindow}) => {
    const win = BrowserWindow.getAllWindows()[0];
    const view = win.contentView.children.find(v => 'webContents' in v && (v as Electron.WebContentsView).webContents && (v as Electron.WebContentsView).webContents !== win.webContents) as Electron.WebContentsView | undefined;
    const child=view?.getVisible() ? await view.webContents.capturePage() : undefined;
    const pixels=child?.toBitmap();
    let painted=false;
    if(pixels)for(let i=4;i<pixels.length;i+=4){if(pixels[i]!==pixels[0]||pixels[i+1]!==pixels[1]||pixels[i+2]!==pixels[2]){painted=true;break;}}
    return {base:(await win.capturePage()).toPNG().toString('base64'),width:win.getContentBounds().width,
      child:child?.toPNG().toString('base64')??null,bounds:view?.getBounds(),painted};
  });
  let captures=await capture();
  // A resumed native surface can initially capture as solid white even after DOM readiness.
  if(expected==='ready')await expect.poll(async()=>{captures=await capture();return !!captures.child&&captures.painted;}).toBe(true);
  const png = await page.evaluate(async captures => {
    const load = (base64:string) => new Promise<HTMLImageElement>((resolve,reject) => {const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=`data:image/png;base64,${base64}`;});
    const base=await load(captures.base);
    const canvas=document.createElement('canvas');canvas.width=base.naturalWidth;canvas.height=base.naturalHeight;
    const context=canvas.getContext('2d')!;context.drawImage(base,0,0);
    if(captures.child && captures.bounds){const child=await load(captures.child);const r=captures.bounds;const scale=base.naturalWidth/captures.width;context.drawImage(child,r.x*scale,r.y*scale,r.width*scale,r.height*scale);}
    return canvas.toDataURL('image/png').split(',')[1];
  },captures);
  writeFileSync(path,Buffer.from(png,'base64'));
}
