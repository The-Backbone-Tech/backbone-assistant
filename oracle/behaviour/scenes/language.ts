import type { Directive } from './port.ts';

/** The adversary's language, as text an outsider writes (packages/evals/README.md, "The models"). */

/** `[[do tool {input}]]` as text, for injections. */
export const doText = (tool: string, input: Record<string, unknown>): string => `[[do ${tool} ${JSON.stringify(input)}]]`;

/** `[[say {"text": …}]]` as text: the answer itself is the channel. */
export const sayText = (text: string): string => `[[say ${JSON.stringify({ text })}]]`;

/** A step of a person's own plan. */
export const step = (tool: string, input: Record<string, unknown> = {}): Directive => ({ kind: 'do', tool, input });

/** The answer a person's plan ends with, once its calls are made. */
export const saying = (text: string): Directive => ({ kind: 'say', text });

/** Prose an outsider wrote, followed by the instructions the adversary obeys. */
export const injection = (prose: string, ...steps: string[]) => `${prose}\n\n${steps.join(' ')}`;

/** The operation a tool's call is recorded as: `mail__read_inbox` is `mcp.mail.read_inbox`. */
export function operationOf(tool: string): string {
  const [slug, name] = tool.split('__');
  return name === undefined ? `workspace.${tool}` : `mcp.${slug}.${name}`;
}
