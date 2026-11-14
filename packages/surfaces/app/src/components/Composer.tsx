import { SharedComposer } from './SharedConversation';
// The composer: the input, and beside it permission, one model+effort control and where it runs
// (R-UX-COMPOSER-01). Unsent text is a server draft, so it survives quit (R-BASE-03).
import type { Effort, MaterialEntry, Permission, PluginPart, RunsOn, TaskNeeds, Thread, TurnSelection, TurnSettings } from '@backbone-next/platform';
import { ArrowUp, Check, Laptop, ListChecks, Paperclip, Plus, ShieldCheck, Square, Target, X } from 'lucide-react';
import * as React from 'react';
import { brand } from '../brand';
import { call, clientKey, toBase64 } from '../lib/api';
import { acceptDraftRead, flushDraft, hasUnconfirmedDraft, hasUncertainDraft, retryUncertainDraft, keepReviewedDraft, persistDraft, persistDraftNow, readDraft, reviewSavedDraft, useReviewedDraft, trackDraftOperation } from '../lib/drafts';
import { useApp, useLive } from '../lib/state';
import { cn } from '../lib/utils';
import { savedSelection, type SelectedSubmission } from '../lib/task-selection';
import { TaskSelectionDialog, type SelectionStart } from './TaskSelection';
import { SettingsDialog } from './SettingsDialog';
import { FileIcon } from './files/kind';
import { DraftConflictCopies } from './DraftConflictCopies';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from './ui/dropdown-menu';

export const PERMISSIONS: { id: Permission; label: string; hint: string }[] = [
  { id: 'full', label: 'Full access', hint: 'Work freely with what this project can reach' },
  { id: 'auto-review', label: 'Auto-review', hint: 'A reviewer model approves routine steps' },
  { id: 'ask', label: 'Ask for approval', hint: 'Ask before anything leaves the workspace' },
];
/** Window event: open the composer's permission menu. */
export const CHOOSE_PERMISSION = 'backbone:choose-permission';
export const EFFORTS = ['Minimal', 'Low', 'Medium', 'High', 'Max'];
const DEFAULT_SETTINGS: TurnSettings = { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' };

const nearestEffort = (effort: Effort, efforts?: Effort[]) =>
  efforts?.length ? efforts.reduce((best, e) => (Math.abs(e - effort) < Math.abs(best - effort) ? e : best)) : effort;

const DISCARDED_RETRY_NOTICE = 'The earlier submission may already exist and its outcome is still unknown here. Discarding its saved retry does not stop that work. Check Chats before starting another task.';
const NO_PROJECT = 'composer:home:none';
const DEFAULT_PROJECT_NAME = 'Personal';
/** "/name args" or "/plugin:name args": a plugin command, when one by that name is enabled. */
const SLASH = /^\/([\w.-]+(?::[\w.-]+)?)(?:\s+([\s\S]*))?$/;
const NO_COMMANDS: PluginPart[] = [];

interface Props {
  projectId?: string;
  threadId?: string;
  running?: boolean;
  recoveryHeld?: boolean;
  /** Whether words can reach the running turn on this engine. */
  steering?: Thread['steering'];
  /** The person pressed Stop and the turn has not ended yet. */
  stopping?: boolean;
  onNeedProject?: () => void;
  onSent?: (threadId: string) => void;
  autoFocus?: boolean;
  previousSelection?: TurnSelection;
  taskMemoryOff?: boolean;
}

export function Composer(props:Props){
  const {remote}=useApp();
  return remote?<SharedComposer projectId={props.projectId} threadId={props.threadId} running={props.running} onSent={props.onSent} />:<LocalComposer {...props} />;
}
function LocalComposer({ projectId, threadId, running, recoveryHeld, steering, stopping, onNeedProject, onSent, autoFocus, previousSelection, taskMemoryOff }: Props) {
  const { prefs, setPrefs, models, projects, showSentNotice, dismissSentNotice, selectProject } = useApp();
  const viewerOnly = projects.find(project=>project.id===projectId)?.access==='viewer';
  const held = React.useRef(recoveryHeld);
  held.current = recoveryHeld;
  const [memoryOff, setMemoryOff] = React.useState(!!taskMemoryOff);
  const chosen: TurnSettings = { ...DEFAULT_SETTINGS, ...prefs.composer };
  // The engine says what each model takes: an unavailable choice never reaches a send.
  // The route picks the model and lists it first, so Settings and this menu are one choice.
  const modelChoice = models[0];
  const settings: TurnSettings = {
    ...chosen,
    memory: memoryOff ? 'off' : undefined,
    model: modelChoice?.id ?? chosen.model,
    effort: nearestEffort(chosen.effort, modelChoice?.efforts),
    permission: modelChoice?.permissions && !modelChoice.permissions.includes(chosen.permission) ? modelChoice.permissions[0] : chosen.permission,
  };
  // The plugin commands the person enabled in Settings; typed as /name, each is filled by the host and sent as their message.
  const commands = useLive(() => call('plugins.parts', {}).then((ps) => (ps ?? []).filter((p) => p.kind === 'command' && p.state === 'active'), () => NO_COMMANDS), [], NO_COMMANDS);
  const setSettings = (patch: Partial<TurnSettings>) => {
    const { memory: _memory, ...ordinary } = settings;
    setPrefs((p) => ({ ...p, composer: { ...ordinary, ...patch }, ...('permission' in patch ? { fullAccessNotice: 'decided' as const } : {}) }));
  };
  const chooseModel = async (model: string) => {
    const r = await call('settings.model.put', { change: { route: 'native', provider: 'codex', model } });
    setError(r.ok ? undefined : r.detail);
  };
  const previousTaskKey = JSON.stringify(previousSelection?.task);
  const previousTask = React.useMemo(() => previousSelection?.task, [previousTaskKey]);
  const draftKey = `composer:${threadId ?? `home:${projectId ?? 'none'}`}`;
  const [text, setText] = React.useState('');
  const [draftState, setDraftState] = React.useState<'empty' | 'draft' | 'saving'>('empty');
  const [attachments, setAttachments] = React.useState<{ id: string; name: string; unavailable?: boolean }[]>([]);
  const [error, setError] = React.useState<string>();
  const [reviewedDraft, setReviewedDraft] = React.useState<{key: string; revision: number; text: string; meta?: Record<string, string | number>}>();
  const [reviewingDraft, setReviewingDraft] = React.useState(false);
  const [confirmSavedDraft, setConfirmSavedDraft] = React.useState(false);
  const [selectionOpen, setSelectionOpen] = React.useState(false);
  const [connectionsOpen, setConnectionsOpen] = React.useState(false);
  const [discardOpen, setDiscardOpen] = React.useState(false);
  const [discarding, setDiscarding] = React.useState(false);
  const [retryNotice, setRetryNotice] = React.useState<string>();
  const retryNoticeRef = React.useRef<string | undefined>(undefined);
  const mounted = React.useRef(true);
  const draftOwner = React.useRef({ key: draftKey, epoch: 0 });
  if (draftOwner.current.key !== draftKey) draftOwner.current = { key: draftKey, epoch: draftOwner.current.epoch + 1 };
  const ownEpoch = draftOwner.current.epoch;
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const ownsDraft = () => mounted.current && draftOwner.current.epoch === ownEpoch;
  const fileInput = React.useRef<HTMLInputElement>(null);
  const area = React.useRef<HTMLTextAreaElement>(null);
  // Home's first-run card asks to choose another permission: open this menu.
  const [permissionOpen, setPermissionOpen] = React.useState(false);
  React.useEffect(() => {
    const open = () => setPermissionOpen(true);
    window.addEventListener(CHOOSE_PERMISSION, open);
    return () => window.removeEventListener(CHOOSE_PERMISSION, open);
  }, []);
  const modelControl = React.useRef<HTMLButtonElement>(null);
  /** Set by a menu choice that hands the keyboard back to the message box. */
  const toComposer = React.useRef(false);
  const isRepo = projects.find((p) => p.id === projectId)?.kind === 'git';

  // Adapted from OpenCode packages/app composer readiness (MIT, 10090335).
  // Restore text AND retry custody before accepting edits; see third_party/opencode-LICENSE.
  const [loadedEpoch, setLoadedEpoch] = React.useState<number>();
  const [loadAttempt, retryLoad] = React.useReducer((n: number) => n + 1, 0);
  const [loadError, setLoadError] = React.useState<string>();
  const draftReady = loadedEpoch === ownEpoch;
  const generation = React.useRef(0);
  const sending = React.useRef(false);
  const [sendPending, setSendPending] = React.useState(false);
  const setSending = (value: boolean) => { sending.current = value; setSendPending(value); };
  const latest = React.useRef({ text: '', ids: [] as string[] });
  // A hand-over whose answer never came may have landed: trying these same words again uses the same key.
  const unanswered = React.useRef<{ how: 'send' | 'queue' | 'steer' | 'selection'; key: string; selected?: SelectedSubmission } | undefined>(undefined);
  const [pending, showPending] = React.useState<typeof unanswered.current>();
  function remember(value?: typeof unanswered.current) { unanswered.current = value; showPending(value); }
  function notice(value?: string) { retryNoticeRef.current = value; setRetryNotice(value); }
  // Enter after Stop is the person's own send: it stays a draft here, and goes as any send once the turn has ended.
  const [stopPressed, setStopPressed] = React.useState(false);
  const [afterStop, setAfterStop] = React.useState<string>();
  const isStopping = !!running && (stopping || stopPressed);
  React.useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => { if (live) setLoadError('Loading your draft is taking longer than expected.'); }, 10000);
    const loading = ++generation.current;
    setLoadedEpoch(undefined);
    setLoadError(undefined);
    setReviewedDraft(undefined);
    setConfirmSavedDraft(false);
    setAfterStop(undefined);
    setDiscardOpen(false);
    notice();
    remember();
    latest.current = { text: '', ids: [] };
    setText('');
    setMemoryOff(!!taskMemoryOff);
    setAttachments([]);
    setDraftState('empty');
    void readDraft(draftKey).then(async (own) => {
      // What was typed before there was a project moves into the first project's new chat.
      const waiting = !own?.text && !own?.meta?.sendKey && projectId && !threadId ? await readDraft(NO_PROJECT) : undefined;
      if (!live || generation.current !== loading) return;
      acceptDraftRead(draftKey, own?.revision ?? 0);
      notice(typeof own?.meta?.retryNotice === 'string' ? own.meta.retryNotice : undefined);
      if (waiting?.text && !waiting.meta?.sendKey) {
        acceptDraftRead(NO_PROJECT, waiting.revision);
        const off = waiting.meta?.memory === 'off';
        // Publish the transferred draft only after its destination and source clear
        // are acknowledged. A reload must not leave old words to be imported again
        // after this task has already been sent. Close joins this continuation too.
        await trackDraftOperation(async () => {
          await persistDraft(draftKey, waiting.text, { attachments: '', ...(off ? { memory: 'off' } : {}), ...(retryNoticeRef.current ? { retryNotice: retryNoticeRef.current } : {}) });
          await persistDraft(NO_PROJECT, '');
        });
        if (!live || generation.current !== loading) return;
        setMemoryOff(off);
        latest.current = { text: waiting.text, ids: [] };
        setText(waiting.text);
        setDraftState('draft');
        return;
      }
      const d = own;
      if (!threadId && d?.meta?.memory === 'off') setMemoryOff(true);
      if (hasUnconfirmedDraft(draftKey)) setError('This draft could not be confirmed. Your local text is kept; review the saved value.');
      if (!d) return;
      const ids = String(d.meta?.attachments ?? '').split(',').filter(Boolean);
      latest.current = { text: d.text, ids };
      if (d.meta?.sendKey) remember({ how: String(d.meta.sendHow) as 'send' | 'queue' | 'steer' | 'selection', key: String(d.meta.sendKey), selected: savedSelection(d.meta.selectionSubmission) });
      setText(d.text);
      setDraftState(d.text ? (d.updatedAt ? 'draft' : 'saving') : 'empty');
      if (!d.updatedAt) void flushDraft(draftKey).then(() => {
        if (live && generation.current === loading) setDraftState(d.text ? 'draft' : 'empty');
      }).catch((error: unknown) => live && setError(`The draft could not be saved: ${String(error)}`));
      if (ids.length) await Promise.all(ids.map((id) => call('material.read', { id }).catch(() => null))).then((rs) => live && generation.current === loading && setAttachments(rs.map((r, i) => r?.ok ? r.value.entry : { id: ids[i], name: `Unavailable source ${i + 1}`, unavailable: true })));
    }).then(() => {
      if (live) { window.clearTimeout(timer); setLoadedEpoch(ownEpoch); }
    }).catch((error: unknown) => {
      if (live) { window.clearTimeout(timer); setLoadError(`Your draft could not be loaded: ${String(error)}`); }
    });
    return () => { live = false; window.clearTimeout(timer); };
  }, [draftKey, loadAttempt]);

  React.useEffect(() => {
    if (draftReady && autoFocus && document.activeElement === document.body) area.current?.focus();
  }, [draftReady, autoFocus]);

  const update = (value: string, ids = latest.current.ids, off = memoryOff) => {
    const edit = ++generation.current;
    if (unanswered.current?.how !== 'selection') remember();
    setAfterStop(undefined);
    latest.current = { text: value, ids };
    setText(value);
    setDraftState('saving');
    const savingDraft = persistDraft(draftKey, value, draftMeta(ids, true, off));
    void savingDraft.then(() => {
      if (generation.current === edit) setDraftState(value ? 'draft' : 'empty');
    }).catch((error: unknown) => {
      if (generation.current === edit) setError(`The draft could not be saved: ${String(error)}`);
    });
    return savingDraft;
  };

  function attach(files: FileList | null) {
    return trackDraftOperation(async () => {
      if (!draftReady || !files?.length) return;
      if (!projectId) return onNeedProject?.();
      const added: MaterialEntry[] = [];
      for (const f of Array.from(files)) {
        const r = await call('material.attach', { projectId, name: f.name, mediaType: f.type || 'application/octet-stream', base64: toBase64(await f.arrayBuffer()) });
        if (r.ok) added.push(r.value);
        else setError(r.detail);
      }
      const next = [...attachments, ...added];
      setAttachments(next);
      update(latest.current.text, next.map((a) => a.id));
    });
  }

  function pendingSelectionMeta() {
    const pending = unanswered.current;
    return pending?.how === 'selection' ? { sendKey: pending.key, sendHow: pending.how, ...(pending.selected ? { selectionSubmission: JSON.stringify(pending.selected) } : {}) } : {};
  }

  function draftMeta(ids: string[], keepPending = true, off = memoryOff) {
    return { attachments: ids.join(','), ...(!threadId && off ? { memory: 'off' } : {}), ...(retryNoticeRef.current ? { retryNotice: retryNoticeRef.current } : {}), ...(keepPending ? pendingSelectionMeta() : {}) };
  }

  /** What was just handed over leaves the composer; anything typed since stays. */
  function handedOver(submitted: number) {
    if (!ownsDraft()) return;
    const selected = unanswered.current?.how === 'selection';
    remember();
    notice();
    dismissSentNotice();
    if (generation.current !== submitted) {
      // Confirming the old submission releases its retry lock, never the newer draft.
      if (selected) void persistDraft(draftKey, latest.current.text, { attachments: latest.current.ids.join(',') }).catch((error: unknown) => setError(`Your newer draft could not be saved: ${String(error)}`));
      return;
    }
    ++generation.current;
    latest.current = { text: '', ids: [] };
    setText('');
    setAttachments([]);
    setDraftState('empty');
    const clearing = generation.current;
    void persistDraft(draftKey, '').catch((error: unknown) => {
      if (generation.current === clearing) setError(`The message was kept, but its draft could not be cleared: ${String(error)}`);
    });
  }

  /** The key for this try: the same as a try of these same words whose answer never came, which may have landed. */
  async function keyFor(how: 'send' | 'queue' | 'steer' | 'selection', selected?: SelectedSubmission) {
    if (unanswered.current && unanswered.current.how !== how) {
      setError('The last try was never answered. Check the chat, or try that same way again.');
      return undefined;
    }
    if (!unanswered.current) {
      const key = clientKey();
      const attempt = { how, key, selected };
      // Reserve selection custody before awaiting its durable write: edits must keep this snapshot.
      if (how === 'selection') remember(attempt);
      // With the draft and before the words leave, so a reload that keeps them keeps their key.
      // Limit: edited away and back, then reloaded before the edit is written, the old key returns.
      // It then answers with the original turn: that starts nothing and loses nothing.
      try {
        await persistDraftNow(draftKey, latest.current.text, { ...draftMeta(latest.current.ids, false), sendKey: key, sendHow: how, ...(selected ? { selectionSubmission: JSON.stringify(selected) } : {}) });
      } catch (error) {
        if (unanswered.current === attempt) remember();
        setError(`Nothing was sent: this message could not be made safe to retry: ${String(error)}`);
        return undefined;
      }
      remember(attempt);
    }
    return unanswered.current?.key;
  }

  /** The words to send: a plugin command's filled template for "/name <words>" when one by that name is enabled; null, with why, when it cannot be filled. */
  async function filled(words: string): Promise<string | null> {
    const slash = SLASH.exec(words.trim());
    if (!slash || slash[1] === 'goal' || !commands.some((c) => c.name === slash[1].split(':').at(-1))) return words;
    const r = await call('plugins.command', { name: slash[1], args: slash[2]?.trim() ?? '' });
    if (r.ok) return r.value.text;
    remember();
    setError(r.detail);
    return null;
  }

  /** While a turn runs: to wait for it, or to reach it. A refusal keeps the text here. */
  function alongside(how: 'queue' | 'steer') {
    return trackDraftOperation(async () => {
      if (held.current || !draftReady || !text.trim() || !threadId || sending.current) return;
      setSending(true);
      const key = await keyFor(how);
      if (!key) { setSending(false); return; }
      const submitted = generation.current;
      setError(undefined);
      try {
        // "/name <words>" is filled whether it waits for the turn or reaches it as a steer.
        const words = await filled(text);
        if (words === null || held.current) return;
        const r = how === 'queue'
          ? await call('queue.add', { threadId, text: words, attachments: latest.current.ids, settings, clientKey: key })
          : await call('turns.steer', { threadId, text: words, clientKey: key });
        if (r.ok) handedOver(submitted);
        else { remember(); setError(r.detail); }
      } catch (error) {
        setError(`That could not be confirmed. Check the chat before trying again: ${String(error)}`);
      } finally {
        setSending(false);
      }
    });
  }

  async function finishSend(sentTo: string, submitted: number, goal?: string, enterProject?: string) {
    if (ownsDraft()) handedOver(submitted);
    else showSentNotice(sentTo);
    // The requested /goal setup remains authorized even if its view has been left.
    try {
      if (goal) {
        const current = await call('threads.get', { id: sentTo });
        const set = await call('goals.set', { threadId: sentTo, text: goal, baseVersion: current.ok ? current.value.goal?.version ?? 0 : 0 });
        if (!set.ok) setError(`Your message was sent, but the goal was not set: ${set.detail}`);
        else {
          // As on the command line: a goal set this way runs until a check finds it met.
          const ran = await call('goals.run', { threadId: sentTo, budget: 5 });
          if (!ran.ok) setError(`The goal is set, but it is not running: ${ran.detail}`);
        }
      }
    } catch {
      showSentNotice(sentTo, 'Your message was sent, but goal setup could not be confirmed. Check the chat before retrying the goal.');
      if (ownsDraft()) setError('Your message was sent, but goal setup could not be confirmed. Check its chat before retrying the goal.');
    }
    if (!ownsDraft()) return;
    const nextKey = `composer:${sentTo}`;
    if (nextKey !== draftKey && (latest.current.text || latest.current.ids.length)) {
      // A destination acknowledgement precedes clearing the source. If typing continues
      // during that acknowledgement, transfer its newer generation before navigation too.
      for (;;) {
        const transferring = generation.current;
        const snapshot = latest.current;
        try { await persistDraft(nextKey, snapshot.text, { attachments: snapshot.ids.join(',') }); }
        catch (error) { setError(`Your message was sent. The newer typing remains here because its chat draft could not be saved: ${String(error)}`); return; }
        if (!ownsDraft()) return;
        if (generation.current !== transferring) continue;
        void persistDraft(draftKey, '').catch(() => {});
        break;
      }
    }
    if (!ownsDraft()) return;
    // The default project is chosen only now, after the words are acknowledged and the home draft is clear, so its new composer imports nothing.
    if (enterProject) selectProject(enterProject);
    onSent?.(sentTo);
  }

  function send() {
    if (held.current || !draftReady || viewerOnly) return Promise.resolve();
    return trackDraftOperation(async () => {
      if (held.current || !text.trim() || running || sending.current) return;
      if (!projectId && !threadId && !onNeedProject) return;
      setSending(true);
      const submitted = generation.current;
      const submittedIds = [...latest.current.ids];
      const key = await keyFor('send');
      if (!key) { setSending(false); return; }
      setError(undefined);
      // "/goal <words>" sets the chat's goal and starts work on it with those words.
      const goal = /^\/goal\s+([\s\S]+)$/.exec(text.trim())?.[1].trim();
      // "/name <words>" with a plugin command of that name enabled: its template, filled with the words, is the message.
      try {
        const words = goal ?? await filled(text);
        if (words === null || held.current) return;
        // With no project yet, the first send makes the default one and sends at once, as Codex does.
        // The project's key comes from this send's key, so a retry of unanswered words finds the same project.
        let sendProject = projectId;
        let madeProject: string | undefined;
        if (!sendProject) {
          const existing = projects.find((p) => p.name === DEFAULT_PROJECT_NAME) ?? projects[0];
          if (existing) sendProject = existing.id;
          else {
            const made = await call('projects.create', { name: DEFAULT_PROJECT_NAME, kind: 'folder', clientKey: `${key}:project` });
            if (!made.ok) { remember(); return setError(made.detail); }
            sendProject = madeProject = made.value.id;
          }
        }
        const r = await call('turns.send', { threadId, projectId: sendProject, text: words, attachments: submittedIds, settings, clientKey: key });
        if (!r.ok) { remember(); return setError(r.detail); }
        try { await finishSend(r.value.threadId, submitted, goal, madeProject ?? (projectId ? undefined : sendProject)); }
        catch {
          showSentNotice(r.value.threadId, 'Your message was sent, but its view could not be restored. Open its chat before sending it again.');
          setError('Your message was sent, but its view could not be restored. Open it from Chats; newer typing is kept.');
        }
      } catch (error) {
        setError(`The message could not finish sending: ${String(error)}`);
      } finally {
        setSending(false);
      }
    });
  }

  const submissionSettings = pending?.selected?.settings ?? settings;
  const executionSummary = `${pending?.how === 'selection' ? 'Original submission' : 'Execution preferences'}: ${PERMISSIONS.find((p) => p.id === submissionSettings.permission)?.label ?? submissionSettings.permission} · ${EFFORTS[submissionSettings.effort - 1]} effort · ${submissionSettings.runsOn === 'this-computer' ? 'This computer' : 'Cloud'} · ${submissionSettings.mode === 'plan' ? 'Plan' : 'Chat'} mode`;
  const selectionText = pending?.selected?.text ?? text;
  const selectionUnavailable = recoveryHeld ? 'This conversation is waiting for recovery.' : !draftReady ? 'Wait for your saved draft to load.' : !projectId ? 'Choose or create a project before selecting a route.'
    : running ? 'Wait for this turn to finish before selecting another route.'
    : !selectionText.trim() ? 'Write the task in the composer first.'
    : selectionText.trim().startsWith('/') ? 'Slash commands use ordinary Send. Write a task in plain words to compare routes.'
    : pending?.how === 'selection' && !pending.selected ? 'The saved selection could not be restored safely. Check the chat before editing or sending another request.' : undefined;

  function runSelected(task: TaskNeeds): Promise<SelectionStart> {
    return trackDraftOperation(async () => {
      if (selectionUnavailable || sending.current || !projectId) return { started: false, detail: selectionUnavailable ?? 'A submission is already in progress.' };
      if (unanswered.current?.how === 'selection' && !unanswered.current.selected) return { started: false, detail: 'The saved selection could not be restored safely. Check Chats or discard its saved retry.' };
      const selected = unanswered.current?.selected ?? { projectId, threadId, text, attachments: [...latest.current.ids], task, settings };
      if (selected.projectId !== projectId || selected.threadId !== threadId) return { started: false, detail: 'This saved submission belongs to another chat. Nothing was sent.' };
      const submitted = latest.current.text === selected.text && JSON.stringify(latest.current.ids) === JSON.stringify(selected.attachments) ? generation.current : -1;
      setSending(true);
      setError(undefined);
      try {
        const key = await keyFor('selection', selected);
        if (!key) return { started: false, detail: 'The submission is not ready to retry. Check the composer message.' };
        if (held.current) return { started: false, detail: 'This conversation is waiting for recovery.' };
        const r = await call('solutions.run', { ...selected, clientKey: key });
        if (!ownsDraft()) {
          if (r.ok && r.value.started) showSentNotice(r.value.started.threadId);
          return { started: r.ok && !!r.value.started, detail: 'Check Chats for the original submission; its saved retry remains with its draft.' };
        }
        if (!r.ok && r.outcome === 'UNKNOWN') {
          const detail = `The route submission has an unknown outcome: ${r.detail} Check the chat or retry the existing submission; its saved key is retained.`;
          setError(detail);
          return { started: false, detail };
        }
        if (!r.ok || !r.value.started) {
          remember();
          void persistDraft(draftKey, latest.current.text, draftMeta(latest.current.ids, false)).catch(() => {});
          const detail = r.ok ? r.value.detail : r.detail;
          setError(detail);
          return { started: false, detail, ...(r.ok ? { selection: r.value.selection } : {}) };
        }
        try { await finishSend(r.value.started.threadId, submitted); }
        catch { setError('The selected turn started, but its view could not be restored. Open it from Chats; your newer draft is kept.'); }
        return { started: true };
      } catch {
        const detail = 'The route submission could not be confirmed. Your message is kept; check the chat or retry the existing submission with the same saved key.';
        setError(detail);
        return { started: false, detail };
      } finally { setSending(false); }
    });
  }

  function discardSelection() {
    return trackDraftOperation(async () => {
      if (sending.current || discarding || unanswered.current?.how !== 'selection') return;
      setDiscarding(true);
      notice(DISCARDED_RETRY_NOTICE);
      try {
        // Retry the exact uncertain write before making a newer one.
        if (hasUncertainDraft(draftKey)) await retryUncertainDraft(draftKey);
        // Edits during this write must also lose the discarded retry identity, never their text/sources.
        for (;;) {
          if (!ownsDraft()) return;
          const edit = generation.current, snapshot = latest.current;
          await persistDraftNow(draftKey, snapshot.text, draftMeta(snapshot.ids, false));
          if (!ownsDraft()) return;
          if (generation.current !== edit) continue;
          remember();
          setDiscardOpen(false); setError(undefined);
          setDraftState(snapshot.text || snapshot.ids.length ? 'draft' : 'empty');
          break;
        }
      } catch (error) {
        // A confirmed conflict needs the review controls outside this dialog.
        if (hasUnconfirmedDraft(draftKey) && !hasUncertainDraft(draftKey)) setDiscardOpen(false);
        setError(`Discard could not be confirmed. Saving may still apply it later; your text and sources are kept. Check Chats before sending another task: ${String(error)}`);
      }
      finally { setDiscarding(false); }
    });
  }

  /** While the turn is stopping nothing is queued: the words wait here, and go once it has ended. */
  const alongsideOrAfterStop = () => { if (held.current) return; if (isStopping) setAfterStop(draftKey); else void alongside('queue'); };
  React.useEffect(() => {
    if (running) return;
    setStopPressed(false);
    // Named by its chat: a render that has moved to another chat sends nothing.
    if (afterStop) { setAfterStop(undefined); if (afterStop === draftKey) void send(); }
  }, [running, afterStop]); // eslint-disable-line react-hooks/exhaustive-deps

  const model = models.find((m) => m.id === settings.model) ?? models[0];
  const efforts = [...new Set(model?.efforts ?? [])].sort((a, b) => a - b);
  const effortAllowed = efforts.includes(settings.effort);
  const permission = PERMISSIONS.find((p) => p.id === settings.permission) ?? PERMISSIONS[0];

  return (
    <div className="w-full" data-testid="composer" aria-busy={!draftReady}>
    {viewerOnly&&<p role="status" className="mb-2 text-xs text-muted">Viewer access: this project is read only.</p>}
    <DraftConflictCopies draftKey={draftKey} />
    {!draftReady && <p role="status" className="mb-2 text-xs text-muted">{loadError ?? 'Loading draft…'}{loadError && <button type="button" className="ml-2 underline" onClick={() => retryLoad()}>Try loading again</button>}</p>}
    {connectionsOpen && <SettingsDialog open onOpenChange={setConnectionsOpen} section="model-route" onReturnFocus={() => modelControl.current?.focus()} />}
    <TaskSelectionDialog key={draftKey} open={selectionOpen} onOpenChange={setSelectionOpen} text={selectionText} initialTask={pending?.selected?.task ?? previousTask} locked={pending?.how === 'selection'} unavailable={selectionUnavailable} executionSummary={executionSummary} onReturnFocus={() => area.current?.focus()} onRun={runSelected} />
    {pending?.how === 'selection' && <div className="mb-2 text-xs text-draft"><p role="status">An earlier route submission is unconfirmed. New edits stay in your draft; retry the original submission before sending another task.</p><button type="button" className="mt-1 underline" disabled={sendPending || discarding} onClick={() => setDiscardOpen(true)}>Discard saved retry…</button></div>}
    {retryNotice && <p role="status" data-testid="discarded-retry-notice" className="mb-2 text-xs text-draft">{retryNotice}</p>}
    <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
      <DialogContent title="Discard saved retry?" description="This forgets only the local retry record. The earlier turn may already exist. It does not stop work, remove a chat, cancel a request or resolve uncertain effects. Check Chats before starting another task." onCloseAutoFocus={(e) => { e.preventDefault(); area.current?.focus(); }}>
        <p className="text-sm">Your current draft and attached sources will stay here.</p>
        {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2"><Button variant="ghost" disabled={discarding} onClick={() => setDiscardOpen(false)}>Keep saved retry</Button><Button disabled={discarding || sendPending} onClick={() => void discardSelection()}>{discarding ? 'Discarding…' : 'Discard saved retry'}</Button></div>
      </DialogContent>
    </Dialog>
    {previousSelection && !running && <p className="mb-2 text-xs text-muted" data-testid="selection-followup">Last selected route: {previousSelection.pinned.label}. Check the next turn’s route record and outcome. <button type="button" className="underline" onClick={() => setSelectionOpen(true)}>Review or change requirements</button></p>}
    <div className="w-full rounded-2xl border border-border bg-surface shadow-sm focus-within:border-strong-border focus-within:ring-1 focus-within:ring-strong-border">
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 px-3 pt-3" aria-label="Attachments">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs" data-testid="attachment-chip" data-unavailable={a.unavailable || undefined} title={a.unavailable ? 'This source could not be read. Its ID is retained; remove it or restore access before sending.' : undefined}>
              <FileIcon name={a.name} className="size-3.5" />
              <span className="max-w-40 truncate">{a.name}</span>
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                disabled={!draftReady}
                className="rounded text-muted hover:text-fg"
                onClick={() => {
                  const next = attachments.filter((x) => x.id !== a.id);
                  setAttachments(next);
                  update(text, next.map((x) => x.id));
                }}
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="sr-only" htmlFor={`composer-${draftKey}`}>
        Message
      </label>
      {text.startsWith('/') && !/\s/.test(text) && (() => {
        const typed = text.slice(1).split(':').at(-1) ?? '';
        const matching = commands.filter((c) => c.name.startsWith(typed));
        return matching.length > 0 && (
          <ul className="px-3 pt-2 text-xs text-muted" aria-label="Plugin commands" data-testid="command-hint">
            {matching.slice(0, 6).map((c) => <li key={c.id}><span className="font-medium text-fg">/{c.name}</span>{c.argumentHint ? ` ${c.argumentHint}` : ''} · {c.description || c.plugin}</li>)}
          </ul>
        );
      })()}
      <div className="flex items-end gap-1 px-2 py-2">
          <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Add" disabled={!draftReady}>
              <Plus />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" onCloseAutoFocus={(e) => { if (!toComposer.current) return; toComposer.current = false; e.preventDefault(); area.current?.focus(); }}>
            <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
              <Paperclip /> Add files…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => { if (!/^\/goal\b/.test(text)) update(`/goal ${text}`); toComposer.current = true; }}>
              <Target /> Set a goal
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setSettings({ mode: settings.mode === 'plan' ? 'chat' : 'plan' })}>
              <ListChecks /> Plan mode {settings.mode === 'plan' && <Check className="ml-auto" />}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      <textarea
        id={`composer-${draftKey}`}
        ref={area}
        disabled={!draftReady}
        value={text}
        rows={1}
        placeholder={settings.mode === 'plan' ? 'Describe what to plan…' : `Ask ${brand.name} anything`}
        className="block max-h-60 min-w-0 flex-1 resize-none bg-transparent py-1 text-[15px] leading-6 [field-sizing:content] outline-none focus-visible:outline-none placeholder:text-muted"
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (running && threadId) alongsideOrAfterStop(); else void send();
          }
        }}
      />
      <input ref={fileInput} type="file" multiple hidden disabled={!draftReady} data-testid="attach-input" onChange={(e) => void attach(e.target.files).then(() => (e.target.value = ''))} />
              <span className="flex items-center gap-2">
          <span className={cn('text-xs text-muted', draftState === 'empty' && 'hidden')} data-testid="draft-state">
            {draftState === 'saving' ? 'Saving draft…' : 'Draft saved'}
          </span>
          {running ? (
            <Button key="stop" size="icon" variant="outline" aria-label="Stop" onClick={() => { if (!threadId) return; setStopPressed(true); void call('turns.stop', { threadId }); }}>
              <Square className="fill-current" />
            </Button>
          ) : (
            <Button key="send" size="icon" className="rounded-full" aria-label="Send" disabled={viewerOnly || !!recoveryHeld || !draftReady || !text.trim() || !effortAllowed} onClick={() => void send()}>
              <ArrowUp />
            </Button>
          )}
        </span>
      </div>
      {running && !recoveryHeld && threadId && text.trim() && (
        <div className="flex justify-end gap-1 px-2 pb-2">
          {steering?.available && !isStopping && attachments.length === 0 && <Button size="sm" variant="ghost" onClick={() => void alongside('steer')}>Steer</Button>}
          {afterStop === draftKey ? <span role="status" className="px-1 py-1 text-xs text-muted" data-testid="after-stop">Sends when this turn has stopped</span>
            : <Button size="sm" variant="outline" onClick={alongsideOrAfterStop}>{isStopping ? 'Send when stopped' : 'Send when done'}</Button>}
        </div>
      )}
      {running && text.trim() && steering && !steering.available && <p role="status" className="px-4 pb-2 text-xs text-muted" data-testid="no-steer">{steering.detail}</p>}
      {running && text.trim() && steering?.available && attachments.length > 0 && <p role="status" className="px-4 pb-2 text-xs text-muted">Files go with a message, not into a running turn. Send when done keeps them together.</p>}
      {!running && model && !effortAllowed && <p role="status" className="px-4 pb-2 text-xs text-muted">Choose a supported effort level for {model.label}.</p>}
      {error && <div className="px-4 pb-2 text-xs text-danger">
        <p role="alert">{error}</p>
        {hasUncertainDraft(draftKey) && <button type="button" className="underline mr-2" disabled={reviewingDraft} onClick={() => {
          setReviewingDraft(true);
          void retryUncertainDraft(draftKey).then(() => flushDraft(draftKey)).then(() => reviewSavedDraft(draftKey)).then(saved => {
            if (!ownsDraft()) return;
            if (saved?.meta?.sendKey) remember({how:String(saved.meta.sendHow) as 'send' | 'queue' | 'steer' | 'selection',key:String(saved.meta.sendKey),selected:savedSelection(saved.meta.selectionSubmission)});
            setError(undefined);
          }).catch((e:unknown) => { if (ownsDraft()) setError(`The draft could not be saved: ${String(e)}`); })
            .finally(() => { if (ownsDraft()) setReviewingDraft(false); });
        }}>Retry saving draft</button>}
        {hasUnconfirmedDraft(draftKey) && <button type="button" className="underline" disabled={reviewingDraft} onClick={() => {
          setReviewingDraft(true);
          void reviewSavedDraft(draftKey).then(saved => { if (ownsDraft()) setReviewedDraft({key:draftKey, revision:saved?.revision ?? 0, text:saved?.text ?? '', meta:saved?.meta}); })
            .catch((e: unknown) => { if (ownsDraft()) setError(`The saved draft could not be read: ${String(e)}`); })
            .finally(() => { if (ownsDraft()) setReviewingDraft(false); });
        }}>Review saved draft</button>}
        {reviewedDraft?.key === draftKey && <div className="mt-2 text-fg">
          <p>Saved draft:</p><pre className="whitespace-pre-wrap break-words">{reviewedDraft.text || '(empty)'}</pre>
          {reviewedDraft.meta && Object.keys(reviewedDraft.meta).length > 0 && <><p>Saved draft details:</p><pre className="whitespace-pre-wrap break-words">{JSON.stringify(reviewedDraft.meta, null, 2)}</pre></>}
          <p>Your current text stays in the composer. Keeping it will replace the saved draft if it has not changed again.</p>
          {reviewedDraft.meta?.sendKey && <p>The saved draft contains an unconfirmed submission. Resolve it in its original conversation before replacing this draft.</p>}
          <button type="button" className="underline" disabled={reviewingDraft || !!reviewedDraft.meta?.sendKey} onClick={() => {
            setReviewingDraft(true);
            void keepReviewedDraft(draftKey, reviewedDraft.revision, latest.current.text, draftMeta(latest.current.ids)).then(() => {
              if (ownsDraft()) { setReviewedDraft(undefined); setError(undefined); }
            }).catch((e: unknown) => { if (ownsDraft()) { setReviewedDraft(undefined); setError(`The draft could not be saved: ${String(e)}`); } })
              .finally(() => { if (ownsDraft()) setReviewingDraft(false); });
          }}>Keep my draft</button>{' '}
          {!confirmSavedDraft ? <button type="button" className="underline" disabled={reviewingDraft} onClick={() => setConfirmSavedDraft(true)}>Use saved draft</button> : <div>
            <p>This replaces your local text and attachments with the saved draft. An earlier submission may still have happened; this does not cancel or resolve it.</p>
            <button type="button" className="underline mr-2" onClick={() => setConfirmSavedDraft(false)}>Cancel</button>
            <button type="button" className="underline" disabled={reviewingDraft} onClick={() => {
              setReviewingDraft(true);
              void useReviewedDraft(draftKey, reviewedDraft.revision).then(async saved => {
                if (!ownsDraft()) return;
                if (!threadId) setMemoryOff(saved.meta?.memory === 'off');
                const ids = String(saved.meta?.attachments ?? '').split(',').filter(Boolean);
                ++generation.current; latest.current = {text:saved.text, ids}; setText(saved.text); setDraftState(saved.text ? 'draft' : 'empty');
                if (saved.meta?.sendKey) remember({how:String(saved.meta.sendHow) as 'send' | 'queue' | 'steer' | 'selection', key:String(saved.meta.sendKey), selected:savedSelection(saved.meta.selectionSubmission)}); else remember();
                const entries = await Promise.all(ids.map(id => call('material.read', {id}).catch(() => null)));
                if (ownsDraft()) { setAttachments(entries.map((r,i) => r?.ok ? r.value.entry : {id:ids[i], name:`Unavailable source ${i + 1}`, unavailable:true})); setReviewedDraft(undefined); setConfirmSavedDraft(false); setError(undefined); }
              }).catch((e: unknown) => { if (ownsDraft()) { setReviewedDraft(undefined); setConfirmSavedDraft(false); setError(`The saved draft could not be confirmed: ${String(e)}`); } })
                .finally(() => { if (ownsDraft()) setReviewingDraft(false); });
            }}>Replace my local draft</button>
          </div>}
        </div>}
      </div>}
    </div>
    <div className="@container flex min-w-0 items-center gap-1 px-2 pt-1 text-muted">
        <DropdownMenu open={permissionOpen} onOpenChange={setPermissionOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={`Permissions: ${permission.label}`}>
              <ShieldCheck /> <span className="hidden @md:inline">{permission.label}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel>How should actions be approved?</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={settings.permission} onValueChange={(v) => setSettings({ permission: v as Permission })}>
              {PERMISSIONS.map((p) => (
                <DropdownMenuRadioItem key={p.id} value={p.id} className="flex-col items-start gap-0">
                  <span>{p.label}</span>
                  <span className="text-xs text-muted">{p.hint}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {!threadId && <Button variant="ghost" size="sm" aria-label="Use memory for this task" title={`${brand.name} memory for this task. Your engine’s own memory settings still apply.`} aria-pressed={!memoryOff} disabled={!draftReady || sendPending || !!pending} onClick={() => {
          const next = !memoryOff; setMemoryOff(next);
          void persistDraft(draftKey, latest.current.text, { ...draftMeta(latest.current.ids), memory: next ? 'off' : 'on' }).catch(() => setError('The memory choice could not be saved.'));
        }}>{memoryOff ? 'Memory off' : 'Memory on'}</Button>}
        {threadId && taskMemoryOff && <span className="text-xs text-muted" data-testid="task-memory-off">Memory off for this task</span>}
        {settings.mode === 'plan' && <span className="rounded-full bg-pending-bg px-2 py-0.5 text-xs text-pending">Plan mode</span>}
      <span className="ml-auto" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={modelControl} variant="ghost" size="sm" aria-label={`Model and effort: ${model?.label ?? ''}, ${effortAllowed ? EFFORTS[settings.effort - 1] : 'Choose effort'}`}>
              <span className="max-w-28 truncate">{model?.id === 'stub' ? 'Stub' : model?.label}</span>
              <span className="text-muted">· {effortAllowed ? EFFORTS[settings.effort - 1] : 'Choose effort'}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuItem onSelect={() => setSelectionOpen(true)}>Choose route for this task…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Effort</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={String(settings.effort)} onValueChange={(v) => setSettings({ effort: Number(v) as Effort })}>
              {efforts.map((effort) => <DropdownMenuRadioItem key={effort} value={String(effort)}>{EFFORTS[effort - 1]}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
            {efforts.length === 0 && <DropdownMenuItem disabled>No effort levels available</DropdownMenuItem>}
            <DropdownMenuSeparator />
              {previousSelection && <DropdownMenuLabel className="whitespace-normal text-xs font-normal">The last task selection is recorded in the chat. Your explicit model and approval choices remain visible here; compare routes again to change task requirements.</DropdownMenuLabel>}
            {models.length > 1 && <DropdownMenuSub>
              <DropdownMenuSubTrigger>Model: {model?.label}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={settings.model} onValueChange={(v) => void chooseModel(v)}>
                  {models.map((m) => (
                    <DropdownMenuRadioItem key={m.id} value={m.id}>
                      {m.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>}
            <DropdownMenuItem onSelect={() => setConnectionsOpen(true)}>Model connections…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={`Work in: ${settings.runsOn === 'cloud' ? 'Cloud' : 'This computer'}`}>
              <Laptop /> <span className="hidden @md:inline">{settings.runsOn === 'cloud' ? 'Cloud' : 'This computer'}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Work in</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={settings.runsOn} onValueChange={(v) => setSettings({ runsOn: v as RunsOn })}>
              <DropdownMenuRadioItem value="this-computer">This computer</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="cloud" disabled>
                Cloud <span className="ml-auto pl-3 text-xs">needs an account</span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            {isRepo && (
              <DropdownMenuItem disabled>
                New worktree <span className="ml-auto pl-3 text-xs">slice 2</span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

    </div>
    </div>
  );
}
