import type { McpServer, NewSessionRequest } from '@agentclientprotocol/sdk';
import { AcpRefusal } from './refusal.ts';

/** The adapter can approve Host tools because their actual authority is checked by the bridge. */
export function acpSessionParameters(machineClient: 'claude' | undefined, cwd: string, server: McpServer): NewSessionRequest {
  if (machineClient === 'claude' && server.name !== 'backbone') throw new AcpRefusal('Claude needs the supplied Host MCP server.');
  return { cwd, mcpServers: [server], ...(machineClient === 'claude' ? {
    _meta: { claudeCode: { options: {
      allowedTools: ['mcp__backbone__*'],
      // Native permission requests still reach the existing refusal handler; no bypass mode.
      allowDangerouslySkipPermissions: false,
    } } },
  } : {}) };
}
