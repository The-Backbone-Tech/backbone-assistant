// Optional Host tools travel over the same acknowledged dynamic-tool channel as connectors.
import { HOST_TOOLS, offeredHostTools, workspaceExecution, workspaceFailure, type WorkspaceExecution, type HostToolName, type ToolHost } from '@backbone-next/platform/ports';
import type { ObjectValue } from './native.ts';

export function codexHostTools(host: ToolHost) {
  return offeredHostTools(host).map(name => ({ type: 'function' as const, name, description: HOST_TOOLS[name].description, inputSchema: HOST_TOOLS[name].inputSchema }));
}
const said = (text: string, success = true): ObjectValue => ({ contentItems: [{ type: 'inputText', text }], success });

export async function carryCodexHostTool(host: ToolHost, name: HostToolName, params: ObjectValue, signal: AbortSignal, recordWorkspace?: (result: WorkspaceExecution) => void): Promise<ObjectValue | null> {
  if (signal.aborted || !offeredHostTools(host).includes(name)) return null;
  const schema = HOST_TOOLS[name].inputSchema;
  const args = params.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return said('Invalid tool arguments: expected an object.', false);
  const values = args as Record<string, unknown>;
  for (const [key, rule] of Object.entries(schema.properties)) {
    const value = values[key];
    if (value === undefined && !(schema.required as readonly string[]).includes(key)) continue;
    if (typeof value !== 'string' || ('maxLength' in rule && typeof rule.maxLength === 'number' && [...value].length > rule.maxLength)) return said(`Invalid tool arguments: ${key} must be text${'maxLength' in rule ? ` of at most ${rule.maxLength} characters` : ''}.`, false);
  }
  try {
    // Await the Host directly: it records the turn's reads before their words come back.
    // No cache, background dispatch or rewriting of memory answers belongs here.
    let result: ObjectValue;
    switch (name) {
      case 'workspace_run': {
        recordWorkspace?.(workspaceExecution());
        const text = await host.runWorkspace!({ command: values.command as string, ...(values.attachment === undefined ? {} : { attachment: values.attachment as string }) }, signal);
        const execution = workspaceExecution(text); recordWorkspace?.(execution);
        result = said(text, execution.phase === 'done'); break;
      }
      case 'memory_search': result = said(await host.searchMemory!(values.query as string)); break;
      case 'propose_memory': result = said(await host.proposeMemory!({ text: values.text as string, ...(values.topic === undefined ? {} : { topic: values.topic as string }) })); break;
      case 'propose_goal': await host.proposeGoal!(values.text as string); result = said('Proposed. The goal stands until the person decides.'); break;
      case 'message_card': {
        const r = await host.messageCard!({ card: values.card as string, text: values.text as string });
        result = r.outcome === 'SENT' ? said(`Sent to card ${values.card} (${r.state}).`) : said(`${r.reason}: ${r.detail}`, false);
        break;
      }
    }
    return signal.aborted ? null : result;
  } catch (error) {
    if (name === 'workspace_run') recordWorkspace?.(workspaceFailure(signal.aborted ? undefined : error));
    // A Host exception is a tool error, not a new instruction or a reason to retry.
    return signal.aborted ? null : said('Host refused the tool call or could not return its result.', false);
  }
}
