// Heartbeat and brief: the one standing check the host runs inside active hours, and when the daily
// brief comes. Nothing here sends outside the app; chat channels come later, with their own accounts.
import * as React from 'react';
import { call, configureWakeGate } from '../../lib/api';
import { useApp } from '../../lib/state';
import { useProactivity, useTurnSettings } from '../Scheduled';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/input';
import { SettingsRow } from './SettingsRow';

export function ProactiveSection() {
  const p = useProactivity();
  const { projects, prefs } = useApp();
  const settings = useTurnSettings();
  const beat = p.heartbeat;
  const [on, setOn] = React.useState(false);
  const [projectId, setProject] = React.useState('');
  const [every, setEvery] = React.useState('30');
  const [from, setFrom] = React.useState('08:00');
  const [until, setUntil] = React.useState('20:00');
  const [check, setCheck] = React.useState('');
  const [briefAt, setBriefAt] = React.useState('');
  const [said, setSaid] = React.useState<string>();
  const [problem, setProblem] = React.useState<string>();
  const [loaded, setLoaded] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    // The live hook starts with an empty fallback; only the actual response may initialise an edit.
    void call('schedules.get', {}).then(saved => {
      if (!live) return;
      const beat = saved.heartbeat;
      setOn(!!beat);
      setProject(beat?.projectId ?? prefs.selectedProjectId ?? projects[0]?.id ?? '');
      if (beat) {
        setCheck(beat.text); setFrom(beat.hours?.start ?? '08:00'); setUntil(beat.hours?.end ?? '20:00');
        const rule = beat.rule.kind === 'rrule' ? beat.rule.rrule : '';
        const interval = Number(/INTERVAL=(\d+)/.exec(rule)?.[1] ?? 1);
        setEvery(String(interval * (rule.includes('FREQ=HOURLY') ? 60 : 1)));
      }
      setBriefAt(saved.brief.time); setLoaded(true);
    }).catch(() => { if (live) setProblem('Heartbeat settings could not be loaded. Reopen Settings to try again.'); });
    return () => { live = false; };
  }, []);

  const saveBeat = async (enabled: boolean) => {
    const minutes = Number(every);
    const r = await call('heartbeat.put', { enabled, projectId: projectId || projects[0]?.id || '', everyMinutes: minutes, hours: { start: from, end: until }, check, settings });
    if (r.ok) { setProblem(undefined); setSaid(r.value ? r.value.summary : 'Heartbeat off'); } else setProblem(r.detail);
  };
  const toggle = (checked: boolean) => { setOn(checked); if (!checked) void saveBeat(false); };
  const saveBrief = async () => {
    const r = await call('brief.put', { time: briefAt });
    if (r.ok) setProblem(undefined); else setProblem(r.detail);
  };
  return (
    <div>
      <fieldset disabled={!loaded} className="min-w-0 border-0 p-0">
      <SettingsRow title="Heartbeat" about="A standing check inside active hours. It stays quiet unless something needs you, and what needs you waits for the daily brief.">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label="Heartbeat" checked={on} onChange={(e) => toggle(e.target.checked)} /> On</label>
      </SettingsRow>
      {on && <>
        <SettingsRow title="Project" about="Its runs are turns in one chat of this project.">
          <Select aria-label="Heartbeat project" value={projectId} onChange={(e) => setProject(e.target.value)}>
            {projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </SettingsRow>
        <SettingsRow title="When" about="Every so many minutes, between these local times.">
          <label className="flex items-center gap-1 text-xs text-muted">Every (minutes)<Input aria-label="Every (minutes)" type="number" min={1} className="w-20" value={every} onChange={(e) => setEvery(e.target.value)} /></label>
          <label className="flex items-center gap-1 text-xs text-muted">From<Input aria-label="From" className="w-20" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="flex items-center gap-1 text-xs text-muted">Until<Input aria-label="Until" className="w-20" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
        </SettingsRow>
        <SettingsRow title="What it checks" about="In your words. It answers quietly when nothing needs you.">
          <textarea aria-label="What it checks" rows={2} value={check} onChange={(e) => setCheck(e.target.value)} className="w-full min-w-64 resize-none rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm" />
          <Button size="sm" onClick={() => void saveBeat(true)}>Save heartbeat</Button>
        </SettingsRow>
      </>}
      {said && <p role="status" className="py-2 text-xs text-muted">{said}</p>}
      <SettingsRow title="Daily brief" about="One message a day with what waited for you, each item one click. Only a security or money emergency comes sooner, and each is counted.">
        <label className="flex items-center gap-1 text-xs text-muted">Daily brief at<Input aria-label="Daily brief at" className="w-20" value={briefAt} onChange={(e) => setBriefAt(e.target.value)} /></label>
        <Button size="sm" variant="outline" onClick={() => void saveBrief()}>Save brief time</Button>
        <span className="text-xs text-muted" data-testid="brief-time-saved">Now {p.brief.time}</span>
      </SettingsRow>
      {problem && <p role="alert" className="py-2 text-xs text-danger">{problem}</p>}
      </fieldset>
      <WakeGateSettings schedules={p.schedules} />
    </div>
  );
}

function WakeGateSettings({ schedules }: { schedules: import('@backbone-next/platform').Schedule[] }) {
  const [id, setId] = React.useState('');
  const [command, setCommand] = React.useState('');
  const [args, setArgs] = React.useState('[]');
  const [timeout, setTimeoutMs] = React.useState('5000');
  const [message, setMessage] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const schedule = schedules.find(s => s.id === id);
  const select = (next: string) => {
    setId(next); const gate = schedules.find(s => s.id === next)?.wakeGate;
    setCommand(gate?.command ?? ''); setArgs(JSON.stringify(gate?.args ?? [])); setTimeoutMs(String(gate?.timeoutMs ?? 5000)); setMessage('');
  };
  const save = async (remove = false) => {
    if (!schedule) return;
    setBusy(true); setMessage('');
    try {
      const argv: unknown = remove ? [] : JSON.parse(args);
      if (!Array.isArray(argv) || argv.some(a => typeof a !== 'string')) throw new Error('Arguments must be a JSON array of strings.');
      const result = await configureWakeGate({ method: 'schedules.update', args: { id, baseVersion: schedule.version, patch: { wakeGate: remove ? null : { command, args: argv, timeoutMs: Number(timeout) } } } });
      setMessage(result.ok ? 'Script check updated.' : result.detail);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The script check could not be confirmed.'); }
    finally { setBusy(false); }
  };
  return <section aria-label="Script wake gates" className="mt-4 border-t border-border pt-3">
    <SettingsRow title="Script wake gate" about="A trusted read-only program checks first. Exit 0 stays quiet; exit 10 wakes the model. It runs with your OS rights. The desktop app asks you to confirm the exact program and arguments.">
      <Select aria-label="Script check schedule" value={id} onChange={e => select(e.target.value)} disabled={busy}>
        <option value="">Choose an existing schedule</option>
        {schedules.map(s => <option key={s.id} value={s.id}>{s.text || s.id}</option>)}
      </Select>
    </SettingsRow>
    {schedule && <>
      <SettingsRow title="Program" about="An absolute path. The schedule needs Full permission in a local chat; the program itself is not sandboxed.">
        <Input aria-label="Wake-gate program" value={command} onChange={e => setCommand(e.target.value)} disabled={busy} />
      </SettingsRow>
      <SettingsRow title="Arguments" about="A JSON array, one string per argument. Keep tokens and other secrets out of arguments.">
        <textarea aria-label="Wake-gate arguments" value={args} onChange={e => setArgs(e.target.value)} disabled={busy} className="w-full rounded-md border border-border bg-transparent p-2 text-sm" />
      </SettingsRow>
      <SettingsRow title="Deadline" about="Milliseconds, including waiting for a process slot. Failed checks pause the schedule for inspection.">
        <Input aria-label="Wake-gate deadline" type="number" min={100} max={30000} value={timeout} onChange={e => setTimeoutMs(e.target.value)} disabled={busy} />
        <Button size="sm" disabled={busy || !window.backbone?.configureWakeGate} onClick={() => void save()}>Review script check</Button>
        {schedule.wakeGate && <Button size="sm" variant="outline" disabled={busy || !window.backbone?.configureWakeGate} onClick={() => void save(true)}>Remove script check</Button>}
      </SettingsRow>
    </>}
    {message && <p role="status" className="py-2 text-xs text-muted">{message}</p>}
  </section>;
}
