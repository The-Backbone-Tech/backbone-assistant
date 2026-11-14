// Test-only preload: record and refuse before the OS can start a key store tool. The record has
// only the executable's name, never arguments, input, environment values or secret output.
import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = cp[name];
  cp[name] = function (file, ...args) {
    if (['security', 'secret-tool'].includes(basename(String(file)))) {
      appendFileSync(process.env.BACKBONE_TEST_STORE_SPAWN_RECORD, `${basename(String(file))}\n`);
      throw new Error('Test refused a real key store tool spawn.');
    }
    return original.call(this, file, ...args);
  };
}
syncBuiltinESMExports();
