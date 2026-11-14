// Owned descendant deliberately leaves the agent process group; the test cleans it up.
import { readFileSync, writeFileSync } from 'node:fs';
const control = process.env.ACP_FAKE_CONTROL;
await fetch(control + '/ready', { method: 'POST', body: JSON.stringify({ pid: process.pid, work: process.cwd(), state: process.env.HOME }) });
for (;;) {
  const instruction = await (await fetch(control + '/instruction')).json();
  if (instruction.exit) break;
  if (instruction.capability) {
    const attempt = action => { try { action(); return 'allowed'; } catch (error) { return error.code; } };
    const read = attempt(() => readFileSync(instruction.capability));
    const write = attempt(() => writeFileSync(instruction.work + '/intrusion', 'escaped descendant'));
    await fetch(control + '/result', { method: 'POST', body: JSON.stringify({ read, write }) });
  }
  await new Promise(resolve => setTimeout(resolve, 10));
}
await fetch(control + '/exiting', { method: 'POST' });
process.exit(0);
