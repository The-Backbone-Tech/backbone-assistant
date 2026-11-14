// A local ACP agent enforcing the adopted adapter's Host-tool approval boundary.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [mode, client, record] = process.argv.slice(2);
const agent = spawn(process.execPath, [new URL('./fake-agent.mjs', import.meta.url).pathname], {
  env: { ...process.env, ACP_FAKE_MODE: mode }, stdio: ['pipe', 'pipe', 'ignore'],
});
createInterface({ input: agent.stdout }).on('line', line => {
  const message = JSON.parse(line);
  if (message.result?.protocolVersion) message.result.agentCapabilities.loadSession = true;
  process.stdout.write(JSON.stringify(message) + '\n');
});
agent.on('exit', code => process.exit(code ?? 1));
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (['session/new', 'session/load'].includes(message.method)) {
    const meta = message.params?._meta;
    appendFileSync(record, JSON.stringify({ method: message.method, meta }) + '\n');
    const options = meta?.claudeCode?.options;
    const allowed = options?.allowedTools;
    const scoped = Array.isArray(allowed) && allowed.length > 0
      && allowed.every(name => typeof name === 'string' && name.startsWith('mcp__backbone__'))
      && (allowed.includes('mcp__backbone__*') || allowed.includes('mcp__backbone__write_file'));
    if (client === 'claude' ? !scoped || options.allowDangerouslySkipPermissions !== false : meta !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'The configured client requires a scoped Host-tool rule.' } }) + '\n');
      continue;
    }
  }
  agent.stdin.write(line + '\n');
}
agent.stdin.end();
