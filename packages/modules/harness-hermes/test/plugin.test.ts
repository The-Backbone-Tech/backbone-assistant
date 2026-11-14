// The plugin that runs inside Hermes, executed by a plain Python with a stand-in for Hermes's
// plugin context. This is the line that must fail closed, so its own failure paths run here; it
// needs python3, not Hermes. Whether Hermes honours the block is the VM journey's question.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writePlane } from '../src/plane.ts';

const DRIVER = `
import importlib.util, json, sys
home, action = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("host_gate", home + "/plugins/host_gate/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
class Ctx:
    def __init__(self): self.hooks, self.tools = {}, {}
    def register_hook(self, name, cb): self.hooks[name] = cb
    def register_tool(self, name, toolset, schema, handler, **kw): self.tools[name] = (toolset, schema, handler)
ctx = Ctx()
mod.register(ctx)
if action == "shape":
    print(json.dumps({"hooks": sorted(ctx.hooks), "tools": sorted(ctx.tools), "toolsets": sorted({t[0] for t in ctx.tools.values()})}))
elif action == "report-after-failure":
    print(json.dumps(ctx.hooks["pre_tool_call"](tool_name="door_write_file", args={"name": "a.md", "content": "x"}, session_id="s", tool_call_id="c", turn_id="t")))
    ctx.hooks["post_llm_call"](session_id="s", task_id="", turn_id="t")
    ctx.hooks["post_llm_call"](session_id="s", task_id="", turn_id="t2")
elif action == "allow-hook":
    print(json.dumps(ctx.hooks["pre_tool_call"](tool_name="door_list_files", args={}, session_id="s", tool_call_id="c", turn_id="t", task_id="", api_request_id="")))
elif action == "hook":
    print(json.dumps(ctx.hooks["pre_tool_call"](tool_name="terminal", args={"command": "id"}, session_id="s", tool_call_id="c", turn_id="t", task_id="", api_request_id="")))
elif action == "propagate":
    # What Hermes does with a hook's modify return: its arguments are merged over the call's.
    args = {"name": "a.md", "content": "x"}
    decision = ctx.hooks["pre_tool_call"](tool_name="door_write_file", args=dict(args), session_id="s", tool_call_id="c", turn_id="t", task_id="", api_request_id="")
    args.update(decision["args"])
    print(ctx.tools["door_write_file"][2](args, session_id="s"))
else:
    print(ctx.tools[action][2]({"name": "a.md", "content": "x"}, session_id="s", tool_call_id="c"))
`;

async function plane(port: number) {
  const home = await mkdtemp(join(tmpdir(), 'backbone-hermes-plane-'));
  await writePlane(home, { gateUrl: `http://127.0.0.1:${port}`, gateToken: 'gate-token', modelBaseUrl: 'http://127.0.0.1:8900/v1', model: 'scripted-1' });
  return home;
}
const python = (home: string, action: string) => JSON.parse(execFileSync('python3', ['-I', '-c', DRIVER, home, action], { encoding: 'utf8', timeout: 20_000 }));
/** A gate that holds the plane's secret: it gives its epoch, checks each request and signs each reply, as the adapter does. */
const MASTER = 'gate-token';
const EPOCH = 'e1';
const turnKey = (session: string) => createHmac('sha256', MASTER).update(`hermes-gate-turn\n${EPOCH}\n${session}`).digest();
const mac = (key: Buffer, kind: string, path: string, nonce: string, time: string, body: string) => createHmac('sha256', key).update(`${kind}\n${path}\n${nonce}\n${time}\n${body}`).digest('hex');
type Seen = { url: string; headers: Record<string, unknown>; raw: string; signed: boolean; [k: string]: unknown };
/** `answer` returns the reply body, or null to drop the connection. */
async function serveGate(answer: (url: string, body: any) => string | null, seen: Seen[] = []) {
  return serve((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      if (req.url === '/epoch') {
        // The epoch, signed over the plugin's nonce and the time, under a key only the plane's secret gives.
        const time = String(Date.now());
        const epochKey = createHmac('sha256', MASTER).update('hermes-gate-epoch').digest();
        res.writeHead(200, { 'x-gate-mac': createHmac('sha256', epochKey).update(`epoch\n${body.nonce}\n${EPOCH}\n${time}`).digest('hex') });
        return void res.end(JSON.stringify({ epoch: EPOCH, time: Number(time) }));
      }
      const key = turnKey(typeof body.session_id === 'string' ? body.session_id : '');
      const nonce = String(req.headers['x-gate-nonce'] ?? '');
      const time = String(req.headers['x-gate-time'] ?? '');
      seen.push({ url: req.url ?? '', headers: req.headers, raw, signed: req.headers['x-gate-mac'] === mac(key, 'req', req.url ?? '', nonce, time, raw), ...body });
      const reply = answer(req.url ?? '', body);
      if (reply === null) return void req.socket.destroy();
      res.writeHead(200, { 'x-gate-mac': mac(key, 'res', req.url ?? '', nonce, time, reply) });
      res.end(reply);
    });
  });
}
async function serve(handler: Parameters<typeof createServer>[1]) {
  const server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as { port: number }).port };
}
const pythonAsync = (home: string, action: string) =>
  new Promise<any>((resolve, reject) => {
    import('node:child_process').then(({ execFile }) => {
      execFile('python3', ['-I', '-c', DRIVER, home, action], { encoding: 'utf8', timeout: 20_000 }, (err, out) => (err ? reject(err) : resolve(JSON.parse(out))));
    });
  });

test('the plugin registers the policy hook, the turn report and the three door tools', async () => {
  const home = await plane(1);
  assert.deepEqual(python(home, 'shape'), { hooks: ['post_llm_call', 'pre_tool_call'], tools: ['door_list_files', 'door_read_file', 'door_write_file'], toolsets: ['door'] });
  await rm(home, { recursive: true });
});

test('an unreachable gate blocks', async () => {
  const { server, port } = await serve(() => undefined);
  await new Promise((r) => server.close(r));
  const home = await plane(port);
  const r = python(home, 'hook');
  assert.equal(r.action, 'block');
  await rm(home, { recursive: true });
});

for (const [name, status, body] of [['a 500', 500, '{}'], ['garbage', 200, 'not json'], ['an empty object', 200, '{}'], ['a list', 200, '[]'], ['an unknown action', 200, '{"action":"approve"}'], ['a wrong-case allow', 200, '{"action":"ALLOW"}']] as const) {
  test(`${name} from the gate blocks`, async () => {
    const { server, port } = await serve((_req, res) => {
      res.writeHead(status);
      res.end(body);
    });
    const home = await plane(port);
    const r = await pythonAsync(home, 'hook');
    assert.equal(r.action, 'block');
    server.close();
    await rm(home, { recursive: true });
  });
}

test('only an explicit allow passes, and the hook sends the call signed, never the plane\'s secret', async () => {
  const seen: Seen[] = [];
  const { server, port } = await serveGate(() => '{"action":"allow"}', seen);
  const home = await plane(port);
  assert.equal(await pythonAsync(home, 'hook'), null);
  assert.equal(seen[0].signed, true);
  assert.equal(seen[0].tool_name, 'terminal');
  assert.equal(seen[0].session_id, 's');
  assert.ok(!JSON.stringify(seen[0].headers).includes(MASTER) && !seen[0].raw.includes(MASTER));
  server.close();
  await rm(home, { recursive: true });
});

test('an allow with a ticket reaches the door through the hook\'s modify, and the door returns it apart from the arguments', async () => {
  const seen: Seen[] = [];
  const issued = randomUUID();
  const { server, port } = await serveGate((url) => (url === '/decide' ? JSON.stringify({ action: 'allow', ticket: issued }) : '{"ok":true,"text":"Done."}'), seen);
  const home = await plane(port);
  assert.deepEqual(await pythonAsync(home, 'propagate'), { output: 'Done.' });
  assert.equal(seen[1].url, '/call');
  assert.equal(seen[1].ticket, issued, 'the ticket the gate issued, carried by the hook\'s return alone');
  assert.deepEqual(seen[1].args, { name: 'a.md', content: 'x' });
  server.close();
  await rm(home, { recursive: true });
});

test('the door acknowledges delivery with its ticket before it returns to Hermes', async () => {
  const seen: Seen[] = [];
  const { server, port } = await serveGate((url) => (url === '/decide' ? '{"action":"allow","ticket":"t-1"}' : '{"ok":true,"text":"Done."}'), seen);
  const home = await plane(port);
  await pythonAsync(home, 'propagate');
  assert.deepEqual(seen.map((s) => s.url), ['/decide', '/call', '/delivered']);
  assert.equal(seen[2].ticket, 't-1');
  assert.equal(seen[2].session_id, 's');
  server.close();
  await rm(home, { recursive: true });
});

test('an acknowledgement that fails does not change what the model is told', async () => {
  const { server, port } = await serveGate((url) => (url === '/delivered' ? null : url === '/decide' ? '{"action":"allow","ticket":"t-1"}' : '{"ok":true,"text":"Done."}'));
  const home = await plane(port);
  assert.deepEqual(await pythonAsync(home, 'propagate'), { output: 'Done.' });
  server.close();
  await rm(home, { recursive: true });
});

test('the turn report carries every decision the hook could not get, until one is delivered and after', async () => {
  const seen: Seen[] = [];
  let reports = 0;
  const { server, port } = await serveGate((url) => (url === '/decide' ? null : (reports += 1) === 1 ? null : '{}'), seen);
  const home = await plane(port);
  await new Promise<void>((resolve, reject) => {
    import('node:child_process').then(({ execFile }) => execFile('python3', ['-I', '-c', DRIVER, home, 'report-after-failure'], { encoding: 'utf8', timeout: 20_000 }, (err) => (err ? reject(err) : resolve())));
  });
  assert.deepEqual(seen.filter((s) => s.url === '/report').map((s) => [s.session_id, s.failed]), [['s', 1], ['s', 1]], 'a lost report does not take the count with it');
  server.close();
  await rm(home, { recursive: true });
});

test('a door call that loses the gate says the outcome is UNKNOWN and never claims success', async () => {
  const { server, port } = await serve(() => undefined);
  await new Promise((r) => server.close(r));
  const home = await plane(port);
  const r = python(home, 'door_write_file');
  assert.match(r.error, /UNKNOWN/);
  await rm(home, { recursive: true });
});

test('a door call returns the gate\'s text to the model', async () => {
  const { server, port } = await serveGate(() => '{"ok":true,"text":"Wrote a.md v2."}');
  const home = await plane(port);
  assert.deepEqual(await pythonAsync(home, 'door_write_file'), { output: 'Wrote a.md v2.' });
  server.close();
  await rm(home, { recursive: true });
});

test('an impostor on the gate\'s port learns no secret, and its allow is not trusted', async () => {
  const seen: { headers: Record<string, unknown>; raw: string }[] = [];
  const { server, port } = await serve((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, raw });
      res.writeHead(200);
      res.end(req.url === '/decide' ? '{"action":"allow","ticket":"forged"}' : '{"ok":true,"text":"Forged."}');
    });
  });
  const home = await plane(port);
  assert.equal((await pythonAsync(home, 'allow-hook')).action, 'block');
  assert.ok((await pythonAsync(home, 'door_write_file')).error);
  assert.ok(seen.length > 0);
  for (const r of seen) assert.ok(!JSON.stringify(r.headers).includes(MASTER) && !r.raw.includes(MASTER), 'the secret never leaves the plugin');
  server.close();
  await rm(home, { recursive: true });
});

test('the plane turns on the doors and Hermes\'s own toolsets, and nothing that leaves it', async () => {
  const home = await plane(1);
  const config = await readFile(join(home, 'config.yaml'), 'utf8');
  assert.deepEqual(/api_server:\n((?:\s+- .+\n)+)/.exec(config)?.[1].trim().split(/\s*- /).filter(Boolean), ['door', 'memory', 'skills', 'todo']);
  assert.match(config, /auxiliary:\n\s+background_review:\n\s+enabled: false\n\s+title_generation:\n\s+enabled: false/, 'no auxiliary task reaches its own route');
  assert.match(config, /nudge_interval: 0/);
  assert.match(config, /memory:\n\s+memory_enabled: true\n\s+user_profile_enabled: true\n\s+provider: ""/, 'built-in memory, no external provider');
  assert.match(config, /skills:\n\s+external_dirs: \[\]\n\s+inline_shell: false/, 'skills run no shell');
  assert.match(config, /^mcp_servers: \{\}$/m, 'no MCP server');
  await rm(home, { recursive: true });
});

test('the plane enables the plugin, sets a hook budget, adds no shell hook and keeps the token private', async () => {
  const home = await plane(1);
  const config = await readFile(join(home, 'config.yaml'), 'utf8');
  assert.match(config, /enabled:\n\s+- host_gate/);
  assert.match(config, /hook_callback_timeout: \d+/);
  assert.match(config, /platform_toolsets:\n\s+api_server:\n\s+- door\n/, 'nothing native to reach if the hook fails');
  assert.match(config, /tool_search:\n\s+enabled: "off"/, 'door tools are offered directly, not deferred behind a bridge');
  assert.doesNotMatch(config, /^hooks:/m, 'the shell hook fails open by default');
  const gate = join(home, 'plugins/host_gate/gate.json');
  assert.equal((await stat(gate)).mode & 0o077, 0, 'readable by its owner only');
  assert.doesNotMatch(config, /gate-token/);
  await rm(home, { recursive: true });
});

// Second review, item 4: a properly signed reply still has to say exactly "allow".
for (const [name, reply] of [['approve', '{"action":"approve","ticket":"t"}'], ['ALLOW', '{"action":"ALLOW","ticket":"t"}'], ['a missing action', '{"ticket":"t"}'], ['an action that is not text', '{"action":1,"ticket":"t"}']] as const) {
  test(`a signed reply with ${name} blocks`, async () => {
    const seen: Seen[] = [];
    const { server, port } = await serveGate(() => reply, seen);
    const home = await plane(port);
    assert.equal((await pythonAsync(home, 'allow-hook')).action, 'block');
    assert.equal(seen[0]?.signed, true, 'the request reached the gate properly signed, so the reply was checked');
    server.close();
    await rm(home, { recursive: true });
  });
}

// Third review, item 4: an epoch is taken only from a gate that proves the plane's secret.
test('an impostor that hands out an epoch gets no signed request', async () => {
  const seen: { method: string; url: string }[] = [];
  const { server, port } = await serve((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '' });
    req.resume();
    req.on('end', () => {
      res.writeHead(200);
      res.end(req.url === '/epoch' ? JSON.stringify({ epoch: 'chosen-by-impostor', time: Date.now() }) : '{"action":"allow","ticket":"t"}');
    });
  });
  const home = await plane(port);
  assert.equal((await pythonAsync(home, 'allow-hook')).action, 'block');
  assert.deepEqual(seen.filter((r) => r.url !== '/epoch'), [], 'nothing signed reached a gate that could not prove the secret');
  server.close();
  await rm(home, { recursive: true });
});
