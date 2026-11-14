import type { Message, Step } from '@backbone-next/platform/testing';

/** One fixture drives both development and installed apps through the same model API. */
export function longConversationStep(messages: Message[]): Step {
  if (JSON.stringify(messages).includes('<conversation>')) return { text: 'The ledger decision is amber. Keep the original evidence.' };
  const asked = messages.findLast(message => message.role === 'user');
  // Pi's OpenAI-compatible request uses text-part arrays as well as plain strings. String(array)
  // loses the request as "[object Object]" and incorrectly grows the ledger on the final turn.
  const text = typeof asked?.content === 'string' ? asked.content : (asked?.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('');
  return { text: text.includes('Continue after compaction') ? 'Continued using the amber decision.' : `The ledger decision is amber.\n${'Ledger evidence remains readable. '.repeat(1500)}` };
}
