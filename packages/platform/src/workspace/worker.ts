// A disposable trusted supervisor: survives Host disconnect long enough to kill and detach.
// No home, provider credential, product database address or inherited environment is given.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { WORKSPACE_WRAPPER, workspaceSetup } from './launch.ts';
import type { WorkspaceRefusalCode } from './result.ts';
import type { WorkspaceCleanupStage } from './store.ts';
import { processIdentity, processOperation, stopSandbox } from './processes.ts';
import { workspaceCommand } from './policy.ts';
import { system, systemEnvironment, detach } from './volume.ts';

const folder = process.argv[2]!;
let child: ChildProcess | undefined, stopping = false, reason: string | undefined;
const kill = () => { if (child?.pid && child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
const stop = (why: string) => { stopping = true; reason ??= why; kill(); };
process.on('disconnect', () => stop('host disconnected'));
process.on('message', async (message: { command: string; inputs: { name: string; base64: string }[]; expiresAt: number }) => {
  if (child) return;
  let timer: NodeJS.Timeout | undefined, usageTimer: NodeJS.Timeout | undefined;
  let inspecting: Promise<void> | undefined, closing = false;
  let drained: Promise<boolean> | undefined;
  let memoryStop: { detectedAtMs: number; stoppedAtMs?: number; detachedAtMs?: number } | undefined;
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), code: number | null = null;
  let admissionReleased = false, setupStatus = '', refused: WorkspaceRefusalCode | undefined;
  let cleanupStage: WorkspaceCleanupStage | undefined;
  const token = randomUUID(), mount = join(folder, `mount-${token}`);
  const label = { permit: join(folder, `.permit-${token}`), refuse: join(folder, `.refuse-${token}`) };
  let ownsRunning = false;
  try {
    const identity = await processIdentity(process.pid);
    if (!identity) throw new Error('Supervisor identity unavailable.');
    await writeFile(join(folder, '.running'), JSON.stringify({ ...identity, token, deadline: Math.min(message.expiresAt, Date.now() + 30_000) }), { flag: 'wx', mode: 0o600 });
    ownsRunning = true;
    await writeFile(label.permit, '', { flag: 'wx', mode: 0o600 });
    await writeFile(label.refuse, '', { flag: 'wx', mode: 0o600 });
    await mkdir(mount, { mode: 0o700 });
    await system('/usr/bin/hdiutil', ['attach', '-nobrowse', '-noautoopen', '-mountpoint', mount, join(folder, 'volume.dmg')]);
    if (stopping) throw new Error('stopped');
    await mkdir(join(mount, 'work'), { recursive: true, mode: 0o700 });
    await mkdir(join(mount, 'inputs'), { recursive: true, mode: 0o700 });
    for (const input of message.inputs) {
      if (!/^[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(input.name)) throw new Error('Unsafe input name.');
      const bytes = Buffer.from(input.base64, 'base64'), path = join(mount, 'inputs', input.name);
      try { await writeFile(path, bytes, { mode: 0o400, flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await readFile(path)).equals(bytes)) throw error; }
    }
    const argv = workspaceCommand(mount, process.platform, undefined, label), work = join(mount, 'work');
    if (Date.now() >= message.expiresAt) {
      // Volume preparation can consume the remaining lease before any command is admitted.
      stop('time limit');
      throw new Error('expired');
    }
    const headroom = await processOperation('headroom');
    child = spawn(argv[0]!, [...argv.slice(1), '/bin/bash', '--noprofile', '--norc', '-c', WORKSPACE_WRAPPER, 'workspace', headroom, message.command], { cwd: work, detached: true, env: { ...systemEnvironment, PATH: '/Library/Developer/CommandLineTools/usr/bin:/usr/bin:/bin', DEVELOPER_DIR: '/Library/Developer/CommandLineTools', HOME: work, TMPDIR: work, PYTHONNOUSERSITE: '1' }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const exited = new Promise<number | null>(resolve => { child!.once('exit', (status, signal) => { if (signal && admissionReleased) reason ??= `command ended by ${signal}`; resolve(status); }); child!.once('error', () => { stop('command could not start'); resolve(null); }); });
    child.stdin!.on('error', () => {});
    timer = setTimeout(() => stop('time limit'), Math.min(30_000, message.expiresAt - Date.now()));
    const collect = (kind: 'out' | 'err', bytes: Buffer) => {
      const used = stdout.length + stderr.length;
      if (used + bytes.length > 65_536) stop('output limit');
      const part = bytes.subarray(0, Math.max(0, 65_536 - used));
      if (kind === 'out') stdout = Buffer.concat([stdout, part]); else stderr = Buffer.concat([stderr, part]);
    };
    child.stdout!.on('data', bytes => collect('out', bytes)); child.stderr!.on('data', bytes => collect('err', bytes));
    const setupPipe = child.stdio[3] as Readable;
    setupPipe.on('data', (bytes: Buffer) => { setupStatus = (setupStatus + bytes.toString('utf8')).slice(0, 64); });
    drained = Promise.all([finished(child.stdout!, { cleanup: true }), finished(child.stderr!, { cleanup: true }), finished(setupPipe, { cleanup: true })]).then(() => true, () => false);
    // `exit`, not `close`: descendants may keep pipes open. Enumerate the inherited Seatbelt
    // label below, so reparenting, setsid, argv changes and an empty environment cannot evade cleanup.
    // Admit no engine code until the OS can identify the inherited label. Refuse if this SPI
    // is unavailable on a future OS; otherwise a missed descendant could look like successful cleanup.
    let admitted = false;
    for (let attempt = 0; attempt < 20 && !stopping && child.exitCode === null && child.signalCode === null; attempt++) {
      const members = JSON.parse(await processOperation('list', label.permit, label.refuse)) as { pid: number }[];
      if (members.some(member => member.pid === child!.pid)) { admitted = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!admitted || stopping) throw new Error('Sandbox descendant identification is unavailable; no engine code ran.');
    usageTimer = setInterval(() => {
      if (closing || inspecting) return;
      inspecting = processOperation('usage', label.permit, label.refuse).then(raw => {
        const usage = JSON.parse(raw) as { cpuSeconds: number[]; memoryBytes: number };
        if (closing) return;
        if (usage.memoryBytes > 1024 ** 3) {
          // First over-budget sample delivered to this supervisor, before it sends any kill.
          memoryStop ??= { detectedAtMs: performance.now() };
          stop("stopped: the workspace's programs used more than 1 GiB of memory");
        }
        else if (usage.cpuSeconds.some(seconds => seconds >= 10)) stop('CPU time limit');
      }).catch(() => { if (!closing) stop('Resource accounting unavailable'); }).finally(() => { inspecting = undefined; });
    }, 200);
    admissionReleased = true; child.stdin!.end('run\n');
    code = await exited;
    kill();
  } catch (error) {
    if (!admissionReleased && !stopping) refused = 'admission';
    else reason ??= `workspace execution failed: ${error instanceof Error ? error.message : 'unknown error'}`;
  }
  finally {
    closing = true; if (timer) clearTimeout(timer); if (usageTimer) clearInterval(usageTimer); await inspecting; kill();
    if (ownsRunning) {
      try {
        cleanupStage = 'stop'; await stopSandbox(label.permit, label.refuse);
        if (memoryStop) memoryStop.stoppedAtMs = performance.now();
        // Exit does not imply the pipes have delivered their last bytes. Stop inherited
        // writers first, then join EOF; a delay followed by destroy can discard valid output.
        cleanupStage = 'drain';
        if (drained && !await drained) reason ??= 'command output could not be confirmed';
        else cleanupStage = undefined;
        const outputUnconfirmed = cleanupStage === 'drain';
        cleanupStage = 'detach'; await detach(folder);
        if (memoryStop) memoryStop.detachedAtMs = performance.now();
        cleanupStage = 'unlink';
        await unlink(label.permit); await unlink(label.refuse); await unlink(join(folder, '.running'));
        cleanupStage = outputUnconfirmed ? 'drain' : undefined;
      } catch { await writeFile(join(folder, '.retiring'), '', { mode: 0o600 }); reason = 'workspace cleanup unconfirmed; scratch cannot be reused'; }
    }
    child?.stdout?.destroy(); child?.stderr?.destroy();
    (child?.stdio[3] as Readable | undefined)?.destroy();
    let out = '', err = '';
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      out = decoder.decode(stdout); err = decoder.decode(stderr);
    } catch { reason ??= 'non-UTF8 output'; out = ''; err = '(binary output; encode it as base64 to return it)'; }
    if (admissionReleased && !reason) {
      const setup = workspaceSetup(setupStatus);
      if (setup === 'unconfirmed') reason = 'workspace setup could not be confirmed';
      else if (setup) refused = setup;
    }
    if (refused && !reason) code = null;
    if (process.connected) await new Promise<void>(resolve => process.send!({ code, stdout: out, stderr: err, ...(refused && !reason ? { refused } : {}), ...(reason ? { reason } : {}), ...(cleanupStage ? { cleanupStage } : {}), ...(memoryStop ? { memoryStop } : {}) }, () => resolve()));
    if (process.connected) process.disconnect!();
  }
});
