// Minimal scripted ACP agent: asks the scoped MCP bridge, echoes its answers, then continues.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let servers;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (method === 'session/new') { servers = params.mcpServers; send({ id, result: { sessionId: 'tools-session' } }); }
  if (method !== 'session/prompt') continue;
  const spec = servers.find(s => s.name === 'backbone');
  const child = spawn(spec.command, spec.args, { env: { ...process.env, ...Object.fromEntries(spec.env.map(e => [e.name, e.value])) }, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let counter = 0;
  const call = async (method, params) => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++counter, method, params }) + '\n'); return JSON.parse((await lines.next()).value).result; };
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'script', version: '1' } });
    const catalog = (await call('tools/list', {})).tools;
    const results = [];
    for (const c of JSON.parse(params.prompt[0].text.split('HOST_TOOL_CALLS:').at(-1))) results.push(await call('tools/call', { name: c.name, arguments: c.args }));
    send({ method: 'session/update', params: { sessionId: 'tools-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ catalog, results, continued: true }) } } } });
    send({ id, result: { stopReason: 'end_turn' } });
  } finally { child.stdin.end(); child.kill(); }
}
