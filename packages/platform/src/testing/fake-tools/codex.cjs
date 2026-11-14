#!/usr/bin/env node
// A stand-in for `codex mcp add|remove|get`, for tests that must never touch the real settings. It
// records its argv and edits $CODEX_HOME/config.toml (or $HOME/.codex/config.toml) the way Codex
// 0.162.1 was seen to: a new server's tables go after the last [mcp_servers.*] table (or at the end),
// an existing name is overwritten silently, remove restores the file byte for byte, an unknown
// approval mode or a line it cannot parse fails every command with "failed to load configuration".
// Like a TOML parser, it never takes a line inside a multiline string for a table or a key.
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
if (process.env.FAKE_TOOLS_LOG) fs.appendFileSync(process.env.FAKE_TOOLS_LOG, `${JSON.stringify({ tool: 'codex', argv, at: new Date().toISOString() })}\n`);
const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
if (process.env.FAKE_FAIL && argv.join(' ').startsWith(process.env.FAKE_FAIL)) fail('fake failure');
const file = path.join(process.env.CODEX_HOME || path.join(process.env.HOME, '.codex'), 'config.toml');
let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

const looksLikeHeader = (l) => /^\s*\[[^\]]+\]\s*(#.*)?$/.test(l);
const tableOf = (l) => /^\s*\[\s*([^\]]+?)\s*\]/.exec(l)[1];
/** Which lines are inside a multiline string ("\"\"\"" or '''), its closing line included. */
function inStrings(lines) {
  const out = [];
  let open = null;
  for (const line of lines) {
    if (open) {
      out.push(true);
      if (line.includes(open)) open = null;
      continue;
    }
    out.push(false);
    const m = /=\s*("{3}|'{3})/.exec(line);
    if (m && line.indexOf(m[1], m.index + m[0].length) < 0) open = m[1];
  }
  return out;
}
/** Each line with whether it is a real table header. */
const headers = (lines) => {
  const s = inStrings(lines);
  return lines.map((l, i) => !s[i] && looksLikeHeader(l));
};
const textLines = text.split('\n');
const quoted = inStrings(textLines);
for (const [i, line] of textLines.entries()) {
  if (quoted[i]) continue;
  const t = line.trim();
  const isHeader = looksLikeHeader;
  if (t === '' || t.startsWith('#') || isHeader(t) || /^[A-Za-z0-9_."-]+\s*=\s*\S/.test(t)) {
    const mode = /^default_tools_approval_mode\s*=\s*"([^"]*)"/.exec(t);
    if (mode && !['auto', 'prompt', 'writes', 'approve'].includes(mode[1])) fail(`Error: failed to load configuration\n\nCaused by:\n    unknown variant \`${mode[1]}\``);
    continue;
  }
  fail('Error: failed to load configuration');
}

/** The line range of a server's tables: from its header to the next other table, or the end. */
function region(name) {
  const lines = text.split('\n');
  const real = headers(lines);
  const mine = (i) => real[i] && (tableOf(lines[i]) === `mcp_servers.${name}` || tableOf(lines[i]).startsWith(`mcp_servers.${name}.`));
  const start = lines.findIndex((_, i) => mine(i));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !(real[end] && !mine(end))) end++;
  return { lines, start, end };
}
function removeServer(name) {
  const r = region(name);
  if (!r) return false;
  const { lines, start, end } = r;
  // Appended at the end after a blank line; otherwise followed by one.
  if (end === lines.length) lines.splice(Math.max(start - 1, 0), end - Math.max(start - 1, 0), '');
  else lines.splice(start, end - start);
  text = lines.join('\n');
  return true;
}
const save = () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
};

if (argv[0] !== 'mcp') fail('fake codex: only mcp');
const [, sub, ...rest] = argv;
if (sub === 'add') {
  const env = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (rest[i] === '--env') {
      const [k, ...v] = rest[++i].split('=');
      env[k] = v.join('=');
    } else if (rest[i].startsWith('-')) fail(`fake codex: unknown option ${rest[i]}`);
    else positional.push(rest[i]);
  }
  const [name, command, ...args] = positional;
  removeServer(name);
  let block = `[mcp_servers.${name}]\ncommand = ${JSON.stringify(command)}\nargs = [${args.map((a) => JSON.stringify(a)).join(', ')}]\n`;
  if (Object.keys(env).length) block += `\n[mcp_servers.${name}.env]\n${Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n')}\n`;
  const lines = text.split('\n');
  const real = headers(lines);
  let last = -1;
  lines.forEach((l, i) => real[i] && tableOf(l).startsWith('mcp_servers.') && (last = i));
  const next = last < 0 ? -1 : lines.findIndex((_, i) => i > last && real[i]);
  if (next < 0) text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${block}`;
  else text = [...lines.slice(0, next), ...`${block}`.split('\n'), ...lines.slice(next)].join('\n');
  save();
  process.stdout.write(`Added global MCP server '${name}'.\n`);
} else if (sub === 'remove') {
  const [name] = rest;
  if (removeServer(name)) {
    save();
    process.stdout.write(`Removed global MCP server '${name}'.\n`);
  } else process.stdout.write(`No MCP server named '${name}' found.\n`);
} else if (sub === 'get') {
  const [name] = rest;
  const r = region(name);
  if (!r) fail(`Error: No MCP server named '${name}' found.`);
  const transport = { type: 'stdio', command: null, args: [], env: {}, env_vars: [], cwd: null };
  let table = '';
  for (const l of r.lines.slice(r.start, r.end)) {
    if (looksLikeHeader(l)) table = tableOf(l);
    const kv = /^\s*([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(l);
    if (!kv) continue;
    if (table.endsWith('.env')) transport.env[kv[1]] = JSON.parse(kv[2]);
    else if (kv[1] === 'command') transport.command = JSON.parse(kv[2]);
    else if (kv[1] === 'args') transport.args = JSON.parse(kv[2]);
  }
  process.stdout.write(`${JSON.stringify({ name, enabled: true, transport }, null, 2)}\n`);
} else fail(`fake codex: no ${sub}`);
