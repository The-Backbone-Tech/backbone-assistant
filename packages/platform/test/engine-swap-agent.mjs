// Local ACP peer for the swap journey. Record the exact prompt and MCP replies.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let servers = [], sessionId = 'swap';
async function call(name, args) {
  const s = servers.find(s => s.name === 'backbone');
  const child = spawn(s.command, s.args, { env: { ...process.env, ...Object.fromEntries(s.env.map(e => [e.name, e.value])) }, stdio: ['pipe', 'pipe', 'ignore'] });
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const request = async (id, method, params) => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return JSON.parse((await replies.next()).value); };
  try { await request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'swap', version: '1' } }); return (await request(2, 'tools/call', { name, arguments: args })).result; }
  finally { child.stdin.end(); child.kill(); }
}
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentInfo: { name: 'swap', version: '1' }, agentCapabilities: {} } });
  else if (method === 'session/new') { servers = params.mcpServers; send({ id, result: { sessionId } }); }
  else if (method === 'session/prompt') {
    const prompt = params.prompt[0].text;
    const first = prompt.endsWith('First turn marker.');
    const actions = first ? [['write_file', { name: 'swap.md', body: 'Document from first engine.' }], ['connector_mcp__notes__plain', { x: 'first' }]] : [['connector_mcp__notes__draft_note', { text: 'signed second' }], ['connector_mcp__notes__plain', { x: 'second' }], ['read_file', { name: 'swap.md' }], ['search_memory', { query: 'orchard' }]];
    const results = [];
    for (const [name, args] of actions) results.push({ name, result: await call(name, args) });
    appendFileSync(process.env.SWAP_RECORD, JSON.stringify({ prompt, results }) + '\n');
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: first ? 'First answer marker.' : 'Second answer marker.' } } } });
    send({ id, result: { stopReason: 'end_turn' } });
  }
}
