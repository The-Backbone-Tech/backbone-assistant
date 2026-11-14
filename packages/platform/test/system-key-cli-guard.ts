// An independent preload boundary for the opt-in CLI test; no production imports it.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename, isAbsolute } from 'node:path';
import { runTool, securityWord, type ToolRequest } from '../src/system-keys/tools.ts';

export function scratchGuard(keychain: string) {
  assert.ok(isAbsolute(keychain));
  let loaded = false, approved: string[] | undefined;
  return {
    markHook() { loaded = true; },
    assertHook() { assert.ok(loaded, 'Scoped CLI key-store hook did not load'); },
    checkSpawn(file: string, args: readonly string[]) {
      if (!['security', 'secret-tool'].includes(basename(file))) return;
      assert.ok(loaded, 'Scoped CLI key-store hook did not load');
      assert.equal(file, '/usr/bin/security', 'Only the scoped macOS tool is allowed');
      if (args[0] === '-q') {
        assert.equal(args, approved, 'Interactive invocation needs independently validated scratch input');
      } else {
        assert.equal(args[0], 'find-generic-password', 'No preference, settings or lock queries');
        assert.equal(args.at(-1), keychain, 'Real-store invocation must name the scratch keychain');
      }
    },
    run<T>(request: ToolRequest, launch: (request: ToolRequest) => T): T {
      assert.equal(request.executable, '/usr/bin/security');
      if (request.args[0] === '-q') {
        assert.deepEqual(request.args, ['-q', '-i']);
        const input = request.input?.toString() ?? '';
        assert.equal(input.split('\n').length, 2, 'Exactly one interactive command');
        assert.ok(input.startsWith('"add-generic-password" '));
        assert.ok(input.endsWith(' ' + securityWord(keychain) + '\n'), 'Interactive command must end with scratch scope');
        approved = request.args;
      }
      try { this.checkSpawn(request.executable, request.args); return launch(request); }
      finally { approved = undefined; }
    },
  };
}
let active: ReturnType<typeof scratchGuard> | undefined;
export function installScratchGuard(keychain: string): void {
  assert.equal(active, undefined); active = scratchGuard(keychain);
  const original = cp.spawn;
  cp.spawn = ((file: string, args: string[], options: cp.SpawnOptions) => {
    active!.checkSpawn(file, args); return original(file, args, options);
  }) as typeof cp.spawn;
  syncBuiltinESMExports();
  process.once('exit', () => {
    try { active!.assertHook(); } catch { process.stderr.write('Scoped CLI key-store hook did not load\n'); process.exitCode = 1; }
  });
}
export function markScopedHook(): void { assert.ok(active, 'Scratch preload did not load'); active.markHook(); process.stderr.write('SCOPED_CLI_HOOK_LOADED\n'); }
export const runScopedTool = (request: ToolRequest) => { assert.ok(active, 'Scratch preload did not load'); return active.run(request, runTool); };
