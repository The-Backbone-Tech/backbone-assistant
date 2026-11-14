import { createInterface } from 'node:readline';
const mode = process.env.ACP_STEERING_MODE ?? 'injected';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
let prompt;
const update = text => send({ method: 'session/update', params: { sessionId: 'steering-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentCapabilities: {}, _meta: { steering: { supported: mode !== 'unsupported' } } } });
  else if (method === 'session/new') send({ id, result: { sessionId: 'steering-session' } });
  else if (method === 'session/prompt') { prompt = id; update('Working.'); }
  else if (method === '_session/steering') {
    if (params.sessionId !== 'steering-session' || params._meta?.steering?.idleBehavior !== 'promptRequired') process.exit(2);
    if (mode === 'lost') process.exit(0);
    send({ id, result: mode === 'idle' ? { outcome: 'promptRequired', reason: 'noRunningTurn' } : { outcome: 'injected' } });
    if (mode !== 'idle') update(params.prompt[0].text);
    send({ id: prompt, result: { stopReason: 'end_turn' } });
  } else if (method === 'session/cancel') send({ id: prompt, result: { stopReason: 'cancelled' } });
}
