// Tests only: a throwaway home where the person's AI tools live, so connecting them never touches
// this machine's real settings. HOME, CLAUDE_CONFIG_DIR and CODEX_HOME point inside it; fake
// `claude`, `codex` and `open` commands on PATH record their argv and edit those files the way the
// real ones do (fake-tools/); Claude.app and Cursor.app are empty folders in its own Applications.
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolEnv } from '../tools/places.ts';

const FAKES = fileURLToPath(new URL('./fake-tools/', import.meta.url));

/** Settings as each tool writes them, with comments, other servers and keys that must survive. */
export const SEEDS = {
  claude: JSON.stringify({ numStartups: 12, mcpServers: { linear: { type: 'stdio', command: 'linear-mcp', args: [], env: {} } }, projects: { '/work': { allowedTools: [] } } }, null, 2),
  codex: '# my Codex settings\nmodel = "gpt-5.5" # the one I like\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\nargs = ["--quiet"]\n\n[profiles.fast]\nmodel = "gpt-5.5-mini"\n',
  cursor: '{\n  // my servers\n  "mcpServers": {\n    "linear": { "url": "https://mcp.linear.app/sse" }, // remote\n  },\n  /* keep me */\n  "theme": "dark"\n}\n',
};

export interface ToolWorld {
  root: string;
  home: string;
  claudeConfig: string;
  codexHome: string;
  /** The environment the tools see: these variables only, plus PATH to the fakes and node. */
  env: Record<string, string>;
  toolEnv: ToolEnv;
  files: { claude: string; codex: string; cursor: string };
  /** Each fake command's argv, in order. */
  log(): { tool: string; argv: string[]; at: string }[];
  /** Every file under the world's home folders, by path, with its bytes. */
  snapshot(): Map<string, string>;
  remove(): void;
}

export function toolWorld(options: { seed?: boolean; extraEnv?: Record<string, string>; processes?: ToolEnv['processes'] } = {}): ToolWorld {
  const root = mkdtempSync(join(tmpdir(), 'backbone-tools-'));
  const home = join(root, 'home');
  const claudeConfig = join(root, 'claude-config');
  const codexHome = join(root, 'codex-home');
  const bin = join(root, 'bin');
  const apps = join(root, 'Applications');
  for (const d of [home, claudeConfig, codexHome, bin, join(apps, 'Claude.app'), join(apps, 'Cursor.app'), join(home, '.cursor')]) mkdirSync(d, { recursive: true });
  for (const name of ['claude', 'codex', 'open']) {
    copyFileSync(join(FAKES, `${name}.cjs`), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  const files = { claude: join(claudeConfig, '.claude.json'), codex: join(codexHome, 'config.toml'), cursor: join(home, '.cursor', 'mcp.json') };
  if (options.seed !== false) {
    writeFileSync(files.claude, SEEDS.claude);
    writeFileSync(files.codex, SEEDS.codex);
    writeFileSync(files.cursor, SEEDS.cursor);
  }
  const log = join(root, 'tools.log');
  const env: Record<string, string> = {
    HOME: home,
    CLAUDE_CONFIG_DIR: claudeConfig,
    CODEX_HOME: codexHome,
    PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    FAKE_TOOLS_LOG: log,
    ...options.extraEnv,
  };
  const toolEnv: ToolEnv = { env, platform: 'darwin', applications: [apps], bins: [], processes: options.processes ?? (() => []) };
  const watched = [home, claudeConfig, codexHome];
  return {
    root,
    home,
    claudeConfig,
    codexHome,
    env,
    toolEnv,
    files,
    log: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    snapshot() {
      const out = new Map<string, string>();
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else out.set(relative(root, full), readFileSync(full).toString('base64'));
        }
      };
      for (const d of watched) if (existsSync(d)) walk(d);
      return out;
    },
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A minimal MCP client over stdio with the 2025 handshake: initialize, then each call in turn. */
export async function mcp(command: string, args: string[], env: Record<string, string>, calls: { method: string; params: unknown }[]): Promise<unknown[]> {
  const child = spawn(command, args, { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let stderr = '';
  const waiting = new Map<number, (v: unknown) => void>();
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  child.stdout.on('data', (c: Buffer) => {
    buffer += c.toString();
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const msg = JSON.parse(buffer.slice(0, nl)) as { id?: number };
      buffer = buffer.slice(nl + 1);
      if (msg.id !== undefined) waiting.get(msg.id)?.(msg);
    }
  });
  const ask = (id: number, method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}: ${stderr}`)), 60_000);
      waiting.set(id, (v) => (clearTimeout(timer), resolve(v)));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  try {
    await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tools-test', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const out: unknown[] = [];
    for (const [i, c] of calls.entries()) out.push(await ask(i + 2, c.method, c.params));
    return out;
  } finally {
    child.stdin.end();
    await new Promise((r) => (child.exitCode !== null ? r(null) : child.once('exit', r)));
  }
}
