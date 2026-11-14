// Deliberately fake native executable: exercises adapter/JSONL validation, never a real sandbox or model.
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFile, readFile, writeFile, symlink, link, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
// Independent fake config for the inspected 0.165.0 profile; never derived from production controls.
const PROFILE = 'backbone-native-staged';
const filesystem = { ':root': 'deny', ':minimal': 'read', ':workspace_roots': 'write', '/tmp': 'deny', '/var/tmp': 'deny', '/private/tmp': 'deny', '/private/var/tmp': 'deny' };
const features = {
  shell_tool: true, stable_environment_tools: false, view_image: false,
  hooks: false, memories: false, plugins: false, apps: false,
  in_app_browser: false, browser_use: false, browser_use_external: false,
  computer_use: false, image_generation: false, workspace_dependencies: false,
  multi_agent: false, multi_agent_v2: false, goals: false, tool_suggest: false,
  recommended_plugins: false, request_permissions_tool: false, agent_message_board: false,
  code_mode: false, code_mode_host: true, code_mode_prewarm: false,
  skill_mcp_dependency_install: false, skill_search: false, skip_host_skill_discovery: true,
  external_agent_memory_import: false,
};
// The `full` contract, written out independently: native account permissions stay with Codex.
const fullFeatures = {
  ...features, view_image: true, memories: true, multi_agent: true, goals: true,
  apps: true, plugins: true,
  skill_search: true, skip_host_skill_discovery: false,
};
const [mode, command, ...args] = process.argv.slice(2);
const readonly = args.some((a) => a.includes('":workspace_roots"="read"'));
const full = args.includes('web_search="live"') && mode !== 'full-claims-contained';
// A person's own config turns a feature on; a bare turn asks for it off, echoed back unless told to ignore it.
const userFeature = mode.startsWith('bare-user-feature') && (mode === 'bare-user-feature-ignored' || !args.includes('features.chronicle=false'));
// A bare turn asks for its shell off; echoed back unless told to ignore it.
const shellOff = args.includes('features.shell_tool=false') && mode !== 'bare-shell-ignored';
// The filesystem map the adapter asked for, echoed back as the effective one (minus one deny when told to drop it).
const asked = (() => { const a = args.find((v) => v.startsWith(`permissions.${PROFILE}.filesystem=`)); if (!a) return filesystem; const map = {}; for (const [, k, v] of a.matchAll(/"([^"]+)"="([^"]+)"/g)) map[k] = v; return map; })();
// The PATH the adapter set, echoed back as the effective one (or another one when told to change it).
const askedPath = (() => { const a = args.find((v) => v.startsWith('shell_environment_policy.set.PATH=')); return a ? JSON.parse(a.slice('shell_environment_policy.set.PATH='.length)) : undefined; })();
const effectivePath = mode === 'path-changed' ? `/tmp/elsewhere:${askedPath}` : askedPath;
const askedScratch = Object.fromEntries(['TMPDIR', 'TMPPREFIX'].flatMap((name) => { const arg = args.findLast((value) => value.startsWith(`shell_environment_policy.set.${name}=`)); return arg ? [[name, JSON.parse(arg.slice(arg.indexOf('=') + 1))]] : []; }));
if (mode === 'scratch-changed') askedScratch.TMPPREFIX = '/tmp/unowned-zsh';
if (mode === 'scratch-missing') delete askedScratch.TMPPREFIX;
const effectiveFs = mode === 'dropped-deny' ? Object.fromEntries(Object.entries(asked).filter(([k]) => !k.endsWith('/.ssh'))) : mode === 'dropped-extra-deny' ? Object.fromEntries(Object.entries(asked).filter(([k]) => k !== '/srv/arrangement-denied')) : asked;
// `codex features list`: the effective feature set, as 0.165.0 prints it, with `-c features.X=…` applied.
// Removed-stage flags and unified_exec stay as they are, as the pinned version does.
// `codex debug models`: a catalog whose one model, like 0.165.0's, chooses code mode and multi-agent tools.
if (command === 'debug' && args[0] === 'models') { console.log(JSON.stringify({ models: [{ slug: 'test-model', tool_mode: 'code_mode_only', multi_agent_version: 'v2', apply_patch_tool_type: 'freeform', experimental_supported_tools: ['clock'], supports_search_tool: true, context_window: 1000 }] })); process.exit(0); }
if (command === 'features') {
  const listed = { code_mode_host: ['stable', true], skip_host_skill_discovery: ['under development', false], shell_tool: ['stable', true], sleep_tool: ['stable', true], unified_exec: ['stable', true], item_ids: ['removed', true], hooks: ['stable', false], ...(mode.startsWith('bare-user-feature') ? { chronicle: ['under development', true] } : {}) };
  for (const [, name, value] of args.join(' ').matchAll(/features\.([A-Za-z0-9_]+)=(true|false)/g)) {
    if (!listed[name] || listed[name][0] === 'removed' || name === 'unified_exec') continue;
    if (mode === 'bare-default-ignored' && name === 'sleep_tool') continue;
    listed[name] = [listed[name][0], value === 'true'];
  }
  for (const [name, [stage, on]] of Object.entries(listed)) console.log(`${name.padEnd(40)} ${stage.padEnd(18)} ${on}`);
  process.exit(0);
}
if (command === '--version') { console.log(`codex-cli ${mode === 'wrong-version' ? '0.0.0' : mode === 'prior-version' ? '0.162.1' : '0.165.0'}`); process.exit(0); }
if (command === 'sandbox' && ['namespace-refused', 'bubblewrap-missing', 'seccomp-refused', 'executable-hidden'].includes(mode)) { console.error(mode === 'executable-hidden' ? 'bwrap: execvp /secret-canary/runtime: No such file or directory' : mode === 'namespace-refused' ? 'bwrap: Creating new namespace failed: Operation not permitted secret-canary' : mode === 'bubblewrap-missing' ? 'bubblewrap is unavailable secret-canary' : 'error applying seccomp secret-canary'); process.exit(1); }
if (command === 'sandbox' && args.some((value) => value.includes('backbone-native-snapshot-v1'))) { if (mode === 'helper-fails') process.exit(1); const mark = args.indexOf('--'); const result = spawnSync(args[mark + 1], args.slice(mark + 2), { cwd: process.cwd(), encoding: 'utf8' }); process.stdout.write(result.stdout ?? ''); process.exit(result.status ?? 1); }
if (command === 'sandbox' && args.some(value => value.includes('backbone-linux-mount-table-v1'))) { console.log(JSON.stringify({mounts:'1 0 0:1 / / ro - ext4 root ro',network_namespace:'net:[999999999]'})); process.exit(0); }
if (command === 'sandbox' && args.some(value => value.includes('backbone-linux-datagram-visibility-v1'))) { console.log(JSON.stringify({ visible: mode === 'visible-host-datagram', complete: true, network_namespace: 'net:[999999999]', count:1, limit:250000, time_limit_ms:10000, elapsed_ms:1 })); process.exit(0); }
if (command === 'sandbox' && args.some(value => value.includes('backbone-linux-node-audit-v1'))) {
  const spec=JSON.parse(args.at(-1)), fullView=asked[':root']==='read';
  console.log(JSON.stringify({ready:true,single_file_initial:'denied'}));
  const timer=setInterval(async()=>{
    try { if(await readFile(spec.release,'utf8')!==spec.token)return; }catch{return;}
    clearInterval(timer);
    console.log(JSON.stringify({single_file_initial:'denied',single_file_renamed:fullView?'allowed':'denied',created_path:fullView?'allowed':'denied',data_home:'denied',arrangement:'denied',extra_denies:spec.extra.map(()=> 'denied'),run_visible:fullView,udp:'denied',dns:'denied',unix_stream:'denied',abstract_stream:'denied',fresh_proc:true,pid_namespace_distinct:true,network_namespace_distinct:true,proc_cmdline:'denied',proc_environ:'denied'}));process.exit(0);
  },10);
  setTimeout(()=>process.exit(1),10000).unref();await new Promise(()=>{});
}
if (command === 'sandbox' && args.some(value => value.includes('backbone-readonly-isolation-v1'))) {
  const spec = JSON.parse(args.at(-1));
  if (spec.phase === 'read') {
    console.log(JSON.stringify({ inside_read: 'allowed', namespace: 'mnt:[2]', private_reads: spec.readTargets.map(() => 'absent') })); process.exit(0);
  }
  console.log(JSON.stringify({ ready: true, namespace: 'mnt:[1]', writes: spec.targets.map(() => 'denied') }));
  const timer = setInterval(async () => {
    try { if (await readFile(spec.release, 'utf8') === spec.token) { clearInterval(timer); console.log(JSON.stringify({ released: true })); process.exit(0); } } catch {}
  }, 10);
  setTimeout(() => process.exit(1), 10000).unref();
  await new Promise(() => {});
}
if (command === 'sandbox') { const reads = args.some((a) => a.includes('":root"="read"')); console.log(JSON.stringify({ inside_read: 'allowed', inside_write: readonly ? 'denied' : 'allowed', outside_read: reads ? 'allowed' : 'denied', outside_write: mode === 'outside-write' ? 'allowed' : 'denied', denied_read: mode === 'deny-ignored' ? 'allowed' : 'denied', child_inside_read: 'allowed', symlink_read: mode === 'symlink-escape' ? 'allowed' : 'denied', child_read: mode === 'child-escape' ? 'allowed' : 'denied', alias_read: mode === 'alias-escape' ? 'allowed' : 'denied', network: mode === 'network-escape' ? 'allowed' : 'denied', temp_read: reads ? 'allowed' : 'denied', temp_write: 'denied', var_temp_read: reads ? 'allowed' : 'denied', var_temp_write: 'denied' })); process.exit(0); }
const final = args.some((arg) => arg.includes('mcp_servers.')) || full;
let threadStarted = false;
// A bare turn's tool-free catalog, echoed back unless told to drop it; its preflight's stand-in provider.
const catalogArg = args.find((a) => a.startsWith('model_catalog_json='));
const catalog = catalogArg && mode !== 'bare-catalog-dropped' ? JSON.parse(catalogArg.slice('model_catalog_json='.length)) : undefined;
const preflightUrl = /base_url = "([^"]+)"/.exec(args.find((a) => a.startsWith('model_providers.backbone_bare_preflight=')) ?? '')?.[1];
let preflightThread = false;
if (mode === 'bare-catalog-swap' && catalogArg && !preflightUrl && final) {
  const path = JSON.parse(catalogArg.slice('model_catalog_json='.length));
  setTimeout(() => { void writeFile(path, JSON.stringify({ models: [{ slug: 'test-model', tool_mode: 'code_mode_only', multi_agent_version: 'v2' }] })); }, 0);
}
const stage = process.cwd();
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method, params) => send({ method, params: { threadId: 'native-thread', ...params } });
const config = () => ({
  ...(catalog ? { model_catalog_json: catalog } : {}),
  features: { ...(full ? fullFeatures : shellOff ? { ...features, shell_tool: false } : features), ...(userFeature ? { chronicle: true } : {}) }, default_permissions: PROFILE, web_search: full ? 'live' : 'disabled', model_provider: 'openai', forced_login_method: 'chatgpt', allow_login_shell: false,
  ...(mode === 'native-disabled' ? { features: { ...fullFeatures, apps: false, plugins: false } } : {}),
  shell_environment_policy: { inherit: 'none', set: { PATH: effectivePath, ...askedScratch } }, skills: { include_instructions: full },
  tools: { update_plan: { enabled: false }, experimental_request_user_input: { enabled: false } },
  ...(mode === 'env-set' ? { shell_environment_policy: { inherit: 'none', set: { PATH: effectivePath, TOKEN: 'secret-canary' } } } : {}),
  permissions: { [PROFILE]: { filesystem: effectiveFs, network: { enabled: mode === 'network-on' } } },
  mcp_servers: { demo: { enabled: full || !final }, disabled: { enabled: false }, ...(mode === 'new-mcp' && threadStarted ? { surprise: { enabled: true } } : {}) },
  ...(mode === 'bad-config' && final ? { features: { ...features, hooks: true } } : {}),
  ...(mode === 'host-disabled' && final ? { features: { ...features, code_mode_host: false } } : {}),
});
async function stdoutHolder() {
  const pidFile = join(stage, 'stdout-holder-pid');
  const shell = spawn('/bin/bash', ['-c', 'set -m; /bin/sleep 5 & printf \"%s\" \"$!\" > \"$1\"; exit 0', 'owned-holder', pidFile], { stdio: ['ignore', 'inherit', 'ignore'] });
  await new Promise((resolve, reject) => { shell.once('exit', resolve); shell.once('error', reject); });
}
let dynamicTools = [];
let firstEffectResult;
let hostCalls = [], hostResults = [];
const askHost = () => { const call = hostCalls[hostResults.length]; send({ id: 901, method: 'item/tool/call', params: { threadId: 'native-thread', turnId: 'native-turn', callId: `host-${hostResults.length}`, tool: call.name, arguments: call.args, ...(Object.hasOwn(call, 'namespace') ? { namespace: call.namespace } : {}) } }); };
/** A connector call's answer arrives on the same stream; the turn finishes with what it said. */
const answerTool = (result) => {
  if (mode === 'host-tools') {
    hostResults.push(result);
    if (hostResults.length < hostCalls.length) { askHost(); return; }
    notify('item/completed', { turnId: 'native-turn', item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: JSON.stringify({ catalog: dynamicTools, results: hostResults, continued: true }) } });
    notify('turn/completed', { turn: { id: 'native-turn', status: 'completed', items: [] } }); return;
  }
  if (mode === 'connector-effects' && !firstEffectResult) {
    firstEffectResult = result;
    send({ id: 901, method: 'item/tool/call', params: { threadId: 'native-thread', turnId: 'native-turn', callId: 'call-2', tool: dynamicTools.find(t => t.name.endsWith('__draft_note'))?.name, arguments: { text: 'different second effect' } } });
    return;
  }
  const said = mode === 'readonly-false' ? 'I changed the file.' : `${result.success ? 'ok' : 'refused'}: ${result.contentItems?.[0]?.text ?? ''}`;
  notify('item/completed', { turnId: 'native-turn', item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: firstEffectResult ? `${JSON.stringify(firstEffectResult)}\n${said}` : said } });
  notify('turn/completed', { turn: { id: 'native-turn', status: 'completed', items: [] } });
};
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const message = JSON.parse(line); if (message.id === undefined) continue;
  if (message.method === undefined && message.id === 901) { answerTool(message.result); continue; }
  const { method, id, params } = message;
  if (method === 'initialize') { if (mode === 'stdout-holder') await stdoutHolder(); send({ id, result: { userAgent: 'fake', platformOs: mode === 'wrong-platform' ? 'other' : process.platform === 'darwin' ? 'macos' : process.platform, platformFamily: 'unix', codexHome: '/fake' } }); }
  else if (method === 'config/read') send({ id, result: { config: config(), origins: {}, layers: null } });
  else if (method === 'account/read') send({ id, result: { account: { type: mode === 'api-auth' ? 'apiKey' : 'chatgpt' }, requiresOpenaiAuth: true } });
  else if (method === 'model/list') send({ id, result: { data: [{ id: 'test-model', displayName: 'Test model', hidden: false, supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map((reasoningEffort) => ({ reasoningEffort })) }], nextCursor: null } });
  // A malformed refusal: an error that is null, not an object. The request must still settle.
  else if (method === 'thread/start' && mode === 'null-error') send({ id, error: null });
  else if (method === 'thread/start' && mode === 'coercing-error') send({ id, error: { code: { valueOf: 0, toString: 0 }, message: 'x' } });
  // As the real 0.165.0 app-server does: a dynamic tool under the reserved mcp__ prefix refuses the thread.
  else if (method === 'thread/start' && (params.dynamicTools ?? []).some((t) => String(t.name).startsWith('mcp__'))) send({ id, error: { code: -32600, message: `dynamic tool name is reserved: ${params.dynamicTools.find((t) => String(t.name).startsWith('mcp__')).name}` } });
  else if (method === 'thread/start' && params.modelProvider === 'backbone_bare_preflight') { preflightThread = true; dynamicTools = params.dynamicTools ?? []; send({ id, result: { thread: { id: 'preflight-thread' }, model: params.model, modelProvider: params.modelProvider } }); }
  else if (method === 'turn/start' && preflightThread) {
    // The one model request Codex would send, to the stand-in provider: tool-free only with the bare catalog.
    send({ id, result: { turn: { id: 'preflight-turn', status: 'inProgress', items: [] } } });
    const tools = catalogArg && mode !== 'bare-catalog-ignored' && mode !== 'readonly-unsafe-offer' ? readonly ? dynamicTools.filter(({ name }) => mode !== 'readonly-missing-tool' || name !== 'read_file').map(({ name }) => ({ type: 'function', name })) : [] : [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }] }];
    const input = mode === 'bare-input-tools' ? [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'spawn_agent' }] }] : [{ type: 'message', role: 'user', content: [] }];
    const capturedInput = mode === 'readonly-namespaced' || mode === 'readonly-namespaced-read' || mode === 'readonly-other-namespace'
      ? [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: mode === 'readonly-namespaced' || mode === 'readonly-namespaced-read' ? 'functions' : 'other', tools }] }]
      : input;
    const capturedTools = mode === 'readonly-namespaced' || mode === 'readonly-namespaced-read' || mode === 'readonly-other-namespace' ? [] : tools;
    await fetch(`${preflightUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: params.model, input: capturedInput, tools: capturedTools, tool_choice: 'auto' }) }).catch(() => {});
  }
  else if (method === 'thread/start') { threadStarted = true; dynamicTools = params.dynamicTools ?? []; send({ id, result: { thread: { id: 'native-thread', environments: [{ environmentId: 'local', cwd: stage, runtimeWorkspaceRoots: [stage] }] }, model: mode === 'different-model' ? 'other' : params.model, modelProvider: 'openai', cwd: stage, runtimeWorkspaceRoots: [stage], activePermissionProfile: { id: mode === 'bad-profile' ? ':danger-full-access' : PROFILE, extends: null }, approvalPolicy: 'never', sandbox: readonly ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots: [stage], networkAccess: false } } }); }
  else if (method === 'turn/start') {
    if (mode.startsWith('native-mcp')) {
      await writeFile(join(stage, 'draft.md'), 'A staged draft, never an account receipt.');
      send({ id, result: { turn: { id: 'native-turn', status: 'inProgress', items: [] } } });
      notify('turn/started', { turn: { id: 'native-turn' } });
      notify('mcpServer/startupStatus/updated', { server: 'demo', status: 'ready' });
      const item = { type: 'mcpToolCall', id: 'mcp-call', server: 'demo', tool: 'calendar_search', arguments: {}, status: 'inProgress' };
      notify('item/started', { turnId: 'native-turn', item });
      if (mode === 'native-mcp-crash') { setTimeout(() => process.exit(1), 25); continue; }
      if (mode === 'native-mcp-pending' || mode === 'native-mcp-stop') continue;
      notify('item/completed', { turnId: 'native-turn', item: { ...item, ...(mode === 'native-mcp-read-failed' ? { readOnlyHint: true } : {}), status: mode === 'native-mcp-failed' || mode === 'native-mcp-read-failed' ? 'failed' : 'completed', result: { content: [] } } });
      notify('item/completed', { turnId: 'native-turn', item: { type: 'agentMessage', id: 'answer', text: 'Native connector answered.', phase: 'final_answer' } });
      notify('turn/completed', { turn: { id: 'native-turn', status: 'completed', items: [] } });
      continue;
    }
    if (mode === 'shell-scratch') {
      const setting = (name) => { const arg = args.findLast((value) => value.startsWith(`shell_environment_policy.set.${name}=`)); return arg ? JSON.parse(arg.slice(arg.indexOf('=') + 1)) : undefined; };
      const temp = setting('TMPDIR'), prefix = setting('TMPPREFIX');
      if (temp !== join(stage, '.backbone-tmp') || prefix !== join(temp, 'zsh')) { send({ id, error: { code: -1, message: 'missing owned shell scratch' } }); continue; }
      await mkdir(temp, { recursive: true });
      await writeFile(join(temp, 'scratch.bin'), Buffer.from([0, 255]));
      // macOS zsh uses TMPPREFIX; Linux verifies the same heredoc through its POSIX shell.
      const shell = spawnSync(process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh', ['-f', '-c', 'cat <<EOF\nheredoc works\nEOF'], { env: { PATH: effectivePath, TMPDIR: temp, TMPPREFIX: prefix }, encoding: 'utf8' });
      if (shell.status !== 0 || shell.stdout !== 'heredoc works\n') { send({ id, error: { code: -1, message: 'heredoc failed' } }); continue; }
    }
    let spawnedInSnapshot;
    if (mode === 'helper-fails' || mode === 'runtime-options') await writeFile(join(stage, '..', '..', 'model-started'), 'started');
    if (readonly && mode === 'readonly-empty') { const entries = await readdir(stage); if (entries.length !== 1 || entries[0] !== '.backbone-tmp') { send({ id, error: { code: -1, message: 'workspace contains sources' } }); continue; } }
    if (readonly && mode === 'readonly-prompt') { const text = params.input?.[0]?.text ?? ''; if (!text.includes('list_files and read_file') || !text.includes('cannot change files') || text.includes('host applies your changes') || text.includes('Revise working')) { send({ id, error: { code: -1, message: 'bad read-only prompt' } }); continue; } }
    if (mode === 'prompt-contract') { const text = params.input?.[0]?.text ?? ''; if (!text.includes('\"note.md\" v1') || !text.includes('Never delete a file') || text.includes('Create or edit') || text.includes('withdrawn-canary') || (full !== text.includes('search the web'))) { send({ id, error: { code: -1, message: 'bad prompt' } }); continue; } }
    if (mode === 'source-classes') {
      const text = params.input?.[0]?.text ?? '';
      if (!text.includes('"note.md" v1 [original: keep unchanged; create a new working copy]') || !text.includes('"working.md" v3 [working: may revise in place]') || !text.includes('"accepted.md" v4 [accepted: may revise in place]') || text.includes('Edit a file in place to revise it')) {
        send({ id, error: { code: -1, message: 'source classes did not reach the native request' } }); continue;
      }
    }
    if (mode === 'malformed') { console.log('not-json secret-canary'); continue; }
    if (mode === 'server-request') { send({ id: 900, method: 'item/tool/call', params: { tool: 'escape', arguments: 'secret-canary' } }); continue; }
    if (mode === 'readonly-read' || mode === 'readonly-list' || mode === 'readonly-namespaced-read' || mode === 'readonly-other-ns-call' || mode === 'readonly-bad-tool' || mode === 'readonly-write' || mode === 'readonly-false') {
      const tool = mode === 'readonly-list' ? 'list_files' : (mode === 'readonly-read' || mode === 'readonly-namespaced-read' || mode === 'readonly-other-ns-call') ? 'read_file' : (mode === 'readonly-write' || mode === 'readonly-false') ? 'write_file' : 'unexpected';
      send({ id, result: { turn: { id: 'native-turn', status: 'inProgress', items: [] } } });
      notify('turn/started', { turn: { id: 'native-turn' } });
      notify('item/started', { turnId: 'native-turn', item: { type: 'dynamicToolCall', id: 'call-1', tool, arguments: { name: 'note.md' }, status: 'inProgress' } });
      send({ id: 901, method: 'item/tool/call', params: { threadId: 'native-thread', turnId: 'native-turn', callId: 'call-1', tool, ...(mode === 'readonly-other-ns-call' ? { namespace: 'evil' } : {}), arguments: mode === 'readonly-list' ? {} : { name: 'note.md' } } });
      continue;
    }
    if (mode === 'host-tools') {
      hostCalls = JSON.parse(params.input[0].text.split('HOST_TOOL_CALLS:').at(-1));
      send({ id, result: { turn: { id: 'native-turn', status: 'inProgress', items: [] } } });
      notify('turn/started', { turn: { id: 'native-turn' } });
      askHost(); continue;
    }
    if (mode.startsWith('connector-')) {
      const tool = mode === 'connector-unoffered' ? 'mcp__notes__not_offered' : (mode === 'connector-effects' ? dynamicTools.find(t => !t.name.endsWith('__draft_note')) : dynamicTools[0])?.name ?? 'none';
      const turnId = ['connector-wrong-turn', 'connector-early-wrong'].includes(mode) ? 'other-turn' : mode === 'connector-no-turn' ? undefined : 'native-turn';
      const ask = () => send({ id: 901, method: 'item/tool/call', params: { threadId: 'native-thread', ...(turnId ? { turnId } : {}), callId: 'call-1', tool, arguments: mode === 'connector-effects' ? {} : { q: 'launch' } } });
      // Early: the call comes before the turn is acknowledged; it must wait for that, then be answered.
      const early = mode.startsWith('connector-early');
      if (early) ask();
      send({ id, result: { turn: { id: 'native-turn', status: 'inProgress', items: [] } } });
      notify('turn/started', { turn: { id: 'native-turn' } });
      if (!early) ask();
      continue;
    }
    if (mode === 'crash') process.exit(1);
    if (!['completion-before-ack', 'wrong-ack-after-complete', 'no-ack'].includes(mode)) send({ id, result: { turn: { id: 'native-turn', status: 'inProgress', items: [] } } });
    notify('turn/started', { turn: { id: 'native-turn' } });
    const message = (itemId, phase, text, completed = true) => {
      notify('item/started', { turnId: 'native-turn', item: { type: 'agentMessage', id: itemId, phase, text: '' } });
      if (mode !== 'completed-only') notify('item/agentMessage/delta', { turnId: 'native-turn', itemId, delta: text });
      if (completed) notify('item/completed', { turnId: 'native-turn', item: { type: 'agentMessage', id: itemId, phase, text } });
    };
    if (['phased', 'completed-only'].includes(mode)) { message('progress', 'commentary', 'I will inspect the files.'); message('answer', 'final_answer', 'Created the brief.'); }
    else if (mode === 'interleaved') {
      message('progress', 'commentary', 'Working', false); message('answer', 'final_answer', 'Created', false);
      notify('item/agentMessage/delta', { turnId: 'native-turn', itemId: 'progress', delta: ' carefully.' });
      notify('item/agentMessage/delta', { turnId: 'native-turn', itemId: 'answer', delta: ' the brief.' });
      notify('item/completed', { turnId: 'native-turn', item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Created the brief.' } });
      notify('item/completed', { turnId: 'native-turn', item: { type: 'agentMessage', id: 'progress', phase: 'commentary', text: 'Working carefully.' } });
    } else if (mode === 'queue-pressure') { message('large', 'commentary', '', false); for (let i = 0; i < 100; i++) notify('item/agentMessage/delta', { turnId: 'native-turn', itemId: 'large', delta: 'x'.repeat(5_000) }); }
    else if (mode === 'missing-item-id') notify('item/agentMessage/delta', { turnId: 'native-turn', delta: 'unsafe' });
    else if (mode === 'wrong-item-turn') notify('item/completed', { turnId: 'other-turn', item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'unsafe' } });
    else if (mode === 'bad-phase') message('answer', 'invented_phase', 'unsafe');
    else if (mode === 'conflicting-complete' || mode === 'late-delta') {
      message('answer', 'final_answer', 'Created the brief.');
      if (mode === 'late-delta') notify('item/agentMessage/delta', { turnId: 'native-turn', itemId: 'answer', delta: 'unsafe' });
      else notify('item/completed', { turnId: 'native-turn', item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'different' } });
    } else if (mode === 'duplicate-complete') {
      message('answer', 'final_answer', 'Created the brief.');
      notify('item/completed', { turnId: 'native-turn', item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Created the brief.' } });
    } else message('answer', mode === 'ordered-final' ? 'final_answer' : null, 'Created the brief.');
    if (mode.startsWith('bare-item-')) notify('item/completed', { turnId: 'native-turn', item: { type: mode.slice('bare-item-'.length), id: 'odd' } });
    // A sub-agent the turn spawns, shaped as 0.165.0 reports one (multi_agent v2). Its first status may come
    // before the spawn item that names it; its turn names the parent turn as its root.
    if (mode.includes('spawn')) {
      const child = (method, params) => send({ method, params: { threadId: 'child-thread', ...params } });
      child('thread/status/changed', { status: { type: 'idle' } });
      const activity = { type: 'subAgentActivity', model: 'test-model', reasoningEffort: 'low', id: 'call-spawn', kind: 'started', agentThreadId: 'child-thread', agentPath: '/root/helper' };
      // spawn-snapshot: the spawn is reported only in the parent's terminal snapshot.
      if (mode !== 'spawn-snapshot') { notify('item/started', { turnId: 'native-turn', item: activity }); notify('item/completed', { turnId: 'native-turn', item: activity }); }
      else spawnedInSnapshot = activity;
      if (mode !== 'spawn-snapshot') child('turn/started', { turn: { id: 'child-turn', rootTurnId: 'native-turn', items: [], status: 'inProgress' } });
      if (mode !== 'spawn-snapshot') child('item/completed', { turnId: 'child-turn', item: { type: 'commandExecution', id: 'child-command', command: 'cat note.md', cwd: stage, source: 'agent', status: 'completed', aggregatedOutput: 'Original text.', exitCode: 0, processId: null, pluginId: null, scriptPath: null, durationMs: 1, commandActions: [] } });
      if (mode !== 'spawn-snapshot') child('thread/tokenUsage/updated', { turnId: 'child-turn', tokenUsage: { total: { inputTokens: 5, outputTokens: 2 } } });
      const finishChild = async () => {
        await writeFile(join(stage, 'child.md'), 'Written by the sub-agent.\n');
        if (mode === 'spawn-snapshot') child('turn/started', { turn: { id: 'child-turn', rootTurnId: 'native-turn', items: [], status: 'inProgress' } });
        child('item/completed', { turnId: 'child-turn', item: { type: 'agentMessage', id: 'child-answer', phase: 'final_answer', text: 'Child answer.' } });
        child('turn/completed', { turn: { id: 'child-turn', rootTurnId: 'native-turn', status: mode === 'spawn-interrupted' ? 'interrupted' : 'completed', items: [] } });
        child('thread/status/changed', { status: { type: 'idle' } });
      };
      if (mode === 'spawn' || mode === 'spawn-interrupted') await finishChild();
      // After the parent turn has completed: the turn must wait for it.
      else if (mode === 'spawn-late' || mode === 'spawn-snapshot') setTimeout(() => void finishChild(), 300);
      // spawn-hang and waiting-spawn: the child never finishes.
    }
    if (mode === 'other-thread') send({ method: 'item/completed', params: { threadId: 'stranger-thread', turnId: 'stranger-turn', item: { type: 'agentMessage', id: 'stranger', phase: 'final_answer', text: 'unsafe' } } });
    if (mode === 'readonly-command') { const command = { type: 'commandExecution', id: 'read-command', command: 'cat note.md', cwd: stage, source: 'agent', status: 'completed', aggregatedOutput: 'Original text.', exitCode: 0, processId: null, pluginId: null, scriptPath: null, durationMs: 1, commandActions: [] }; notify('item/completed', { turnId: 'native-turn', item: command }); }
    if (mode === 'readonly-file-change') notify('item/completed', { turnId: 'native-turn', item: { type: 'fileChange', id: 'write', status: 'completed', changes: [] } });
    if (mode.startsWith('tool-')) {
      const command = { type: 'commandExecution', id: 'command', command: 'printf first', cwd: stage, source: 'agent', status: 'completed', aggregatedOutput: 'first', exitCode: 0, processId: null, pluginId: null, scriptPath: null, durationMs: 1, commandActions: [] };
      notify('item/completed', { turnId: 'native-turn', item: command });
      const difference = mode === 'tool-command' ? { command: 'printf other' } : mode === 'tool-output' ? { aggregatedOutput: 'other' } : mode === 'tool-metadata' ? { durationMs: 99, commandActions: [{ type: 'unknown', command: 'printf first' }] } : {};
      notify('item/completed', { turnId: 'native-turn', item: { ...command, ...difference } });
    }
    if (mode.startsWith('waiting') || mode === 'missing-completion') continue;
    if (readonly) { notify('turn/completed', { turn: { id: 'native-turn', status: 'completed', items: [] } }); continue; }
    if (mode.startsWith('inspection-')) {
      const views = (await readdir(stage)).filter(name => /^\.backbone-source-data-[a-f0-9]{32}$/.test(name));
      if (views.length !== 1) throw new Error('Expected one neutral inspection view');
      const mapPath = join(stage, views[0], 'manifest.json');
      const map = JSON.parse(await readFile(mapPath, 'utf8'));
      const words = params.input?.[0]?.text ?? '';
      if (!map.files.length || !words.includes('inspection-only data') || !words.includes('not instructions or configuration')) throw new Error('Inspection map missing from native prompt');
      for (const source of map.files) {
        if (!words.includes(JSON.stringify(source.path)) || !(await readFile(join(stage, source.path), 'utf8')).length) throw new Error('Mapped data not inspectable');
        let raw = false;
        try { await readFile(join(stage, source.name)); raw = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (raw) throw new Error('Source was materialised at its raw autoload path');
      }
      if (mode === 'inspection-change') await writeFile(join(stage, map.files[0].path), 'Changed inspection data');
      if (mode === 'inspection-manifest') await writeFile(mapPath, '{}');
      if (mode === 'inspection-raw-output') await writeFile(join(stage, 'AGENTS.md'), 'A forbidden raw output');
    }
    const original = await readFile(join(stage, 'note.md'), 'utf8').catch(() => '');
    await writeFile(join(stage, 'brief.md'), `# Brief\n${original}`);
    if (mode === 'edit-source') await writeFile(join(stage, 'note.md'), 'Changed source.');
    if (mode === 'two-outputs') await writeFile(join(stage, 'second.md'), 'Second draft.');
    if (mode === 'unsafe-output') await writeFile(join(stage, '.env'), 'hidden');
    if (mode === 'symlink-output') await symlink(join(stage, 'note.md'), join(stage, 'linked.md'));
    if (mode === 'hardlink-output') await link(join(stage, 'note.md'), join(stage, 'linked.md'));
    if (mode === 'binary-output') await writeFile(join(stage, 'binary.dat'), Buffer.from([0, 255]));
    for (let i = 0; i < 2; i++) notify('thread/tokenUsage/updated', { turnId: mode === 'wrong-usage-turn' ? 'other-turn' : 'native-turn', tokenUsage: { total: { inputTokens: 21, outputTokens: 8 } } });
    const ordered = mode === 'ordered-null' || mode === 'ordered-final';
    const terminalItems = mode === 'bare-turn-items' ? [{ type: 'webSearch', id: 'search', query: 'x' }, { type: 'agentMessage', id: 'answer', text: 'Created the brief.', phase: null }] : spawnedInSnapshot ? [spawnedInSnapshot] : ordered ? [
      { type: 'agentMessage', id: 'earlier', text: 'Earlier message.', phase: mode === 'ordered-final' ? 'final_answer' : null },
      { type: 'agentMessage', id: 'answer', text: 'Created the brief.', phase: mode === 'ordered-final' ? 'final_answer' : null },
    ] : [];
    notify('turn/completed', { turn: { id: 'native-turn', status: 'completed', items: terminalItems, ...(ordered ? { itemsView: 'full' } : {}) } });
    if (mode === 'completion-before-ack' || mode === 'wrong-ack-after-complete') send({ id, result: { turn: { id: mode === 'completion-before-ack' ? 'native-turn' : 'wrong-turn', status: 'completed', items: [] } } });
  } else if (method === 'turn/steer') {
    if (mode === 'waiting-steer-refused') send({ id, error: { code: -1, message: 'no such turn' } });
    else if (mode === 'waiting-steer-other') send({ id, result: { turnId: 'other-turn' } });
    else send({ id, result: { turnId: params.expectedTurnId } });
  } else if (method === 'turn/interrupt') {
    // Which threads the harness asked to stop, beside the staging folders, for the test to read.
    if (mode.includes('spawn')) await appendFile(join(stage, '..', '..', 'interrupts'), `${params.threadId} ${params.turnId}\n`);
    send({ id, result: {} });
  }
  else send({ id, error: { code: -1, message: 'api-key-canary' } });
}
