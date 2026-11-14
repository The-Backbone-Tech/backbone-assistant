// The scripted model's triage steps, for tests and journeys: it reads the one message the job
// offers, decides by fixed keyword rules, and writes the triage note. It proves the plumbing (the
// harness, the job, the gateway, the brief), not judgement: its rules were written beside the
// fixture, so its accuracy on that fixture is a regression floor, never a quality claim.
import type { Message, Step } from './scripted-model.ts';

export const TRIAGE_REQUEST = /\nTriage (message-[\w.-]+\.eml)\.(?:\n\nAttached: [^\n]*)?\s*$/;

const text = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
const has = (s: string, ...words: (string | RegExp)[]) => words.some((w) => (typeof w === 'string' ? s.toLowerCase().includes(w.toLowerCase()) : w.test(s)));

interface Parsed {
  from: { name: string; address: string };
  replyTo?: { name: string; address: string };
  subject: string;
  body: string;
}

function address(v: string) {
  const m = /^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/.exec(v.trim());
  return m ? { name: (m[1] ?? '').trim(), address: m[2] } : { name: '', address: v.trim() };
}

function parse(raw: string): Parsed {
  const [head, ...rest] = raw.split('\n\n');
  const h: Record<string, string> = {};
  for (const line of head.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).toLowerCase()] ??= line.slice(i + 1).trim();
  }
  return { from: address(h.from ?? ''), replyTo: h['reply-to'] ? address(h['reply-to']) : undefined, subject: h.subject ?? '', body: rest.join('\n\n') };
}

/** The requester: the original asker of a forward, the submitter of a form, else Reply-To or From. */
function requester(p: Parsed) {
  const fwd = /Forwarded message[\s\S]*?\nFrom:\s*([^\n]+)/i.exec(p.body);
  if (fwd) return address(fwd[1]);
  const form = /\nName:\s*([^\n]+)\nEmail:\s*(\S+)/.exec(`\n${p.body}`);
  if (form) return { name: form[1].trim(), address: form[2].trim() };
  return p.replyTo ?? p.from;
}

export function triageNote(raw: string): string {
  const p = parse(raw);
  const all = `${p.subject}\n${p.body}`;
  const es = has(all, /\b(hola|gracias|factura|reunión|mañana|saludo|necesito|podéis|buenos días|estimado)\b/i);
  const automated = has(p.from.address, /^(no-?reply|notifications?|alerts?|avisos|deploys|billing|boletin)@/i) || has(all, 'automatic reply', 'no responda', 'este es un mensaje automático');
  const bulk = has(all, 'unsubscribe', 'darte de baja', 'email preferences', 'you are receiving this');
  const suspicious = has(all, /\bAI assistant\b/i, /verify your (account|credentials)/i, /claim your (prize|bonus)/i, 'free spins', /nueva pasarela/i);
  const spam = suspicious && !has(all, 'IBAN', 'open invoice');
  let category = 'internal';
  if (spam) category = 'spam';
  else if (automated && !bulk) category = 'notification';
  else if (bulk) category = 'newsletter';
  else if (has(all, /\b(502|error|wrong vat|no carga|not loading|broken|charged 23%)\b/i)) category = 'support';
  else if (has(all, /\b(invoice|factura|refund|payment|IBAN|paid|cobro|facturas)\b/i)) category = 'billing';
  else if (has(all, /\b(NDA|RGPD|GDPR|art\. 15|contract|security incident|legal)\b/i)) category = 'legal';
  else if (has(all, /\b(quote|presupuesto|proposal|redesign|subcontract|shopify|online ordering|budget)\b/i)) category = 'sales';
  else if (has(all, /\b(meeting|reunión|kickoff|sprint review|reschedul|cancelar)\b/i)) category = 'scheduling';
  else if (has(all, /\b(candidatura|application|CV|portfolio|entrevista)\b/i)) category = 'hiring';
  else if (has(all, /\b(renewal|policy|premium|developers available)\b/i)) category = 'vendor';
  else if (has(all, /\b(brand|logo|menu|workshop|launch|guidelines|migration)\b/i)) category = 'project';
  const urgency = ['spam', 'newsletter'].includes(category) || has(all, 'thank you', 'gracias por', 'FYI')
    ? 'low'
    : has(all, /\b(today|hoy|ya\?|before 12|antes de las|right now|this morning)\b/i) && category === 'support'
      ? 'urgent'
      : has(all, /\b(tomorrow|mañana|wednesday|thursday|friday|viernes|jueves|by \w+day|3 days|7 days|overdue|vencid|bank details|72 hours)\b/i)
        ? 'high'
        : category === 'notification' ? 'low' : 'normal';
  const label = { spam: 'none', notification: 'Notifications', newsletter: 'Newsletters', support: 'Support', billing: 'Billing', legal: 'Legal', sales: 'Sales', scheduling: 'Scheduling', hiring: 'Hiring', vendor: 'Vendors', project: 'Projects', internal: 'Team' }[category];
  const move = category === 'spam' ? 'Spam' : ['notification', 'newsletter'].includes(category) ? 'Archive' : 'none';
  const who = requester(p);
  const first = who.name.split(/\s+/)[0] || '';
  const needsReply = !['spam', 'notification', 'newsletter'].includes(category) && !suspicious && !has(all, 'FYI', 'thanks jonas', 'go ahead with', 'facturación');
  const reply = !needsReply
    ? 'none'
    : es
      ? `Hola ${first}:\n\nGracias por tu mensaje sobre «${p.subject}». Lo revisamos y te respondemos en breve.\n\nUn saludo,\nMarta`
      : `Hi ${first},\n\nThanks for your message about "${p.subject}". We're looking into it and will get back to you shortly.\n\nBest,\nMarta`;
  return [
    `requester: ${who.name ? `${who.name} <${who.address}>` : who.address}`,
    `category: ${category}`,
    `urgency: ${urgency}`,
    `label: ${label}`,
    `move: ${move}`,
    `suspicious: ${suspicious ? 'yes' : 'no'}`,
    `reason: scripted rules`,
    'reply:',
    reply,
  ].join('\n');
}

/** The next step of a triage turn: read the message, then write the note, then say so. */
export function triageStep(messages: Message[], file: string): Step {
  const start = messages.findLastIndex((m) => m.role === 'user');
  const calls = new Map<string, { name: string; result: string }>();
  for (const m of messages.slice(start + 1)) {
    for (const c of m.tool_calls ?? []) calls.set(c.id, { name: c.function.name, result: '' });
    if (m.role === 'tool' && m.tool_call_id && calls.has(m.tool_call_id)) calls.get(m.tool_call_id)!.result = text(m);
  }
  const done = [...calls.values()];
  const wrote = done.find((d) => d.name === 'write_file');
  if (wrote) return { text: wrote.result.startsWith('Wrote') ? 'Noted.' : `The note was refused: ${wrote.result}` };
  const read = done.find((d) => d.name === 'read_file');
  if (!read) return { calls: [{ name: 'read_file', args: { name: file } }] };
  const raw = read.result.split('\n\n').slice(1).join('\n\n');
  return { calls: [{ name: 'write_file', args: { name: 'triage-note.md', content: triageNote(raw) } }] };
}
