import { machineClientEnvironment } from './machine-client.ts';
import { verifyAgentExecutable } from './executable.ts';
import type { AcpExecutableIdentity } from '@backbone-next/platform';
import { installedExecutablePath, verifyExecutable, verifyExecutableAccess } from '@backbone-next/platform/executable-identity';
import { constants, openSync, fstatSync, closeSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, PROTOCOL_VERSION, type ClientApp, type ClientConnection } from '@agentclientprotocol/sdk';
import { assertDirectory, assertOpenedDirectory, type DirectoryIdentity } from './directories.ts';
import { AcpRefusal, PROCESS_VISIBILITY_REFUSAL, checkEnvironment } from './refusal.ts';
import { writeRestrictionCommand, type WriteRestrictionOptions } from './write-restrictions.ts';
const machineChecked = Symbol('machine client checked asynchronously');

export interface AgentOptions extends Pick<WriteRestrictionOptions, 'command' | 'args' | 'extraDenies' | 'environment' | 'storage'> {
  acceptsProcessVisibility?: boolean;
  executable?: AcpExecutableIdentity;
  acceptedArguments?: string;
  machineExecutable?: AcpExecutableIdentity;
  machineClient?: 'claude';
  machineClientEnvironment?: Record<string, string>;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
}
export class AgentProcess {
  readonly process: ChildProcessWithoutNullStreams;
  readonly connection: ClientConnection;
  private closing?: Promise<void>;
  private exited = false;
  static async create(options: AgentOptions, workDirectory: DirectoryIdentity, stateDirectory: DirectoryIdentity, app: ClientApp = client({ name: 'backbone-acp' }), beforeSpawn?: () => void): Promise<AgentProcess> {
    if (options.acceptsProcessVisibility !== true) throw new AcpRefusal(PROCESS_VISIBILITY_REFUSAL);
    assertDirectory(workDirectory); assertDirectory(stateDirectory); checkEnvironment(options.env);
    if (options.machineClient && options.extraDenies?.length) throw new AcpRefusal('Claude person-rights cannot honor denied folders.');
    verifyAgentExecutable(options);
    await verifyExecutableAccess(options.executable!);
    const env = await machineClientEnvironment(options);
    await verifyExecutableAccess(options.executable!);
    return new AgentProcess(options, workDirectory, stateDirectory, app, { tag: machineChecked, env, beforeSpawn });
  }
  constructor(options: AgentOptions, workDirectory: DirectoryIdentity, stateDirectory: DirectoryIdentity, app: ClientApp = client({ name: 'backbone-acp' }), checked?: { tag: symbol; env?: Record<string, string>; beforeSpawn?: () => void }) {
    if (options.acceptsProcessVisibility !== true) throw new AcpRefusal(PROCESS_VISIBILITY_REFUSAL);
    assertDirectory(workDirectory); assertDirectory(stateDirectory);
    const work = workDirectory.path, state = stateDirectory.path;
    checkEnvironment(options.env);
    verifyAgentExecutable(options);
    if (options.machineClient && options.extraDenies?.length) throw new AcpRefusal('Claude person-rights cannot honor denied folders.');
    if (options.machineClient && checked?.tag !== machineChecked) throw new AcpRefusal('Machine clients require the asynchronous AgentProcess.create factory.');
    const machine = checked?.env;
    const workFd = openSync(work, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let stateFd: number | undefined;
    try {
      stateFd = openSync(state, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const check = () => { assertOpenedDirectory(workDirectory, fstatSync(workFd)); assertOpenedDirectory(stateDirectory, fstatSync(stateFd!)); };
      check();
      const [command, ...args] = writeRestrictionCommand({ ...options, work, state });
      check();
      checked?.beforeSpawn?.();
      if (options.machineExecutable) verifyExecutable(options.machineExecutable);
      this.process = spawn(command, args, { cwd: work, detached: true, stdio: 'pipe', env: {
        LANG: 'en_US.UTF-8', ...options.env, ...(machine ?? {}),
        PATH: machine?.PATH ?? installedExecutablePath({ ...process.env, PATH: options.env?.PATH ?? process.env.PATH }),
        HOME: machine?.HOME ?? state, XDG_CONFIG_HOME: state, XDG_STATE_HOME: state, XDG_CACHE_HOME: state, TMPDIR: work,
      } });
    } finally { closeSync(workFd); if (stateFd !== undefined) closeSync(stateFd); }
    // Diagnostics may contain account state or secrets. They are deliberately drained, never emitted.
    this.process.stderr.resume();
    this.process.stdin.on('error', () => {});
    this.connection = app.connect(ndJsonStream(Writable.toWeb(this.process.stdin), Readable.toWeb(this.process.stdout) as unknown as Parameters<typeof ndJsonStream>[1], { maxMessageBytes: 1_000_000 }));
    this.process.once('error', () => this.connection.close(new Error('ACP agent could not start.')));
    this.process.once('exit', () => { this.exited = true; this.connection.close(new Error('ACP agent exited.')); });
  }
  async initialize() {
    const initialized = await this.connection.agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'backbone-acp', version: '0.0.0' }, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, session: { compaction: {} } } });
    if (initialized.protocolVersion !== PROTOCOL_VERSION) throw new Error('ACP protocol version is unsupported.');
    return initialized;
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.connection.close();
      const child = this.process;
      const kill = (signal: NodeJS.Signals) => { if (!this.exited && child.exitCode === null && child.signalCode === null && child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
      kill('SIGTERM');
      await new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 250);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      kill('SIGKILL');
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    })();
  }
}
