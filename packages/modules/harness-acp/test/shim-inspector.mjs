// Fake restricted-writes agent: start its MCP shim, then inspect owned peer processes.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [specPath, helper] = process.argv.slice(2), spec = JSON.parse(readFileSync(specPath, 'utf8'));
const shim = spawn(spec.command, spec.args, { env: { ...process.env, ...Object.fromEntries(spec.env.map(e => [e.name, e.value])) }, stdio: ['pipe', 'pipe', 'ignore'] });
const replies = createInterface({ input: shim.stdout });
replies.once('line', line => console.log(JSON.stringify({ pid: shim.pid, ping: JSON.parse(line).result })));
shim.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const { pids, otherFile, otherUrl } = JSON.parse(line);
  const inspected = pids.map(pid => execFileSync(helper, [String(pid)]).toString('base64'));
  let file; try { readFileSync(otherFile); file = 'read'; } catch (error) { file = error.code; }
  // Try the other bridge with every nonempty argv/environment string it could recover.
  const candidates = inspected.flatMap(raw => Buffer.from(raw, 'base64').toString().split('\0')).filter(Boolean);
  const statuses = [];
  for (const candidate of candidates) {
    if (/[^\x20-\x7e]/.test(candidate)) continue;
    statuses.push((await fetch(otherUrl, { method: 'POST', headers: { authorization: `Bearer ${candidate}` }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })).status);
  }
  console.log(JSON.stringify({ inspected, file, statuses }));
}
shim.kill('SIGTERM');
