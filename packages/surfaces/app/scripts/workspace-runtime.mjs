import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
/** These supervisors have only local imports and Node built-ins; ship their exact source closure. */
export function stageWorkspaceRuntime(destination = 'dist/electron/workspace-runtime') {
  const source = fileURLToPath(new URL('../../../platform/src/workspace/', import.meta.url));
  mkdirSync(destination, { recursive: true });
  for (const file of ['worker.ts', 'launch.ts', 'result.ts', 'processes.ts', 'processes.py', 'linux.py', 'linux-worker.ts', 'linux-policy.ts', 'runtime.ts', 'volume.ts', 'policy.ts', 'seatbelt-policy.ts', 'LICENSE.codex', 'NOTICE.codex']) cpSync(join(source, file), join(destination, file));
}
