// Runs a command with a temporary folder of its own (TMPDIR), then fails if the command left a
// `backbone-*` data home, install or database behind in it: tests, journeys and builds remove
// what they make. A clean run's folder is removed; a dirty one is kept for inspection. Ctrl-C reaches
// the command itself (it is in the same foreground group), so this waits for it and checks as usual.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { testEnvironment } from './lib/test-environment.mjs';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/no-leftovers.mjs <command> [args...]');
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), 'run-'));
const status = await new Promise((resolve) => {
  const child = spawn(command, args, { stdio: 'inherit', env: { ...testEnvironment(), TMPDIR: dir } });
  process.on('SIGINT', () => {});
  for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => {
    console.error(`no-leftovers: ${error.message}`);
    resolve(127);
  });
  child.on('exit', (code, signal) => resolve(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)));
});
const running = () => {
  try {
    return execFileSync('pgrep', ['-f', `postgres -D ${dir}`], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
// A test cluster told to stop by Ctrl-C may still be shutting down, with its guard about to remove its folder.
for (let i = 0; i < 75 && (running() || readdirSync(dir).some((name) => name.startsWith('backbone-pg-'))); i++) await new Promise((resolve) => setTimeout(resolve, 200));
const left = readdirSync(dir).filter((name) => name.startsWith('backbone-'));
const servers = running();
if (left.length || servers) {
  if (left.length) console.error(`no-leftovers: left behind: ${left.join(', ')} (in ${dir})`);
  if (servers) console.error(`no-leftovers: PostgreSQL still running under ${dir} (pids ${servers.split('\n').join(', ')})`);
  process.exit(status ? status : 1);
}
rmSync(dir, { recursive: true, force: true });
process.exit(status);
