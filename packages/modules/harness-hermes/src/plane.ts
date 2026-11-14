// What goes into a Hermes home so the gate is in force: the plugin, its private settings and a
// config that enables it, with Hermes's own memory, skills and task list on, its auxiliary tasks off, and nothing that leaves the plane. It writes no shell hook: Hermes's shell hook fails open by default. The
// home belongs in a contained plane; this only lays out files and installs nothing.
import { chmod, cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_TOOLSETS } from './gate.ts';

export interface PlaneOptions {
  /** Where the plugin reaches the gate, as seen from inside the plane. */
  gateUrl: string;
  gateToken: string;
  /** The keyless local model endpoint Hermes calls. */
  modelBaseUrl: string;
  model: string;
  /** Hermes's budget for one hook callback, in seconds; it blocks when this runs out. */
  hookTimeoutSeconds?: number;
  /** The plugin's own socket deadline for one decision; shorter than the hook budget. */
  decideTimeoutSeconds?: number;
  /** The door's deadline; a write that outlives it is UNKNOWN. */
  callTimeoutSeconds?: number;
}

const PLUGIN = fileURLToPath(new URL('../plugin/host_gate', import.meta.url));

export async function writePlane(home: string, options: PlaneOptions): Promise<void> {
  const { gateUrl, gateToken, hookTimeoutSeconds = 8, decideTimeoutSeconds = 5, callTimeoutSeconds = 300 } = options;
  const dir = join(home, 'plugins', 'host_gate');
  await mkdir(join(home, 'plugins'), { recursive: true });
  await cp(PLUGIN, dir, { recursive: true });
  const gate = join(dir, 'gate.json');
  await writeFile(gate, JSON.stringify({ url: gateUrl, token: gateToken, decide_timeout_seconds: decideTimeoutSeconds, call_timeout_seconds: callTimeoutSeconds }), { mode: 0o600 });
  await chmod(gate, 0o600);
  await writeFile(
    join(home, 'config.yaml'),
    [
      '_config_version: 51',
      'model:',
      '  provider: custom',
      `  default: ${JSON.stringify(options.model)}`,
      `  base_url: ${JSON.stringify(options.modelBaseUrl)}`,
      '  context_length: 200000',
      'plugins:',
      '  enabled:',
      '    - host_gate',
      `  hook_callback_timeout: ${hookTimeoutSeconds}`,
      // The doors, and Hermes's own toolsets that act only on this home. Every other native toolset is off
      // at Hermes itself, so a failed hook leaves nothing beyond the plane to reach.
      'platform_toolsets:',
      '  api_server:',
      '    - door',
      ...Object.keys(NATIVE_TOOLSETS).map((name) => `    - ${name}`),
      // Built-in memory only: an external provider would send it out. Skills run no shell and load from this home only.
      'memory:',
      '  memory_enabled: true',
      '  user_profile_enabled: true',
      '  provider: ""',
      '  nudge_interval: 0',
      // Hermes's auxiliary tasks reach a route of their own, which is not pinned to this plane's model: off.
      'auxiliary:',
      '  background_review:',
      '    enabled: false',
      '  title_generation:',
      '    enabled: false',
      'compression:',
      '  enabled: false',
      'skills:',
      '  external_dirs: []',
      '  inline_shell: false',
      // No MCP server: each could act on the person's accounts or the outside world.
      'mcp_servers: {}',
      // Hermes defers plugin tools behind its tool_search bridge by default; the door tools must be offered.
      'tools:',
      '  tool_search:',
      '    enabled: "off"',
      '',
    ].join('\n'),
  );
}
