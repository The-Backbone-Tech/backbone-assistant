// Scheduled work: the page that lists schedules, the heartbeat and recent runs; the card a chat shows
// for its own schedules; and the dialog that makes one from a person's words for when. The host runs
// them while Backbone or its background service is running; each run is a turn like any other.
import type { Proactivity, RunOutcome, Schedule, ScheduleRun, ThreadSummary, TurnSettings } from '@backbone-next/platform';
import { CalendarClock, HeartPulse } from 'lucide-react';
import * as React from 'react';
import { call, clientKey } from '../lib/api';
import { useApp, useLive } from '../lib/state';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ScheduleEditor } from './ScheduleEditor';

const OUTCOME: Record<RunOutcome, { label: string; tone: 'committed' | 'draft' | 'danger' | undefined }> = {
  starting: { label: 'Starting', tone: undefined }, running: { label: 'Running', tone: undefined }, done: { label: 'Done', tone: 'committed' },
  quiet: { label: 'Nothing needed', tone: undefined }, 'needs-you': { label: 'Needs you', tone: 'draft' }, emergency: { label: 'Emergency', tone: 'danger' },
  stopped: { label: 'Stopped', tone: 'danger' }, failed: { label: 'Did not run', tone: 'danger' }, skipped: { label: 'Skipped', tone: 'draft' },
  interrupted: { label: 'Interrupted', tone: 'draft' },
};
const EMPTY: Proactivity = { schedules: [], heartbeat: null, runs: [], brief: { time: '08:00', latest: null }, interruptions: { date: '', briefs: 0, emergencies: [] } };

/** When, as a person reads it: "Tue 3 Nov, 09:00". */
export function when(iso: string | null): string {
  if (!iso) return 'No further runs';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export function useProactivity(): Proactivity {
  // A host without proactivity, or one that fails to answer, shows nothing scheduled rather than breaking the app.
  return useLive(() => call('schedules.get', {}).then((p) => p ?? EMPTY, () => EMPTY), [], EMPTY);
}

/** The settings a scheduled turn runs with: the composer's, on the model the route offers first. */
export function useTurnSettings(): TurnSettings {
  const { prefs, models } = useApp();
  return { permission: 'full', effort: 3, runsOn: 'this-computer', mode: 'chat', ...prefs.composer, model: models[0]?.id ?? prefs.composer?.model ?? 'stub' };
}

/** The project a schedule made from the Scheduled page belongs to: the selected one, else the first. */
export function projectForNewSchedule(projects: { id: string }[], selectedId?: string): string | undefined {
  return projects.find((p) => p.id === selectedId)?.id ?? projects[0]?.id;
}

function ScheduleActions({ schedule, onProblem }: { schedule: Schedule; onProblem: (p?: string) => void }) {
  const [editing, setEditing] = React.useState(false);
  const settings = useTurnSettings();
  const said = <T,>(r: { ok: true; value: T } | { ok: false; detail: string }) => onProblem(r.ok ? undefined : r.detail);
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
      <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button>
      <Button variant="ghost" size="sm" onClick={() => void call('schedules.run', { id: schedule.id, clientKey: clientKey() }).then(said)}>Run now</Button>
      <Button variant="ghost" size="sm" onClick={() => void call('schedules.update', { id: schedule.id, patch: { paused: !schedule.paused }, baseVersion: schedule.version }).then(said)}>{schedule.paused ? 'Resume' : 'Pause'}</Button>
      <Button variant="ghost" size="sm" onClick={() => void call('schedules.delete', { id: schedule.id }).then(said)}>Remove</Button>
      {editing && <ScheduleEditor projectId={schedule.projectId} threadId={schedule.threadId ?? undefined} hasGoal={!schedule.text && !!schedule.threadId} settings={settings} schedule={schedule} open onClose={() => setEditing(false)} />}
    </span>
  );
}

const nextLine = (s: Schedule) => (s.paused ? 'Paused' : `Next ${when(s.nextAt)}`);

/** A chat's own schedules, as cards above its transcript. */
export function ScheduleCards({ threadId }: { threadId: string }) {
  const p = useProactivity();
  const [problem, setProblem] = React.useState<string>();
  const mine = p.schedules.filter((s) => s.threadId === threadId);
  if (!mine.length) return null;
  return (
    <>
      {mine.map((s) => (
        <section key={s.id} aria-label="Schedule" className="flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2" data-testid="thread-schedule">
          <CalendarClock className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-caption text-muted">{s.summary} · {nextLine(s)}</span>
            <span className="block truncate">{s.text || 'Work toward the goal'}</span>
          </span>
          <ScheduleActions schedule={s} onProblem={setProblem} />
        </section>
      ))}
      {problem && <p role="alert" className="text-danger">{problem}</p>}
    </>
  );
}

/** Make a schedule for a chat: the words for when are read back before anything is saved. */
export function ScheduleDialog({ thread, goal, open, onClose }: { thread: ThreadSummary; goal?: string; open: boolean; onClose: () => void }) {
  const settings = useTurnSettings();
  return <ScheduleEditor projectId={thread.projectId} threadId={thread.id} hasGoal={!!goal} goal={goal} settings={settings} open={open} onClose={onClose} />;
}

function RunRow({ run }: { run: ScheduleRun }) {
  const { selectThread } = useApp();
  const o = OUTCOME[run.outcome];
  return (
    <li className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-hover" data-testid="run-row">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2"><strong className="font-medium">{run.title}</strong><Badge tone={o.tone}>{o.label}</Badge><span className="text-xs text-muted">{when(run.startedAt)}{run.caughtUp ? ` · stands for ${run.caughtUp} missed` : ''}</span></span>
        {run.summary && <span className="block text-muted">{run.summary}</span>}
      </span>
      {run.threadId && <Button variant="ghost" size="sm" onClick={() => selectThread(run.threadId!)}>Open chat</Button>}
    </li>
  );
}

/** The Scheduled page: what runs on its own, what ran, and when the brief comes. */
export function Scheduled() {
  const p = useProactivity();
  const { threads, selectThread, setPrefs, projects, prefs } = useApp();
  const settings = useTurnSettings();
  const [problem, setProblem] = React.useState<string>();
  const [creating, setCreating] = React.useState(false);
  // A new schedule belongs to the selected project (or the first one). It has no chat yet: its first run opens one.
  const projectId = projectForNewSchedule(projects, prefs.selectedProjectId);
  const upcoming = [...p.schedules].filter((s) => !s.paused && s.nextAt).sort((a, b) => a.nextAt!.localeCompare(b.nextAt!));
  const label = 'px-2 text-xs font-medium text-muted';
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="scheduled">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 text-ui">
        <header>
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-semibold">Scheduled</h1>
            <Button size="sm" disabled={!projectId} onClick={() => setCreating(true)}>New schedule</Button>
          </div>
          {projectId && creating && <ScheduleEditor projectId={projectId} hasGoal={false} settings={settings} open onClose={() => setCreating(false)} />}
          <p className="text-muted">Runs while the app or its background service is running. Daily brief at {p.brief.time}{p.interruptions.briefs ? ' · sent today' : ''}{p.interruptions.emergencies.length ? ` · ${p.interruptions.emergencies.length} ${p.interruptions.emergencies.length === 1 ? 'emergency' : 'emergencies'} today` : ''}.</p>
        </header>
        {p.heartbeat ? (
          <section className="flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2" data-testid="heartbeat-card" aria-label="Heartbeat">
            <HeartPulse className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-caption text-muted">Heartbeat · {p.heartbeat.summary} · next {when(p.heartbeat.nextAt)}</span>
              <span className="block">{p.heartbeat.text}</span>
            </span>
            {p.heartbeat.threadId && <Button variant="ghost" size="sm" onClick={() => selectThread(p.heartbeat!.threadId!)}>Open chat</Button>}
          </section>
        ) : <p className="text-muted">No heartbeat. Set one in Settings › Heartbeat and brief.</p>}
        <section>
          <h2 className={label}>Schedules</h2>
          {p.schedules.length === 0 && <p className="px-2 py-2 text-muted">Nothing is scheduled. Choose New schedule.</p>}
          <ul>
            {p.schedules.map((s) => (
              <li key={s.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-hover" data-testid="schedule-row">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => s.threadId && selectThread(s.threadId)}>
                  <span className="block font-medium">{s.text || 'Work toward the goal'}</span>
                  <span className="block text-xs text-muted">{s.summary} · {nextLine(s)}{s.threadId ? ` · ${threads.find((t) => t.id === s.threadId)?.title ?? ''}` : ''}</span>
                </button>
                <ScheduleActions schedule={s} onProblem={setProblem} />
              </li>
            ))}
          </ul>
          {problem && <p role="alert" className="px-2 text-danger">{problem}</p>}
        </section>
        {upcoming.length > 0 && (
          <section>
            <h2 className={label}>Next up</h2>
            <ul>{upcoming.slice(0, 5).map((s) => <li key={s.id} className="flex gap-2 px-2 py-1"><span className="w-36 shrink-0 text-muted">{when(s.nextAt)}</span><span className="truncate">{s.text || 'Work toward the goal'}</span></li>)}</ul>
          </section>
        )}
        <section>
          <h2 className={label}>Recent runs</h2>
          {p.runs.length === 0 && <p className="px-2 py-2 text-muted">No runs yet.</p>}
          <ul>{p.runs.slice(0, 50).map((r) => <RunRow key={r.id} run={r} />)}</ul>
        </section>
        <p className="px-2 text-xs text-muted">Nothing here sends outside the app. <button type="button" className="underline" onClick={() => setPrefs((x) => ({ ...x, view: undefined }))}>Back</button></p>
      </div>
    </div>
  );
}
