import { arenaEvidence } from '../selection/arena.ts';
import { policyView } from '../policy/index.ts';
// The Host's reads: the methods a read-only host answers, and the handlers of those the Host answers
// itself (the rest come from their own pieces: board.get, schedules.get). Moved out of host.ts as
// they were; the Host still decides admission, in its `call`, before any of these runs.
import { join } from 'node:path';
import { selectedHarness, engineLabel } from './engine-settings.ts';
import type { Args, Changes, Method, ModelSettings, Project, Receipt, Result, Thread, ThreadSummary, ViewerPrefs } from '../api.ts';
import { DEFAULT_PREFS } from '../api.ts';
import type { ConnectorService } from '../connectors/service.ts';
import type { CredentialStore } from '../credentials/store.ts';
import { detectLocalModels } from '../models/local.ts';
import type { ModelRoutes } from '../models/route.ts';
import type { HarnessV1 } from '../ports/harness.ts';
import { verifyDeliverables, type WrittenText } from '../selection/verify.ts';
import type { lineDiff } from '../stub/diff.ts';
import { readJson, sha256 } from '../stub/fsx.ts';
import { repositoryChanges } from '../stub/git.ts';
import { isText, type MaterialStore } from '../stub/material.ts';
import { auditReceipt } from './audit-export.ts';
import { BackupRefused, exportHome, inspectExport } from './backup.ts';
import type { createConnectorReadDecisions } from './connector-read-decisions.ts';
import type { CoreLink } from './core.ts';
import { decodeDraft, publicDraft } from './draft-cas.ts';
import type { HARNESSES, harnessConfiguration } from './harnesses.ts';
import { withHomeLock } from './home-lock.ts';
import type { HostOptions } from './host-types.ts';
import type { createProjectFiles } from './project-files.ts';
import { standingSignatureStatus } from './signature-status.ts';
import type { StoredThread } from './thread-journal.ts';

/** What a read-only host answers. Everything else changes something, or can. */
export const READS = new Set<Method>(['threads.rewindPreview', 'audit.export', 'core.signatureStatus', 'backup.export', 'backup.inspect', 'solutions.options', 'solutions.verify', 'projects.list', 'threads.list', 'threads.get', 'material.list', 'material.read', 'files.list', 'files.resolveLink', 'work.now', 'drafts.get', 'changes.get', 'models.list', 'models.local', 'settings.policy.get', 'settings.model.get', 'viewer.get', 'board.get', 'connectors.list', 'schedules.get']);

const refused = <T>(reason: 'NOT_FOUND' | 'NOT_A_REPOSITORY' | 'NOT_AVAILABLE' | 'INVALID' | 'STALE_BASE', detail: string): Receipt<T> => ({ ok: false, reason, detail, outcome: 'REFUSED' });

type Names = 'settings.policy.get' | 'core.signatureStatus' | 'projects.list' | 'threads.list' | 'threads.get' | 'material.list' | 'material.read' | 'files.list' | 'files.resolveLink' | 'work.now' | 'drafts.get' | 'changes.get' | 'models.list' | 'models.local' | 'solutions.options' | 'solutions.verify' | 'settings.model.get' | 'viewer.get' | 'connectors.list' | 'audit.export' | 'backup.export' | 'backup.inspect';

/** What the read handlers use of the Host, under the names they had there. The last three change while it runs, so they are read (and the last one set) through the Host. */
export interface HostReadDeps extends Pick<ReturnType<typeof createProjectFiles>, 'filesOf' | 'linkedPath'> {
  home: string;
  options: Pick<HostOptions, 'localModels' | 'harness'>;
  core: Promise<CoreLink>;
  material: MaterialStore;
  threads: Map<string, StoredThread>;
  running: Map<string, AbortController>;
  routes: ModelRoutes;
  connectors: Pick<ConnectorService, 'list'>;
  credentials: Pick<CredentialStore, 'values'>;
  sourceReads: Pick<ReturnType<typeof createConnectorReadDecisions>, 'needsYou'>;
  harnessConfig: ReturnType<typeof harnessConfiguration>;
  harnessRegistrationInfo: (typeof HARNESSES)[string] | undefined;
  harnessLabel(): string;
  projectDir(id: string): string;
  draftPath(key: string): string;
  versionDiff(id: string, version: number): ReturnType<typeof lineDiff> | null;
  summaryView(t: StoredThread): Promise<ThreadSummary>;
  view(t: StoredThread): Promise<Thread>;
  nowIn(projectId: string): Result<'work.now'>;
  selectFor(task: Args<'solutions.options'>): Promise<{ selection: Result<'solutions.options'> }>;
  readonly projects: (Project & { dir: string })[];
  readonly engine: HarnessV1 | undefined;
  nativeProblem: string | undefined;
}

export function createHostReads(deps: HostReadDeps) {
  const { home, options, core, material, threads, running, routes, connectors, credentials, sourceReads, harnessConfig, harnessRegistrationInfo, harnessLabel, projectDir, draftPath, versionDiff, summaryView, view, nowIn, selectFor, filesOf, linkedPath } = deps;
  const selected = selectedHarness(home, options.harness);
  const label = () => deps.engine?.label ?? engineLabel(selected);
  const handlers: { [M in Names]: (a: Args<M>) => Promise<Result<M>> | Result<M> } = {
    'core.signatureStatus': async () => standingSignatureStatus(await core),
    'projects.list': () => deps.projects.map(({ dir: _dir, ...p }) => p),
    'threads.list': async () => (await Promise.all([...threads.values()].map(summaryView))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    'threads.get': async ({ id }) => {
      const t = threads.get(id);
      return t ? { ok: true, value: await view(t) } : refused('NOT_FOUND', `No thread ${id}.`);
    },
    'material.list': ({ projectId, includeHidden }) => withHomeLock(home, async () => material.list(projectId, includeHidden)),
    'material.read': ({ id, version }) => withHomeLock(home, async () => {
      const entry = material.load(id);
      if (!entry) return refused('NOT_FOUND', `No material ${id}.`);
      const v = version ?? entry.current;
      if (!entry.versions.some((x) => x.n === v)) return refused('NOT_FOUND', `${entry.name} has no v${v}.`);
      const bytes = material.bytes(id, v);
      return { ok: true, value: isText(entry) ? { entry, text: Buffer.from(bytes).toString('utf8') } : { entry, base64: Buffer.from(bytes).toString('base64') } };
    }),
    'files.list': ({ projectId }) => withHomeLock(home, async () => filesOf(projectId)),
    'files.resolveLink': ({ projectId, href }) => withHomeLock(home, async () => {
      if (!deps.projects.some((p) => p.id === projectId)) return refused('NOT_FOUND', 'No such project.');
      const path = linkedPath(projectId, href);
      const file = path === null ? undefined : filesOf(projectId).find((f) => f.materialId && f.group !== 'documents' && f.path === path);
      return file ? { ok: true, value: { materialId: file.materialId!, path: file.path } } : refused('NOT_FOUND', 'That link is not a document in this project.');
    }),
    'work.now': async ({ projectId }) => { const link = await core; return withHomeLock(home, async () => { const now = nowIn(projectId); now.needsYou.push(...sourceReads.needsYou(link, projectId)); return now; }); },
    'drafts.get': ({ key }) => {
      const record = decodeDraft(readJson<unknown>(draftPath(key), null), key);
      return record && publicDraft(record);
    },
    'changes.get': ({ projectId, threadId, scope, base, version }) => {
      const p = deps.projects.find((x) => x.id === projectId);
      if (!p) return refused('NOT_FOUND', 'No such project.');
      if (version) {
        // Only a document of this project, at a version it has: the pane names nothing else.
        const entry = material.load(version.materialId);
        if (!entry || entry.projectId !== projectId || !entry.versions.some((v) => v.n === version.version)) return refused('NOT_FOUND', 'No such document version in this project.');
        const diff = versionDiff(entry.id, version.version);
        const before = version.version > 1 ? `v${version.version - 1}` : 'empty';
        return { ok: true, value: { scope, base: before, bases: [before], files: diff ? [diff] : [] } };
      }
      if (scope === 'last-turn') {
        const t = threadId ? threads.get(threadId) : undefined;
        if (threadId && t?.summary.projectId !== projectId) return refused('NOT_FOUND', 'No such thread in this project.');
        const last = t?.turns.findLast((x) => x.effects.some((e) => e.outcome === 'DONE'));
        const files = (last?.answer?.files ?? []).filter((f) => material.load(f.materialId)?.projectId === projectId).map((f) => versionDiff(f.materialId, f.version)).filter((d) => !!d); // only this project's documents
        return { ok: true, value: { scope, base: 'previous version', bases: ['previous version'], files } satisfies Changes };
      }
      if (p.kind !== 'git') return refused('NOT_A_REPOSITORY', `${p.name} is a folder, not a repository; only "Last turn" applies.`);
      return { ok: true, value: repositoryChanges(projectDir(projectId), scope, base) };
    },
    'models.list': async () => {
      if (harnessConfig.blocked) return [];
      if (selected === 'harness-stub' || selected === 'scripted') return [{ id: 'stub', label: label(), efforts: [1, 2, 3, 4, 5] }];
      const route = routes.resolve();
      if (!deps.engine) return [{ id: route?.model ?? 'none', label: route?.label ?? label(), efforts: [1, 2, 3, 4, 5], ...(harnessRegistrationInfo?.requiresFull ? { permissions: ['full'] as const } : {}) }];
      if (harnessRegistrationInfo?.ownsModel) return [{ id: 'chosen-by-agent', label: route?.label ?? harnessLabel(), efforts: [3] }];
      if (harnessRegistrationInfo?.nativeCatalog && deps.engine.listModels) {
        try {
          const catalog = await deps.engine.listModels();
          deps.nativeProblem = undefined;
          // Nothing chosen yet: the client's first model works, and Settings can change it.
          if (!route && catalog[0]) await routes.change({ route: 'native', provider: 'codex', model: catalog[0].id });
          return [...catalog.filter((model) => model.id === route?.model), ...catalog.filter((model) => model.id !== route?.model)].map((model) => ({ ...model, permissions: ['full'] as const }));
        } catch (error) {
          deps.nativeProblem = error instanceof Error ? error.message : 'The native Codex client is unavailable.';
          return route ? [{ id: route.model, label: 'Codex — check Settings', efforts: [3], permissions: ['full'] }] : [];
        }
      }
      return [{ id: route?.model ?? 'none', label: route ? route.model : 'No model set up', efforts: [1, 2, 3, 4, 5] }];
    },
    'models.local': () => detectLocalModels(options.localModels),
    'solutions.options': async (task) => ({ ...(await selectFor(task)).selection, ...(task.evidenceQuery ? { evidence: await arenaEvidence(task.evidenceQuery) } : {}) }),
    'solutions.verify': async ({ threadId, turnId, deliverables }) => {
      const thread = threads.get(threadId);
      const turn = thread?.turns.find((t) => t.id === turnId);
      if (!thread || !turn) return refused('NOT_FOUND', 'No such turn.');
      // The version each write made is read and checked against the hash it wrote, never the current
      // text by name: a later edit is reported, and cannot make the turn's own output pass or fail.
      const found = new Map<string, WrittenText>();
      for (const name of deliverables) {
        const wrote = turn.effects.findLast((e) => e.target === name && e.outcome === 'DONE');
        if (!wrote) continue;
        if (!wrote.materialId || wrote.version === undefined) { found.set(name, { problem: 'its write did not record the version it made, so that version cannot be read back' }); continue; }
        const read = await handlers['material.read']({ id: wrote.materialId, version: wrote.version });
        if (!read.ok || read.value.text === undefined) { found.set(name, { version: wrote.version, problem: `its v${wrote.version} cannot be read back` }); continue; }
        const later = read.value.entry.versions.filter((v) => v.n > wrote.version!);
        const editedSince = later.length ? [...new Set(later.map((v) => v.by))].join(' and ') + ` (now v${later.at(-1)!.n})` : undefined;
        const same = !wrote.sha256 || sha256(read.value.text) === wrote.sha256;
        found.set(name, { version: wrote.version, ...(editedSince ? { editedSince } : {}), ...(same ? { text: read.value.text } : { problem: `its v${wrote.version} does not match what the turn wrote` }) });
      }
      return { ok: true, value: verifyDeliverables(turn, deliverables, (n) => found.get(n)) };
    },
    'settings.policy.get': () => policyView(home),
    'settings.model.get': (): ModelSettings => ({ ...routes.settings(), ...(deps.nativeProblem ? { hint: deps.nativeProblem } : {}), harness: label() }),
    'viewer.get': () => ({ ...DEFAULT_PREFS, ...readJson<Partial<ViewerPrefs>>(join(home, 'viewer.json'), {}) }),
    // Listing observes only; writable startup and mutations reconcile connector authority.
    'connectors.list': () => connectors.list(),
    'audit.export': async (args) => auditReceipt(await core, args),
    // The person's work, in plain files (backup.ts). Under the home's lock and with no turn running.
    'backup.export': async (args) => {
      const link = await core;
      // A ticket is the transport's to turn into the folder the person picked; here only a path is taken.
      const to = 'to' in args && typeof args.to === 'string' ? args.to : null;
      const picked = 'picked' in args ? args.picked : undefined;
      if (!to) return refused('INVALID', 'Choose the folder in the app\'s own picker: an export goes only where you chose.');
      // Turns this host is carrying now. One a kill interrupted is exported as it stands, as history.
      const busy = running.size;
      if (busy) return refused('NOT_AVAILABLE', `${busy} chat${busy === 1 ? ' is' : 's are'} still working; export once ${busy === 1 ? 'it ends' : 'they end'}, so the export holds what came of ${busy === 1 ? 'it' : 'them'}.`);
      try {
        // Core crossings finish before the home lock: a file snapshot must never retain
        // that lock while waiting for another Core scope. Host ownership keeps this reader exclusive.
        const receipts = (await link.read<{ id: string; status: string; operation: string; description: string | null; created_at: string }>(link.person(), 'SELECT id::text AS id, status, operation, description, created_at FROM app.effects ORDER BY created_at, id')).rows;
        return { ok: true, value: await withHomeLock(home, async () => exportHome({
          home,
          projects: deps.projects.map(({ id, name, kind }) => ({ id, name, kind })),
          documents: (projectId) => material.list(projectId, true),
          versionPath: (id, version) => join(home, 'material', id, 'versions', String(version)),
          threads: [...threads.values()],
          // Read as the person, through the core's own policies: what they can see, never a raw row.
          receipts: async () => receipts,
          secrets: () => credentials.values(),
        }, { to, picked })) };
      } catch (error) {
        if (error instanceof BackupRefused) return refused(error.reason === 'NOT_FOUND' ? 'NOT_FOUND' : error.reason === 'INVALID' ? 'INVALID' : 'NOT_AVAILABLE', error.message);
        throw error;
      }
    },
    'backup.inspect': async ({ from }) => {
      try {
        return { ok: true, value: inspectExport(from).summary };
      } catch (error) {
        if (error instanceof BackupRefused) return refused(error.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID', error.message);
        throw error;
      }
    },
  };
  return { handlers };
}
