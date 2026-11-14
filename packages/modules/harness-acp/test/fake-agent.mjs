import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, renameSync, symlinkSync, rmdirSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const mode = process.env.ACP_FAKE_MODE ?? 'normal';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const result = (id, result) => send({ id, result });
let mcpServers = [];
async function callBackbone(name, args) {
  const spec = mcpServers.find(s => s.name === 'backbone');
  const child = spawn(spec.command, spec.args, { env: { ...process.env, ...Object.fromEntries(spec.env.map(e => [e.name, e.value])) }, stdio: ['pipe', 'pipe', 'ignore'] });
  const responses = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const call = async (id, method, params) => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return JSON.parse((await responses.next()).value); };
  try { await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fake', version: '1.0.0' } }); return (await call(2, 'tools/call', { name, arguments: args })).result; }
  finally { child.stdin.end(); child.kill(); }
}
let sessionId = 'fake-session', promptId, count = 0, loaded = false;
let compactionAllowed = false;
if (mode === 'tool-in-flight') process.on('SIGUSR1', () => result(promptId, { stopReason: 'end_turn' }));
for await (const line of createInterface({ input: process.stdin })) {
  let message; try { message = JSON.parse(line); } catch { continue; }
  const { id, method, params } = message;
  if (id === 'file' && !method) {
    const text = message.error ? `refused:${message.error.message}` : 'scratch:written';
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    result(promptId, { stopReason: mode === 'file-after-stop' ? 'cancelled' : 'end_turn' });
  } else if (id === 'permission' && !method) {
    const decision = message.result?.outcome;
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `permission:${decision?.optionId ?? decision?.outcome};${message.result?._meta?.reason ?? ''}` } } } });
    result(promptId, { stopReason: 'end_turn' });
  } else if (method === 'initialize') {
    compactionAllowed = params.clientCapabilities?.session?.compaction != null;
    result(id, { protocolVersion: 1, agentInfo: { name: 'fake', version: '1.0.0' }, agentCapabilities: { loadSession: mode === 'load' || mode === 'load-state' || mode === 'idle-exit' } });
  }
  else if (method === 'session/new') { mcpServers = params.mcpServers; sessionId = `fake-${process.pid}`; result(id, { sessionId }); }
  else if (method === 'session/load') { mcpServers = params.mcpServers; sessionId = params.sessionId; loaded = true; send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HISTORICAL-REPLAY-MUST-NOT-BECOME-ANSWER' } } } }); result(id, {}); }
  else if (method === 'session/prompt') {
    if (mode === 'compaction-count-limit' || mode === 'compaction-text-limit') {
      const update = update => send({ method: 'session/update', params: { sessionId, update } });
      if (mode === 'compaction-count-limit') for (let i = 0; i < 129; i++) update({ sessionUpdate: 'compaction_update', compactionId: String(i), status: 'in_progress' });
      else update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'large', content: { type: 'text', text: 'x'.repeat(200_001) } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'MUST-NOT-CONTINUE' } });
      result(id, { stopReason: 'end_turn' }); continue;
    }
    if (mode === 'compaction') {
      const update = update => send({ method: 'session/update', params: { sessionId, update } });
      if (!compactionAllowed) { result(id, { stopReason: 'end_turn' }); continue; }
      const compactionId = `compact-${count}`;
      update({ sessionUpdate: 'compaction_update', compactionId, status: 'in_progress' });
      update({ sessionUpdate: 'compaction_summary_chunk', compactionId, content: { type: 'text', text: 'Retained amber decision' } });
      update({ sessionUpdate: 'compaction_update', compactionId, status: 'completed' });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${sessionId}:prompt-${++count}` } });
      result(id, { stopReason: 'end_turn' }); continue;
    }
    promptId = id; count++;
    if (mode === 'connector-in-flight' || mode === 'tool-in-flight') {
      void callBackbone(process.env.ACP_FAKE_TOOL ?? 'connector_mcp__notes__search', process.env.ACP_FAKE_TOOL === 'write_file' ? { name: 'note', body: 'draft' } : { q: 'launch' }).catch(() => {});
      continue;
    }
    if (mode === 'mcp-write' || mode === 'mcp-memory' || mode === 'mcp-connector' || mode === 'mcp-read' || mode === 'mcp-tool' || mode === 'mcp-twice' || mode === 'mcp-connector-then-write') {
      const output = mode === 'mcp-connector-then-write' ? [await callBackbone('connector_mcp__notes__search', { q: 'launch' }), await callBackbone('write_file', { name: 'unexpected', body: 'never' })] : mode === 'mcp-tool' ? await callBackbone(process.env.ACP_FAKE_TOOL, JSON.parse(process.env.ACP_FAKE_ARGS ?? '{}')) : mode === 'mcp-twice' ? [await callBackbone('write_file', { name: 'one', body: 'one' }), await callBackbone('write_file', { name: 'two', body: 'two' })] : await callBackbone(mode === 'mcp-write' ? 'write_file' : mode === 'mcp-memory' ? 'search_memory' : mode === 'mcp-read' ? 'read_file' : 'connector_mcp__notes__search', mode === 'mcp-write' ? { name: 'brief.md', body: '# ACP brief\n' } : mode === 'mcp-memory' ? { query: 'launch' } : mode === 'mcp-read' ? { name: 'note.md' } : { q: 'launch' });
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: mode === 'mcp-read' ? `${sessionId}:` + JSON.stringify(output) : JSON.stringify(output) } } } });
      result(id, { stopReason: 'end_turn' }); continue;
    }
    if (mode === 'detached') {
      if (!params.prompt[0].text.endsWith('next')) {
        const child = spawn(process.execPath, [new URL('./detached-child.mjs', import.meta.url).pathname], { detached: true, stdio: 'ignore', env: process.env }); child.unref();
      }
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'rea' } } } });
      continue;
    }
    if (mode === 'swap-folders') {
      const results = [process.cwd(), process.env.HOME].map((path, i) => {
        const attempt = action => { try { action(); return 'allowed'; } catch (error) { return error.code; } };
        const other = i ? process.cwd() : process.env.HOME;
        const rename = attempt(() => renameSync(path, join(other, 'stolen')));
        const remove = attempt(() => rmdirSync(path));
        const symlink = attempt(() => symlinkSync(process.env.ACP_FAKE_TARGET, path));
        const chmod = attempt(() => chmodSync(path, 0o777));
        const write = attempt(() => writeFileSync(join(path, 'inside'), 'permitted'));
        return { rename, remove, symlink, chmod, write };
      });
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(results) } } } });
      result(id, { stopReason: 'end_turn' }); continue;
    }
    if (mode === 'file-probe') {
      const { path, body } = JSON.parse(params.prompt[0].text);
      send({ id: 'file', method: body === undefined ? 'fs/read_text_file' : 'fs/write_text_file', params: { sessionId, path, ...(body === undefined ? {} : { content: body }) } });
      continue;
    }
    if (mode === 'read-host') {
      let text = 'read'; try { readFileSync(join(process.env.ACP_FAKE_HOST_HOME, 'settings.json')); } catch (error) { text = `refused:${error.code}`; }
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      result(id, { stopReason: 'end_turn' }); continue;
    }
    if (mode === 'environment') {
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ env: process.env, argv: process.argv }) } } } });
      result(id, { stopReason: 'end_turn' }); continue;
    }
    if (mode === 'load-state' || mode === 'poison-wait') {
      const planted = join(process.cwd(), 'planted');
      if (process.env.ACP_FAKE_PLANT === 'fifo' && !existsSync(planted)) { if (spawnSync('/usr/bin/mkfifo', [planted]).status !== 0) throw new Error('Cannot plant owned FIFO.'); }
      if (['acl', 'acl-fifo', 'acl-sealed', 'clone', 'deep'].includes(process.env.ACP_FAKE_PLANT) && !existsSync(planted)) {
        const result = spawnSync(process.env.ACP_FAKE_PLANT_HELPER, [process.env.ACP_FAKE_PLANT, planted, process.env.ACP_FAKE_PLANT_SOURCE ?? 'unused']);
        if (result.status !== 0) throw new Error('Cannot plant owned metadata/deep-tree fixture: ' + result.stderr);
      }
      if (process.env.ACP_FAKE_PLANT === 'locked-directory' && !existsSync(planted)) { mkdirSync(planted); writeFileSync(join(planted, 'native-state'), 'owned fixture'); }
      if (process.env.ACP_FAKE_PLANT === 'spaced-flags' && !existsSync(planted)) {
        const result = spawnSync('/bin/cp', ['-cR', process.env.ACP_FAKE_PLANT_SOURCE, planted]);
        if (result.status !== 0) throw new Error('Cannot clone owned fixture: ' + result.stderr);
      }
      if (process.env.ACP_FAKE_PLANT === 'sealed') { if (!existsSync(planted)) mkdirSync(planted); chmodSync(planted, 0o700); writeFileSync(join(planted, 'private'), 'retired data'); chmodSync(planted, 0); }
      const path = join(process.env.HOME, 'native-canary'); const text = existsSync(path) ? 'retained' : 'fresh'; writeFileSync(path, 'old native state');
      if (mode === 'poison-wait' && !params.prompt[0].text.endsWith('next')) { send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'rea' } } } }); continue; }
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      result(id, { stopReason: 'end_turn' }); continue;
    }
    if (mode === 'continuity' || mode === 'load' || mode === 'load-state' || mode === 'idle-exit') {
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${sessionId}:prompt-${count}:loaded-${loaded}` } } } });
      result(id, { stopReason: 'end_turn' }); if (mode === 'idle-exit') setTimeout(() => process.exit(0), 10); continue;
    }
    if (mode === 'file-outside' || mode === 'file-inside' || mode === 'file-wrong-session' || mode === 'terminal') {
      send({ id: 'file', method: mode === 'terminal' ? 'terminal/create' : 'fs/write_text_file', params: mode === 'terminal' ? { sessionId, command: '/bin/echo', args: ['ready'], cwd: process.cwd() } : { sessionId: mode === 'file-wrong-session' ? 'wrong-session' : sessionId, path: mode === 'file-outside' ? join(process.cwd(), '..', 'outside.txt') : join(process.cwd(), 'inside.txt'), content: 'scratch' } });
      continue;
    }
    if (mode === 'direct-write') {
      writeFileSync(join(process.cwd(), 'inside.txt'), 'allowed');
      let outside = 'allowed'; try { writeFileSync(join(process.cwd(), '..', 'outside.txt'), 'escape'); } catch { outside = 'denied'; }
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `inside:allowed;outside:${outside}` } } } });
      result(id, { stopReason: 'end_turn' }); continue;
    }
    if (mode.startsWith('permission')) {
      send({ id: 'permission', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'outside', title: 'Outside effect' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, ...(mode === 'permission-allow-only' ? [] : [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }])] } });
      continue;
    }
    if (mode === 'die') process.exit(7);
    if (mode === 'malformed') process.stdout.write('{broken\n');
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'rea' } } } });
    if (mode === 'wait' || mode === 'ignore-cancel' || mode === 'file-after-stop' || (mode === 'late-stop' && count > 1)) continue;
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'dy' } } } });
    result(id, { stopReason: mode.startsWith('finish-') ? mode.slice(7) : 'end_turn' });
  } else if (method === 'session/cancel' && mode !== 'ignore-cancel') {
    if (mode === 'file-after-stop') { send({ id: 'file', method: 'fs/write_text_file', params: { sessionId, path: join(process.cwd(), 'late.txt'), content: 'late' } }); continue; }
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ':cancel-observed' } } } });
    result(promptId, { stopReason: 'cancelled' });
  }
}
