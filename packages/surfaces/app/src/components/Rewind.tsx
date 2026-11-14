import * as React from 'react';
import type { RewindChoice, RewindPlan, RewindRecord } from '@backbone-next/platform';
import { call, clientKey } from '../lib/api';
import { useLive } from '../lib/state';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';

export function RewindButton({ threadId, turnId, label = 'Rewind to here' }: { threadId: string; turnId: string; label?: string }) {
  const [open, setOpen] = React.useState(false);
  const [plan, setPlan] = React.useState<RewindPlan>();
  const [choices, setChoices] = React.useState<RewindChoice[]>([]);
  const [problem, setProblem] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const operation = React.useRef('');
  const preview = async () => {
    setBusy(true); setProblem(undefined); setPlan(undefined); setChoices([]);
    try {
      const receipt = await call('threads.rewindPreview', { threadId, turnId });
      if (receipt.ok) { setPlan(receipt.value); operation.current = receipt.value.pendingKey ?? clientKey(); }
      else setProblem(receipt.detail);
    } catch { setProblem('The preview could not be loaded. Reload it before continuing.'); }
    finally { setBusy(false); }
  };
  const rewind = async () => {
    if (!plan || busy) return;
    setBusy(true); setProblem(undefined);
    try {
      const receipt = await call('threads.rewind', { threadId, turnId, revision: plan.revision, clientKey: operation.current, choices });
      if (receipt.ok) setOpen(false);
      else setProblem(receipt.detail);
    } catch { setProblem('The rewind could not be confirmed. Reload the preview to inspect its saved progress.'); }
    finally { setBusy(false); }
  };
  return <>
    <Button variant="ghost" size="sm" className="text-muted" onClick={() => { setOpen(true); void preview(); }}>{label}</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent title="Rewind conversation" description="Keep this turn and restore the files the agent changed after it. Later turns and every file version remain in history.">
        <div className="max-h-[60vh] space-y-4 overflow-y-auto text-sm">
          <p>Outside actions cannot be undone. Sent mail stays sent.</p>
          <p>Saved memories and learned skills from later turns remain. Review and manage them in Memory.</p>
          <p className="text-muted">File restore supports managed files and folders inside this data folder. Linked or outside folders cannot be restored here.</p>
          <a className="block underline" href={`#outside-receipts-${turnId}`}>View outside-action receipts</a>
          {plan && <>
            {plan.turns.some(turn => turn.effects.length > 0) && <a className="underline" href={`#turn-${plan.turns.find(turn => turn.effects.length > 0)!.id}`} onClick={() => setOpen(false)}>View later turns and their receipts</a>}
            {plan.files.length === 0 && <p>No agent file changes to restore.</p>}
            {plan.files.map(file => <fieldset key={file.materialId} className="rounded-lg border border-border p-3">
              <legend className="break-all px-1 font-medium">{file.name}</legend>
              <p>{file.restore ? `Restore v${file.restore}` : 'Remove from current files; keep its versions in history'}</p>
              {!!file.foreignVersions?.length && <p>Other work in this interval: {file.foreignVersions.map(version => `v${version}`).join(', ')}.</p>}
              {file.problem && <p role="status">{file.problem}</p>}
              {file.conflict && <>
                <p className="mt-1 text-draft">Changed since the agent wrote it. Choose what to keep.</p>
                {(['keep', 'restore'] as const).map(action => <label key={action} className="mt-2 flex items-center gap-2">
                  <input type="radio" name={`rewind-${file.materialId}`} value={action} checked={choices.some(choice => choice.materialId === file.materialId && choice.action === action)} onChange={() => setChoices(current => [...current.filter(choice => choice.materialId !== file.materialId), { materialId: file.materialId, action }])} />
                  {action === 'keep' ? 'Keep my file' : 'Restore earlier file'}
                </label>)}
              </>}
            </fieldset>)}
          </>}
          {problem && <p role="alert">{problem}</p>}
          {plan && <OutsideReceipts id={`outside-receipts-${turnId}`} turns={plan.turns.map(turn => turn.id)} />}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
            {problem && <Button variant="outline" disabled={busy} onClick={() => void preview()}>Reload preview</Button>}
            <Button disabled={busy || !plan || plan.files.some(file => file.conflict && !choices.some(choice => choice.materialId === file.materialId))} onClick={() => void rewind()}>{busy ? 'Loading…' : 'Rewind conversation and files'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

export function PendingRewind({ threadId, record }: { threadId: string; record?: RewindRecord }) {
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string>();
  if (!record) return null;
  const finish = async () => {
    setBusy(true); setProblem(undefined);
    try {
      const receipt = await call('threads.rewindFinish', { threadId, pendingKey: record.id });
      if (!receipt.ok) setProblem(receipt.detail);
    } catch { setProblem('The decision could not be confirmed. Reload this conversation to inspect its saved state.'); }
    finally { setBusy(false); }
  };
  return <section role="status" data-testid="pending-rewind" className="border-b border-border px-4 py-3 text-sm">
    <p className="font-medium">This conversation has an unfinished rewind.</p>
    <p>Resume the saved decision, or keep the file results already recorded and finish the conversation rewind without restoring remaining files. Other projects remain available.</p>
    {record.problem && <p>{record.problem}</p>}
    <FileOutcomes files={record.files} />
    {problem && <p role="alert">{problem}</p>}
    <div className="flex flex-wrap gap-2">
      <RewindButton threadId={threadId} turnId={record.turnId} label="Resume rewind" />
      <Button variant="outline" disabled={busy} onClick={() => void finish()}>Finish without restoring remaining files</Button>
    </div>
  </section>;
}

function FileOutcomes({ files }: { files: RewindRecord['files'] }) {
  const labels = { pending: 'Waiting', restored: 'Restored', kept: 'Kept', 'not-restored': 'Not restored' };
  return <ul className="my-2 space-y-1">{files.map(file => <li key={file.materialId} data-testid="rewind-file-outcome" data-outcome={file.outcome ?? 'pending'}>
    {file.name}: {labels[file.outcome ?? 'pending']}{file.core && ` · Core ${file.core}`}{file.problem && ` · ${file.problem}`}
  </li>)}</ul>;
}

export function RewindHistory({ records }: { records?: RewindRecord[] }) {
  if (!records?.length) return null;
  return <details className="mx-auto w-full max-w-3xl px-4 py-3 text-sm" data-testid="rewind-history">
    <summary className="cursor-pointer text-muted">Rewound history and receipts</summary>
    <p className="my-2 text-muted">These turns are kept for inspection and are excluded from future conversation context. Outside actions remain done.</p>
    {records.map(record => <div key={record.id} className="space-y-3 border-l border-border pl-3">
      {record.resolution === 'without-remaining-files' && <p>Finished without restoring remaining files.</p>}
      <FileOutcomes files={record.files} />
      {[...record.turns, ...(record.sideTurns ?? [])].map(turn => <article id={`rewound-${record.id}-${turn.id}`} key={turn.id} className="py-2">
        <p className="whitespace-pre-wrap font-medium">{turn.user.text}</p>
        <p className="whitespace-pre-wrap">{turn.answer?.text}</p>
        <a className="underline" href={`#receipts-${record.id}-${turn.id}`}>View receipts</a>
        <ul id={`receipts-${record.id}-${turn.id}`} className="mt-2 space-y-1">
          {turn.effects.map(effect => <li key={effect.key}>{effect.outcome} · {effect.target}{effect.detail && ` · ${effect.detail}`}</li>)}
          {turn.effects.length === 0 && <li>No effects recorded for this turn.</li>}
        </ul>
      </article>)}
      <OutsideReceipts id={`outside-receipts-${record.id}`} turns={record.turns.map(turn => turn.id)} />
    </div>)}
  </details>;
}

/** Connector receipts keep their existing owner even when their conversation is rewound. */
function OutsideReceipts({ id, turns }: { id: string; turns: string[] }) {
  const key = turns.join(':');
  const receipts = useLive(async () => {
    const view = await call('connectors.list', {});
    return view.held.filter(receipt => receipt.turnId && turns.includes(receipt.turnId));
  }, [key], undefined);
  return <section id={id} aria-label="Outside-action receipts" className="space-y-2 rounded-lg border border-border p-3">
    <p className="font-medium">Outside-action receipts</p>
    {receipts === undefined ? <p>Receipts have not loaded.</p> : receipts.length === 0 ? <p>No connector receipts are linked to these turns.</p> : receipts.map(receipt => <details key={receipt.effect}>
      <summary className="cursor-pointer break-all">{receipt.serverName} · {receipt.tool} · {receipt.state}</summary>
      <p className="break-all">Call receipt: {receipt.effect}</p>
      {receipt.dispatchReceipt && <p className="break-all">Dispatch receipt: {receipt.dispatchReceipt.seq} · {receipt.dispatchReceipt.hash}</p>}
      <p className="whitespace-pre-wrap">{receipt.statement}</p>
      <p>{receipt.detail}</p>
    </details>)}
  </section>;
}
