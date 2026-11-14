// The engine a person gets with nothing set up: their own signed-in Codex client, when it is
// installed and no route or engine is configured. Applications started from the Dock get a bare PATH, so
// the usual install locations are added. It reads no credential; the client keeps its own sign-in.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BINARIES = ['/opt/homebrew/bin', '/usr/local/bin'];

function standaloneNode(): string | undefined {
  const nvm = join(homedir(), '.nvm/versions/node');
  const versions = existsSync(nvm) ? readdirSync(nvm).sort().reverse().map((v) => join(nvm, v, 'bin')) : [];
  // A package manager's node links libraries outside the sandbox's read set; nvm's is self-contained.
  return [...versions, ...BINARIES].map((dir) => join(dir, 'node')).find(existsSync);
}

/** Sets this process's environment for the Codex engine and says so, or leaves it alone. */
export function chooseNativeRoute(home: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BACKBONE_HARNESS !== undefined || env.BACKBONE_MODEL_ENDPOINT) return false;
  try {
    const stored = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { harness?: unknown };
    if (Object.hasOwn(stored, 'harness')) {
      // Preserve the saved engine and prepare the runtime its Codex selection needs.
      if ((stored.harness === 'harness-codex' || stored.harness === 'codex') && !env.BACKBONE_CODEX_SNAPSHOT_NODE) {
        const node = standaloneNode();
        if (node) env.BACKBONE_CODEX_SNAPSHOT_NODE = node;
      }
      return false;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
  try {
    const stored = JSON.parse(readFileSync(join(home, 'model-route.json'), 'utf8')) as { own?: unknown; gateway?: unknown; local?: unknown };
    if (stored.own || stored.gateway || Object.hasOwn(stored, 'local')) return false;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
  const directories = [...BINARIES, ...(env.PATH ?? '').split(':').filter(Boolean)];
  const node = env.BACKBONE_CODEX_SNAPSHOT_NODE ?? standaloneNode();
  if (!node || !directories.some((dir) => existsSync(join(dir, 'codex')))) return false;
  env.PATH = [...new Set(directories)].join(':');
  env.BACKBONE_CODEX_SNAPSHOT_NODE = node;
  env.BACKBONE_HARNESS = 'harness-codex';
  return true;
}
