// Memory and skills projections of the api port. Imports stay available through api.ts.
import type { Id, Receipt } from './api.ts';

/** Omitted keeps the existing memory behaviour; off applies to this task and its children. */
export interface MemoryTaskSettings { memory?: 'off' }
/** A malformed present value must not silently restore recall at an untyped boundary. */
export const memoryIsOff = (settings?: { memory?: unknown }): boolean => settings?.memory !== undefined;

export interface SkillControlMethods {
  'skills.put': (a: { id: Id; base: string; text: string }) => Receipt<Skill>;
  'skills.remove': (a: { id: Id; base: string }) => Receipt<{ id: Id }>;
  'skills.undo': (a: { id: Id }) => Receipt<{ id: Id }>;
}

export interface SkillChange {
  id: Id;
  name: string;
  at: string;
  op: 'edit' | 'remove';
}

// ---- Memory and skills -----------------------------------------------------

/** A document version a memory came from: it leaves memory when that source is withdrawn. */
export interface MemorySource { id: Id; name: string; version: number }

/** Provenance, never permission: even personal statements are recalled only as reference data. */
export type MemoryTrust = 'personal' | 'imported' | 'untrusted';

/**
 * One remembered line, kept in a plain markdown topic file under the data home that the person can
 * open and edit; what is here is read back from those files. A person's edit wins.
 */
export interface MemoryEntry {
  id: Id;
  topic: string;
  text: string;
  /**
   * `person`, `turn` (written back from the person's own message), `import` and `merge` (a merge the
   * person kept) belong to the person for editing and consolidation. This ownership is separate
   * from provenance trust. `engine`: a line an engine learned, or a merge of such
   * lines that consolidation made; low-risk, so kept by itself with an undo.
   */
  origin: { kind: 'person' | 'turn' | 'import' | 'merge' | 'engine'; threadId?: Id; turnId?: Id; /** The file an import was copied from. */ source?: string };
  /** Computed for stored lines, including legacy metadata; optional on proposals and older clients. */
  trust?: MemoryTrust;
  /** A direct file edit remains visible but is withheld from recall, search and embeddings. */
  unsafe?: 'injection' | 'exfiltration';
  /** The person saved this exact withheld text unchanged to include it as reference; trust stays. */
  scanOverride?: boolean;
  sources: MemorySource[];
  at: string;
  /** On a proposed change (the daily pass, memory.consolidate): the lines it would replace. An empty `text` takes them out and adds none. */
  replaces?: { id: Id; text: string }[];
  /** On a proposal held by consolidation's model judgement: what it judged and why it waits for the person. */
  judged?: MemoryJudged;
  /** On a held change: the sources of everything its pass showed the model. Withdrawing any takes it away. */
  deps?: MemorySource[];
}

/** A consolidation change held for the person: the lines it touches are theirs, or conflict with them. */
export interface MemoryJudged {
  op: 'merge' | 'supersede' | 'retire' | 'hold';
  why: string;
  /** For `supersede`: the newer line that stays. */
  by?: { id: Id; text: string };
  /** The person's lines the model said it contradicts. */
  conflicts: { id: Id; text: string }[];
}

/**
 * A change consolidation made by itself (only lines an engine learned), with what it took out as it
 * was, so `memory.undo` puts it back. Its sources are every source of what it added and took out: it
 * leaves with any of them, and a line it took out whose source was withdrawn never comes back.
 */
export interface MemoryChange {
  id: Id;
  at: string;
  op: 'keep' | 'merge' | 'supersede' | 'retire';
  why: string;
  added: { id: Id; topic: string; text: string } | null;
  removed: MemoryEntry[];
  sources: MemorySource[];
  /** The sources of everything its pass showed the model: withdrawing any redacts its reason. */
  deps?: MemorySource[];
}

/**
 * What a turn was given from memory, and what it left there, by id only: the words live in memory, so
 * a line forgotten or withdrawn later shows as forgotten here too.
 */
export interface TurnMemory {
  /** The task did not read or write memory, instructions or learned skills. */
  off?: true;
  used: Id[];
  /** The person's or the project's instructions were given. */
  instructions: boolean;
  skills: string[];
  remembered: Id[];
}

/**
 * A SKILL.md folder. `available`: found in the person's folders and given to no turn until they enable
 * it. `active`: enabled (pinned to its text then), accepted, or the data home's own. `proposed`: drafted
 * from a finished task, waiting for their OK. `archived`: one of the data home's own, unused for 30
 * days and moved to skills/.archive by the curator; restorable, given to no turn. `edit`: a change to
 * one of the data home's own skills, proposed from the person's correction and held for their OK.
 */
export interface Skill {
  id: Id;
  name: string;
  description: string;
  path: string;
  origin: 'backbone' | 'claude' | 'codex' | 'agents';
  state: 'available' | 'active' | 'proposed' | 'archived' | 'edit';
  /** For an `edit`: the skill it would change, and the change as a line diff ("- " gone, "+ " added). */
  edit?: { of: string; diff: string };
  /** For a `proposed` draft: its whole text, to read before accepting. */
  body?: string;
  /** Text hash for an editor's compare-and-save. Only data-home skills are editable. */
  revision?: string;
  /** Finished turns from which this procedure was drafted; never authority. */
  sourceTurns?: { threadId: Id; turnId?: Id }[];
  /** For a skill a Claude Code or Codex plugin brings: that plugin, as its agent names it (`name@marketplace`). */
  plugin?: string;
  /** Why it cannot be enabled now (a plugin skill holding a credential, or a change that could not be recorded). */
  blocked?: string;
}

/**
 * A command, agent or hook of a Claude Code or Codex plugin the person enabled, read from the plugin
 * layout (commands/*.md, agents/*.md, hooks/hooks.json, and the paths a manifest declares inside the
 * plugin's folder). What a plugin file says is untrusted text: it can raise no permission and enables
 * nothing by itself. `available`: found, used by nothing until the person enables it. `active`: enabled,
 * pinned to its text then; a change to that text makes it `available` again. `not-run`: a hook, which
 * executes commands, so it is listed and never run. `refused`: a path the manifest declares that leaves
 * the plugin's folder, goes through a link or cannot be read safely; nothing of it is read or enabled.
 */
export interface PluginPart {
  id: Id;
  /** The plugin, as its agent names it (`name@marketplace`). */
  plugin: string;
  /** Whose plugin it is: Claude Code's ($HOME/.claude/plugins) or Codex's ($HOME/.codex/plugins). */
  origin: 'claude' | 'codex';
  kind: 'command' | 'agent' | 'hook';
  /** A command's slash name, an agent's name, or a hook's event; for a `refused` path, the path as declared. */
  name: string;
  description: string;
  path: string;
  state: 'available' | 'active' | 'not-run' | 'refused';
  /** The SHA-256 of the file's text as listed: enabling names it, and is refused if the file has changed since. */
  digest: string;
  /** Why it cannot be enabled (it holds a credential, which is withheld from every field here). */
  blocked?: string;
  /** A command's `argument-hint`. */
  argumentHint?: string;
  /** An agent's declared tools, shown as declared: they grant nothing. */
  tools?: string[];
  /** What the person should know before enabling it. */
  note?: string;
}

/** Two skills whose names and descriptions share most of their words: a merge the curator only proposes. */
export interface SkillMerge { id: Id; names: [string, string]; shared: string[] }

/** How skills learn: drafting from complex finished turns (on unless the person turns it off) and the curator's last pass. */
export interface SkillLearning {
  auto: boolean;
  merges: SkillMerge[];
  /** When the curator last ran, or null. */
  curatedAt: string | null;
}

/** What one pass of the curator did: archived (restorable) and proposed; it deletes nothing. */
export interface CuratorReport { archived: string[]; merges: SkillMerge[] }

export interface MemoryView {
  /** The folder that holds it all, to open in the person's own editor. */
  folder: string;
  instructions: { person: string; project: string };
  topics: { slug: string; title: string; count: number }[];
  entries: MemoryEntry[];
  skills: Skill[];
  learning: SkillLearning;
  /** The embeddings model on this computer that recall also asks, by meaning; null for words alone. */
  meaning: MemoryRoute | null;
  /** Lines and changes waiting for the person to keep or discard; none is used until kept. */
  proposed: MemoryEntry[];
  /** Changes consolidation made by itself, newest first, each with an undo (memory.undo). */
  kept: MemoryChange[];
  /** Recent skill edits and removals whose earlier text can be restored. */
  skillChanges?: SkillChange[];
  /** Optional recovery/source records are damaged; facts and unrelated skills remain usable. */
  skillNotice?: string;
}

/** An OpenAI-compatible embeddings endpoint on the loopback, and the model it serves. */
export interface MemoryRoute { baseUrl: string; model: string }

/** Import positions, not payloads: rejected text and URLs are never echoed in the receipt. */
export interface MemoryImportResult {
  added: number;
  /** Optional for older hosts. Line numbers refer to the original source Markdown. */
  skipped?: { source: string; line: number; reason: 'injection' | 'exfiltration' | 'credential' }[];
}
