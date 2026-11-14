// Installed verification owns only its temporary application copy. Work/data homes remain fixture-owned.
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

// These fixtures honour the installed executable and own their data and person homes.
// Tool connection still requires development-only tool-home isolation.
export const INSTALLED_TEST_ARGS = ['playwright', 'test', '--project=electron', '--project=goals', '--workers=1', 'e2e/(?:electron|notices\\.electron|acp\\.electron|agent-roles\\.electron|identity\\.electron|shared-app\\.electron|memory(?:-controls)?\\.electron|away-work\\.electron|continuity\\.electron|export\\.electron|now\\.electron|triage\\.electron|demos\\.electron|thread-search\\.electron|rewind\\.electron|thread-control\\.electron|local-models\\.electron|goals|pi-sandbox\\.electron|long-conversations)\\.spec\\.ts$'] as const;

interface ChildResult { status: number | null; signal?: string | null; error?: Error }
export interface InstalledJourneyActions {
  prepare(): void | Promise<void>;
  buildInfo(): unknown;
  install(target: string): string | Promise<string>;
  test(executable: string, env: NodeJS.ProcessEnv): ChildResult | Promise<ChildResult>;
  env: NodeJS.ProcessEnv;
  /** Trusted local test seam; production uses rmSync on the root created here. */
  remove?(root: string): void;
}
export interface InstalledJourneyResult {
  exitCode: number;
  childStatus?: number | null;
  signal?: string | null;
  error?: Error;
  cleanupError?: Error;
  cleanupRoot?: string;
}
const failure = (value: unknown) => value instanceof Error ? value : new Error(String(value));

function productName(info: unknown): string {
  const value = info && typeof info === 'object' ? (info as { productName?: unknown }).productName : undefined;
  if (typeof value !== 'string' || !value.trim() || value === '.' || value === '..' || /[/\\\x00-\x1f\x7f]/.test(value)) {
    throw new Error('The packaged product name must be one filesystem name.');
  }
  return value;
}

/** No subprocess runs at import. Command effects are supplied explicitly by the CLI caller. */
export async function runInstalledJourney(actions: InstalledJourneyActions): Promise<InstalledJourneyResult> {
  let root: string | undefined;
  let result: InstalledJourneyResult = { exitCode: 1 };
  try {
    await actions.prepare();
    const name = productName(actions.buildInfo());
    root = mkdtempSync(join(tmpdir(), 'backbone-installed-journey-'));
    root = realpathSync(root);
    const target = join(root, 'application');
    const expected = join(target, `${name}.app`, 'Contents', 'MacOS', name);
    const printed = (await actions.install(target)).trim().split(/\r?\n/).at(-1);
    if (printed !== expected) throw new Error('The installer did not return the owned application executable.');
    const actual = realpathSync(expected), inside = relative(root, actual);
    if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`) || !statSync(actual).isFile()) {
      throw new Error('The installed executable escapes the owned temporary application.');
    }
    // This fixture supplies its own scripted local model. Ambient native/profile settings are
    // not a licence to activate a vendor route during an installed-app test.
    const env: NodeJS.ProcessEnv = { ...actions.env, BACKBONE_HARNESS: 'harness-pi', BACKBONE_APP_EXECUTABLE: actual };
    for (const key of ['BACKBONE_CODEX_MODEL', 'BACKBONE_MODEL_ENDPOINT', 'BACKBONE_MODEL_ID', 'BACKBONE_HOME']) delete env[key];
    const child = await actions.test(actual, env);
    const code = child.status ?? 1;
    result = { exitCode: child.error && code === 0 ? 1 : code,
      childStatus: child.status, signal: child.signal ?? null,
      ...(child.error ? { error: child.error } : child.status === null ? { error: new Error('The installed Electron fixtures did not exit normally.') } : {}) };
  } catch (error) {
    result = { exitCode: 1, error: failure(error) };
  } finally {
    if (root) {
      try { (actions.remove ?? ((path) => rmSync(path, { recursive: true, force: true })))(root); }
      catch (error) {
        result.cleanupError = failure(error);
        result.cleanupRoot = root;
        if (result.exitCode === 0) result.exitCode = 1;
      }
    }
  }
  return result;
}
