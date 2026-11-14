import { writeSync } from 'node:fs';
import { createHost } from '../../src/composition/host.ts';
const [home, point, kind] = process.argv.slice(2);
const host = createHost({home, projectCreateCut(at) {
  if (at === point) {
    writeSync(1, `CUT ${at}\n`);
    process.kill(process.pid, 'SIGKILL');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
    throw new Error('SIGKILL did not terminate the process');
  }
}});
await host.call('projects.create',{name:'Cut project',kind:kind as 'folder'|'git',clientKey:'cut-identity'});
throw new Error('The requested cut was not reached');
