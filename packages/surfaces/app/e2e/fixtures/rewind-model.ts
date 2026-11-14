import type { Message, Step } from '@backbone-next/platform/testing';

export function rewindStep(messages: Message[]): Step {
  const start = messages.findLastIndex(message => message.role === 'user');
  const content = messages[start]?.content;
  const text = typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('');
  if (text.includes('Continue after rewind')) return { text: JSON.stringify(messages).includes('Write stage two') ? 'Discarded history leaked' : 'Continued from stage one' };
  const calls = messages.slice(start + 1).flatMap(message => message.tool_calls ?? []).map(call => ({ name: call.function.name, args: JSON.parse(call.function.arguments) as { name?: string } }));
  const second = text.includes('stage two');
  const files = second ? { 'brief.md': 'Brief two', 'clean.md': 'Clean two', 'new.md': 'New file' } : { 'brief.md': 'Brief one', 'clean.md': 'Clean one' };
  if (!calls.some(call => call.name === 'list_files')) return { calls: [{ name: 'list_files', args: {} }] };
  for (const [name, body] of Object.entries(files)) {
    if (second && name !== 'new.md' && !calls.some(call => call.name === 'read_file' && call.args.name === name)) return { calls: [{ name: 'read_file', args: { name } }] };
    if (!calls.some(call => call.name === 'write_file' && call.args.name === name)) return { calls: [{ name: 'write_file', args: { name, content: body } }] };
  }
  return { text: second ? 'Stage two finished' : 'Stage one finished' };
}
