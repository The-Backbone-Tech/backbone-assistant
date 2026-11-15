// Harness registration, per-home configuration and content-addressed loading.
import { governedPolicy, engineDecision, harnessDecision, routeDecision } from '../policy/index.ts';
import { rm, rmdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ACP_PROCESS_VISIBILITY_WARNING } from '../api.ts';
import { claudeMachineEnvironment } from '../machine-client.ts';
import { verifyAcpAcceptance } from './acp-executable.ts';
import { resolveExecutable } from '../executable-identity.ts';
import type { AcpAgentConfiguration } from '../api-acp.ts';
import { deniedFoldersOf } from './denied-folders.ts';
export { ACP_PROCESS_VISIBILITY_WARNING } from '../api.ts';
import type { HarnessV1, ModelRoute } from '../ports/harness.ts';
import { readJson, sha256 } from '../stub/fsx.ts';
import type { CoreLink } from './core.ts';
import type { HostOptions } from './host-types.ts';
import { loadPiece, PieceRefused, registerPiece, pieceUpgrade, hasAddedCapabilities, type PieceOnDisk } from './pieces.ts';
import { importPiece, snapshotPiece } from './snapshot.ts';

export interface HarnessRegistration {
  factory: string;
  denies?: true;
  codexRoute?: true;
  requiresFull?: true;
  nativeCoordination?: true;
  nativeCatalog?: true;
  ownsModel?: true;
}
export const HARNESSES: Record<string, HarnessRegistration> = {
  'harness-pi': { factory: 'createPiHarness' },
  'harness-codex': { factory: 'createCodexHarness', denies: true, codexRoute: true, requiresFull: true, nativeCoordination: true, nativeCatalog: true },
  'harness-acp': { factory: 'createAcpHarness', denies: true, ownsModel: true, nativeCoordination: true },
};
/** Only known, checked engines may declare that all tools go through the Host. */
export function hostToolsOnly(id: string, manifest?: {capabilities?: {nativeTools?: string}}): boolean {
  const builtins: Record<string, {capabilities: {nativeTools: string}}> = {
    'harness-stub': {capabilities: {nativeTools: 'none'}}, scripted: {capabilities: {nativeTools: 'none'}},
  };
  return (Object.hasOwn(HARNESSES,id) || Object.hasOwn(builtins,id))
    && (manifest ?? builtins[id])?.capabilities?.nativeTools === 'none';
}
const acpStorageBase = () => join(tmpdir(), `backbone-acp-private-${process.getuid?.() ?? 'user'}`);
export const acpStorageDir = (home: string) => join(acpStorageBase(), sha256(home).slice(0, 24));
export const removeHarnessState = async (home: string) => { await rm(acpStorageDir(home), { recursive: true, force: true }); await rmdir(acpStorageBase()).catch(() => {}); };
export const ACP_PROCESS_VISIBILITY_REFUSAL = 'ACP is disabled. Set harnesses.harness-acp.acceptsProcessVisibility: true only if you accept this risk. ' + ACP_PROCESS_VISIBILITY_WARNING;
export interface HarnessConfiguration { options?: object; route?: ModelRoute; blocked?: string }
export function selectHarness(home: string, personal?: string, fallback?: string): string {
  const aliases: Record<string, string> = { pi: 'harness-pi', stub: 'harness-stub' };
  return harnessDecision(governedPolicy(home), personal === undefined ? undefined : aliases[personal] ?? personal, fallback === undefined ? undefined : aliases[fallback] ?? fallback);
}
/** Values of named variables are resolved here; only their names belong in settings.json. */
export function harnessConfiguration(home: string, registration?: HarnessRegistration, env: NodeJS.ProcessEnv = process.env): HarnessConfiguration {
  const policy = governedPolicy(home);
  const id = Object.entries(HARNESSES).find(([, value]) => value === registration)?.[0];
  if (id) engineDecision(policy, id);
  if (registration?.codexRoute) {
    const settings = readJson<{ harnesses?: Record<string, unknown> }>(join(home, 'settings.json'), {});
    const value = settings.harnesses?.['harness-codex'];
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex settings must be an object.');
    const environment = (value as { environment?: unknown }).environment;
    if (environment === undefined) return {};
    if (environment !== 'full' && environment !== 'contained') throw new Error('Codex environment must be full or contained.');
    return { options: { environment } };
  }
  if (!registration?.ownsModel) return {};
  const settings = readJson<{ harnesses?: Record<string, unknown> }>(join(home, 'settings.json'), {});
  return acpConfiguration(home, settings.harnesses?.['harness-acp'], env);
}
/** Shared startup and Settings validation; no writes or agent launch. */
export function acpConfiguration(home: string, value: unknown, env: NodeJS.ProcessEnv = process.env, preparing = false): HarnessConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { blocked: ACP_PROCESS_VISIBILITY_REFUSAL };
  const c = value as Record<string, unknown>;
  const policy = governedPolicy(home);
  const environment = c.environment ?? 'restricted-writes';
  engineDecision(policy, 'harness-acp', { environment: environment as string });
  if (c.acceptsProcessVisibility !== true) return { blocked: ACP_PROCESS_VISIBILITY_REFUSAL };
  if (typeof c.agent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(c.agent) || typeof c.command !== 'string' || !c.command || /[\x00-\x1f]/.test(c.command)) throw new Error('ACP configuration needs a plain agent name and executable command.');
  if (c.machineClient !== undefined && (c.machineClient !== 'claude' || c.environment !== 'person-rights')) throw new Error('Claude machine sign-in requires explicit person-rights; the restricted profile denies machine credentials.');
  if (c.machineClient && deniedFoldersOf(home, 'harness-acp').length) return { blocked: 'Claude person-rights cannot honor denied folders. Neither the machine diagnostic nor the agent was started.' };
  if (c.args !== undefined && (!Array.isArray(c.args) || c.args.some(a => typeof a !== 'string' || a.includes('\0')))) throw new Error('ACP args must be a list of strings.');
  if (c.environment !== undefined && c.environment !== 'restricted-writes' && c.environment !== 'person-rights') throw new Error('ACP environment must be restricted-writes or person-rights (acting with your own rights).');
  if (c.environmentVariables !== undefined && (!Array.isArray(c.environmentVariables) || c.environmentVariables.some(n => typeof n !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) || /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(n) || /^(HOME|TMPDIR|XDG_CONFIG_HOME|XDG_STATE_HOME|XDG_CACHE_HOME)$/.test(n)))) throw new Error('ACP environmentVariables must name allowed variables; the module owns its data folder and scratch paths.');
  if (c.machineClient && ((c.environmentVariables ?? []) as string[]).some(name => !['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_EXECUTABLE'].includes(name))) throw new Error('Claude machine sign-in accepts only CLAUDE_CONFIG_DIR and CLAUDE_CODE_EXECUTABLE.');
  if (!preparing) {
    try { verifyAcpAcceptance(c as unknown as AcpAgentConfiguration); }
    catch { return { blocked: 'The ACP executable or its acceptance changed. Resolve and accept it again in Settings.' }; }
  }
  const variables = Object.fromEntries(((c.environmentVariables ?? []) as string[]).filter(n => env[n] !== undefined).map(n => [n, env[n]!]));
  const acceptance = (c as unknown as AcpAgentConfiguration).acceptance;
  const machineExecutable = acceptance?.machineExecutable;
  if (!preparing && machineExecutable && env.CLAUDE_CODE_EXECUTABLE) {
    try { if (resolveExecutable(env.CLAUDE_CODE_EXECUTABLE, env).path !== machineExecutable.path) throw new Error('Changed client'); }
    catch { return { blocked: 'The selected Claude executable changed. Resolve and accept it again in Settings.' }; }
  }
  const machine = !preparing && c.machineClient && env.HOME ? claudeMachineEnvironment({ ...env, CLAUDE_CODE_EXECUTABLE: machineExecutable!.path }) : undefined;
  return {
    options: { executable: acceptance?.executable, ...(c.machineClient ? { machineClient: c.machineClient, machineClientEnvironment: machine, machineExecutable } : {}), acceptsProcessVisibility: true, command: c.command, args: c.args ?? [], environment, env: variables, storage: acpStorageBase(), storageDir: acpStorageDir(home) },
    route: { ...(c.machineClient ? { machineClient: c.machineClient as 'claude', machineClientEnvironment: machine, machineExecutable } : {}), kind: 'agent', provider: `acp:${c.agent}`, baseUrl: '', model: 'chosen-by-agent', label: `ACP · ${c.agent} · model chosen by the agent · billing and sign-in managed by the agent · ${ACP_PROCESS_VISIBILITY_WARNING}`, credential: null },
  };
}
/** The native Codex command view always denies its Host data home too. */
export const harnessDenies = (home: string, registration: HarnessRegistration, extra: string[]) => [...new Set([...extra, ...(registration.codexRoute ? [resolve(home)] : [])])];
export async function loadHarness(link: CoreLink, piece: PieceOnDisk, home: string, registration: HarnessRegistration, config: HarnessConfiguration, extraDenies: string[], confirm?: HostOptions['confirmPieceUpgrade'], bundledResources?: string, log?: HostOptions['pieceUpgradeLog'], mountOnly = false) {
  const policy = governedPolicy(home);
  const id = Object.entries(HARNESSES).find(([, value]) => value === registration)?.[0] ?? piece.manifest.id;
  engineDecision(policy, id, config.options);
  if (config.route) routeDecision(policy, config.route);
  if (config.blocked) return { registration: null, engine: { specificationVersion: 'v1' as const, id: 'harness-acp', label: `ACP disabled · ${ACP_PROCESS_VISIBILITY_WARNING}`, start() { throw new Error(config.blocked); } } };
  // A path alone does not prove bundle provenance. Desktop main supplies resources only when packaged.
  const bundled = () => {
    if (!bundledResources || !confirm) return false;
    const path = relative(realpathSync(bundledResources), realpathSync(piece.dir));
    return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  const accept = async (allowQuiet: boolean) => {
    if (!confirm) return false;
    const upgrade = await pieceUpgrade(link, piece);
    const wider = hasAddedCapabilities(upgrade);
    const quiet = allowQuiet && !!upgrade.previous && !wider && bundled();
    if (!quiet && !(await confirm(upgrade))) return false;
    const registered = await registerPiece(link, piece);
    await link.grantPiece(registered.id);
    // Core records new identity/version/digest and time. Previous content and reason fit the app log.
    log?.({ ...upgrade, at: new Date().toISOString(), reason: quiet ? 'bundled update within existing permission'
      : wider ? 'person allowed wider capabilities' : 'person allowed configured update' });
    return registered;
  };
  const headless = (error: PieceRefused) => new PieceRefused(`${error.message}\nOpen the app once to allow the update.`);
  let loaded: Awaited<ReturnType<typeof loadPiece>>;
  try { loaded = await loadPiece(link, piece, { firstUse: !mountOnly }); }
  catch (error) {
    if (mountOnly) return { registration: null, engine: { specificationVersion: 'v1' as const, id, label: 'Engine needs a current registration', start() { throw new PieceRefused('The configured engine needs a current registration from a signed-in owner.'); } } };
    if (!(error instanceof PieceRefused)) throw error;
    if (!confirm) throw headless(error);
    const accepted = await accept(!error.registeredContent);
    if (!accepted) throw error;
    loaded = { registration: accepted, firstRegistered: false };
  }
  let grant = loaded.registration;
  if (!mountOnly && !(await link.pieceMandate(grant.id))) {
    if (loaded.firstRegistered) await link.grantPiece(grant.id);
    else {
      const error = new PieceRefused(`${grant.piece} ${grant.version} is registered but has no grant from the person; they grant it with grantPieceIn.`);
      if (!confirm) throw headless(error);
      const accepted = await accept(false);
      if (!accepted) throw error;
      grant = accepted;
    }
  }
  const module = await importPiece<Record<string, (options?: object) => HarnessV1>>(snapshotPiece(piece, home));
  const denies = harnessDenies(home, registration, extraDenies);
  const engine = module[registration.factory]({ ...config.options, ...(denies.length ? { extraDenies: denies } : {}) });
  return { engine, registration: grant.id };
}
export async function closeHarness(engine?: HarnessV1) {
  const close = (engine as (HarnessV1 & { close?: () => Promise<void> }) | undefined)?.close;
  if (close) await close.call(engine);
}
