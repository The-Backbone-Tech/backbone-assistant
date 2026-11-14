// Pinned native-client transport. No tokens, provider credentials or raw config/errors leave here.
import { workspaceScratchParent } from '@backbone-next/platform/workspace-policy';
import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import { CREDENTIAL_PATHS, credentialLocations, unsupportedCredentialDirs } from '@backbone-next/platform/ports';

// Source/experimental-schema binding; actual config and physical admission are separate.
export const CODEX_PROTOCOL = Object.freeze({
  version: '0.165.0',
  revision: '360319d8dee62d87e2d59fc0c21805d79519cfed',
  schema: 'sha256:0a3d36755074a755dfd0eccb948b0bfe3dd3d142247a719d6285d9bef892402d',
});
export const CODEX_VERSION = CODEX_PROTOCOL.version;
export const PROFILE = 'backbone-native-staged';
/** Bind the transport's reported OS to the host whose sandbox is being qualified. */
export function nativePlatform(platform: string = process.platform): 'macos' | 'linux' {
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  throw new Error('Native staged execution requires the verified macOS or Linux sandbox.');
}
/** A fixed diagnostic: no model, provider, path or credential text may cross this boundary. */
export class ReadOnlySourceGateError extends Error {
  constructor() { super('Native read-only source authorization changed; no source was returned.'); }
}

export type ObjectValue = Record<string, unknown>;
export const object = (v: unknown): ObjectValue => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid native protocol object.');
  return v as ObjectValue;
};
/**
 * The environment contract a native turn runs in, chosen by trusted composition, never by a model.
 * `full` (the macOS default; explicit opt-in on Linux): Codex's own working capabilities are on, as when the person uses it directly:
 * memories, skills and their instructions, subagents, goals, live web search (run by the provider, so it
 * carries no local credential), images, and reading the machine with credential-path denies. Linux full masks are snapshots: a rename or
 * later-created path can expose credentials; use contained for the stronger boundary.
 * Full also preserves the person's native MCP servers, apps and plugins, under Codex's own account
 * permissions. Those trusted native calls run outside the command sandbox and Backbone's effect gateway.
 * Command network, hooks, browsers and computer use stay off. There are no command escalations
 * (`approvalPolicy: never`); staged project changes still use the host's versioned import.
 * `contained`: those working capabilities off too, no web search, and reads only of the staged copies.
 */
/**
 * `bare` is never a person's setting: a turn that asked for no tools at all (TurnRequest.bare) runs in
 * the `contained` filesystem with its shell off too, no web search and no client tools.
 */
export type NativeEnvironment = 'full' | 'contained' | 'bare' | 'readOnly';
const containedFeatures: Readonly<Record<string, boolean>> = Object.freeze({
  shell_tool: true, stable_environment_tools: false, view_image: false,
  hooks: false, memories: false, plugins: false, apps: false,
  in_app_browser: false, browser_use: false, browser_use_external: false,
  computer_use: false, image_generation: false, workspace_dependencies: false,
  multi_agent: false, multi_agent_v2: false, goals: false, tool_suggest: false,
  recommended_plugins: false, request_permissions_tool: false, agent_message_board: false,
  code_mode: false, code_mode_host: true, code_mode_prewarm: false,
  skill_mcp_dependency_install: false, skill_search: false, skip_host_skill_discovery: true,
  external_agent_memory_import: false,
});
const fullFeatures: Readonly<Record<string, boolean>> = Object.freeze({
  // Leave native global app/plugin disables intact as well as individual tool settings.
  ...Object.fromEntries(Object.entries(containedFeatures).filter(([name]) => name !== 'apps' && name !== 'plugins')),
  view_image: true, memories: true, multi_agent: true, goals: true,
  skill_search: true, skip_host_skill_discovery: false,
});
const bareFeatures: Readonly<Record<string, boolean>> = Object.freeze({ ...containedFeatures, shell_tool: false });
/** The `contained` set, kept under its earlier name for callers that pin it. */
export const features = containedFeatures;
/**
 * A bare turn inherits no feature the person's own Codex config (or Codex's defaults) turns on: each
 * one switched on in the discovered config, other than the bare set's own, is forced off.
 */
export function bareForcedOff(config: ObjectValue): string[] {
  const flags = config.features === undefined ? {} : object(config.features);
  const names = Object.entries(flags).filter(([name, value]) => value === true && bareFeatures[name] !== true).map(([name]) => name);
  if (names.length > 200 || names.some((n) => !/^[A-Za-z0-9_]{1,100}$/.test(n))) throw new Error('Invalid native feature names.');
  return names.sort();
}
/** One line of `codex features list`: a feature, its stage and whether it is on, as Codex resolves it. */
export interface FeatureState { name: string; stage: string; enabled: boolean }
export function parseFeatures(text: string): FeatureState[] {
  const out: FeatureState[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = /^([A-Za-z0-9_.]{1,100})\s+(.+?)\s+(true|false)\s*$/.exec(line);
    if (!m) throw new Error('Native feature list could not be read.');
    out.push({ name: m[1], stage: m[2].trim(), enabled: m[3] === 'true' });
  }
  if (!out.length || out.length > 500) throw new Error('Native feature list could not be read.');
  return out;
}
/** The only features a bare turn runs with on. */
const BARE_ON = new Set(['code_mode_host', 'skip_host_skill_discovery']);
/**
 * On the pinned Codex no override turns these off: removed-stage flags (which do nothing) and
 * `unified_exec`, which only chooses how the shell runs. A bare turn requires the shell itself off.
 */
const BARE_FIXED = new Set(['unified_exec']);
/** Every feature Codex reports on (the person's config and Codex's defaults alike), but the bare set's own. */
export function bareForcedOffFrom(listed: FeatureState[]): string[] {
  return listed.filter((f) => f.enabled && !BARE_ON.has(f.name) && /^[A-Za-z0-9_]+$/.test(f.name)).map((f) => f.name).sort();
}
/** What is wrong with an effective feature set for a bare turn, or null. */
export function bareEffectiveProblem(listed: FeatureState[], readOnly = false): string | null {
  const shell = listed.find((f) => f.name === 'shell_tool');
  if (!shell || shell.enabled !== readOnly) return 'shell_tool';
  const on = listed.filter((f) => f.enabled && !BARE_ON.has(f.name) && !(readOnly && f.name === 'shell_tool') && f.stage !== 'removed' && !BARE_FIXED.has(f.name));
  return on.length ? on.map((f) => f.name).join(', ') : null;
}
/**
 * The tools Codex offers are chosen from its model catalog (`tool_mode`, `multi_agent_version`, ...),
 * not only from features: on 0.165.0 a code-mode `exec`, `wait` and the collaboration (sub-agent)
 * tools come with every listed model. A bare turn runs on a copy of the catalog Codex itself reports
 * (`codex debug models`), loaded through the supported `model_catalog_json` setting, with every
 * model's tool choices set to none.
 */
export function bareCatalog(raw: string): string {
  const parsed = object(JSON.parse(raw));
  if (!Array.isArray(parsed.models) || !parsed.models.length || parsed.models.length > 500) throw new Error('Native model catalog could not be read.');
  const models = parsed.models.map((value) => {
    const model = { ...object(value) };
    if (typeof model.slug !== 'string' || !model.slug) throw new Error('Native model catalog could not be read.');
    model.tool_mode = 'direct';
    delete model.multi_agent_version;
    model.apply_patch_tool_type = null;
    model.experimental_supported_tools = [];
    model.supports_search_tool = false;
    return model;
  });
  return JSON.stringify({ ...parsed, models });
}
/** The loopback stand-in provider a bare preflight sends its one request to; never the real model. */
export const PREFLIGHT_PROVIDER = 'backbone_bare_preflight';
/** What a captured model request offers: its tools, and any tools carried as input items. */
export function offeredTools(body: unknown): string[] {
  const request = object(body);
  const names: string[] = [];
  const walk = (tool: unknown, prefix = ''): void => {
    const t = tool && typeof tool === 'object' ? tool as { name?: unknown; type?: unknown; tools?: unknown } : {};
    if (Array.isArray(t.tools)) { for (const inner of t.tools) walk(inner, typeof t.name === 'string' ? `${prefix}${t.name}/` : prefix); return; }
    names.push(`${prefix}${String(t.name ?? t.type ?? 'tool')}`);
  };
  if (request.tools !== undefined && request.tools !== null) { if (!Array.isArray(request.tools)) return ['tools']; for (const tool of request.tools) walk(tool); }
  for (const item of Array.isArray(request.input) ? request.input : []) {
    const value = item && typeof item === 'object' ? item as { tools?: unknown; type?: unknown } : {};
    if (value.tools !== undefined || value.type === 'additional_tools') { if (Array.isArray(value.tools) && value.tools.length) for (const tool of value.tools) walk(tool); else names.push(`input ${String(value.type)}`); }
  }
  return names;
}
/** What a bare turn may report: the prompt, reasoning and the answer. Anything else fails it. */
const BARE_ITEMS = new Set(['userMessage', 'reasoning', 'agentMessage']);
export function bareViolation(method: string, params: ObjectValue, readOnly = false): string | null {
  const itemType = (value: unknown) => (value && typeof value === 'object' ? (value as { type?: unknown }).type : undefined);
  const allowed = (value: unknown) => BARE_ITEMS.has(itemType(value) as string) || (readOnly && itemType(value) === 'dynamicToolCall' && !!value && typeof value === 'object' && ['list_files', 'read_file', 'write_file', 'delete_file', 'send_message', 'execute_command'].includes(String((value as { tool?: unknown }).tool)));
  if (method === 'item/started' || method === 'item/completed') return allowed(params.item) ? null : `item ${String(itemType(params.item))}`;
  if (method.startsWith('item/')) return method.startsWith('item/agentMessage/') || method.startsWith('item/reasoning/') ? null : method;
  if (method === 'turn/completed' || method === 'turn/started') {
    const items = (params.turn && typeof params.turn === 'object' ? (params.turn as { items?: unknown }).items : undefined) ?? [];
    if (!Array.isArray(items)) return 'turn items';
    const odd = items.find((item) => !allowed(item));
    return odd === undefined ? null : `item ${String(itemType(odd))}`;
  }
  return null;
}
export const featuresFor = (environment: NativeEnvironment) => (environment === 'full' ? fullFeatures : environment === 'bare' || environment === 'readOnly' ? bareFeatures : containedFeatures);
/** Credential/session paths. Linux full has rename/late-creation limits; see the harness contract. */
// One list for the engine's denies and the host's own readers (platform ports).
export { CREDENTIAL_PATHS };
// Includes a folder a cache-moving variable in the host's environment names (CREDENTIAL_DIR_VARIABLES).
export const credentialDenies = (home: string | undefined, env: Record<string, string | undefined> = process.env) =>
  credentialLocations(home, env).filter((p) => !p.includes('"'));
export const filesystemFor = (environment: NativeEnvironment, extraDenies: readonly string[] = []): Record<string, string> => {
  const inexact = extraDenies.filter((p) => !p.startsWith('/') || /["\\\x00-\x1f]/.test(p));
  if (inexact.length) throw new Error(`A denied folder could not be named exactly (${inexact.length} of them), so the environment is not started. Use absolute folders without quotes.`);
  const explicitDenies = Object.fromEntries(extraDenies.map(p => [p.replace(/\/+$/, '') || '/', 'deny']));
  if (environment !== 'full') return {
    ':root': 'deny', ':minimal': 'read', ':workspace_roots': environment === 'readOnly' ? 'read' : 'write',
    ...explicitDenies,
    // Seatbelt adds implicit scratch grants; Linux's empty root has writable synthetic parents.
    // Ancestor masks constrain both while reopening writable stages. The pinned Linux backend
    // cannot reopen a read-only carveout through a mask; its unmasked profile must still prove
    // Host immutability and private-write isolation. A failed property refuses that turn.
    ...((process.platform === 'darwin' || environment !== 'readOnly') ? { '/tmp': 'deny', '/var/tmp': 'deny', '/private/tmp': 'deny', '/private/var/tmp': 'deny' } : {}),
  };
  // Root read with a credential place the map cannot name exactly would leave it readable: refuse instead.
  const unsupported = unsupportedCredentialDirs(process.env);
  if (unsupported.length || !process.env.HOME?.startsWith('/') || process.env.HOME.includes('"')) {
    throw new Error(`A credential place could not be denied exactly (${unsupported.join(', ') || 'HOME'}), so the full environment is not started. Use an absolute folder without quotes.`);
  }
  const map: Record<string, string> = { ':root': 'read', ':minimal': 'read', ':workspace_roots': 'write' };
  const codexHome = (process.env.CODEX_HOME ?? join(process.env.HOME, '.codex')).replace(/\/+$/, '') || '/';
  if (!isAbsolute(codexHome) || /["\\\x00-\x1f]/.test(codexHome)) throw new Error('Native Codex home cannot be protected exactly.');
  for (const path of [...credentialDenies(process.env.HOME), codexHome, workspaceScratchParent(), '/private' + workspaceScratchParent()]) map[path] = 'deny';
  // The pinned sandbox supports specific read carveouts inside a deny. Expose package/skill
  // content, never auth/config/history; an arrangement's explicit ancestor deny still wins.
  const denies = extraDenies.map(path => path.replace(/\/+$/, '') || '/');
  const skillBlockers = [...denies, ...credentialLocations(undefined, process.env)];
  for (const path of [join(codexHome, 'skills'), join(codexHome, 'plugins', 'cache')]) {
    if (!skillBlockers.some(deny => deny === '/' || path === deny || path.startsWith(deny + '/'))) map[path] = 'read';
  }
  for (const path of denies) map[path] = 'deny';
  return map;
};
export const filesystem = filesystemFor('contained');
const tomlTable = (map: Record<string, string>) => `{ ${Object.entries(map).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(', ')} }`;
export const filesystemOverride = (environment: NativeEnvironment, extraDenies: readonly string[] = []) =>
  `permissions.${PROFILE}.filesystem=${tomlTable(filesystemFor(environment, extraDenies))}`;
/** A bare turn's own settings: its tool-free model catalog, and for its preflight the loopback stand-in provider. */
export interface BareSettings { catalog: string; preflight?: string }
const tomlString = (value: string) => { if (/["\\\x00-\x1f]/.test(value)) throw new Error('Native bare settings could not be named exactly.'); return JSON.stringify(value); };
export function overrides(mcpNames: string[] = [], environment: NativeEnvironment = 'contained', setNames: string[] = [], extraDenies: readonly string[] = [], forcedOff: readonly string[] = [], bare?: BareSettings, stage?: string): string[] {
  const full = environment === 'full';
  const values = [
    ...Object.entries(featuresFor(environment)).map(([k, v]) => `features.${k}=${v}`),
    ...((environment === 'bare' || environment === 'readOnly') ? forcedOff.map((name) => `features.${name}=false`) : []),
    ...((environment === 'bare' || environment === 'readOnly') && bare ? [`model_catalog_json=${tomlString(bare.catalog)}`] : []),
    ...((environment === 'bare' || environment === 'readOnly') && bare?.preflight ? [`model_providers.${PREFLIGHT_PROVIDER}={ name = "preflight", base_url = ${tomlString(bare.preflight)}, wire_api = "responses", requires_openai_auth = false, request_max_retries = 0, stream_max_retries = 0 }`] : []),
    `web_search="${full ? 'live' : 'disabled'}"`, `skills.include_instructions=${full}`,
    'tools.update_plan.enabled=false', 'tools.experimental_request_user_input.enabled=false',
    'model_provider="openai"', 'forced_login_method="chatgpt"', `default_permissions="${PROFILE}"`,
    'shell_environment_policy.inherit="none"', 'allow_login_shell=false',
    filesystemOverride(environment, extraDenies),
    `permissions.${PROFILE}.network.enabled=false`,
    // Full retains Codex's own enabled/disabled and per-tool account policies; never force a server on.
    ...(full ? [] : mcpNames.map((name) => `mcp_servers.${name}.enabled=false`)),
    // Layers merge, so a variable a config layer sets cannot be removed, only emptied: each is set to "".
    ...setNames.filter((name) => name !== 'PATH').map((name) => `shell_environment_policy.set.${name}=""`),
    // No variable is inherited, but the shell needs PATH to find any program by name. It is not a secret.
    `shell_environment_policy.set.PATH=${JSON.stringify(shellPath())}`,
    ...Object.entries(stage ? scratchEnvironment(stage) : {}).map(([name, value]) => `shell_environment_policy.set.${name}=${JSON.stringify(value)}`),
  ];
  return values.flatMap((v) => ['-c', v]);
}

/** Scratch stays inside the granted workspace and is excluded from proposed documents. */
export const scratchEnvironment = (stage: string) => ({ TMPDIR: join(stage, '.backbone-tmp'), TMPPREFIX: join(stage, '.backbone-tmp', 'zsh') });

/** The host's PATH, absolute folders only, with the system folders always present. */
export const shellPath = (path = process.env.PATH ?? '') => {
  const folders = path.split(':').filter((f) => f.startsWith('/') && !/["\\\n]/.test(f));
  for (const system of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) if (!folders.includes(system)) folders.push(system);
  return [...new Set(folders)].join(':');
};

/**
 * The names the person's tools are offered under in the native thread. Codex reserves dynamic tool
 * names beginning `mcp__` for its own MCP servers and refuses the thread that uses one (0.165.0:
 * "dynamic tool name is reserved"), so each is offered as `connector__…`, at most 64 characters and
 * unique; a call comes back under that name and is mapped to the host's own.
 */
export function nativeToolNames(names: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const name of names) {
    const base = `connector__${name.replace(/^mcp__/, '')}`.slice(0, 64);
    let candidate = base;
    for (let i = 2; used.has(candidate); i++) candidate = `${base.slice(0, 60)}_${i}`;
    used.add(candidate);
    out.set(name, candidate);
  }
  return out;
}

export interface NativeOptions {
  /** Trusted composition/test seam. Never populated from a model, message or document. */
  command?: readonly string[];
  temporaryRoot?: string;
  /** Trusted installed standalone Node executable for restricted snapshot capture. */
  snapshotNode?: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  /** Folders denied to the engine in `full` besides the credential places: trusted composition only (the home's settings.json). */
  extraDenies?: readonly string[];
  /** Linux defaults to contained; macOS to full. Trusted composition may explicitly choose either. */
  environment?: NativeEnvironment;
}
export const environmentOf = (options: NativeOptions, platform: string = process.platform): NativeEnvironment => options.environment ?? (platform === 'linux' ? 'contained' : 'full');
export function nativeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Keep native managed-login discovery. API keys, bearer tokens, preload flags and shell hooks
  // are deliberately not inherited. A command's own environment is separately inherit=none.
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'CODEX_HOME', 'XDG_CONFIG_HOME']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}
function launch(options: NativeOptions, args: string[], cwd: string, nodeMode = false, diagnostic = false): ChildProcess {
  const command = options.command ?? ['codex'];
  if (!command.length || command.some((p) => typeof p !== 'string' || p.includes('\0'))) throw new Error('Invalid native command configuration.');
  return spawn(command[0], [...command.slice(1), ...args], { cwd, env: { ...nativeEnvironment(), ...(nodeMode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', diagnostic ? 'pipe' : 'ignore'] });
}
function destroyOwnedChannels(child: ChildProcess) {
  // Parent exit and pipe closure are different: an escaped descendant can retain an inherited
  // pipe indefinitely. These channels belong to this attempt and are never shared with others.
  child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
}
const killedGroups = new WeakSet<ChildProcess>();
export function terminate(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid || killedGroups.has(child)) return;
  try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); if (signal === 'SIGKILL') killedGroups.add(child); }
  catch (e) {
    // macOS answers EPERM for a group that is already exiting; aim at the leader alone then.
    if ((e as NodeJS.ErrnoException).code === 'EPERM') { child.kill(signal); return; }
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error(`Could not stop the owned native process group (${(e as NodeJS.ErrnoException).code}).`); }
}
export async function capture(options: NativeOptions, args: string[], cwd: string, signal: AbortSignal, limit = 1_000_000, nodeMode = false, observe?: (output: string) => void): Promise<string> {
  if (signal.aborted) throw new Error('Native attempt stopped.');
  const child = launch(options, args, cwd, nodeMode, true);
  return new Promise((resolve, reject) => {
    let output = '', diagnostic = '', finished = false, parentExited = false, pipeEnded = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const decoder = new StringDecoder('utf8');
    const finish = (err?: Error) => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(drainTimer); signal.removeEventListener('abort', abort);
      try { terminate(child, 'SIGKILL'); } finally { destroyOwnedChannels(child); }
      if (err) reject(err); else resolve(output);
    };
    const abort = () => finish(new Error('Native attempt stopped.'));
    const timer = setTimeout(() => finish(new Error('Native preflight timed out.')), options.requestTimeoutMs ?? 30_000);
    signal.addEventListener('abort', abort, { once: true });
    child.stdout!.on('data', (chunk: Buffer) => { output += decoder.write(chunk); if (output.length > limit) { finish(new Error('Native preflight output exceeded its limit.')); return; } try { observe?.(output); } catch { finish(new Error('Native preflight observation failed.')); } });
    // Drain bounded evidence; only fixed messages may leave the transport, never raw stderr.
    child.stderr!.on('data', (chunk: Buffer) => { if (diagnostic.length < 16_384) diagnostic += chunk.toString('utf8').slice(0, 16_384 - diagnostic.length); });
    child.stdin!.on('error', () => {});
    child.once('error', () => finish(new Error('The pinned native Codex executable is unavailable.')));
    child.stdout!.once('end', () => { pipeEnded = true; if (parentExited) finish(); });
    child.once('exit', (code) => {
      parentExited = true;
      if (code !== 0) { finish(new Error(sandboxFailure(args, diagnostic))); return; }
      if (pipeEnded) finish();
      else drainTimer = setTimeout(() => finish(), 100);
    });
  });
}

function sandboxFailure(args: string[], diagnostic: string): string {
  if (args[0] !== 'sandbox') return 'Native preflight was refused.';
  if (/namespace.*(?:not permitted|permission denied)|(?:not permitted|permission denied).*namespace/i.test(diagnostic)) return 'Native Linux sandbox cannot create unprivileged user/mount namespaces. An administrator must permit user namespaces for Codex/bubblewrap in the kernel and AppArmor policy (kernel.unprivileged_userns_clone, user.max_user_namespaces, kernel.apparmor_restrict_unprivileged_userns where present). No unconfined fallback was attempted.';
  if (/bwrap:.*execvp.*(?:no such file|permission denied)/i.test(diagnostic)) return 'Native Linux sandbox could not execute the client or requested runtime inside its restricted view. Install trusted runtimes under a permitted minimal runtime path, such as /usr/local. No unconfined fallback was attempted.';
  if (/bubblewrap is unavailable|bwrap: (?:command not found|no such file)/i.test(diagnostic)) return 'Native Linux sandbox requires bubblewrap on PATH or the pinned client\'s verified bundled copy. Install bubblewrap; no unconfined fallback was attempted.';
  if (/seccomp/i.test(diagnostic)) return 'Native Linux sandbox could not establish seccomp restrictions. An administrator must enable kernel seccomp support and permit the sandbox in the outer container policy. No unconfined fallback was attempted.';
  return process.platform === 'linux' ? 'Native Linux sandbox preflight was refused. Verify bubblewrap, unprivileged user/mount namespaces and seccomp, including the administrator\'s AppArmor policy. No unconfined fallback was attempted.' : 'Native preflight was refused.';
}

export class NativeClient {
  private child: ChildProcess;
  private input: Writable;
  private next = 1;
  private pending = new Map<number, { method: string; resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  private stopped = false;
  private failed?: Error;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private handlers = new Set<(method: string, params: ObjectValue) => void>();
  private failureHandlers = new Set<(error: Error) => void>();
  private exited: Promise<void>;
  private parentExitConfirmed = false;
  private closeTask?: Promise<void>;
  private options: NativeOptions;
  /** Answers a client-side tool call; only the tools the host offered at thread start, all others fail closed. */
  private toolCall?: (params: ObjectValue) => Promise<ObjectValue | null>;
  constructor(options: NativeOptions, cwd: string, mcpNames: string[] = [], setNames: string[] = [], forcedOff: string[] = [], bare?: BareSettings) {
    this.options = options;
    this.child = launch(options, ['app-server', '--stdio', ...overrides(mcpNames, environmentOf(options), setNames, options.extraDenies, forcedOff, bare, cwd)], cwd);
    this.input = this.child.stdin!;
    this.exited = new Promise((resolve) => {
      this.child.once('exit', () => {
        this.parentExitConfirmed = true;
        if (!this.stopped) this.fail(new Error('Native client exited before its turn completed.'));
        resolve();
      });
      this.child.once('error', () => {
        // A failed spawn has no live parent to await. An error with a PID does not prove exit.
        if (!this.child.pid) { this.parentExitConfirmed = true; resolve(); }
        this.fail(new Error('The pinned native client could not start.'));
      });
    });
    (this.child.stdout! as Readable).on('data', (chunk: Buffer) => this.read(chunk));
    this.input.on('error', () => { if (!this.stopped) this.fail(new Error('Native protocol input closed.')); });
  }
  private read(chunk: Buffer) {
    if (this.stopped || this.failed) return;
    this.buffer += this.decoder.write(chunk);
    if (this.buffer.length > 4_000_000) { this.fail(new Error('Native protocol line exceeded its limit.')); return; }
    for (;;) {
      const newline = this.buffer.indexOf('\n'); if (newline < 0) return;
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = object(JSON.parse(line));
        if (typeof message.method === 'string') {
          // Clock requests expose no file, network or account capability. A client-side tool call is
          // answered only for a tool the host offered at thread start (the person's own MCP tools,
          // carried by the host's crossing). Everything else requiring host action (approval, any
          // other tool, auth refresh, elicitation) is refused fail-closed.
          if (message.id !== undefined) {
            if (message.method === 'item/tool/call' && this.toolCall) {
              const id = message.id;
              void this.toolCall(object(message.params ?? {})).then((result) => {
                if (!result) this.fail(new Error('Native requested a tool the host did not offer.'));
                else this.send({ id, result });
              }, (error: unknown) => this.fail(error instanceof ReadOnlySourceGateError ? new ReadOnlySourceGateError() : new Error('Native tool call could not be carried.')));
              continue;
            }
            if (message.method !== 'currentTime/read') throw new Error('Unexpected native server request.');
            this.send({ id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } }); continue;
          }
          const params = object(message.params ?? {});
          if (message.method === 'mcpServer/startupStatus/updated' || message.method === 'account/updated') {
            // Startup/account notifications are snapshots; verification below rereads effective
            // state. A turn listener rejects capability changes after admission.
          }
          for (const handler of this.handlers) handler(message.method, params);
        } else {
          if (typeof message.id !== 'number') throw new Error('Invalid native response identifier.');
          const request = this.pending.get(message.id); if (!request) throw new Error('Unexpected native response identifier.');
          clearTimeout(request.timer); this.pending.delete(message.id);
          // Which of our requests, and the protocol's numeric code: both ours to say. The engine's own words stay out.
          // Settled here whatever the error looks like: the request has already left `pending`. Only an error
          // object with a numeric code is a refusal (steer: NOT_DELIVERED); anything else is a protocol failure
          // (steer: UNKNOWN). The code is used only if it already is a finite number, never coerced.
          if ('error' in message) {
            const raw = message.error;
            const code = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { code?: unknown }).code : undefined;
            request.reject(new Error(typeof code === 'number' && Number.isFinite(code)
              ? `Native request was refused (${request.method}, code ${code}).`
              : `Native request answered with a malformed error (${request.method}).`));
          }
          else if ('result' in message) request.resolve(message.result);
          else throw new Error('Invalid native response.');
        }
      } catch { this.fail(new Error('Native protocol failed validation or requested an ungranted host action.')); return; }
    }
  }
  private send(message: unknown) { this.input.write(`${JSON.stringify(message)}\n`); }
  private fail(error: Error) {
    if (this.failed) return; this.failed = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear();
    for (const handler of this.failureHandlers) handler(error);
    terminate(this.child, 'SIGKILL');
  }
  async request(method: string, params: unknown): Promise<unknown> {
    if (this.failed) throw this.failed;
    if (this.stopped) throw new Error('Native client is stopped.');
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Native protocol request timed out.')); this.fail(new Error('Native protocol request timed out.')); }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { method, resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  async initialize() {
    const initialized = object(await this.request('initialize', { clientInfo: { name: 'backbone_native_staged', version: '0.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } }));
    if (initialized.platformOs !== nativePlatform()) throw new Error('Native client platform did not match this host\'s verified sandbox route.');
    this.send({ method: 'initialized' });
  }
  onToolCall(handler: (params: ObjectValue) => Promise<ObjectValue | null>) { this.toolCall = handler; }
  onNotification(handler: (method: string, params: ObjectValue) => void) { this.handlers.add(handler); return () => { this.handlers.delete(handler); }; }
  onFailure(handler: (error: Error) => void) { if (this.failed) handler(this.failed); else this.failureHandlers.add(handler); return () => { this.failureHandlers.delete(handler); }; }
  close(): Promise<void> {
    this.closeTask ??= this.shutdown();
    return this.closeTask;
  }
  private async shutdown() {
    this.stopped = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Native client stopped.')); } this.pending.clear();
    let forceTimer: NodeJS.Timeout | undefined, deadlineTimer: NodeJS.Timeout | undefined;
    try {
      terminate(this.child, 'SIGTERM');
      forceTimer = setTimeout(() => { try { terminate(this.child, 'SIGKILL'); } catch {} }, 300);
      const deadline = new Promise<never>((_resolve, reject) => { deadlineTimer = setTimeout(() => reject(new Error('Native parent shutdown could not be confirmed within its deadline.')), 900); });
      // 'exit' confirms the owned parent stopped. 'close' can wait indefinitely for a pipe held
      // by an escaped process, and is deliberately not used as the lifetime authority.
      await Promise.race([this.exited, deadline]);
      if (!this.parentExitConfirmed) throw new Error('Native parent shutdown could not be confirmed.');
    } finally {
      clearTimeout(forceTimer); clearTimeout(deadlineTimer);
      destroyOwnedChannels(this.child);
      this.handlers.clear(); this.failureHandlers.clear(); this.buffer = '';
      terminate(this.child, 'SIGKILL');
    }
  }

}

export function configValue(response: unknown) { return object(object(response).config); }
export function mcpNames(config: ObjectValue): string[] {
  if (config.mcp_servers === undefined) return [];
  const servers = object(config.mcp_servers);
  const names = Object.keys(servers);
  if (names.length > 100 || names.some((n) => !n || n.length > 200 || !/^[A-Za-z0-9_-]+$/.test(n))) throw new Error('Invalid native MCP configuration names.');
  return names.sort();
}
/** The variable names config layers add to a command's environment; each must then be emptied. */
export function setNames(config: ObjectValue): string[] {
  const set = config.shell_environment_policy === undefined ? undefined : object(config.shell_environment_policy).set;
  if (set == null) return [];
  const names = Object.keys(object(set));
  if (names.length > 100 || names.some((n) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(n))) throw new Error('Invalid native environment variable names.');
  return names.sort();
}
export function verifyConfig(config: ObjectValue, names: string[], environment: NativeEnvironment = 'contained', extraDenies: readonly string[] = [], catalog?: string, stage?: string) {
  if ((environment === 'bare' || environment === 'readOnly') && (!catalog || config.model_catalog_json !== catalog)) throw new Error('Native bare model catalog could not be established.');
  const full = environment === 'full';
  const flags = object(config.features);
  if (flags.code_mode_host !== true) throw new Error('Native required Code Mode host is disabled or unverified.');
  if (Object.entries(featuresFor(environment)).some(([key, value]) => flags[key] !== value)) throw new Error('Native feature controls could not be established.');
  // A bare turn runs with nothing on but its own set: no feature inherited from the person's config.
  if ((environment === 'bare' || environment === 'readOnly') && Object.entries(flags).some(([key, value]) => value === true && bareFeatures[key] !== true)) throw new Error('Native bare feature controls could not be established.');
  if (config.default_permissions !== PROFILE || config.web_search !== (full ? 'live' : 'disabled') || config.model_provider !== 'openai' || config.forced_login_method !== 'chatgpt' || config.allow_login_shell !== false) throw new Error('Native authentication, search or shell controls could not be established.');
  // The child environment is exactly inherit=none: no `set`, include or override field may add variables back,
  // except the host's PATH and attempt-owned scratch, exactly as set here.
  const policy = object(config.shell_environment_policy);
  const expectedEnvironment: Record<string, string> = { PATH: shellPath(), ...(stage ? scratchEnvironment(stage) : {}) };
  const emptied = policy.set != null
    && Object.entries(expectedEnvironment).every(([key, value]) => object(policy.set)[key] === value)
    && Object.entries(object(policy.set)).every(([key, value]) => key in expectedEnvironment ? value === expectedEnvironment[key] : value === '');
  if (policy.inherit !== 'none' || !emptied || Object.entries(policy).some(([key, value]) => key !== 'inherit' && key !== 'set' && value != null)) throw new Error('Native child environment controls could not be established.');
  if (object(config.skills).include_instructions !== full) throw new Error('Native skill controls could not be established.');
  // config/read v2 omits update_plan/request-input settings. They are non-file utilities,
  // so the adapter does not misrepresent their CLI override as an exclusive-tool guarantee.
  const profiles = object(config.permissions), profile = object(profiles[PROFILE]);
  const expected = filesystemFor(environment, extraDenies), actual = object(profile.filesystem);
  const present = Object.entries(actual).filter(([, value]) => value != null);
  if (profile.extends != null || profile.workspace_roots != null || present.length !== Object.keys(expected).length || present.some(([key, value]) => expected[key] !== value) || object(profile.network).enabled !== false || Object.entries(object(profile.network)).some(([key, value]) => key !== 'enabled' && value != null)) throw new Error('Native filesystem or network profile could not be established.');
  const activeNames = mcpNames(config);
  if (activeNames.some((name) => !names.includes(name) || !full && object(object(config.mcp_servers)[name]).enabled !== false)) throw new Error('An unexpected or enabled native MCP server was found.');
  const providers = config.model_providers === undefined ? {} : object(config.model_providers);
  if (providers.openai !== undefined) throw new Error('A native OpenAI provider override is not permitted.');
}
export async function requireChatGpt(client: NativeClient) {
  const response = object(await client.request('account/read', { refreshToken: false }));
  if (object(response.account).type !== 'chatgpt') throw new Error('Native Codex requires an existing managed ChatGPT login.');
}
export const effortNames = { 1: 'minimal', 2: 'low', 3: 'medium', 4: 'high', 5: 'xhigh' } as const;
export interface NativeModel { id: string; label: string; efforts: (1 | 2 | 3 | 4 | 5)[] }
export async function listModels(client: NativeClient): Promise<NativeModel[]> {
  const result: NativeModel[] = []; let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const response = object(await client.request('model/list', { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) }));
    if (!Array.isArray(response.data)) throw new Error('Invalid native model catalog.');
    for (const entry of response.data) {
      const model = object(entry);
      if (model.hidden === true) continue;
      if (typeof model.id !== 'string' || !model.id || typeof model.displayName !== 'string' || !Array.isArray(model.supportedReasoningEfforts) || seen.has(model.id)) throw new Error('Invalid or duplicated native model catalog.');
      seen.add(model.id);
      const supported = model.supportedReasoningEfforts.map((e) => object(e).reasoningEffort);
      result.push({ id: model.id, label: model.displayName, efforts: ([1, 2, 3, 4, 5] as const).filter((n) => supported.includes(effortNames[n])) });
    }
    if (response.nextCursor === null || response.nextCursor === undefined) return result;
    if (typeof response.nextCursor !== 'string' || response.nextCursor === cursor) throw new Error('Invalid native catalog pagination.');
    cursor = response.nextCursor;
  }
  throw new Error('Native model catalog exceeded its pagination limit.');
}
