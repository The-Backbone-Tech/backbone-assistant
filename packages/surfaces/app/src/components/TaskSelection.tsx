import type { Option, Selection, TaskNeeds, Turn, TurnSelection, Verification } from '@backbone-next/platform';
import * as React from 'react';
import { call } from '../lib/api';
import { CAPABILITIES, DEFAULT_TASK, SPENDING } from '../lib/task-selection';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';

export interface SelectionStart { started: boolean; detail?: string; selection?: Selection }

export function TaskSelectionDialog({ open, onOpenChange, text, initialTask, locked, unavailable, onRun, onReturnFocus, executionSummary }: {
  open: boolean; onOpenChange(open: boolean): void; text: string; initialTask?: TaskNeeds; locked: boolean;
  unavailable?: string; executionSummary: string; onReturnFocus?(): void; onRun(task: TaskNeeds): Promise<SelectionStart>;
}) {
  const [task, setTask] = React.useState<TaskNeeds>(DEFAULT_TASK);
  const [result, setResult] = React.useState<Selection>();
  const [problem, setProblem] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const generation = React.useRef(0);
  React.useEffect(() => {
    generation.current++;
    if (open) { if (initialTask) setTask(initialTask); setResult(undefined); setProblem(undefined); }
  }, [open]); // Initial retry constraints are read when opening; a running request must not reset the dialog.
  React.useEffect(() => { if (open && initialTask) setTask(initialTask); }, [open, initialTask]);
  const change = (next: TaskNeeds) => { generation.current++; setTask(next); setResult(undefined); setProblem(undefined); };
  const compare = async () => {
    const mine = ++generation.current;
    setBusy(true); setProblem(undefined);
    try {
      const selection = await call('solutions.options', task);
      if (mine === generation.current) setResult(selection);
    } catch { if (mine === generation.current) setProblem('Available routes could not be checked. Your message is still a draft. Try again.'); }
    finally { setBusy(false); }
  };
  const run = async () => {
    setBusy(true); setProblem(undefined);
    try {
      const r = await onRun(task);
      if (r.started) onOpenChange(false);
      else { if (r.selection) setResult(r.selection); setProblem(r.detail ?? 'No turn started. Your message remains in the composer.'); }
    } catch { setProblem('The submission could not be confirmed. Check the chat or retry the existing submission.'); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Choose a route for this task" description="Compare the routes available to this app data folder against your requirements. This does not select a complete workflow or set up new tools." className="max-w-xl max-h-[85dvh] overflow-y-auto" onCloseAutoFocus={(e) => { if (onReturnFocus) { e.preventDefault(); onReturnFocus(); } }}>
        <div className="space-y-4 text-sm" aria-busy={busy}>
          <p className="wrap-anywhere max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md bg-sunken p-3" aria-label="Task message">{text}</p>
          <p className="text-xs text-muted" aria-label="Submission settings">{executionSummary}</p>
          {locked && <p role="status">A previous submission is unconfirmed. Retry uses its saved requirements, execution preferences and key; it does not start a second copy if that turn already exists.</p>}
          <fieldset disabled={locked || busy} className="space-y-3 disabled:opacity-70">
            <legend className="font-medium">Requirements</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {CAPABILITIES.map((c) => <label key={c.id} className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={task.needs.includes(c.id)} onChange={(e) => change({ ...task, needs: e.target.checked ? [...task.needs, c.id] : task.needs.filter((n) => n !== c.id) })} />{c.label}</label>)}
            </div>
            <label className="flex flex-col gap-1">Model connection
              <select className="h-8 w-full min-w-0 rounded-md border border-border bg-surface px-2" value={String(task.network)} onChange={(e) => change({ ...task, network: e.target.value === 'true' })}>
                <option value="true">Network routes allowed</option><option value="false">Loopback model endpoint only</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">Spending category
              <select className="h-8 w-full min-w-0 rounded-md border border-border bg-surface px-2" value={task.spend} onChange={(e) => change({ ...task, spend: e.target.value as TaskNeeds['spend'] })}>{SPENDING.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
            </label>
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={!!task.structured} onChange={(e) => change({ ...task, structured: e.target.checked })} />Prefer code-capable routes for structured figures</label>
          </fieldset>
          <p className="text-xs text-muted">An existing plan still consumes usage. Categories come from route metadata, not live billing or quota checks; they are not price estimates or monetary caps. Loopback excludes connected tools for this turn; a local server can still forward requests.</p>
          <Button variant="outline" disabled={busy || !task.needs.length || !!unavailable} onClick={() => void compare()}>{busy ? 'Checking…' : 'Compare available routes'}</Button>
          {result && <SelectionOptions selection={result} />}
          <details className="text-xs text-muted"><summary className="cursor-pointer">Current limits</summary><p className="mt-2">This selector covers installed client observations, the configured route and detected local models. It does not use Arena evidence, install tools, compare whole workflows or prove answer quality. Connected-tool and code-only job discovery is not wired here. This data folder runs one engine; routes needing another engine are shown with their setup instructions and cannot be recommended yet. A selected run needs backend support for attached sources; their presence here alone does not prove they were admitted. Check each turn’s recorded route and outcome. A previous choice is historical; inspect the next turn’s requirements, route record and outcome before relying on it.</p></details>
          <p className="text-xs text-muted">Availability is checked again when starting; the recommendation may change. The chat records the actual choice.</p>
          {(unavailable || problem) && <p role="alert" className="text-danger">{unavailable ?? problem}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button disabled={busy || !!unavailable || !task.needs.length || (!locked && !result?.choice)} onClick={() => void run()}>{locked ? 'Retry existing submission' : 'Choose again and run'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RouteOption({ option }: { option: Option }) {
  const availability = option.route.availability;
  const labels = { now: 'Usable when checked', setup: 'Setup required', entitlement: 'API access required' };
  return <li className="wrap-anywhere rounded-md border border-border p-2">
    <p className="font-medium">{option.route.label}</p>
    {availability && <p data-availability={availability.state} className="mt-1 text-xs text-muted"><span className="font-medium">{labels[availability.state]}: </span>{availability.detail}</p>}
    <ul className="mt-1 list-disc pl-4 text-xs text-muted">{option.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>
  </li>;
}
function SelectionOptions({ selection, includeChoice = true }: { selection: Selection; includeChoice?: boolean }) {
  return <section role="region" aria-label="Route comparison" className="space-y-3">
    {selection.choice ? includeChoice && <div><h3 className="font-medium">Recommended route</h3><ul className="mt-1"><RouteOption option={selection.choice} /></ul><p className="mt-1 text-xs text-muted">Reasons from the selector; capability matching is not independent verification.</p></div> : <p role="status">{selection.limitation ?? 'No route meets these requirements.'}</p>}
    {selection.feasible.length > 1 && <details><summary className="cursor-pointer">Other eligible routes ({selection.feasible.length - 1})</summary><ul className="mt-2 space-y-2">{selection.feasible.slice(1).map((o) => <RouteOption key={o.route.id} option={o} />)}</ul></details>}
    {selection.excluded.length > 0 && <details open={!selection.choice}><summary className="cursor-pointer">Excluded routes ({selection.excluded.length})</summary><ul className="mt-2 space-y-2">{selection.excluded.map((o) => <RouteOption key={o.route.id} option={o} />)}</ul></details>}
  </section>;
}

export function TurnSelectionCard({ selection, status, threadId, turnId, files }: { selection: TurnSelection; status: Turn['status']; threadId: string; turnId: string; files: string[] }) {
  const [check, setCheck] = React.useState<{ result: Verification; at: string }>();
  const [problem, setProblem] = React.useState<string>();
  const [checking, setChecking] = React.useState(false);
  const verify = async () => {
    setChecking(true); setProblem(undefined);
    try {
      const r = await call('solutions.verify', { threadId, turnId, deliverables: files });
      if (r.ok) setCheck({ result: r.value, at: new Date().toLocaleTimeString() });
      else { setCheck(undefined); setProblem(r.detail); }
    } catch { setCheck(undefined); setProblem('The written versions could not be checked. No work was restarted.'); }
    finally { setChecking(false); }
  };
  const route = selection.ran ?? selection.pinned;
  const changed = selection.ran && (['kind', 'provider', 'baseUrl', 'model'] as const).some((k) => selection.ran![k] !== selection.pinned[k]);
  return <details className="wrap-anywhere rounded-lg border border-border px-3 py-2 text-xs" data-testid="turn-selection">
    <summary className="cursor-pointer"><span className="font-medium">{selection.ran ? 'Route recorded for execution' : status === 'running' ? 'Selected route · awaiting execution' : 'Selected route · no execution recorded'}</span> · {route.label}</summary>
    <div className="mt-2 space-y-2">
      <p>{route.provider} · {route.model}</p>
      {changed && <p className="text-draft">The execution record differs from the selected route: selected {selection.pinned.label} ({selection.pinned.model}); recorded {route.label} ({route.model}). Review the turn outcome before relying on this work.</p>}
      <p>Requirements: {CAPABILITIES.filter((c) => selection.task.needs.includes(c.id)).map((c) => c.label).join(', ')}. {selection.task.network ? 'Network model routes allowed' : 'Loopback model endpoint only'}. {SPENDING.find((s) => s.id === selection.task.spend)?.label}.</p>
      <ul className="list-disc pl-4">{selection.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      <p className="text-muted">This is a backend route record, not an independent receipt that a request reached the endpoint or proof that the answer is correct.</p>
      {status !== 'running' && files.length > 0 && <section aria-label="Written version checks" className="space-y-2">
        <Button variant="outline" size="sm" disabled={checking} onClick={() => void verify()}>{checking ? 'Checking versions…' : 'Check written file versions'}</Button>
        <p className="text-muted">Checks only this turn's listed outputs and their basic file structure, not missing requested outputs or content correctness. Uncertain effects remain unresolved.</p>
        {check && <div role="status"><p>{check.result.complete ? 'Recorded files passed basic checks.' : check.result.summary} Snapshot at {check.at}.</p><ul className="mt-1 list-disc pl-4">{check.result.checks.map((c, i) => <li key={i}>{c.name}{c.version ? ` v${c.version}` : ''}: {c.ok ? 'passed' : c.problem ?? 'not verified'}{c.editedSince ? ` · edited since by ${c.editedSince}` : ''}</li>)}</ul></div>}
        {problem && <p role="alert" className="text-danger">{problem}</p>}
      </section>}
      {selection.options && <SelectionOptions selection={selection.options} includeChoice={false} />}
    </div>
  </details>;
}
