// A supervisor owns the temporary PostgreSQL and removal from the instant the folder is allocated.
// No credential is received: startup uses local trust on a socket inside the private folder.
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [folder, ownerText] = process.argv.slice(2), owner = Number(ownerText);
const identity = lstatSync(folder);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
let server, closing;
const record = () => writeFileSync(join(folder, 'owner.json'), JSON.stringify({ format: 'backbone.audit.temp.v1', owner, uid: process.getuid?.(), supervisor:process.pid, server: server?.pid ?? null }), { mode: 0o600 });
const remove = () => closing ??= (async () => {
  clearInterval(watch);
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(r => server.once('exit', r));
    server.kill('SIGINT'); const timer = setTimeout(() => server.kill('SIGKILL'), 3000);
    await exited; clearTimeout(timer);
  }
  if (existsSync(folder)) { const now = lstatSync(folder); if (now.dev === identity.dev && now.ino === identity.ino) rmSync(folder, { recursive: true, force: true }); }
  if (process.connected) process.disconnect();
})();
const watch = setInterval(() => { if (!alive(owner)) void remove(); }, 100);
process.on('disconnect', () => void remove());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void remove());
process.on('message', message => {
  if (message.type === 'close') return void remove();
  if (message.type === 'start' && !server && !closing) {
    server = spawn(message.command, message.args, { stdio: 'ignore' });
    record();
    server.once('error', () => { if (process.connected) process.send({ type: 'failed' }); });
    server.once('exit', () => { if (process.connected && !closing) process.send({ type: 'failed' }); });
    process.send({ type: 'started', pid: server.pid });
  }
});
record();
process.send({ type: 'ready' });
