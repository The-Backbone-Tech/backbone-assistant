// Started beside a test cluster by testing.ts, detached from it. When the process that owns the
// cluster is gone without stopping it (killed, crashed, Ctrl-C), this stops the server the way a
// fast shutdown does if it still runs, and removes the cluster's folder, so a killed run leaves
// neither a server nor its System V shared-memory segment behind. A run that stops its cluster
// itself has removed the folder by then, and this ends quietly.
import { existsSync, rmSync } from 'node:fs';

const [owner, server, dir] = process.argv.slice(2);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (;;) {
  if (!alive(Number(owner))) {
    if (alive(Number(server))) {
      process.kill(Number(server), 'SIGINT');
      for (let i = 0; i < 100 && alive(Number(server)); i++) await wait(100);
      if (alive(Number(server))) process.kill(Number(server), 'SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true });
    break;
  }
  if (!existsSync(dir)) break;
  await wait(500);
}
