#!/usr/bin/env node
// A stand-in for Claude Code's `claude mcp add|remove -s user`, for tests that must never touch the
// real settings. It records its argv and edits the user settings file the way Claude Code 2.1.310
// does: $CLAUDE_CONFIG_DIR/.claude.json (or $HOME/.claude.json), two-space JSON with no final newline;
// an existing name is refused, a missing one on remove is an error.
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
if (process.env.FAKE_TOOLS_LOG) fs.appendFileSync(process.env.FAKE_TOOLS_LOG, `${JSON.stringify({ tool: 'claude', argv, at: new Date().toISOString() })}\n`);
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
if (process.env.FAKE_FAIL && argv.join(' ').startsWith(process.env.FAKE_FAIL)) fail('fake failure');
const file = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(process.env.HOME, '.claude.json');
const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
const store = (o) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(o, null, 2));
};

if (argv[0] !== 'mcp') fail('fake claude: only mcp');
const [, sub, ...rest] = argv;
let scope = 'local';
const env = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--') {
    positional.push(...rest.slice(i + 1));
    break;
  }
  if (a === '-s' || a === '--scope') scope = rest[++i];
  else if (a === '-e' || a === '--env') {
    while (rest[i + 1] !== undefined && !rest[i + 1].startsWith('-')) {
      const [k, ...v] = rest[++i].split('=');
      env[k] = v.join('=');
    }
  } else if (a.startsWith('-')) fail(`fake claude: unknown option ${a}`);
  else positional.push(a);
}
if (scope !== 'user') fail('fake claude: this stand-in knows the user scope only');
const settings = load();
if (sub === 'add') {
  const [name, command, ...args] = positional;
  settings.mcpServers ??= {};
  if (settings.mcpServers[name]) fail(`MCP server ${name} already exists in user config`);
  settings.mcpServers[name] = { type: 'stdio', command, args, env };
  store(settings);
  process.stdout.write(`Added stdio MCP server ${name} with command: ${command} ${args.join(' ')} to user config\n`);
} else if (sub === 'remove') {
  const [name] = positional;
  if (!settings.mcpServers?.[name]) fail(`No MCP server named "${name}" in user scope`);
  delete settings.mcpServers[name];
  store(settings);
  process.stdout.write(`Removed MCP server ${name} from user config\n`);
} else fail(`fake claude: no ${sub}`);
