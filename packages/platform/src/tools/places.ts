// Where each AI tool keeps what this app may change, found read-only. Nothing here writes, and
// nothing runs a tool: detection looks at files, folders and executables only. Locations follow
// each tool's own variables (CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME, HOME), as the tools do.
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { AiToolId } from '../api.ts';

/** What detection reads: the environment the tools themselves would see, and where apps are installed. */
export interface ToolEnv {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Folders apps are installed in (`/Applications` and the person's own on a Mac). */
  applications: string[];
  /** Folders searched for a tool's command after PATH: an app started from the Finder has a short PATH. */
  bins: string[];
  /** Running processes, to tell whether a tool started before it was connected. */
  processes: () => { started: Date; command: string }[];
}

export function defaultToolEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ToolEnv {
  const home = env.HOME || homedir();
  const nvm = join(home, '.nvm/versions/node');
  const nvmBins = existsSync(nvm) ? readdirSync(nvm).sort().reverse().map((v) => join(nvm, v, 'bin')) : [];
  return {
    env,
    platform,
    applications: platform === 'darwin' ? ['/Applications', join(home, 'Applications')] : [],
    bins: [join(home, '.local/bin'), join(home, '.claude/local'), ...nvmBins, join(home, '.volta/bin'), join(home, '.bun/bin'), '/opt/homebrew/bin', '/usr/local/bin'],
    processes: listProcesses,
  };
}

function listProcesses(): { started: Date; command: string }[] {
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'lstart=,command='], { encoding: 'utf8', timeout: 5_000, env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } });
    // lstart is five words: "Mon Oct 26 13:11:02 2026".
    return out.split('\n').filter(Boolean).map((line) => {
      const words = line.trim().split(/\s+/);
      return { started: new Date(words.slice(0, 5).join(' ')), command: words.slice(5).join(' ') };
    });
  } catch {
    return [];
  }
}

export interface ToolPlace {
  id: AiToolId;
  name: string;
  installed: boolean;
  /** The tool's own command, when its official mechanism is a command and it was found. */
  command: string | null;
  /** The settings file the `backbone` entry lives in. */
  config: string;
  /** Skill folders this tool reads the usage skill from. */
  skills: string[];
  /** The installed app, when there is one (Claude Desktop's install dialog opens in it). */
  app: string | null;
  /** The tool's own data folder (Claude Desktop keeps its installed bundles there). */
  data: string | null;
  /** The tool's app as a running process, by its command line: it reads a new entry only after a restart. */
  process: RegExp | null;
}

const NAMES: Record<AiToolId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', 'claude-desktop': 'Claude Desktop' };
export const TOOL_IDS = Object.keys(NAMES) as AiToolId[];

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A command on PATH, then in the usual install folders. */
export function findCommand(name: string, t: ToolEnv, extra: string[] = []): string | null {
  const dirs = [...(t.env.PATH ?? '').split(delimiter).filter(Boolean), ...t.bins];
  for (const dir of dirs) if (executable(join(dir, name))) return join(dir, name);
  return extra.find(executable) ?? null;
}

function firstApp(t: ToolEnv, names: string[]): string | null {
  for (const dir of t.applications) for (const n of names) if (existsSync(join(dir, n))) return join(dir, n);
  return null;
}

export const homeOf = (t: ToolEnv) => t.env.HOME || homedir();
/** Where Electron apps keep their data: Application Support on a Mac, XDG_CONFIG_HOME (or $HOME/.config) elsewhere. */
const appData = (t: ToolEnv) => (t.platform === 'darwin' ? join(homeOf(t), 'Library/Application Support') : t.env.XDG_CONFIG_HOME || join(homeOf(t), '.config'));
/** The skill folder Codex, Cursor and VS Code read. */
export const sharedSkills = (t: ToolEnv) => join(homeOf(t), '.agents/skills/backbone');

export function place(id: AiToolId, t: ToolEnv): ToolPlace {
  const home = homeOf(t);
  switch (id) {
    case 'claude-code': {
      // Verified with Claude Code 2.1.310: with CLAUDE_CONFIG_DIR set, user-scope servers live in its .claude.json.
      const dir = t.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
      const config = t.env.CLAUDE_CONFIG_DIR ? join(t.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json');
      const command = findCommand('claude', t);
      return { id, name: NAMES[id], installed: !!command || existsSync(dir) || existsSync(config), command, config, skills: [join(dir, 'skills/backbone')], app: null, data: dir, process: null };
    }
    case 'codex': {
      const dir = t.env.CODEX_HOME || join(home, '.codex');
      // The Codex app (its bundle is ChatGPT.app, id com.openai.codex) ships the same CLI.
      const app = firstApp(t, ['ChatGPT.app', 'Codex.app']);
      const bundled = app ? [join(app, 'Contents/Resources/codex-cli/bin/codex')] : [];
      const command = findCommand('codex', t, bundled);
      return { id, name: NAMES[id], installed: !!command || existsSync(dir) || !!app, command, config: join(dir, 'config.toml'), skills: [sharedSkills(t)], app, data: dir, process: /(ChatGPT|Codex)\.app\/Contents\/MacOS\// };
    }
    case 'cursor': {
      const app = firstApp(t, ['Cursor.app']);
      const dir = join(home, '.cursor');
      const data = join(appData(t), 'Cursor');
      return { id, name: NAMES[id], installed: !!app || existsSync(dir) || existsSync(data), command: null, config: join(dir, 'mcp.json'), skills: [sharedSkills(t)], app, data: dir, process: /Cursor\.app\/Contents\/MacOS\/Cursor( |$)/ };
    }
    case 'claude-desktop': {
      const app = firstApp(t, ['Claude.app']);
      const data = join(appData(t), 'Claude');
      // Its config file is read only to find an entry someone else made; this app never writes it.
      return { id, name: NAMES[id], installed: !!app || existsSync(data), command: null, config: join(data, 'claude_desktop_config.json'), skills: [], app, data, process: null };
    }
  }
}
