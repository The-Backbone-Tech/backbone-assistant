import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const result = spawnSync(process.execPath, ['packages/surfaces/cli/src/main.ts', 'doctor', '--json'], { encoding: 'utf8', timeout: 25000 });
try {
  const report = JSON.parse(result.stdout);
  // doctor currently treats a busy holder as a warning. Require a live daemon read as well.
  const daemon = JSON.parse(readFileSync(`${process.env.BACKBONE_HOME}/daemon.json`, 'utf8'));
  process.kill(daemon.pid, 0);
  const held = report.checks.some(c => c.name === 'holder' && c.status === 'ok');
  process.exit(result.status === 0 && report.ok && held ? 0 : 1);
} catch { process.exit(1); }
