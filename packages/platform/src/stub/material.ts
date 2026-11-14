// Work material: originals (bytes untouched), working copies and versions. Save is atomic:
// the meta file's rename is the commit point, so after a kill exactly one of {vN, vN+1} is current.
import { constants, fstatSync, readSync, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import type { MaterialClass, MaterialEntry, Receipt } from '../api.ts';
import { isIntermediate, readJson, sha256, writeAtomic, writeJson } from './fsx.ts';

/** Private restore input, never an API grant or restored run/receipt identity. */
export interface MaterialImport {
  projection: 'managed';
  original: boolean;
  versionAuthors?: readonly ('person' | 'agent')[];
  source?: MaterialEntry['source'];
}

/** Trusted composition only: the durable observation allocates both identities before dispatch. */
export interface ConnectorObservationMaterial {
  id: string;
  observation: string;
  projectId: string;
  name: string;
  mediaType: string;
  body: string;
  connection: string;
  tool: string;
}

const OBSERVATION_ID = /^[a-f0-9]{64}$/;
const NATIVE_ID = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const pendingObservation = (entry: MaterialEntry) => !!entry.observation && entry.observation.state !== 'registered';
function syncMaterialDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** A document id: letters, digits, '-' and '_', no separators or dots. */
export const MATERIAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Input paths identify stored data; native executors must inspect autoload-sensitive names through their data view. */
export function sourcePathProblem(name: string, entries: readonly Pick<MaterialEntry, 'name'>[]): string | undefined {
  if (typeof name !== 'string' || !name || name.length > 500 || name.normalize('NFC') !== name || Buffer.from(name).toString('utf8') !== name || /[\\:]/.test(name) || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) return 'That is not a supported relative source path.';
  if (name.split('/').some(part => !part.trim() || part === '.' || part === '..' || /[. ]$/.test(part))) return 'Source paths need non-empty relative segments without traversal or trailing dots/spaces.';
  if (entries.some(entry => entry.name !== name && entry.name.toLowerCase() === name.toLowerCase())) return 'That source path aliases an existing name with different casing.';
  return documentPathCollision(name, entries);
}

/** Projection alone cannot establish origin: legacy connector originals deliberately have none. */
export function isPersonSource(entry: MaterialEntry): boolean {
  return entry.class === 'original' && entry.projection === 'managed' && !entry.fromServer &&
    entry.source?.kind === 'person' && entry.source.path === entry.name && entry.current === 1 && entry.versions.length === 1 && entry.versions[0]?.by === 'person' && !sourcePathProblem(entry.name, []);
}

/** Explicit octet-stream text gets bounded fatal UTF-8 decoding; binary/invalid data stays opaque. */
export function sourceText(entry: MaterialEntry, bytes: Uint8Array): string | undefined {
  if (!isPersonSource(entry) || entry.mediaType !== 'application/octet-stream' || bytes.length > 2_000_000 || bytes.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return undefined; }
}

/** Logical managed paths are metadata, never a grant to project a file onto a physical folder. */
export function managedPathProblem(name: string, entries: readonly Pick<MaterialEntry, 'name'>[]): string | undefined {
  if (name.includes('/')) {
    if (name.length > 500 || name.normalize('NFC') !== name || Buffer.from(name).toString('utf8') !== name || /[\\:]/.test(name) || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) return 'That is not a supported relative document path.';
    const parts = name.split('/');
    if (parts.some(part => !part.trim() || part.startsWith('.') || /[. ]$/.test(part))) return 'Document paths need non-empty relative segments without dot prefixes or trailing dots/spaces.';
  } else if (!name.trim() || name.length > 1024 || /[\\\0\r\n]/.test(name) || name.startsWith('.')) return 'That is not a supported document name.';
  return documentPathCollision(name, entries);
}

/** Display-only connector label. Raw server/tool identity stays in its observation and source
 * envelope. Reserve the observation suffix before shortening, without splitting a code point;
 * 480 reserves room for collision qualifiers under documentVariantName's 500-unit bound. */
export function connectorMaterialLabel(serverName: string, tool: string, observation: string): string {
  if (!OBSERVATION_ID.test(observation)) throw new Error('A connector label needs its exact observation identity.');
  const prefix = 'From ', suffix = ` · ${observation.slice(0, 16)}.json`;
  const description = `${serverName} · ${tool}`.replace(/[\\/\0\r\n]/g, '-');
  let shortened = '';
  for (const character of description) {
    if (prefix.length + shortened.length + character.length + suffix.length > 480) break;
    shortened += character;
  }
  return prefix + shortened + suffix;
}

/** Namespace conflicts are checked again where bytes commit, including recovery and ordinary saves. */
export function documentPathCollision(name: string, entries: readonly Pick<MaterialEntry, 'name'>[]): string | undefined {
  const parts = name.split('/');
  for (const entry of entries) {
    if (entry.name === name) continue;
    if (!name.includes('/') && !entry.name.includes('/')) continue; // Preserve existing flat-label semantics.
    const other = entry.name.split('/');
    let shared = 0;
    while (shared < Math.min(parts.length, other.length) && parts[shared].toLowerCase() === other[shared].toLowerCase()) {
      if (parts[shared] !== other[shared]) return 'That path aliases an existing document or folder with different casing.';
      shared++;
    }
    if (shared === Math.min(parts.length, other.length)) return 'A document and a folder cannot occupy the same path.';
  }
}

/** Add a qualifier to the leaf, never to a dotted parent directory. */
export function documentVariantName(name: string, qualifier: string): string {
  const dot = name.lastIndexOf('.'), slash = name.lastIndexOf('/');
  const extension = dot > slash + 1 ? dot : name.length;
  const suffix = ` (${qualifier})`, tail = name.slice(extension);
  const qualified = `${name.slice(0, extension)}${suffix}${tail}`;
  if (qualified.length <= 500) return qualified;
  // Shorten the leaf without cutting a Unicode code point. An exceptionally long directory
  // cannot hold the qualifier: retain the work under an explicit logical label instead.
  const room = 500 - (slash + 1) - suffix.length - tail.length;
  if (room < 1) return `Revision ${sha256(name).slice(0, 12)}${suffix}`;
  let stem = '';
  for (const letter of name.slice(slash + 1, extension)) { if (stem.length + letter.length > room) break; stem += letter; }
  return stem ? `${name.slice(0, slash + 1)}${stem}${suffix}${tail}` : `Revision ${sha256(name).slice(0, 12)}${suffix}`;
}

export type CrashPoint = 'after-intent' | 'after-version' | 'after-meta' | 'rewind-after-version' | 'rewind-after-meta' | 'rewind-after-aside';
export interface MaterialFaults {
  crashAt?: CrashPoint;
  saveDelayMs?: number;
  beforeFolderMove?: () => void;
}

const TEXT = /^(text\/|application\/(json|x-ndjson|javascript|typescript))/;
export const isText = (e: Pick<MaterialEntry, 'mediaType' | 'name'>) => TEXT.test(e.mediaType) || /\.(md|txt|json|csv|ts|tsx|js|mjs|css|html|ya?ml)$/i.test(e.name);

export const isWithdrawn = (e: Pick<MaterialEntry, 'withdrawals'>) => !!e.withdrawals?.length && !e.withdrawals.at(-1)!.restoredAt;

/** One immutable store withdrawal, to be delivered idempotently to the owning workspace's Core. */
export interface MaterialWithdrawalEvent {
  id: string;
  materialId: string;
  projectId: string;
  version: number;
  sequence: number;
  at: string;
}

function withdrawalEvent(entry: MaterialEntry, index: number): MaterialWithdrawalEvent {
  const record = entry.withdrawals![index];
  const identity = ['material-withdrawal-v1', entry.projectId, entry.id, index + 1, record.at, record.version];
  return { id: sha256(JSON.stringify(identity)), materialId: entry.id, projectId: entry.projectId, version: record.version, sequence: index + 1, at: record.at };
}

function acknowledged(record: NonNullable<MaterialEntry['withdrawals']>[number], event: string, workspace: string) {
  return Array.isArray(record.coreAcknowledgements) && record.coreAcknowledgements.find(ack => ack && typeof ack === 'object' && ack.event === event && ack.workspace === workspace &&
    typeof ack.receipt === 'string' && MATERIAL_ID.test(ack.receipt) && typeof ack.at === 'string' && Number.isFinite(Date.parse(ack.at)));
}

function conflicted(record: NonNullable<MaterialEntry['withdrawals']>[number], event: string, workspace: string): boolean {
  return Array.isArray(record.coreConflicts) && record.coreConflicts.some(conflict => conflict && typeof conflict === 'object' &&
    conflict.event === event && conflict.workspace === workspace && typeof conflict.at === 'string' && Number.isFinite(Date.parse(conflict.at)));
}

export function mediaTypeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const known: Record<string, string> = {
    md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf',
  };
  return known[ext] ?? 'application/octet-stream';
}

const refuse = <T>(reason: 'NOT_FOUND' | 'STALE_BASE' | 'INVALID', detail: string): Receipt<T> => ({ ok: false, reason, detail, outcome: 'REFUSED' });

// Only in-process liveness; durable versions/intents remain the existing material owner's
// truth. Cross-process access still requires the composition's data-home lock.
const liveSaves = new Set<string>();

export class MaterialStore {
  private readonly dir: string;
  private readonly faults: MaterialFaults;
  private readonly materialise: (entry: MaterialEntry, bytes: Uint8Array) => void;
  private readonly folderPath: (entry: MaterialEntry) => string | null;
  /** False for a read-only host: an interrupted Save is shown, and left for the next real open to settle. */
  private readonly settles: boolean;
  private readonly withdrawalChanged?: () => void;

  constructor(home: string, faults: MaterialFaults, materialise: (entry: MaterialEntry, bytes: Uint8Array) => void, folderPath: (entry: MaterialEntry) => string | null = () => null, settles = true, withdrawalChanged?: () => void) {
    this.dir = join(home, 'material');
    this.faults = faults;
    this.materialise = materialise;
    this.folderPath = folderPath;
    this.settles = settles;
    this.withdrawalChanged = withdrawalChanged;
  }

  private path(id: string, ...rest: string[]) {
    // An id is one plain path segment: never a way out of this home's material folder.
    if (!MATERIAL_ID.test(id)) throw new Error('That is not a document id.');
    return join(this.dir, id, ...rest);
  }

  /** Loads an entry and settles any Save that a kill interrupted, so the UI can say which version is current. */
  load(id: string): MaterialEntry | null {
    if (!MATERIAL_ID.test(id)) return null;
    const metaPath = this.path(id, 'meta.json');
    if (!existsSync(metaPath)) return null;
    const meta = readJson<MaterialEntry>(metaPath, null as unknown as MaterialEntry);
    // Older agent revisions retained their ancestor's accepted label. Derive the truthful
    // current class without writing during a read. An explicit archive restore is a person act.
    if (meta.class === 'accepted' && !meta.restored && meta.versions.find(v => v.n === meta.current)?.by === 'agent') meta.class = 'working';
    const intentPath = this.path(id, 'intent.json');
    if (existsSync(intentPath) && !liveSaves.has(resolve(this.path(id)))) {
      const intent = readJson<{ version: number; at: string }>(intentPath, { version: 0, at: '' });
      if (intent.version > meta.current) {
        meta.interruptedSave = { version: intent.version, at: intent.at };
        if (this.settles) writeJson(metaPath, meta);
      }
      if (this.settles) unlinkSync(intentPath);
    }
    return meta;
  }

  private entries(): MaterialEntry[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .map((id) => this.load(id))
      .filter((e): e is MaterialEntry => !!e);
  }

  list(projectId: string, includeHidden = false): MaterialEntry[] {
    return this.entries()
      .filter((e) => e.projectId === projectId && (includeHidden || (!e.hidden && !e.recovery && !pendingObservation(e))))
      .sort((a, b) => a.versions[0].at.localeCompare(b.versions[0].at) || a.name.localeCompare(b.name));
  }

  /** Durable outbox derived from committed history, including legacy and subsequently restored
   * withdrawals. No separate enqueue can be lost after the withdrawal's metadata commit. An
   * acknowledgement only avoids resending this event; consumers must still verify Core at use. */
  pendingWithdrawals(workspace: string): MaterialWithdrawalEvent[] {
    if (!MATERIAL_ID.test(workspace)) throw new Error('That is not a workspace id.');
    return this.entries().flatMap(entry => (entry.withdrawals ?? []).flatMap((record, index) => {
      const event = withdrawalEvent(entry, index);
      // Contradictory stored evidence cannot silently heal a terminal conflict into confirmation.
      return acknowledged(record, event.id, workspace) && !conflicted(record, event.id, workspace) ? [] : [event];
    })).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  /** Trusted composition only, after Core confirms this exact event and workspace. There is no
   * public/model API for supplying this receipt. Unknown/conflicting acknowledgements change
   * nothing, and a later withdrawal cannot be consumed by a response to an earlier delivery. */
  acknowledgeWithdrawal(id: string, event: string, workspace: string, receipt: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(event) || !MATERIAL_ID.test(workspace) || !MATERIAL_ID.test(receipt)) return false;
    const meta = this.load(id);
    if (!meta) return false;
    const index = (meta.withdrawals ?? []).findIndex((_, i) => withdrawalEvent(meta, i).id === event);
    if (index < 0) return false;
    const record = meta.withdrawals![index];
    if (conflicted(record, event, workspace)) return false;
    const prior = acknowledged(record, event, workspace);
    if (prior) return prior.receipt === receipt;
    const ack = { event, workspace, receipt, at: new Date().toISOString() };
    writeJson(this.path(id, 'meta.json'), { ...meta, withdrawals: meta.withdrawals!.map((value, i) => i === index ? { ...value, coreAcknowledgements: [...(value.coreAcknowledgements ?? []), ack] } : value) });
    return true;
  }

  /** Trusted composition only, under the home lock, after Core returns a terminal conflict for
   * this exact event/workspace. Persist no SQL error, source content or caller-supplied reason.
   * A confirmed event refuses; repeating a recorded conflict preserves its original evidence. */
  recordWithdrawalConflict(id: string, event: string, workspace: string): boolean {
    if (typeof event !== 'string' || !/^[a-f0-9]{64}$/.test(event) || typeof workspace !== 'string' || !MATERIAL_ID.test(workspace)) return false;
    const meta = this.load(id);
    if (!meta) return false;
    const index = (meta.withdrawals ?? []).findIndex((_, i) => withdrawalEvent(meta, i).id === event);
    if (index < 0) return false;
    const record = meta.withdrawals![index];
    if (acknowledged(record, event, workspace)) return false;
    if (conflicted(record, event, workspace)) return true;
    const conflict = { event, workspace, at: new Date().toISOString() };
    const prior = Array.isArray(record.coreConflicts) ? record.coreConflicts : [];
    writeJson(this.path(id, 'meta.json'), { ...meta, withdrawals: meta.withdrawals!.map((value, i) => i === index ? { ...value, coreConflicts: [...prior, conflict] } : value) });
    return true;
  }

  /** Exact terminal delivery evidence only. It says nothing about current source access. */
  withdrawalConflict(id: string, event: string, workspace: string): boolean {
    if (typeof event !== 'string' || !/^[a-f0-9]{64}$/.test(event) || typeof workspace !== 'string' || !MATERIAL_ID.test(workspace)) return false;
    const meta = this.load(id);
    if (!meta) return false;
    const index = (meta.withdrawals ?? []).findIndex((_, i) => withdrawalEvent(meta, i).id === event);
    return index >= 0 && conflicted(meta.withdrawals![index], event, workspace);
  }

  /** Caller holds the home lock. Conflicts remain in pendingWithdrawals; the delivery worker
   * uses this separate evidence to stop automatic retries and show the person the unresolved event. */
  withdrawalConflicts(workspace: string): MaterialWithdrawalEvent[] {
    if (!MATERIAL_ID.test(workspace)) throw new Error('That is not a workspace id.');
    return this.entries().flatMap(entry => (entry.withdrawals ?? []).flatMap((record, index) => {
      const event = withdrawalEvent(entry, index);
      return conflicted(record, event.id, workspace) ? [event] : [];
    })).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  /** What any turn may read, hidden intermediates included: never withdrawn, held or unimported recovery material. */
  available(projectId: string): MaterialEntry[] {
    return this.list(projectId, true).filter((e) => !isWithdrawn(e) && !e.held && !e.recovery && !pendingObservation(e));
  }

  /** Labels may be renamed before creating an input; write targets stay exact and receipt-bound. */
  freeName(projectId: string, label: string): string {
    const entries = this.list(projectId, true), taken = new Set(entries.map(entry => entry.name));
    const free = (name: string) => !taken.has(name) && !documentPathCollision(name, entries);
    if (free(label)) return label;
    // A metadata label with a conflicting ancestor cannot be fixed by renaming only its leaf.
    const base = label.replace(/[\\/]/g, ' · ');
    for (let i = 2; i <= entries.length + 2; i++) {
      const name = documentVariantName(base, String(i));
      if (free(name)) return name;
    }
    throw new Error('No unused material label could be allocated.');
  }

  /** Allocate before proposing a generated held/beside write; its receipt keeps that exact name. */
  freeVariantName(projectId: string, name: string, qualifier: string, separator = ', ', reserved: readonly string[] = []): string {
    const entries = [...this.list(projectId, true), ...reserved.map(name => ({ name }))], taken = new Set(entries.map(entry => entry.name));
    for (let i = 1; i <= entries.length + 2; i++) {
      const candidate = documentVariantName(name, `${qualifier}${i > 1 ? `${separator}${i}` : ''}`);
      if (!taken.has(candidate) && !documentPathCollision(candidate, entries)) return candidate;
    }
    throw new Error('No available revision name in that document namespace.');
  }

  bytes(id: string, version: number, maxBytes?: number): Uint8Array {
    const path = this.path(id, 'versions', String(version));
    if (maxBytes === undefined) return readFileSync(path);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid material byte limit.');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > maxBytes) throw new Error('Material exceeds the workspace input size limit.');
      const bytes = Buffer.alloc(info.size + 1); let length = 0;
      for (;;) {
        const count = readSync(fd, bytes, length, bytes.length - length, length);
        if (!count) break; length += count;
        if (length > info.size) throw new Error('Material grew during the bounded read.');
      }
      return bytes.subarray(0, length);
    } finally { closeSync(fd); }
  }

  create(projectId: string, name: string, mediaType: string, bytes: Uint8Array, cls: MaterialClass, by: 'person' | 'agent', id: string = randomUUID(), projection?: 'managed', held?: MaterialEntry['held'], fromServer?: MaterialEntry['fromServer'], recovery?: MaterialEntry['recovery'], source?: MaterialEntry['source']): MaterialEntry {
    return this.createVersions(projectId, name, mediaType, [bytes], cls, by, { id, projection, held, fromServer, recovery, source });
  }

  /** Caller holds the home lock. Retain once before typed Core registration; no existing or
   * partial directory is overwritten. Replays preserve all later lifecycle decisions. */
  retainConnectorObservation(input: ConnectorObservationMaterial): MaterialEntry {
    const value = { ...input };
    if (!NATIVE_ID.test(value.id) || !OBSERVATION_ID.test(value.observation) || !NATIVE_ID.test(value.connection)
      || [value.projectId, value.name, value.mediaType, value.tool].some(text => typeof text !== 'string' || !text || text.includes('\0') || Buffer.from(text).toString('utf8') !== text)
      || typeof value.body !== 'string' || Buffer.from(value.body).toString('utf8') !== value.body)
      throw new Error('An observation original needs exact supported identities, provenance and UTF-8 bytes.');
    const bytes = Buffer.from(value.body, 'utf8'), digest = sha256(bytes), path = this.path(value.id);
    const root = lstatSync(this.dir, { throwIfNoEntry: false });
    // Check before entries(): load can settle an interrupted Save, which must never happen
    // through an alias of the material root while merely looking for observation identity.
    if (root && (!root.isDirectory() || root.isSymbolicLink())) throw new Error('The material directory is not a private source directory.');
    if (lstatSync(path, { throwIfNoEntry: false })) {
      const prior = this.observationOriginal(value.id, value.observation, digest);
      if (prior.projectId !== value.projectId || prior.name !== value.name || prior.mediaType !== value.mediaType
        || prior.fromServer!.connection !== value.connection || prior.fromServer!.tool !== value.tool)
        throw new Error('This observation material identity already retains another immutable source.');
      return prior;
    }
    // Frozen originals above keep their exact historical labels. New originals must already
    // satisfy the flat managed-name contract; never rename a retained observation on replay.
    if (value.name.includes('/') || managedPathProblem(value.name, []))
      throw new Error('A new connector observation needs a supported flat label.');
    if (this.entries().some(entry => entry.observation?.id === value.observation))
      throw new Error('This connector observation already retains another material identity.');
    // Establish each new directory entry before its descendants. The data home already exists;
    // these barriers are syscall ordering, not a claim about power-loss behavior of every device.
    if (!existsSync(this.dir)) { mkdirSync(this.dir, { mode: 0o700 }); syncMaterialDirectory(join(this.dir, '..')); }
    if (!lstatSync(this.dir).isDirectory() || lstatSync(this.dir).isSymbolicLink()) throw new Error('The material directory is not a private source directory.');
    mkdirSync(path, { mode: 0o700 }); syncMaterialDirectory(this.dir);
    mkdirSync(this.path(value.id, 'versions'), { mode: 0o700 }); syncMaterialDirectory(path);
    return this.createVersions(value.projectId, value.name, value.mediaType, [bytes], 'original', 'agent', {
      id: value.id, projection: 'managed', fromServer: { connection: value.connection, tool: value.tool },
      observation: { id: value.observation, state: 'pending' },
    });
  }

  /** Acknowledged registration is historical. A changed pending entry stays withheld; this
   * never clears withdrawal, hidden/held/uncertain/recovery state or a person's later decision. */
  registerConnectorObservation(id: string, observation: string, originalSha256: string): MaterialEntry {
    const entry = this.observationOriginal(id, observation, originalSha256);
    if (entry.observation!.state === 'registered') return entry;
    if (entry.hidden || entry.held || entry.unsure || entry.recovery || entry.interruptedSave || entry.projecting
      || entry.restored || (entry.lifecycle ?? 0) !== 0 || (entry.withdrawals?.length ?? 0) !== 0)
      throw new Error('This pending observation changed or became unavailable; its registration does not restore access.');
    const registered: MaterialEntry = { ...entry, observation: { id: observation, state: 'registered' } };
    writeJson(this.path(id, 'meta.json'), registered);
    return registered;
  }

  /** Verify the original directly, without load's interrupted-Save settlement changing evidence. */
  private observationOriginal(id: string, observation: string, originalSha256: string): MaterialEntry {
    if (!NATIVE_ID.test(id) || !OBSERVATION_ID.test(observation) || !OBSERVATION_ID.test(originalSha256)) throw new Error('Invalid observation material identity or digest.');
    for (const path of [this.dir, this.path(id), this.path(id, 'versions')]) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Observation source directories cannot be aliases.');
    }
    for (const path of [this.path(id, 'meta.json'), this.path(id, 'versions', '1')]) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Observation source records cannot be aliases.');
    }
    if (existsSync(this.path(id, 'intent.json')) || JSON.stringify(readdirSync(this.path(id, 'versions')).sort()) !== '["1"]')
      throw new Error('Incomplete or unexpected observation source records were preserved for inspection.');
    const entry = readJson<MaterialEntry>(this.path(id, 'meta.json'), null as unknown as MaterialEntry);
    if (!entry || entry.id !== id || entry.class !== 'original' || entry.projection !== 'managed' || entry.source || entry.restored
      || entry.current !== 1 || !Array.isArray(entry.versions) || entry.versions.length !== 1 || entry.versions[0]?.n !== 1
      || entry.versions[0].by !== 'agent' || !Number.isFinite(Date.parse(entry.versions[0].at))
      || !entry.fromServer || !NATIVE_ID.test(entry.fromServer.connection) || typeof entry.fromServer.tool !== 'string' || !entry.fromServer.tool
      || entry.observation?.id !== observation || !['pending', 'registered'].includes(entry.observation.state))
      throw new Error('This material is not the exact retained connector observation original.');
    const bytes = this.bytes(id, 1);
    if (entry.versions[0].bytes !== bytes.byteLength || entry.versions[0].sha256 !== originalSha256 || sha256(bytes) !== originalSha256)
      throw new Error('Observation original bytes do not match their immutable record.');
    return entry;
  }

  /** Write every immutable version before the one metadata commit that makes it visible. */
  private createVersions(projectId: string, name: string, mediaType: string, versions: readonly Uint8Array[], cls: MaterialClass, by: 'person' | 'agent', birth: Pick<MaterialEntry, 'id' | 'projection' | 'held' | 'fromServer' | 'recovery' | 'source' | 'restored' | 'observation'>, versionAuthors?: readonly ('person' | 'agent')[]): MaterialEntry {
    const { id, projection, held, fromServer, recovery, source, restored, observation } = birth;
    if (!versions.length) throw new Error('A document needs its versions.');
    if (cls === 'original' && versions.length !== 1) throw new Error('An original needs exactly one version.');
    if (versionAuthors && (versionAuthors.length !== versions.length || versionAuthors.some(author => author !== 'person' && author !== 'agent'))) throw new Error('Invalid historical version authors.');
    const entries = this.list(projectId, true);
    if (source && (source.kind !== 'person' || source.path !== name || cls !== 'original' || by !== 'person' || projection !== 'managed' || fromServer || held || recovery || versions.length !== 1)) throw new Error('That source identity is not a person-supplied original.');
    if (source && (sourcePathProblem(name, entries) || entries.some(entry => entry.name === name))) throw new Error('That source path is invalid or already occupied.');
    const managed = entries.filter(entry => entry.projection === 'managed');
    // A connector's source label is data, not a structured write target. Target syntax is checked
    // at admission and in proposal custody; this store enforces the shared namespace at commit.
    const problem = documentPathCollision(name, projection === 'managed' ? entries : managed);
    if (problem || (name.includes('/') && (projection === 'managed' ? entries : managed).some(entry => entry.name === name))) throw new Error(problem ?? 'That managed document path is already occupied.');
    const at = new Date().toISOString();
    const entry: MaterialEntry = { id, projectId, name, mediaType, ...(projection ? { projection } : {}), ...(source ? { source } : {}), ...(restored ? { restored } : {}), ...(observation ? { observation } : {}), class: cls, hidden: !!held || !!recovery, ...(recovery ? { recovery } : {}), ...(held ? { held } : {}), ...(fromServer ? { fromServer } : {}), current: versions.length, versions: versions.map((bytes, i) => ({ n: i + 1, by: versionAuthors?.[i] ?? by, at, bytes: bytes.length, sha256: sha256(bytes) })) };
    for (const [i, bytes] of versions.entries()) {
      const path = this.path(id, 'versions', String(i + 1));
      writeAtomic(path, bytes);
      if (cls === 'original') chmodSync(path, 0o444);
    }
    writeJson(this.path(id, 'meta.json'), entry);
    if (!held && !recovery && !pendingObservation(entry)) this.materialise(entry, versions.at(-1)!);
    return entry;
  }

  /** The caller holds the data-home lock. Explicit paths never receive a silent alternate name. */
  attachSource(projectId: string, path: string, mediaType: string, bytes: Uint8Array): Receipt<MaterialEntry> {
    const entries = this.list(projectId, true), problem = sourcePathProblem(path, entries);
    if (problem) return refuse('INVALID', problem);
    const prior = entries.find(entry => entry.name === path);
    if (prior) {
      if (isPersonSource(prior) && !prior.hidden && !prior.held && !prior.recovery && !isWithdrawn(prior) && prior.mediaType === mediaType && prior.current === 1 && prior.versions.length === 1) {
        try { if (sha256(this.bytes(prior.id, 1)) === sha256(bytes)) return { ok: true, value: prior }; }
        catch { return refuse('INVALID', 'The existing original could not be checked; no replacement was attached.'); }
      }
      return refuse('STALE_BASE', 'That source path already holds different or unavailable material. Inspect it before choosing another path.');
    }
    return { ok: true, value: this.create(projectId, path, mediaType, bytes, 'original', 'person', undefined, 'managed', undefined, undefined, undefined, { kind: 'person', path }) };
  }

  /** Host-only restore under the home lock; ordinary v3 input keeps its existing label semantics. */
  async importDocument(projectId: string, name: string, mediaType: string, versions: readonly (string | Uint8Array)[], layout?: MaterialImport): Promise<Receipt<MaterialEntry>> {
    if (!versions.length) return refuse('INVALID', 'A document needs its versions.');
    if (layout) {
      if (layout.projection !== 'managed') return refuse('INVALID', 'That restored document layout is unsupported.');
      if (layout.original && versions.length !== 1) return refuse('INVALID', 'A restored original needs exactly one version.');
      if (layout.versionAuthors && (layout.versionAuthors.length !== versions.length || layout.versionAuthors.some(author => author !== 'person' && author !== 'agent'))) return refuse('INVALID', 'Invalid historical version authors.');
      const entries = this.list(projectId, true);
      const problem = layout.source ? sourcePathProblem(name, entries) : managedPathProblem(name, entries);
      if (problem || entries.some(entry => entry.name === name)) return refuse('INVALID', problem ?? 'That restored document name is already occupied.');
      if (layout.source && (!layout.original || versions.length !== 1 || layout.source.kind !== 'person' || layout.source.path !== name || (layout.versionAuthors && layout.versionAuthors[0] !== 'person'))) return refuse('INVALID', 'That restored source identity is invalid.');
      const bytes = versions.map(version => typeof version === 'string' ? Buffer.from(version) : Buffer.from(version));
      return { ok: true, value: this.createVersions(projectId, name, mediaType, bytes, layout.original ? 'original' : 'accepted', 'person', { id: randomUUID(), projection: 'managed', restored: true, ...(layout.source ? { source: layout.source } : {}) }, layout.versionAuthors) };
    }
    const clean = String(name).split(/[\\/]/).pop() ?? '';
    if (!clean || isIntermediate(clean)) return refuse('INVALID', 'That file name cannot be added.');
    if (!versions.every((version): version is string => typeof version === 'string')) return refuse('INVALID', 'Ordinary document import needs text versions.');
    let entry = this.create(projectId, this.freeName(projectId, clean), String(mediaType), Buffer.from(versions[0]), 'accepted', 'person');
    for (const [i, text] of versions.slice(1).entries()) {
      const result = await this.save(entry.id, text, i + 1, 'person');
      if (!result.ok) return result;
      entry = result.value;
    }
    return { ok: true, value: entry };
  }

  async save(id: string, text: string, baseVersion: number, by: 'person' | 'agent' = 'person'): Promise<Receipt<MaterialEntry>> {
    const identity = resolve(this.path(id));
    if (liveSaves.has(identity)) return refuse('STALE_BASE', 'A Save of this document is still in flight. Wait for its current version.');
    const meta = this.load(id);
    if (!meta) return refuse('NOT_FOUND', `No material ${id}.`);
    if (meta.class === 'original') return refuse('INVALID', `${meta.name} is an original; originals are never modified. Edit a working copy instead.`);
    if (baseVersion !== meta.current) return refuse('STALE_BASE', `${meta.name} is at v${meta.current}; this edit started from v${baseVersion}.`);
    liveSaves.add(identity);
    try {
      const n = meta.current + 1;
      const at = new Date().toISOString();
      writeJson(this.path(id, 'intent.json'), { version: n, at });
      this.crash('after-intent');
      const bytes = Buffer.from(text);
      writeAtomic(this.path(id, 'versions', String(n)), bytes);
      if (this.faults.saveDelayMs) await new Promise((r) => setTimeout(r, this.faults.saveDelayMs));
      this.crash('after-version');
      const next: MaterialEntry = {
        ...meta,
        rewindOperation: undefined,
        class: by === 'person' ? 'accepted' : 'working',
        // A Save on an open editor brings a retired document back: it is someone's current work.
        hidden: meta.recovery ? true : by === 'person' && !meta.held ? false : meta.hidden,
        current: n,
        versions: [...meta.versions, { n, by, at, bytes: bytes.length, sha256: sha256(bytes) }],
      };
      delete next.interruptedSave;
      writeJson(this.path(id, 'meta.json'), next);
      this.crash('after-meta');
      unlinkSync(this.path(id, 'intent.json'));
      if (!next.held) this.materialise(next, bytes);
      return { ok: true, value: next };
    } finally {
      liveSaves.delete(identity);
    }
  }

  /** Keep direct folder edits inspectable as versions before any explicit replacement.
   * Committing metadata only also reconciles a kept racing edit with a retired entry. */
  keepRewindFile(id: string): MaterialEntry {
    const meta = this.load(id)!, path = this.folderPath(meta);
    if (path && !this.rewindPathSafe(path)) throw new Error('The rewind folder path is unavailable.');
    if (!path || !existsSync(path)) return meta;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try { if (!fstatSync(fd).isFile()) throw new Error('Not a regular file.'); bytes = readFileSync(fd); }
    finally { closeSync(fd); }
    const differs = sha256(bytes) !== meta.versions.find(v => v.n === meta.current)?.sha256;
    if (!differs && !meta.hidden && !meta.folderConflict) return meta;
    const n = meta.versions.length + 1;
    if (differs) writeAtomic(this.path(id, 'versions', String(n)), bytes);
    return this.commit({ ...meta, hidden: false, class: 'accepted', folderConflict: undefined, rewindOperation: undefined,
      lifecycle: (meta.lifecycle ?? 0) + 1,
      current: differs ? n : meta.current, versions: differs ? [...meta.versions, { n, by: 'person', at: new Date().toISOString(), bytes: bytes.length, sha256: sha256(bytes) }] : meta.versions });
  }

  /** A person restores immutable bytes; the projection intent and operation survive a kill. */
  rewind(id: string, version: number, operation: string, replaceApplied = false): MaterialEntry {
    const meta = this.load(id)!;
    if (!replaceApplied && meta.rewindOperation === operation) { this.settleProjection(id); return this.load(id)!; }
    const path = this.folderPath(meta);
    if (path && !this.rewindPathSafe(path)) throw new Error('The rewind folder path is unavailable.');
    if (version === 0) return this.commit({ ...meta, hidden: true, rewindOperation: operation, folderConflict: undefined, lifecycle: (meta.lifecycle ?? 0) + 1 }, 'out');
    const bytes = this.bytes(id, version), n = meta.versions.length + 1;
    writeAtomic(this.path(id, 'versions', String(n)), bytes);
    this.crash('rewind-after-version');
    const next: MaterialEntry = { ...meta, current: n, hidden: false, class: 'accepted', rewindOperation: operation, folderConflict: undefined,
      versions: [...meta.versions, { n, by: 'person', at: new Date().toISOString(), bytes: bytes.length, sha256: sha256(bytes) }] };
    return this.commit(next, 'rewind');
  }

  /** Hides or shows an entry, or marks it kept. Every version stays. */
  mark(id: string, change: Pick<MaterialEntry, 'hidden'> & Partial<Pick<MaterialEntry, 'kept' | 'held' | 'unsure' | 'folderConflict'>>): MaterialEntry {
    const prior = this.load(id)!;
    const next: MaterialEntry = { ...prior, ...change, lifecycle: (prior.lifecycle ?? 0) + 1 };
    return this.commit(next, next.held && !prior.held ? 'out' : prior.hidden && !next.hidden ? 'in' : undefined);
  }

  /** The meta file commits the decision and any move it owes the folder; the move follows. */
  private commit(next: MaterialEntry, projecting?: 'in' | 'out' | 'rewind'): MaterialEntry {
    if (pendingObservation(next)) { writeJson(this.path(next.id, 'meta.json'), next); return this.load(next.id)!; }
    const path = projecting === 'out' || projecting === 'rewind' ? this.folderPath(next) : null;
    const folderSha = path && existsSync(path) ? sha256(readFileSync(path)) : undefined;
    writeJson(this.path(next.id, 'meta.json'), projecting ? { ...next, projecting, ...(folderSha ? { folderSha } : {}) } : next);
    if (projecting === 'rewind') this.crash('rewind-after-meta');
    this.settleProjection(next.id);
    return this.load(next.id)!;
  }

  /** Recheck persisted rewind intents on startup as well as at the original preview.
   * Parents must already exist: a moved project is a conflict, never a new grant. */
  private rewindPathSafe(target: string): boolean {
    const home = resolve(this.dir, '..'), within = relative(home, resolve(target));
    if (!within || within === '..' || within.startsWith('../')) return false;
    const parts = within.split('/'); let path = home;
    for (const [index, part] of parts.entries()) {
      path = join(path, part);
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) return false;
      } catch (error) { return index === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT'; }
    }
    return true;
  }

  /**
   * Out of the folder the file is moved aside, not deleted: a person's edit there lives only in that
   * file. Only the file recorded with the decision moves, and it comes back as it left. A different
   * file at that path is never moved or replaced; it is put to the person.
   */
  private settleProjection(id: string) {
    const meta = this.load(id);
    if (!meta?.projecting) return;
    const { projecting, folderSha, ...settled } = meta;
    if (pendingObservation(settled)) { writeJson(this.path(id, 'meta.json'), settled); return; }
    const path = this.folderPath(settled);
    if (path && (projecting === 'rewind' || projecting === 'out' && settled.rewindOperation) && !this.rewindPathSafe(path)) {
      writeJson(this.path(id, 'meta.json'), { ...settled, folderConflict: true }); return;
    }
    const aside = () => readdirSync(this.path(id)).filter((name) => name.startsWith('folder-copy-')).sort().at(-1);
    if (projecting === 'rewind') {
      const bytes = this.bytes(id, settled.current);
      if (!path) this.materialise(settled, bytes);
      else if (existsSync(path) && sha256(readFileSync(path)) === sha256(bytes)) { /* Already projected before interruption. */ }
      else {
        if (existsSync(path)) {
          if (sha256(readFileSync(path)) !== folderSha) settled.folderConflict = true;
          else {
            this.faults.beforeFolderMove?.();
            const copy = this.path(id, `folder-copy-${Date.now()}`);
            renameSync(path, copy);
            this.crash('rewind-after-aside');
            if (sha256(readFileSync(copy)) !== folderSha) { if (!existsSync(path)) renameSync(copy, path); settled.folderConflict = true; }
          }
        }
        if (!settled.folderConflict && !existsSync(path)) this.materialise(settled, bytes);
      }
    } else if (projecting === 'out') {
      if (path && existsSync(path)) {
        if (sha256(readFileSync(path)) === folderSha) {
          this.faults.beforeFolderMove?.();
          // A file can still be swapped between the hash and the rename. Checking what moved closes
          // most of that, not all: a swap back during this check goes unseen, and that window is accepted.
          const copy = this.path(id, `folder-copy-${Date.now()}`);
          renameSync(path, copy);
          if (sha256(readFileSync(copy)) !== folderSha) { if (!existsSync(path)) renameSync(copy, path); settled.folderConflict = true; }
        } else settled.folderConflict = true;
      }
    } else if (!path) this.materialise(settled, this.bytes(id, settled.current));
    else if (existsSync(path)) { if (aside()) settled.folderConflict = true; }
    else {
      const kept = aside();
      if (kept) renameSync(this.path(id, kept), path);
      else this.materialise(settled, this.bytes(id, settled.current));
    }
    writeJson(this.path(id, 'meta.json'), settled);
  }

  /** Finishes any folder move a kill interrupted. */
  settleProjections() {
    if (existsSync(this.dir)) for (const id of readdirSync(this.dir)) this.settleProjection(id);
  }

  /** Ends later work's access to an original, in the store and in the folder. Every version stays. */
  withdraw(id: string): MaterialEntry {
    const meta = this.load(id)!;
    if (isWithdrawn(meta)) { this.signalWithdrawal(); return meta; }
    const next: MaterialEntry = { ...meta, hidden: true, lifecycle: (meta.lifecycle ?? 0) + 1, withdrawals: [...(meta.withdrawals ?? []), { at: new Date().toISOString(), version: meta.current }] };
    try { return this.commit(next, 'out'); } finally { this.signalWithdrawal(); }
  }

  restore(id: string): MaterialEntry {
    const meta = this.load(id)!;
    const next: MaterialEntry = { ...meta, hidden: false, lifecycle: (meta.lifecycle ?? 0) + 1, withdrawals: meta.withdrawals!.map((w, i, all) => (i === all.length - 1 ? { ...w, restoredAt: new Date().toISOString() } : w)) };
    try { return this.commit(next, 'in'); } finally { this.signalWithdrawal(); }
  }

  private signalWithdrawal() {
    // Delivery cannot turn a durable local withdrawal into a reported failure. A failed signal
    // loses no event: opening the owning Host scans the same persisted history again.
    try { this.withdrawalChanged?.(); } catch { /* The outbox remains durable. */ }
  }

  private crash(point: CrashPoint) {
    if (this.faults.crashAt === point) process.kill(process.pid, 'SIGKILL');
  }
}
