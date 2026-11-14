// Save confirms the exact displayed preview. Editing the input invalidates it immediately.
import type { Result, Schedule, TurnSettings } from '@backbone-next/platform';
import * as React from 'react';
import { call, clientKey } from '../lib/api';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';
import { Input } from './ui/input';

type Preview = Extract<Result<'schedules.parse'>, { ok: true }>['value'];
interface Props {
  projectId: string;
  threadId?: string;
  hasGoal: boolean;
  goal?: string;
  settings: TurnSettings;
  schedule?: Schedule;
  open: boolean;
  onClose(): void;
}
const nextTime = (at: string) => new Date(at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

export function ScheduleEditor({ projectId, threadId, hasGoal, goal, settings, schedule, open, onClose }: Props) {
  // Keep the version opened by the person; live events must neither erase edits nor advance its base.
  const [base] = React.useState(schedule);
  const [shownGoal, setShownGoal] = React.useState<string>();
  const [whenText, setWhen] = React.useState('');
  const [what, setWhat] = React.useState('');
  const [read, setRead] = React.useState<{ input: string; preview: Preview }>();
  const [parseProblem, setParseProblem] = React.useState<string>();
  const [problem, setProblem] = React.useState<string>();
  const [saving, setSaving] = React.useState(false);
  const [refresh, setRefresh] = React.useState(0);
  const key = React.useRef(clientKey());
  React.useEffect(() => {
    if (open) { setShownGoal(goal); setWhen(base?.when ?? ''); setWhat(base?.text ?? ''); setRead(undefined); setParseProblem(undefined); setProblem(undefined); key.current = clientKey(); }
  }, [open, base]);
  React.useEffect(() => {
    if (!open || !whenText.trim() || (base && whenText === base.when)) return;
    let live = true;
    const timer = setTimeout(() => void call('schedules.parse', { when: whenText }).then(r => {
      if (!live) return;
      if (r.ok) { setRead({ input: whenText, preview: r.value }); setParseProblem(undefined); }
      else { setRead(undefined); setParseProblem(r.detail); }
    }).catch(() => { if (live) { setRead(undefined); setParseProblem('The time could not be previewed. Try again.'); } }), 150);
    return () => { live = false; clearTimeout(timer); };
  }, [whenText, open, refresh, base]);
  const changesTime = !base || whenText !== base.when;
  const preview = !changesTime ? { summary: base.summary, nextAt: base.nextAt } : read?.input === whenText ? read.preview : undefined;
  const goalWork = base ? hasGoal : !!shownGoal;
  const ready = (!changesTime || !!preview?.nextAt) && !!(what.trim() || goalWork) && !saving;
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || (changesTime && !read?.preview.nextAt)) return;
    setSaving(true); setProblem(undefined);
    const pinned = changesTime && read?.preview.nextAt ? { rule: read.preview.rule, anchor: read.preview.anchor, firstAt: read.preview.nextAt } : undefined;
    try {
      const result = base
        ? await call('schedules.update', { id: base.id, baseVersion: base.version, patch: { text: what, ...(changesTime ? { when: whenText } : {}) }, ...(pinned ? { pinned } : {}) })
        : await call('schedules.create', { projectId, threadId, text: what, when: whenText, settings, clientKey: key.current, pinned: pinned && { ...pinned, ...(!what.trim() && shownGoal !== undefined ? { goal: shownGoal } : {}) } });
      if (result.ok) onClose();
      else { setProblem(result.detail); setRead(undefined); setRefresh(n => n + 1); }
    } catch { setProblem('The save could not be confirmed. Check Scheduled before trying again.'); }
    finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={o => { if (!o && !saving) onClose(); }}>
      <DialogContent title={base ? 'Edit schedule' : 'Schedule'} description="Confirm the time below before saving. Runs while the app or its background service is running; missed runs are caught up once.">
        <form className="flex flex-col gap-3" onSubmit={e => void save(e)}>
          <label className="flex flex-col gap-1 text-sm">When
            <Input aria-label="When" autoFocus placeholder="every weekday at 8" value={whenText} disabled={saving} onChange={e => { setWhen(e.target.value); setRead(undefined); setParseProblem(undefined); }} />
          </label>
          {parseProblem && <p role="alert" className="text-xs text-danger">{parseProblem}</p>}
          {preview && <p className="text-xs text-muted" data-testid="when-preview">{preview.summary} · {preview.nextAt ? `next ${nextTime(preview.nextAt)}` : 'No further runs'}. Save confirms this time.</p>}
          <label className="flex flex-col gap-1 text-sm">What
            <textarea aria-label="What" rows={3} value={what} disabled={saving} onChange={e => setWhat(e.target.value)} placeholder={goalWork ? 'Leave empty to work toward the goal' : 'What each run should do'} className="w-full resize-none rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm" />
          </label>
          {!base && !what.trim() && shownGoal && <p className="text-xs text-muted" data-testid="schedule-goal">Goal: {shownGoal}</p>}
          {problem && <p role="alert" className="text-danger">{problem}</p>}
          <div className="flex justify-end"><Button type="submit" disabled={!ready}>{base ? 'Save changes' : 'Save schedule'}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
