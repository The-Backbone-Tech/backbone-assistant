// E7 is Pi's only shell route. Exercise its real OS boundary through the packaged Host,
// with a scripted model and owned positive controls. Use the installed runner's owned
// application copy, or install our own DMG; an arbitrary unpacked executable is refused.
import type { Receipt, Thread, ThreadSummary } from '@backbone-next/platform';
import { removeDataHome } from '@backbone-next/platform/composition';
import { assertHomeWriteAdmission } from '@backbone-next/platform/composition/home-lock';
import { startScriptedModel } from '@backbone-next/platform/testing';
import { WorkspaceStore } from '../../../platform/src/workspace/store.ts';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { api, appDir } from './journey';

test('Pi shell is confined on macOS and a denied outside write is recorded as a failed command without promoting scratch', async ({}, testInfo) => {
  test.setTimeout(300_000);
  expect(process.platform, 'this native boundary probe requires macOS').toBe('darwin');
  const root = realpathSync(mkdtempSync('/tmp/pi-os-sandbox-'));
  const home = join(root, 'home'), canary = join(root, 'outside'), created = join(root, 'escaped');
  const userHome = join(root, 'user-home'), userCanary = join(userHome, 'owned-user-file'), dataCanary = join(home, 'owned-data-file');
  assertHomeWriteAdmission(userHome); mkdirSync(userHome);
  assertHomeWriteAdmission(userHome); writeFileSync(userCanary, 'owned personal canary');
  assertHomeWriteAdmission(home); mkdirSync(home);
  assertHomeWriteAdmission(home); writeFileSync(dataCanary, 'owned data-home canary');
  const scratch = new WorkspaceStore(home);
  const socket = join(root, 'service.sock');
  writeFileSync(canary, 'owned outside canary');
  let tcpHits = 0, udpHits = 0, unixHits = 0;
  const tcp = createServer(client => { tcpHits++; client.end(); });
  const unix = createServer(client => { unixHits++; client.end(); });
  const udp = createSocket('udp4'); udp.on('message', () => { udpHits++; });
  let app: ElectronApplication | undefined;
  let model: Awaited<ReturnType<typeof startScriptedModel>> | undefined;
  try {
    // Another thread's real retained scratch image is Host-readable and contains owned data.
    const peer = await scratch.run('owned-peer-thread', { command: 'printf peer-thread-canary > peer-file', inputs: [] });
    expect(peer.code).toBe(0); expect(peer.reason).toBeUndefined();
    const peerRecord = await scratch.inspect('owned-peer-thread');
    const peerScratch = join(peerRecord!.folder, 'volume.dmg');
    expect(readFileSync(peerScratch).length).toBeGreaterThan(0);
    expect(readFileSync(userCanary, 'utf8')).toBe('owned personal canary');
    expect(readFileSync(dataCanary, 'utf8')).toBe('owned data-home canary');
    tcp.listen(0, '127.0.0.1'); await once(tcp, 'listening');
    unix.listen(socket); await once(unix, 'listening');
    udp.bind(0, '127.0.0.1'); await once(udp, 'listening');
    const port = (tcp.address() as { port: number }).port;
    const udpPort = (udp.address() as { port: number }).port;
    // A denial against an unreachable endpoint proves nothing. All three Host controls deliver.
    const control = createConnection({ host: '127.0.0.1', port }); await once(control, 'close');
    const unixControl = createConnection(socket); await once(unixControl, 'close');
    const received = once(udp, 'message'); udp.send('owned control', udpPort, '127.0.0.1'); await received;
    expect([tcpHits, udpHits, unixHits]).toEqual([1, 1, 1]);
    const python = `import errno,json,os,socket
def denied(action):
 try:
  action()
  return False
 except OSError as e:
  if e.errno not in (errno.EPERM,errno.EACCES): raise
  return True
def connect(family,address):
 with socket.socket(family) as s:
  s.settimeout(2)
  s.connect(address)
def udp_send():
 with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
  s.sendto(b'owned sandbox probe',('127.0.0.1',${udpPort}))
with open('inside','w') as f: f.write('workspace result')
os.symlink(${JSON.stringify(canary)},'outside-link')
print(json.dumps(dict(
 inside=open('inside').read()=='workspace result',
 outside_read=denied(lambda:open(${JSON.stringify(canary)}).read()),
 outside_write=denied(lambda:open(${JSON.stringify(canary)},'w')),
 outside_create=denied(lambda:open(${JSON.stringify(created)},'w')),
 data_home_read=denied(lambda:open(${JSON.stringify(dataCanary)}).read()),
 user_home_read=denied(lambda:open(${JSON.stringify(userCanary)}).read()),
 peer_scratch_read=denied(lambda:open(${JSON.stringify(peerScratch)},'rb').read(1)),
 symlink_read=denied(lambda:open('outside-link').read()),
 symlink_write=denied(lambda:open('outside-link','w')),
 tcp=denied(lambda:connect(socket.AF_INET,('127.0.0.1',${port}))),
 udp=denied(udp_send),
 unix=denied(lambda:connect(socket.AF_UNIX,${JSON.stringify(socket)})),
 environment='PI_SANDBOX_HOST_CANARY' not in os.environ)))`;
    const commands = [
      `python3 - <<'OWNED_PROBE'\n${python}\nOWNED_PROBE`,
      // The OS denial makes the command fail; exit status alone never establishes a policy refusal.
      `printf escape > '${created}'`,
      'cat inside',
    ];
    const results: { code: number | null; stdout: string; stderr: string; reason?: string }[] = [];
    model = await startScriptedModel('pi-os-boundary', messages => {
      const start = messages.findLastIndex(m => m.role === 'user');
      const replies = messages.slice(start + 1).filter(m => m.role === 'tool');
      if (replies.length < commands.length) return { calls: [{ name: 'workspace_run', args: { command: commands[replies.length] } }] };
      results.splice(0, results.length, ...replies.map(m => JSON.parse(typeof m.content === 'string' ? m.content : '') as typeof results[number]));
      return { text: 'The outside write was refused. The workspace result is still available.' };
    });
    let installed = process.env.BACKBONE_APP_EXECUTABLE;
    if (installed) {
      installed = realpathSync(installed);
      expect(installed, 'a supplied executable must be the installed runner\'s owned DMG copy').toMatch(/\/backbone-installed-journey-[^/]+\/application\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/);
    }
    if (!installed) {
      execFileSync(process.execPath, ['scripts/package.mjs'], { cwd: appDir, timeout: 120_000 });
      installed = execFileSync(process.execPath, ['scripts/install-dmg.mjs', join(root, 'application')], { cwd: appDir, encoding: 'utf8', timeout: 60_000 }).trim().split('\n').at(-1)!;
    }
    // Keychain needs the OS home. Person-memory and its canary use an independent fixture home.
    const runtime = { env: { ...process.env, BACKBONE_USER_HOME: userHome, BACKBONE_HOME: home, BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model, PI_SANDBOX_HOST_CANARY: 'owned environment canary' } as Record<string, string> };
    app = await electron.launch({ ...runtime, executablePath: installed, args: [] });
    expect(await app.evaluate(() => process.env.HOME)).toBe(process.env.HOME);
    expect(await app.evaluate(() => process.env.BACKBONE_USER_HOME)).toBe(userHome);
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const page = await app.firstWindow();
    await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: 60_000 });
    const compiled = JSON.parse(readFileSync(join(appDir, 'dist/build.json'), 'utf8'));
    const identity = await page.evaluate(() => window.backbone!.appInfo!());
    expect(identity.version).toBe(compiled.version);
    expect(identity.packaged).toBe(true);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByTestId('build-identity')).toContainText(compiled.id);
    await page.keyboard.press('Escape');
    const call = async <T>(method: string, args: unknown) => {
      const receipt = await api<Receipt<T>>(page, method, args);
      if (!receipt.ok) throw new Error(`${receipt.reason}: ${receipt.detail}`);
      return receipt.value;
    };
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('OS confinement');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Check the OS workspace boundary');
    await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
    await expect(page.getByTestId('work-block').first()).toHaveText(/Worked for \d+/, { timeout: 90_000 });
    const threads = await api<ThreadSummary[]>(page, 'threads.list', {});
    expect(threads).toHaveLength(1);
    const turn = (await call<Thread>('threads.get', { id: threads[0]!.id })).turns.at(-1)!;
    const proof = testInfo.outputPath('boundary.json');
    mkdirSync(dirname(proof), { recursive: true });
    writeFileSync(proof, JSON.stringify({ evidenceLevel: 'installed-app-e2e', platform: process.platform, build: compiled, fixtureHome: home, results, deliveries: { tcpHits, udpHits, unixHits } }, null, 2));
    await testInfo.attach('boundary', { path: proof, contentType: 'application/json' });
    expect(turn.status).toBe('done');
    expect(results).toHaveLength(3);
    expect(results[0]!.code, JSON.stringify(results[0])).toBe(0);
    expect(results[0]!.reason).toBeUndefined();
    expect(JSON.parse(results[0]!.stdout)).toEqual({ inside: true, outside_read: true, outside_write: true, outside_create: true, data_home_read: true, user_home_read: true, peer_scratch_read: true, symlink_read: true, symlink_write: true, tcp: true, udp: true, unix: true, environment: true });
    expect(results[1]!.code).not.toBe(0);
    expect(results[1]!.reason).toBeUndefined();
    expect(results[2]!.stdout.trim()).toBe('workspace result');
    expect(results[2]!.code).toBe(0);
    expect(readFileSync(canary, 'utf8')).toBe('owned outside canary');
    expect(() => readFileSync(created)).toThrow();
    expect([tcpHits, udpHits, unixHits]).toEqual([1, 1, 1]);
    expect(turn.work.steps.some(step => step.kind === 'note' && /workspace_run.*failed.*status [1-9]/.test(step.label))).toBe(true);
    expect(turn.work.steps.some(step => step.kind === 'note' && /workspace_run.*refused/.test(step.label))).toBe(false);
    expect(JSON.stringify(turn.work.steps)).not.toContain('Operation not permitted');
    expect(turn.effects).toHaveLength(0);
    await page.getByTestId('work-block').first().click();
    await expect(page.getByText(/workspace_run.*failed.*status [1-9]/)).toBeVisible();
    const screenshot = testInfo.outputPath('installed-chat.png');
    await page.screenshot({ path: screenshot });
    await testInfo.attach('installed-chat', { path: screenshot, contentType: 'image/png' });
  } finally {
    await app?.close();
    // Scratch intentionally outlives a home close; this disposable fixture owns its retirement.
    await expect.poll(async () => { await scratch.sweep(Number.MAX_SAFE_INTEGER); return existsSync(scratch.directory); }, { timeout: 30_000 }).toBe(false);
    await removeDataHome(home);
    await model?.close();
    await Promise.all([new Promise<void>(resolve => tcp.close(() => resolve())), new Promise<void>(resolve => unix.close(() => resolve()))]);
    udp.close();
    rmSync(root, { recursive: true, force: true });
  }
});
