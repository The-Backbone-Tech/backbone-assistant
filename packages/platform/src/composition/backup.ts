import { unknownChecked } from './unknown-checks.ts';
// Export and import of a person's work, in plain files they can read.
//
// Export (exit) writes what the person made: each project with every version of each document, each
// chat as history (JSON and markdown), memory, skills, the names and commands of their own MCP
// servers, and a read-only report of every receipt in history/, where an UNKNOWN or held effect is
// listed as unresolved when exported. It holds no database row and no authority: no grant, door,
// mandate, session, queue, claim, hash or lineage. Every value in the home's credential store is cut
// out of every string before anything is serialised, and out of every document's bytes; files and
// folders are named by number only, so no name carries one; a value too short to cut out reliably
// refuses the export, and so does a file with a second name on disk (a hard link). Free text the
// person wrote is exported as they wrote it, and the README says so.
//
// Import (restore) goes only into a new, empty home, under that home's lock for the whole import,
// through the host's own methods, as the person would add the work: projects created, documents added
// with their versions, chats and the receipts report added as read-only documents, memory lines
// added, skills proposed for the person to accept. It reads every file of the export once, into
// memory, while it checks it, and uses only those bytes. Nothing is written as the database's
// installer and no table is written, so nothing in the history can be claimed, observed, sent or
// released. The home it came from is never touched; the person switches homes themselves.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Args, HomeExport, MaterialEntry, MemoryImportResult, Method, PickedFolder, Receipt as ApiReceipt, RefusalReason, Result, Skill, Turn } from '../api.ts';
import { canonicalHome } from '../doors/protocol.ts';
import { documentPathCollision, isPersonSource, managedPathProblem, sourcePathProblem, type MaterialImport } from '../stub/material.ts';
import { isIntermediate } from '../stub/fsx.ts';
import { anchoredRoot, readInside } from '../memory/safe-read.ts';
import { parseAgentRole } from '../memory/agent-roles.ts';
import type { StoredThread } from './thread-journal.ts';

export const EXPORT_FORMAT = 'home-export';
export const EXPORT_VERSION = 4;
const LEGACY_EXPORT_VERSION = 3;
export const MANIFEST = 'manifest.json';
const README = 'README.md';
/** What stands in for each credential cut out of an exported string or file. */
export const SCRUBBED = '[left out: a credential]';
/** The shortest credential that can be cut out reliably. */
const SHORTEST = 4;
/** Every folder and file an export may hold, by exact name and case. Any other path refuses it. */
const FOLDERS = [/^(projects|threads|memory|skills|roles|history|connectors)$/, /^projects\/p\d{3,}$/, /^projects\/p\d{3,}\/documents$/, /^projects\/p\d{3,}\/documents\/d\d{3,}$/, /^memory\/(topics|daily|projects)$/, /^skills\/s\d{3,}$/];
const FILES = [/^(README\.md|manifest\.json)$/, /^projects\/p\d{3,}\/project\.json$/, /^projects\/p\d{3,}\/documents\/d\d{3,}\/(meta\.json|v\d+)$/, /^threads\/t\d{3,}\.(json|md)$/, /^memory\/instructions\.md$/, /^memory\/(topics|daily)\/m\d{3,}\.md$/, /^memory\/projects\/p\d{3,}\.md$/, /^skills\/s\d{3,}\/(SKILL\.md|skill\.json)$/, /^roles\/r\d{3,}\.md$/, /^history\/receipts\.(md|json)$/, /^connectors\/servers\.json$/];
/** What an import reads into memory at most. */
export const IMPORT_CAP = 512 * 1024 * 1024;
const RESTORED_PROJECT = 'Restored history';

/** An import cannot complete; `reason` is the api's. */
export class BackupRefused extends Error {
  readonly reason: RefusalReason;
  /** True once an import had begun writing: the new data folder may hold part of the export. False for every refusal that came before the first write. */
  partial = false;
  /** True when a write's outcome could not be established, so the new data folder may hold it or not. */
  unknown = false;
  constructor(reason: RefusalReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Never in an export, in the words the export carries. */
export const EXCLUDED: HomeExport['excluded'] = [
  { what: 'Credentials and keys', why: 'The vault, sealed model and connector keys, the database and its passwords. Every value the credential store holds is also cut out of every exported string, name and file.' },
  { what: 'Authority', why: 'No grant, door, mandate, session, queue, claim or receipt lineage. Grant again, in the new data folder, what should run.' },
  { what: 'The database', why: 'No row of it. The receipts are in history/ as a report to read.' },
  { what: 'Connected servers\' settings', why: 'Only each server\'s name and command: no environment value, header, argument or address. Set them up again.' },
  { what: 'This computer\'s state', why: 'Who holds the data folder, AI tool connections, schedules, triggers, goal runs, queued messages, logs and app storage.' },
];

/** A file of the home, read once, refused if it has a second name on disk or is not a plain file. */
function readOwn(path: string, rel: string): Buffer {
  const st = lstatSync(path);
  if (!st.isFile()) throw new BackupRefused('INVALID', `${rel} is not a plain file, so nothing was exported.`);
  if (st.nlink > 1) throw new BackupRefused('INVALID', `${rel} has another name on disk (a hard link), so nothing was exported: it could be a credential under another name.`);
  return readFileSync(path);
}
const readOwnIf = (path: string, rel: string) => (existsSync(path) ? readOwn(path, rel) : null);

/** Cuts every known credential out of strings and bytes, counting each. */
class Scrubber {
  n = 0;
  private readonly secrets: string[];
  constructor(secrets: readonly string[]) {
    const known = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length > 0))];
    if (known.some((s) => s.length < SHORTEST)) throw new BackupRefused('INVALID', `A credential the app holds is shorter than ${SHORTEST} characters. A secret that short cannot be cut out of an export reliably, so nothing was exported. Replace it with a longer one, or remove it, then export again.`);
    this.secrets = known.sort((a, b) => b.length - a.length);
  }
  text(s: string): string {
    let out = s;
    for (const secret of this.secrets) if (out.includes(secret)) { this.n += out.split(secret).length - 1; out = out.split(secret).join(SCRUBBED); }
    return out;
  }
  /** Every string of a value, keys included, cut before it is serialised. */
  value<T>(v: T): T {
    if (typeof v === 'string') return this.text(v) as T;
    if (Array.isArray(v)) return v.map((x) => this.value(x)) as T;
    if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [this.text(k), this.value(x)])) as T;
    return v;
  }
  bytes(data: Buffer): Buffer {
    let out = data;
    for (const secret of this.secrets) {
      const needle = Buffer.from(secret);
      let at = out.indexOf(needle);
      if (at < 0) continue;
      const parts: Buffer[] = [];
      let from = 0;
      while (at >= 0) { parts.push(out.subarray(from, at), Buffer.from(SCRUBBED)); this.n++; from = at + needle.length; at = out.indexOf(needle, from); }
      parts.push(out.subarray(from));
      out = Buffer.concat(parts);
    }
    return out;
  }
  /** Whether bytes still hold a credential, as written or as JSON escapes it: a last check before a file is kept. */
  holds(data: Buffer): boolean {
    return this.secrets.some((s) => data.includes(Buffer.from(s)) || data.includes(Buffer.from(JSON.stringify(s).slice(1, -1))));
  }
}

const id = (prefix: string, n: number) => `${prefix}${String(n + 1).padStart(3, '0')}`;
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const within = (path: string, root: string) => path === root || path.startsWith(root + sep);

/** One receipt as the report shows it. */
interface Receipt { status: string; operation: string; description: string; at: string; unresolved: boolean }
const UNRESOLVED = new Set(['unknown', 'dispatching', 'claimed', 'allowed', 'proposed', 'awaiting_checker']);

/** What the host gives an export: the home's records as it holds them. */
export interface ExportSource {
  home: string;
  projects: { id: string; name: string; kind: string }[];
  documents(projectId: string): MaterialEntry[];
  versionPath(id: string, version: number): string;
  threads: StoredThread[];
  /** The receipts the person can see, read as them. */
  receipts(): Promise<{ id: string; status: string; operation: string; description: string | null; created_at: string | Date }[]>;
  /** Every value the home's credential store holds now. */
  secrets(): Promise<string[]>;
}

interface Manifest {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION | typeof LEGACY_EXPORT_VERSION;
  id: string;
  createdAt: string;
  counts: HomeExport['counts'];
  excluded: HomeExport['excluded'];
  /** How many credential values were cut out. */
  scrubbed: number;
  /** Every file of the export but this manifest, by path, with its SHA-256. */
  files: Record<string, string>;
}

const summary = (folder: string, m: Manifest): HomeExport => ({ folder, id: m.id, createdAt: m.createdAt, counts: m.counts, excluded: m.excluded, files: Object.keys(m.files).length, scrubbed: m.scrubbed });

/** Validate managed paths together; legacy labels keep their basename/freeName semantics. */
function namespaceProblem(documents: readonly { project: string; name: string; projection?: 'managed'; source?: MaterialEntry['source'] }[]): string | undefined {
  const seen = new Map<string, { name: string; source?: MaterialEntry['source'] }[]>();
  // Explicit sources have stricter flat-name casing. Restore them before other managed material,
  // then let ordinary attachments choose their existing alternate basename around that namespace.
  for (const document of [...documents].sort((a, b) => Number(!!b.source) - Number(!!a.source))) {
    if (document.projection !== 'managed') {
      const name = document.name.split(/[\\/]/).at(-1)!;
      if (!name || isIntermediate(name)) return `An invalid ordinary document name prevents restore: ${JSON.stringify(document.name)}.`;
      continue;
    }
    const prior = seen.get(document.project) ?? [];
    const syntax = document.source ? sourcePathProblem(document.name, []) : managedPathProblem(document.name, []);
    if (syntax) return `An invalid managed document path prevents restore: ${JSON.stringify(document.name)}. ${syntax}`;
    const collision = document.source ? sourcePathProblem(document.name, prior.filter(d => d.source)) || documentPathCollision(document.name, prior) : documentPathCollision(document.name, prior);
    if (collision || prior.some(d => d.name === document.name)) return `Managed document namespace has a duplicate, case alias or file/folder collision at ${JSON.stringify(document.name)}.`;
    prior.push({ name: document.name, source: document.source }); seen.set(document.project, prior);
  }
}

/** The picked folder still the one the person picked: the same device and inode, not a link, at the same real path. */
function stillPicked(picked: PickedFolder): boolean {
  try {
    const st = lstatSync(picked.path);
    return st.isDirectory() && !st.isSymbolicLink() && st.dev === picked.dev && st.ino === picked.ino && realpathSync(picked.path) === picked.real;
  } catch { return false; }
}

/** A thread as history: what was asked, answered and done, never its custody, keys or links. */
function history(thread: StoredThread, project: string, projectFolder: string | null) {
  return {
    title: thread.summary.title,
    project,
    projectFolder,
    updatedAt: thread.summary.updatedAt,
    turns: [...thread.turns.map(turn => ({ turn, rewound: false })), ...(thread.rewinds ?? []).flatMap(record => [...record.turns, ...(record.sideTurns ?? [])].map(turn => ({ turn, rewound: true })))].map(({ turn: t, rewound }) => ({
      ...(rewound ? { rewound: true } : {}),
      at: t.user.at,
      asked: t.user.text,
      attachments: t.user.attachments.map((a) => `${a.name} v${a.version}`),
      status: t.unknownOutcome || t.unknownChecked ? 'unknown' : t.status,
      ...(t.unknownOutcome ? { unknownOutcome: true } : {}),
      ...(t.unknownChecked ? { unknownChecked: { ...t.unknownChecked, current: unknownChecked(t) } } : {}),
      // A turn whose source was withdrawn is not replayed, here either.
      answer: t.withheld ? null : t.answer?.text ?? null,
      withheld: !!t.withheld,
      effects: t.effects.map((e) => ({ target: e.target, outcome: e.outcome, ...(e.outcome === 'UNKNOWN' ? { note: 'Unresolved when exported; check before redoing.' } : {}) })),
    })),
  };
}
type History = ReturnType<typeof history>;

function transcript(h: History): string {
  const lines = [`# ${h.title}`, '', `Chat history from project ${h.project}, exported as history. It is not a live chat.`, ''];
  for (const t of h.turns) {
    lines.push(`## ${t.at}`, '', ...(t.rewound ? ['*Rewound branch, retained as history.*', ''] : []), `**Asked:** ${t.asked}`, '');
    if (t.unknownChecked) {
      const check = t.unknownChecked;
      lines.push(check.current
        ? `unknown, checked by ${check.byName ?? check.by} on ${check.at}`
        : `Earlier check by ${check.byName ?? check.by} on ${check.at}; the turn changed and this check no longer applies.`,
        `Checker ID: ${check.by}`, ...check.steps.map(s => `${s.at}: ${s.label}`), '');
    }
    if (t.attachments.length) lines.push(`Attached: ${t.attachments.join(', ')}`, '');
    if (t.withheld) lines.push('*Answer withheld: a source it used was withdrawn.*', '');
    else if (t.answer) lines.push('**Answered:**', '', t.answer, '');
    for (const e of t.effects) lines.push(`- ${e.outcome}: ${e.target}${e.note ? ` (${e.note})` : ''}`);
    if (t.effects.length) lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

type Held = { tool: string; serverName: string; state: string; statement: string };
function report(receipts: Receipt[], threads: History[], held: Held[]): string {
  const unresolved = 'UNRESOLVED (unresolved when exported; check before redoing)';
  const lines = [
    '# Receipts and effects when exported',
    '',
    'A read-only report. Nothing here can be sent, released or settled again: it is history.',
    'An effect marked UNRESOLVED was UNKNOWN or held when this was exported. Check what happened before you do it again.',
    '',
    '## Receipts',
    '',
    ...receipts.map((r) => `- ${r.unresolved ? unresolved : r.status.toUpperCase()} · ${r.operation} · ${r.description || 'no description'} · ${r.at}`),
    ...(receipts.length ? [] : ['None.']),
    '',
    '## Writes in chats',
    '',
  ];
  for (const t of threads) for (const turn of t.turns) for (const e of turn.effects) lines.push(`- ${e.outcome === 'UNKNOWN' ? unresolved : e.outcome} · ${e.target} · "${t.title}" · ${turn.at}`);
  lines.push('', '## Connector calls held for you', '');
  for (const h of held) lines.push(`- ${h.state === 'waiting' ? 'UNRESOLVED (held when exported; check before redoing)' : h.state.toUpperCase()} · ${h.tool} on ${h.serverName} · ${h.statement}`);
  if (!held.length) lines.push('None.');
  return `${lines.join('\n')}\n`;
}

function readme(m: Manifest): string {
  return [
    '# Your work, exported',
    '',
    `Made ${m.createdAt}. Export ${m.id}.`,
    '',
    '- `projects/p001/`: each project (`project.json` has its name), with every version of each document in `documents/d001/` (`meta.json` names it; `v1`, `v2`, … are its versions).',
    '- `threads/t001.json` and `.md`: each chat as history.',
    '- `memory/`: your instructions and what was remembered, as markdown. `skills/s001/`: your skills. `roles/`: saved role definitions, restored as inactive reference documents.',
    '- `history/`: a read-only report of every receipt and effect. One that was UNKNOWN or held is marked UNRESOLVED: check it before you do it again.',
    '- `connectors/servers.json`: your own MCP servers, by name and command only.',
    `- \`${MANIFEST}\`: every file by SHA-256.`,
    '',
    'Files and folders are numbered, never named after what they hold. Free text you wrote (chats,',
    'documents, memory, skills) is exported as you wrote it. Every value the app\'s credential store held',
    `is cut out of everything the app wrote and of every plain-text file, replaced by "${SCRUBBED}"`,
    `(${m.scrubbed} found). Files you attached are exported byte for byte, as you attached them (plain text`,
    'aside): a credential written inside one, in any encoding, goes out as it is. A key you typed yourself,',
    'that the store never held, is not known to be one.',
    '',
    'Never in it:',
    ...m.excluded.map((e) => `- ${e.what}: ${e.why}`),
    '',
    'The export goes into a new folder inside the one you picked, checked to be that same folder before',
    'and after it is written. Another program running as you, racing to swap that folder meanwhile, is',
    'outside what this check can stop.',
    '',
    'Bring it into a new, empty data folder with `backbone restore <this folder> --home <new data folder> --dry-run`, then',
    'again without `--dry-run`. Your projects, documents, memory and skills come in as you would add them;',
    'chats and receipts come in as documents to read. Nothing in it grants anything or runs by itself.',
    '',
  ].join('\n');
}

/**
 * Export the person's work from `source` into `to`, a new folder outside the home. With `picked` (the
 * folder the person picked, as it was then), `to` must be directly inside it, and that folder is
 * checked again right before the export folder is made and after it is written; on a mismatch what
 * was written goes and the export is refused. The caller holds the home so nothing changes meanwhile.
 */
export async function exportHome(source: ExportSource, options: { to: string; picked?: PickedFolder; now?: () => Date; cap?: number; identityUpgrade?: boolean }): Promise<HomeExport> {
  const { home } = source;
  const target = resolve(options.to);
  const picked = options.picked;
  if (picked && dirname(target) !== resolve(picked.path)) throw new BackupRefused('INVALID', 'An export from the app goes into a new folder inside the one you picked.');
  if (within(canonicalHome(target), canonicalHome(home)) && !(options.identityUpgrade && canonicalHome(dirname(target)) === join(canonicalHome(home), 'backups') && !lstatSync(dirname(target)).isSymbolicLink())) throw new BackupRefused('INVALID', `${canonicalHome(target)} is inside the data folder; an export goes outside it.`);
  if (existsSync(target) && (!statSync(target).isDirectory() || readdirSync(target).length)) throw new BackupRefused('INVALID', `${target} is not empty, and an export never writes over anything. Name a new folder.`);
  const known = await source.secrets();
  const scrub = new Scrubber(known);
  // Everything is built, scrubbed and checked in memory first; nothing is on disk until it all is.
  const files = new Map<string, Buffer>();
  const putValue = <T>(rel: string, value: T): T => {
    const clean = scrub.value(value);
    files.set(rel, Buffer.from(`${JSON.stringify(clean, null, 2)}\n`));
    return clean;
  };
  const putText = (rel: string, text: string) => files.set(rel, Buffer.from(scrub.text(text)));
  const putBytes = (rel: string, data: Buffer) => files.set(rel, scrub.bytes(data));
  /** Files the person attached, exported as attached: the last check leaves their bytes alone. */
  const attached = new Set<string>();
  const counts: HomeExport['counts'] = { projects: 0, threads: 0, documents: 0, versions: 0, memoryFiles: 0, skills: 0, receipts: 0, unresolved: 0 };
  // Projects and their documents, every version.
  const folders = new Map<string, string>();
  let managed = false;
  const documentNames: { project: string; name: string; projection?: 'managed'; source?: MaterialEntry['source'] }[] = [];
  source.projects.forEach((p, i) => {
    const folder = `projects/${id('p', i)}`;
    folders.set(p.id, folder);
    putValue(`${folder}/project.json`, { name: p.name, kind: p.kind });
    counts.projects++;
    source.documents(p.id).forEach((d, j) => {
      const dir = `${folder}/documents/${id('d', j)}`;
      const withdrawn = !!d.withdrawals?.length && !d.withdrawals.at(-1)!.restoredAt;
      if (d.source && !isPersonSource(d)) throw new BackupRefused('INVALID', `A structured original ${JSON.stringify(scrub.text(d.name))} has an unconfirmed source identity, so nothing was exported.`);
      if (d.projection === 'managed') managed = true;
      // Export keeps inspection bytes, but an unregistered observation must stay out of restore.
      const pendingObservation = !!d.observation && d.observation.state !== 'registered';
      const meta = putValue(`${dir}/meta.json`, { name: d.name, mediaType: d.mediaType, class: d.class, ...(d.projection ? { projection: d.projection } : {}), ...(d.source ? { source: d.source } : {}), hidden: d.hidden || !!d.recovery || pendingObservation, withdrawn, current: d.current, versions: d.versions.map((v) => ({ n: v.n, by: v.by, at: v.at, file: `v${v.n}` })) });
      if (meta.source && sourcePathProblem(meta.name, [])) throw new BackupRefused('INVALID', `Credential redaction made structured source path ${JSON.stringify(meta.name)} invalid, so nothing was exported.`);
      if (!meta.hidden && !meta.withdrawn) documentNames.push({ project: folder, name: meta.name, projection: meta.projection, source: meta.source });
      // A file the person attached goes out byte for byte, as attached; plain text aside, whose credentials are cut out like everything Backbone wrote.
      const asAttached = d.class === 'original' && !d.mediaType.startsWith('text/');
      for (const v of d.versions) {
        const bytes = readOwn(source.versionPath(d.id, v.n), `a version of a document of project ${i + 1}`);
        if (asAttached) { files.set(`${dir}/v${v.n}`, bytes); attached.add(`${dir}/v${v.n}`); } else putBytes(`${dir}/v${v.n}`, bytes);
      }
      counts.documents++;
      counts.versions += d.versions.length;
    });
  });
  // Chats, as history, scrubbed as values before either form is made.
  const histories = source.threads.map((t) => scrub.value(history(t, source.projects.find((p) => p.id === t.summary.projectId)?.name ?? '', folders.get(t.summary.projectId) ?? null)));
  histories.forEach((h, i) => {
    files.set(`threads/${id('t', i)}.json`, Buffer.from(`${JSON.stringify(h, null, 2)}\n`));
    files.set(`threads/${id('t', i)}.md`, Buffer.from(transcript(h)));
    counts.threads++;
  });
  // Memory and skills, as markdown, under numbers.
  const memory = join(home, 'memory');
  const instructions = readOwnIf(join(memory, 'instructions.md'), 'memory instructions');
  if (instructions) { putText('memory/instructions.md', instructions.toString('utf8')); counts.memoryFiles++; }
  for (const dir of ['topics', 'daily'] as const) {
    if (!existsSync(join(memory, dir))) continue;
    readdirSync(join(memory, dir)).filter((n) => n.endsWith('.md')).sort().forEach((f, i) => {
      // The store's own id markers stay home: each line comes back as a line the person wrote.
      putText(`memory/${dir}/${id('m', i)}.md`, readOwn(join(memory, dir, f), `a memory file`).toString('utf8').replace(/[ \t]*<!--[\s\S]*?-->/g, ''));
      counts.memoryFiles++;
    });
  }
  if (existsSync(join(memory, 'projects'))) for (const f of readdirSync(join(memory, 'projects')).filter((n) => n.endsWith('.md'))) {
    const folder = folders.get(f.slice(0, -3));
    if (folder) { putText(`memory/projects/${folder.split('/')[1]}.md`, readOwn(join(memory, 'projects', f), 'project instructions').toString('utf8')); counts.memoryFiles++; }
  }
  const skills = join(home, 'skills');
  if (existsSync(skills)) readdirSync(skills).filter((n) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(n)).sort().forEach((name) => {
    const data = readOwnIf(join(skills, name, 'SKILL.md'), 'a skill');
    if (!data) return;
    const folder = `skills/${id('s', counts.skills)}`;
    putValue(`${folder}/skill.json`, { name });
    putText(`${folder}/SKILL.md`, data.toString('utf8'));
    counts.skills++;
  });
  // Roles remain plain documents on restore. Never restore instructions as active roles automatically.
  const rolePath = join(home, '.agent-roles');
  if (lstatSync(rolePath, { throwIfNoEntry: false })) {
    const root = anchoredRoot(home, ['.agent-roles']);
    if (!root) throw new BackupRefused('INVALID', 'The role definitions folder could not be read safely. Nothing was exported.');
    const names = readdirSync(root.path).filter(name => /^[a-z][a-z0-9-]{0,63}\.md$/.test(name)).sort();
    for (const [i, name] of names.entries()) {
      const review = `Inspect role definition ${i + 1} in the data folder's .agent-roles folder (filename order) directly; invalid definitions can be hidden in Settings.`;
      const text = readInside(root, join(root.path, name), 32_000, true);
      if (text === null) throw new BackupRefused('INVALID', `A role definition could not be read safely. ${review} Nothing was exported.`);
      const redacted = scrub.text(text);
      // Raw scrubbing cannot see YAML escapes. Reuse role admission on the outgoing definition.
      try { parseAgentRole(redacted, known); }
      catch { throw new BackupRefused('INVALID', `A role definition could not be checked safely after credential redaction. ${review} Nothing was exported.`); }
      files.set(`roles/${id('r', i)}.md`, Buffer.from(redacted));
    }
    if (names.length) counts.roles = names.length;
  }
  // The person's own MCP servers: name and command, nothing they start with.
  const servers = (() => { try { return (JSON.parse(readOwn(join(home, 'connectors', 'servers.json'), 'the server list').toString('utf8')) as { mcpServers?: Record<string, { command?: unknown; url?: unknown }> }).mcpServers ?? {}; } catch (error) { if (error instanceof BackupRefused) throw error; return {}; } })();
  putValue('connectors/servers.json', Object.entries(servers).map(([name, s]) => ({ name, command: typeof s?.command === 'string' ? s.command.split(/[\\/]/).pop() : typeof s?.url === 'string' ? 'an address (set it up again)' : null })));
  // The receipts, as a report to read.
  const receipts: Receipt[] = scrub.value((await source.receipts()).map((r) => ({ status: r.status, operation: r.operation, description: r.description ?? '', at: new Date(r.created_at).toISOString(), unresolved: UNRESOLVED.has(r.status) })));
  const held: Held[] = scrub.value((() => { try { return (JSON.parse(readOwn(join(home, 'connectors', 'mcp.json'), 'the held calls').toString('utf8')) as { held?: Held[] }).held ?? []; } catch (error) { if (error instanceof BackupRefused) throw error; return []; } })()
    .map(({ tool, serverName, state, statement }) => ({ tool, serverName, state, statement })));
  counts.receipts = receipts.length;
  counts.unresolved = receipts.filter((r) => r.unresolved).length + held.filter((h) => h.state === 'waiting').length;
  files.set('history/receipts.json', Buffer.from(`${JSON.stringify({ note: 'A read-only report. Unresolved: UNKNOWN or held when exported; check before redoing.', receipts, held }, null, 2)}\n`));
  files.set('history/receipts.md', Buffer.from(report(receipts, histories, held)));
  const collision = managed ? namespaceProblem(documentNames) : undefined;
  if (collision) throw new BackupRefused('INVALID', collision + ' Nothing was exported.');
  const manifest: Manifest = { format: EXPORT_FORMAT, version: managed ? EXPORT_VERSION : LEGACY_EXPORT_VERSION, id: randomUUID(), createdAt: (options.now?.() ?? new Date()).toISOString(), counts, excluded: EXCLUDED, scrubbed: scrub.n, files: {} };
  files.set(README, Buffer.from(readme(manifest)));
  manifest.files = Object.fromEntries([...files].map(([rel, data]) => [rel, sha(data)]).sort(([a], [b]) => a.localeCompare(b)));
  files.set(MANIFEST, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  // A last check: no credential, as written or as JSON escapes it, in any name or file kept.
  for (const [rel, data] of files) if (scrub.holds(Buffer.from(rel)) || (!attached.has(rel) && scrub.holds(data))) throw new BackupRefused('INVALID', 'A credential would remain in the export after it was cut out, so nothing was exported.');

  const size = [...files.values()].reduce((n, data) => n + data.length, 0);
  const cap = options.cap ?? IMPORT_CAP;
  if (size > cap) throw new BackupRefused('INVALID', `The export would be ${Math.ceil(size / 1024 / 1024)} MB, larger than the ${Math.round(cap / 1024 / 1024)} MB a restore accepts, so nothing was exported.`);
  // On disk: a staging folder beside the target, inside the picked folder, checked before and after.
  if (picked && !stillPicked(picked)) throw new BackupRefused('INVALID', 'The folder you picked is not the same folder any more, so nothing was exported. Pick it again.');
  mkdirSync(dirname(target), { recursive: true });
  const staging = join(dirname(target), `.export-partial-${randomUUID().slice(0, 8)}`);
  mkdirSync(staging, { mode: 0o700 });
  let placed = false;
  try {
    for (const [rel, data] of files) {
      mkdirSync(join(staging, dirname(rel)), { recursive: true, mode: 0o700 });
      writeFileSync(join(staging, rel), data, { mode: 0o600, flag: 'wx' });
    }
    if (existsSync(target)) rmdirSync(target);
    renameSync(staging, target);
    placed = true;
    if (picked && !stillPicked(picked)) throw new BackupRefused('INVALID', 'The folder you picked changed while the export was written, so what was written is removed and nothing was exported. Pick it again.');
    return summary(target, manifest);
  } catch (error) {
    rmSync(placed ? target : staging, { recursive: true, force: true });
    throw error;
  }
}

/** A path as a case-insensitive, Unicode-normalising file system sees it. */
const folded = (rel: string) => rel.normalize('NFC').toLowerCase();

/** An export checked and read: every file's bytes, held in memory, are all an import uses. */
export interface ReadExport { folder: string; manifest: Manifest; /** The SHA-256 of the manifest file's own bytes. */ manifestDigest: string; summary: HomeExport; files: Map<string, Buffer> }

/**
 * Read an export and check it, once: a plain tree (no link, device or second name anywhere), only the
 * export's own layout (compared case-folded and NFC-normalised), at most IMPORT_CAP bytes, and every
 * file as its manifest says, none missing or added. Every file is read into memory as it is checked,
 * and those bytes are what an import uses: no path is opened again. Changes nothing.
 */
export function inspectExport(from: string, cap = IMPORT_CAP): ReadExport {
  const folder = resolve(from);
  const path = join(folder, MANIFEST);
  if (!existsSync(path)) throw new BackupRefused('NOT_FOUND', `${folder} holds no ${MANIFEST}, so it is not a data folder export.`);
  const read = new Map<string, Buffer>();
  const seen = new Map<string, string>();
  let total = 0;
  const go = (rel: string) => {
    for (const name of readdirSync(rel ? join(folder, rel) : folder)) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(folder, r));
      if (st.isSymbolicLink()) throw new BackupRefused('INVALID', `${r} is a link; an export holds none, so it is not imported.`);
      // Folders and files alike: two names one case-insensitive file system takes for one refuse it.
      const key = folded(r);
      if (seen.has(key)) throw new BackupRefused('INVALID', `${r} and ${seen.get(key)} are the same name to a case-insensitive file system, so the export is not imported.`);
      seen.set(key, r);
      if (st.isDirectory()) {
        if (!FOLDERS.some((f) => f.test(r))) throw new BackupRefused('INVALID', `${r} is outside what an export holds (its exact names and case), so it is not imported.`);
        go(r);
        continue;
      }
      if (!FILES.some((f) => f.test(r))) throw new BackupRefused('INVALID', `${r} is outside what an export holds (its exact names and case), so it is not imported.`);
      if (!st.isFile() || st.nlink > 1) throw new BackupRefused('INVALID', `${r} is not a plain file with one name, so the export is not imported.`);
      total += st.size;
      if (total > cap) throw new BackupRefused('INVALID', `The export is larger than ${Math.round(cap / 1024 / 1024)} MB, so it is not imported.`);
      const data = readFileSync(join(folder, r));
      if (data.length !== st.size) throw new BackupRefused('INVALID', `${r} changed while it was read, so the export is not imported.`);
      read.set(r, data);
    }
  };
  go('');
  const raw = read.get(MANIFEST);
  if (!raw) throw new BackupRefused('NOT_FOUND', `${folder} holds no ${MANIFEST}, so it is not a data folder export.`);
  let manifest: Manifest;
  try { manifest = JSON.parse(raw.toString('utf8')) as Manifest; } catch { throw new BackupRefused('INVALID', `${path} cannot be read as JSON.`); }
  if (manifest.format !== EXPORT_FORMAT) throw new BackupRefused('INVALID', `${path} is not a data folder export.`);
  if (manifest.version !== EXPORT_VERSION && manifest.version !== LEGACY_EXPORT_VERSION) throw new BackupRefused('INVALID', `This export is version ${manifest.version}; this version reads versions ${LEGACY_EXPORT_VERSION} and ${EXPORT_VERSION}.`);
  if (!manifest.files || typeof manifest.files !== 'object') throw new BackupRefused('INVALID', `${path} is not a whole manifest.`);
  read.delete(MANIFEST);
  for (const [rel, digest] of Object.entries(manifest.files)) {
    const data = read.get(rel);
    if (!data) throw new BackupRefused('INVALID', `${rel} is missing from the export, so it is not imported.`);
    if (sha(data) !== digest) throw new BackupRefused('INVALID', `${rel} is not as it was exported (its SHA-256 differs), so the export is not imported.`);
  }
  const extra = [...read.keys()].find((rel) => !(rel in manifest.files));
  if (extra) throw new BackupRefused('INVALID', `${extra} is in the folder but not in the export's manifest, so it is not imported.`);
  return { folder, manifest, manifestDigest: sha(raw), summary: summary(folder, manifest), files: read };
}

/** What names one export's content: the digest of the manifest's own bytes (version, date and counts included) and of every file the check just compared. Same bytes, same fingerprint. */
export const exportFingerprint = (read: ReadExport): string => sha(Buffer.from(JSON.stringify([read.manifestDigest, Object.entries(read.manifest.files).sort(([a], [b]) => a.localeCompare(b))])));

/**
 * What an import goes through: the new home's own methods, as the person calls them, and the two the
 * host keeps off the api for an import alone: a document with its versions as the person's own, and
 * a skill proposed for them to accept.
 */
export interface ImportApi {
  call<M extends Method>(method: M, args: Args<M>): Promise<Result<M>>;
  addDocument(projectId: string, name: string, mediaType: string, versions: readonly (string | Uint8Array)[], layout?: MaterialImport): Promise<ApiReceipt<MaterialEntry>>;
  proposeSkill(name: string, text: string): Promise<ApiReceipt<Skill>>;
  /** Memory lines from a file the export holds, through the memory import: its filtering, limits and source. */
  importMemory(text: string, source: string): Promise<ApiReceipt<MemoryImportResult>>;
  /** Whether the home holds any skill of its own, proposed ones included. */
  hasSkills(): boolean;
}

/** What an import found, did or would do. */
export interface ImportPlan {
  export: HomeExport;
  target: string;
  /** Why it cannot go ahead, in plain words; empty when it can. */
  conflicts: string[];
  /** What it adds: projects, documents (with versions), chats as history, memory files and skills proposed. */
  adds: { projects: number; documents: number; versions: number; chats: number; memoryFiles: number; skills: number };
  /** What it leaves out of the new home, and why. */
  skipped: string[];
  dryRun: boolean;
  done: boolean;
}

/** Entries a new home may already hold: its keys, its database and who holds it. Anything else is work. */
const NEW_HOME = new Set(['keys', 'pg', 'run', 'cli', 'threads', '.lock', 'kernel.json', 'core.json']);
/** Whether `home` is a new, empty home before a host opens it: absent, or holding nothing but its keys, database and holders. */
export function newHome(home: string): string | null {
  if (!existsSync(home)) return null;
  const extra = readdirSync(home).filter((n) => !NEW_HOME.has(n) || (n === 'threads' && readdirSync(join(home, n)).length));
  return extra.length ? notNewHome(home, extra.slice(0, 3).join(', ')) : null;
}
const notNewHome = (home: string, what: string) => `${resolve(home)} is not a new, empty data folder (it holds ${what}). Import into a new data folder; this one is left as it is.`;

/** The new home's api says it holds no work: no project, chat, memory line, instructions or skill. */
async function holdsWork(api: ImportApi, home: string): Promise<string | null> {
  // Do not call agents.list here: import already holds the home lock and listing can migrate.
  if (lstatSync(join(home, '.agent-roles'), { throwIfNoEntry: false })) return 'saved agent definitions or recovery records';
  if ((await api.call('projects.list', {})).length) return 'projects';
  if ((await api.call('threads.list', {})).length) return 'chats';
  const memory = await api.call('memory.get', {});
  if (memory.entries.length || memory.proposed?.length) return 'memory';
  if (memory.instructions.person.trim()) return 'instructions';
  if (api.hasSkills()) return 'skills';
  return null;
}

const isText = (mediaType: string, name: string) => /^(text\/|application\/(json|x-ndjson|javascript|typescript))/.test(mediaType) || /\.(md|txt|json|csv|ts|tsx|js|mjs|css|html|ya?ml)$/i.test(name);

const unwrap = <T>(r: ApiReceipt<T>, what: string): T => {
  if (!r.ok) {
    if (r.outcome === 'UNKNOWN' || r.reason === 'PROJECT_CREATE_FAILED') {
      const unknown = r.outcome === 'UNKNOWN';
      const refused = new BackupRefused('NOT_AVAILABLE', `${what}: ${r.detail} The data folder ${unknown ? 'may hold' : 'holds'} part of the export: import again into another new data folder.`);
      refused.unknown = unknown;
      throw refused;
    }
    throw new BackupRefused('INVALID', `${what}: ${r.detail}`);
  }
  return r.value;
};


/**
 * Import the export at `from` into a new, empty home through `api`, its own methods; the caller holds
 * the home's lock for the whole import (Host.importExport). `dryRun` (no api needed) reads the export
 * and says what would be added. The export is read once, into memory, as it is checked, and only those
 * bytes are used. Projects, documents with their versions, memory and skills come in as the person
 * would add them; chats and the receipts report come in as read-only documents. A withdrawn or hidden
 * document stays out, and says so.
 */
export async function importHome(options: { from: string; home: string; api?: ImportApi; dryRun?: boolean; signal?: AbortSignal; /** The fingerprint of the export the person was shown: an export that no longer has it is refused before any write. */ expect?: string }): Promise<ImportPlan> {
  const read = inspectExport(options.from);
  if (options.expect !== undefined && exportFingerprint(read) !== options.expect) throw new BackupRefused('INVALID', 'The backup changed since you were shown it, so nothing was imported. Look at it again first.');
  const { files } = read;
  const text = (rel: string) => files.get(rel)?.toString('utf8') ?? '';
  const refuse = (why: string): never => { throw new BackupRefused('INVALID', `${why}, so nothing was imported.`); };
  const json = <T>(rel: string): T => { try { return JSON.parse(text(rel)) as T; } catch { return refuse(`${rel} cannot be read as JSON`); } };
  const names = [...files.keys()];
  // Every reference is read and checked here, before anything is written.
  const projects = names.filter((f) => /^projects\/p\d+\/project\.json$/.test(f)).map((f) => ({ dir: f.split('/').slice(0, 2).join('/'), meta: json<{ name?: unknown; kind?: unknown }>(f) }));
  const folders = new Set(projects.map((p) => p.dir));
  const declaredLayout = read.manifest.version === EXPORT_VERSION;
  type Meta = { name: string; mediaType: string; class: string; projection?: 'managed'; source?: MaterialEntry['source']; fromServer?: unknown; current?: number; hidden?: boolean; withdrawn?: boolean; versions: { n: number; file: string; by?: string }[] };
  const documents = names.filter((f) => /^projects\/p\d+\/documents\/d\d+\/meta\.json$/.test(f)).map((f) => {
    const dir = f.slice(0, -'/meta.json'.length);
    const project = f.split('/').slice(0, 2).join('/');
    const meta = json<Meta>(f);
    if (!folders.has(project)) refuse(`${f} belongs to a project the export does not hold`);
    if (typeof meta.name !== 'string' || !Array.isArray(meta.versions) || !meta.versions.length) refuse(`${f} does not name a document and its versions`);
    if (declaredLayout && (!['original', 'working', 'accepted'].includes(meta.class) || (meta.projection !== undefined && meta.projection !== 'managed'))) refuse(`${f} declares an unsupported document layout`);
    if (declaredLayout && meta.fromServer !== undefined) refuse(`${f} declares an invalid server origin for restore`);
    if (declaredLayout && meta.versions.some(v => !v || typeof v !== 'object' || !Number.isInteger(v.n) || typeof v.file !== 'string' || !['person', 'agent'].includes(v.by ?? ''))) refuse(`${f} declares invalid versions`);
    const versions = meta.versions.map((v) => Number(v?.n)).sort((a, b) => a - b).map((n, i) => {
      if (!Number.isInteger(n) || n < 1) refuse(`${f} names a version that is not a number`);
      if (declaredLayout && (n !== i + 1 || meta.current !== meta.versions.length || meta.versions.find(v => v.n === n)?.file !== `v${n}`)) refuse(`${f} does not declare contiguous current versions`);
      return files.get(`${dir}/v${n}`) ?? refuse(`${f} names version ${n}, which the export does not hold`);
    });
    if (declaredLayout && meta.class === 'original' && versions.length !== 1) refuse(`${f} declares an original without exactly one version`);
    if (declaredLayout && meta.source !== undefined && (!meta.source || typeof meta.source !== 'object' || Array.isArray(meta.source) || meta.source.kind !== 'person' || meta.source.path !== meta.name || meta.projection !== 'managed' || meta.class !== 'original' || versions.length !== 1 || meta.versions[0].by !== 'person' || sourcePathProblem(meta.name, []))) refuse(`${f} declares an invalid person-source identity`);
    const layout: MaterialImport | undefined = declaredLayout && meta.projection === 'managed' ? { projection: 'managed', original: meta.class === 'original', versionAuthors: [...meta.versions].sort((a, b) => a.n - b.n).map(v => v.by as 'person' | 'agent'), ...(meta.source ? { source: { kind: 'person', path: meta.name } as const } : {}) } : undefined;
    return { dir, project, meta, versions, layout };
  });
  const chats = names.filter((f) => /^threads\/t\d+\.json$/.test(f)).map((f) => {
    const h = json<{ title?: unknown; projectFolder?: unknown }>(f);
    if (h.projectFolder !== null && h.projectFolder !== undefined && !folders.has(String(h.projectFolder))) refuse(`${f} belongs to a project the export does not hold`);
    return { rel: f, folder: h.projectFolder ? String(h.projectFolder) : null, md: files.get(f.replace(/\.json$/, '.md')) ?? refuse(`${f} has no markdown beside it`) };
  });
  const projectMemory = names.filter((x) => /^memory\/projects\/p\d+\.md$/.test(x)).map((f) => {
    const folder = `projects/${f.split('/')[2].slice(0, -3)}`;
    if (!folders.has(folder)) refuse(`${f} belongs to a project the export does not hold`);
    return { rel: f, folder };
  });
  const memory = names.filter((f) => /^memory\/(topics|daily)\/m\d+\.md$/.test(f));
  const skills = names.filter((f) => /^skills\/s\d+\/SKILL\.md$/.test(f)).map((f) => {
    const metaRel = f.replace(/SKILL\.md$/, 'skill.json');
    return { rel: f, name: String((files.has(metaRel) ? json<{ name?: unknown }>(metaRel) : {}).name ?? 'restored-skill') };
  });
  const roles = names.filter(f => /^roles\/r\d{3,}\.md$/.test(f));
  const kept = documents.filter((d) => !d.meta.withdrawn && !d.meta.hidden);
  const collision = declaredLayout ? namespaceProblem(kept.map(d => ({ project: d.project, name: d.meta.name, projection: d.layout?.projection, source: d.layout?.source }))) : undefined;
  if (collision) refuse(collision);
  const plan: ImportPlan = {
    export: read.summary, target: resolve(options.home), conflicts: [], dryRun: !!options.dryRun, done: false,
    adds: { projects: projects.length + 1, documents: kept.length + roles.length, versions: kept.reduce((n, d) => n + d.versions.length, 0), chats: chats.length, memoryFiles: memory.length + (files.has('memory/instructions.md') ? 1 : 0), skills: skills.length },
    skipped: documents.filter((d) => d.meta.withdrawn || d.meta.hidden).map((d) => `${d.meta.name}: ${d.meta.withdrawn ? 'withdrawn' : 'a hidden intermediate'} when exported, so it stays out.`),
  };
  if (within(canonicalHome(read.folder), canonicalHome(options.home))) plan.conflicts.push('The export is inside the data folder it would be imported into.');
  const api = options.api;
  const work = api ? await holdsWork(api, options.home) : null;
  const notNew = api ? (work ? notNewHome(options.home, work) : null) : newHome(options.home);
  if (notNew) plan.conflicts.push(notNew);
  if (options.dryRun) return plan;
  if (plan.conflicts.length) throw new BackupRefused('INVALID', plan.conflicts.join(' '));
  if (!api) throw new Error('An import needs the new data folder\'s api.');
  // Each write waits on the hold of the home: one lost, and nothing more is written.
  let attempted = false;
  const held = () => {
    if (options.signal?.aborted) throw new BackupRefused('NOT_AVAILABLE', attempted
      ? 'The import lost its hold on the data folder, so it stopped writing. The data folder holds part of the export: import again into another new data folder.'
      : 'The import lost its hold on the data folder before it wrote anything, so nothing was imported.');
    attempted = true; // every write is preceded by this check: from here a write may have begun
  };

  // From here on a refusal means the new data folder may hold part of the export, and says so.
  try {
    // Projects, then each document as the person would add it, every version in order.
    const projectIds = new Map<string, string>();
    for (const p of projects) {
      held();
      const made = unwrap(await api.call('projects.create', { name: String(p.meta.name ?? '').slice(0, 200) || 'Project', kind: p.meta.kind === 'git' ? 'git' : 'folder' }), 'A project');
      projectIds.set(p.dir, made.id);
    }
    for (const d of [...kept].sort((a, b) => (b.layout?.source ? 2 : b.layout ? 1 : 0) - (a.layout?.source ? 2 : a.layout ? 1 : 0))) {
      const projectId = projectIds.get(d.project)!;
      const name = d.meta.name;
      const mediaType = typeof d.meta.mediaType === 'string' ? d.meta.mediaType : 'application/octet-stream';
      if (d.layout) {
        held();
        unwrap(await api.addDocument(projectId, name, mediaType, d.versions, d.layout), 'A managed document');
      } else if (d.meta.class === 'original' || d.versions.length === 1 || !isText(mediaType, name)) {
        // One version, an original, or bytes that are not text: each version as a document of its own.
        for (const [i, bytes] of d.versions.entries()) { held(); unwrap(await api.call('material.attach', { projectId, name: d.versions.length > 1 ? name.replace(/(\.[^.]*)?$/, ` (v${i + 1})$1`) : name, base64: bytes.toString('base64'), mediaType }), 'A document'); }
      } else {
        held();
        unwrap(await api.addDocument(projectId, name, mediaType, d.versions.map((v) => v.toString('utf8'))), 'A document');
      }
    }
    // History: each chat and the receipts report, as documents to read.
    held();
    const restored = unwrap(await api.call('projects.create', { name: RESTORED_PROJECT, kind: 'folder' }), RESTORED_PROJECT);
    for (const chat of chats) {
      held();
      unwrap(await api.call('material.attach', { projectId: (chat.folder && projectIds.get(chat.folder)) || restored.id, name: `Chat history - ${chat.rel.split('/')[1].replace(/\.json$/, '')}.md`, base64: chat.md.toString('base64'), mediaType: 'text/markdown' }), 'A chat');
    }
    for (const [rel, name] of [['history/receipts.md', 'Receipts when exported.md'], ['connectors/servers.json', 'Connected servers when exported.json']] as const) {
      const data = files.get(rel);
      if (!data) continue;
      held();
      unwrap(await api.call('material.attach', { projectId: restored.id, name, base64: data.toString('base64'), mediaType: rel.endsWith('.md') ? 'text/markdown' : 'application/json' }), name);
    }
    for (const rel of roles) {
      held();
      unwrap(await api.call('material.attach', { projectId: restored.id, name: `Agent role - ${rel.split('/')[1]}`, base64: files.get(rel)!.toString('base64'), mediaType: 'text/markdown' }), 'A role definition');
    }
    // Memory: instructions as the person's; remembered lines through the memory import, with its filtering, limits and source.
    if (files.has('memory/instructions.md')) { held(); unwrap(await api.call('memory.instructions.put', { scope: 'person', text: text('memory/instructions.md') }), 'Your instructions'); }
    for (const m of projectMemory) { held(); unwrap(await api.call('memory.instructions.put', { scope: 'project', projectId: projectIds.get(m.folder)!, text: text(m.rel) }), 'Project instructions'); }
    for (const f of memory) {
      held();
      const r = await api.importMemory(text(f), `export ${read.manifest.id}: ${f}`);
      if (!r.ok) plan.skipped.push(`${f}: ${r.detail}`);
      else for (const skipped of r.value.skipped ?? []) plan.skipped.push(`${skipped.source}, line ${skipped.line} (${skipped.reason})`);
    }
    // Skills wait for the person to accept them.
    for (const skill of skills) {
      held();
      const r = await api.proposeSkill(skill.name, text(skill.rel));
      if (!r.ok) plan.skipped.push(`A skill: ${r.detail}`);
    }
  } catch (error) {
    if (error instanceof BackupRefused && attempted) error.partial = true;
    throw error;
  }
  plan.done = true;
  return plan;
}

/** The folder an export goes in, inside the one the person picked. */
export const exportFolderIn = (picked: string, now = new Date()) => join(picked, `home-export-${now.toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);

/**
 * Where a renderer's export may go: only into a new folder inside one the person chose in the main
 * process's own picker. The picker issues a one-time ticket bound to the window that asked (its
 * webContents id) and to the chosen folder as it was then (device, inode and real path, not a link).
 * An export takes the ticket, never a path, from that same window, within ten minutes; the folder's
 * identity goes with it and is checked again when the export is written.
 */
export function exportDestinations(now: () => number = Date.now, ttlMs = 10 * 60_000) {
  const issued = new Map<string, { folder: string; owner: number; picked: PickedFolder; at: number }>();
  return {
    issue(path: string, owner: number): { ticket: string; folder: string } {
      const st = lstatSync(path);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new BackupRefused('INVALID', `${path} is not a folder.`);
      const ticket = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
      const folder = exportFolderIn(path);
      issued.set(ticket, { folder, owner, picked: { path, real: realpathSync(path), dev: st.dev, ino: st.ino }, at: now() });
      return { ticket, folder };
    },
    take(ticket: unknown, owner: number): { to: string; picked: PickedFolder } | null {
      if (typeof ticket !== 'string') return null;
      const found = issued.get(ticket);
      issued.delete(ticket);
      if (!found || found.owner !== owner || now() - found.at > ttlMs || !stillPicked(found.picked)) return null;
      return { to: found.folder, picked: found.picked };
    },
  };
}

/** A renderer's `backup.export`, as its transport passes it on: its ticket's folder and identity, or a refusal. A path it names is never taken. */
export function rendererExport(destinations: ReturnType<typeof exportDestinations>, args: unknown, owner: number): { to: string; picked: PickedFolder } | { ok: false; reason: 'INVALID'; detail: string; outcome: 'REFUSED' } {
  const ticket = args && typeof args === 'object' && 'ticket' in args ? (args as { ticket: unknown }).ticket : undefined;
  return destinations.take(ticket, owner) ?? { ok: false, reason: 'INVALID', outcome: 'REFUSED', detail: 'Choose the folder in the app\'s own picker first: an export goes only to the folder you chose there, once, from this window.' };
}
