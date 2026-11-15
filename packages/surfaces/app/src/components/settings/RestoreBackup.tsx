// Restore from a backup, as a guided dialog in Settings › Backup: choose the export, read what a restore
// would do (the dry run), choose a new data folder, restore with its progress, and read the end. Main runs the
// platform's restore (the operation `backbone restore` runs); this page only asks for each step, and every
// refusal it shows is the operation's own. The job's state is main's, so closing the dialog loses nothing.
import { Loader2 } from 'lucide-react';
import * as React from 'react';
import type { RestoreJob, RestorePreview, RestoreView } from '../../../electron/restore';
import { restore } from '../../lib/api';
import { brand } from '../../brand';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quoted = (path: string) => `"${path.replace(/(["\\$`])/g, '\\$1')}"`;

/** What the person types to start the app on the restored data folder: the app reads it from BACKBONE_HOME at launch. */
export const openCommand = (folder: string) => `open -n -a ${quoted(brand.name)} --env BACKBONE_HOME=${quoted(folder)}`;

type Stage = 'backup' | 'preview' | 'place' | 'job';
type Place = { ticket: string; folder: string };

function Comes({ preview }: { preview: RestorePreview }) {
  const c = preview.counts;
  return (
    <ul data-testid="restore-comes" className="list-disc space-y-0.5 pl-5">
      <li>{count(c.projects, 'project')}, with {count(c.documents, 'document')} ({count(c.versions, 'version')} in all)</li>
      <li>{count(c.threads, 'conversation')}, as documents to read: in their project, or in a new project called Restored history</li>
      <li>{count(c.memoryFiles, 'memory file')}, and your instructions</li>
      <li>{count(c.skills, 'skill')}, each waiting for you to accept it</li>
      <li>A report of {count(c.receipts, 'receipt')} to read{c.unresolved ? `, ${c.unresolved} of them unresolved when exported: check them before redoing anything` : ''}</li>
    </ul>
  );
}

function Stays() {
  return (
    <ul data-testid="restore-stays" className="list-disc space-y-0.5 pl-5">
      <li>No credential. Model keys, connector keys and passwords are not in a backup: set them up again.</li>
      <li>No permission. Nothing in a backup lets anything run or send, and what you allowed before is not restored.</li>
      <li>No schedule or running work. Nothing starts by itself, and no conversation carries on: they are only to read.</li>
      <li>Connected servers come back as a list to read, with each name and command only. Connect them again.</li>
    </ul>
  );
}

const PHASES = { preparing: 'Checking the backup and making the new data folder…', writing: 'Bringing your work in…', closing: 'Closing the new data folder…' } as const;

function Progress({ job }: { job: Extract<RestoreJob, { state: 'running' }> }) {
  return (
    <div className="space-y-1.5">
      <p role="status" aria-label="Restoring" className="flex items-center gap-1.5 text-sm"><Loader2 className="size-4 animate-spin" aria-hidden />{PHASES[job.phase]}</p>
      <p className="text-xs leading-5 text-muted">You can close this window. The restore carries on, and Settings › Backup shows how it ended.</p>
    </div>
  );
}

function CopyLine({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="space-y-1.5">
      <pre aria-label={label} className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-sunken px-2.5 py-1.5 font-mono text-xs">{text}</pre>
      <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false))}>{copied ? 'Copied' : 'Copy'}</Button>
    </div>
  );
}

function Finished({ job }: { job: Extract<RestoreJob, { state: 'done' }> }) {
  return (
    <div data-testid="restore-done" className="space-y-2">
      <p className="text-sm font-medium">Restored into a new data folder.</p>
      <p data-testid="restore-where" className="break-all font-mono text-xs text-muted">{job.target}</p>
      <p className="text-xs leading-5 text-muted">{brand.name} keeps using your current data folder until you open this one. Set up model keys, connected servers and schedules again there.</p>
      {job.skipped.length > 0 && <p className="text-xs leading-5 text-muted">Left out: {job.skipped.join(' ')}</p>}
      <details className="text-xs leading-5 text-muted">
        <summary className="cursor-pointer text-ui font-medium text-fg">How to open it</summary>
        <div className="mt-2 space-y-1.5">
          <p>{brand.name} opens the folder named by BACKBONE_HOME when it starts, and has no switcher yet. Quit {brand.name}, then start it with this in Terminal:</p>
          <CopyLine label="Command to open the restored data folder" text={openCommand(job.target)} />
          <p>To go back, start {brand.name} as usual: your current data folder is not changed.</p>
        </div>
      </details>
    </div>
  );
}

function Failed({ job }: { job: Extract<RestoreJob, { state: 'refused' | 'unknown' }> }) {
  const partial = job.state === 'unknown' || job.partial;
  const remains = partial || job.remains;
  return (
    <div role="alert" data-testid={job.state === 'unknown' ? 'restore-unknown' : 'restore-refused'} className="space-y-2">
      <p className="text-sm font-medium text-danger">
        {job.state === 'unknown' ? 'It is not known whether the restore finished.' : partial ? 'The restore did not finish.' : 'Nothing was restored.'}
      </p>
      <p className="text-sm leading-6">{job.detail}</p>
      {partial ? (
        <>
          <p className="text-sm">{job.state === 'unknown' ? 'The new data folder may hold part of the backup:' : 'The new data folder holds part of the backup:'}</p>
          <p data-testid="restore-where" className="break-all font-mono text-xs text-muted">{job.target}</p>
          <p className="text-xs leading-5 text-muted">Do not use it as it is. {job.state === 'unknown' ? 'Nothing is tried again for you: look at it first. ' : ''}To try again, restore into another new data folder. You can delete this folder yourself: the app never deletes anything. Your current data folder was not changed.</p>
        </>
      ) : remains ? (
        <>
          <p className="text-sm">Nothing was imported, but the folder may exist and hold files:</p>
          <p data-testid="restore-where" className="break-all font-mono text-xs text-muted">{job.target}</p>
          <p className="text-xs leading-5 text-muted">Look at it first. You can delete it yourself: the app never deletes anything. Your current data folder was not changed.</p>
        </>
      ) : (
        <p className="text-xs leading-5 text-muted">Nothing was made, and your current data folder was not changed.</p>
      )}
    </div>
  );
}

export function RestoreDialog({ open, onOpenChange, view, onChange }: { open: boolean; onOpenChange: (open: boolean) => void; view: RestoreView; onChange: (view: RestoreView) => void }) {
  const [stage, setStage] = React.useState<Stage>('backup');
  const [from, setFrom] = React.useState<string>();
  const [preview, setPreview] = React.useState<RestorePreview>();
  const [place, setPlace] = React.useState<Place>();
  const [busy, setBusy] = React.useState<string>();
  const [problem, setProblem] = React.useState<string>();
  const job = view.job;

  const read = React.useCallback(async (ticket: string, folder: string) => {
    setBusy('Reading the backup…'); setProblem(undefined); setPreview(undefined); setPlace(undefined);
    try {
      const r = await restore.preview(ticket);
      if (!r.ok) { setProblem(r.detail); setStage('backup'); return; }
      setFrom(folder); setPreview(r.preview); setStage('preview');
    } catch (error) { setProblem((error as Error).message); setStage('backup'); } finally { setBusy(undefined); }
  }, []);

  // Opened again with a job in main's hands (running, or ended while the dialog was shut): show it.
  React.useEffect(() => {
    if (!open) return;
    if (job) { setStage('job'); return; }
    setStage('backup'); setProblem(undefined);
    // Only on opening: later changes of the job are followed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  React.useEffect(() => { if (open && job) setStage('job'); }, [open, job?.state]);

  const choose = async () => {
    setProblem(undefined);
    try {
      const picked = await restore.chooseBackup();
      if (!picked) return;
      if (!picked.ok) setProblem(picked.detail); else await read(picked.ticket, picked.folder);
    } catch (error) { setProblem((error as Error).message); }
  };
  const suggest = async (picker: () => Promise<(Place & { ok: true }) | { ok: false; detail: string } | null>) => {
    setBusy('Looking for a place…'); setProblem(undefined);
    try {
      const r = await picker();
      if (!r) return;
      if (!r.ok) setProblem(r.detail); else setPlace({ ticket: r.ticket, folder: r.folder });
    } catch (error) { setProblem((error as Error).message); } finally { setBusy(undefined); }
  };
  const toPlace = async () => { setStage('place'); if (!place) await suggest(() => restore.target()); };
  const go = async () => {
    if (!preview || !place) return;
    setBusy('Starting…'); setProblem(undefined);
    try {
      const r = await restore.start(preview.previewId, place.ticket);
      if (!r.ok) { setPlace(undefined); await suggest(() => restore.target()); setProblem(r.detail); return; }
      onChange(await restore.view()); setStage('job');
    } catch (error) { setProblem((error as Error).message); } finally { setBusy(undefined); }
  };
  const again = async () => {
    try { onChange(await restore.dismiss()); } catch (error) { setProblem((error as Error).message); return; }
    setPreview(undefined); setPlace(undefined); setFrom(undefined); setStage('backup');
  };
  const finish = async () => {
    // Only a finished restore the person has read goes; a failed one stays until they start again, so its folder is not lost.
    if (job?.state === 'done') { try { onChange(await restore.dismiss()); } catch { /* it stays to be read again */ } }
    onOpenChange(false);
  };

  const steps = ['Backup', 'Preview', 'Place', 'Restore'];
  const at = stage === 'backup' ? 0 : stage === 'preview' ? 1 : stage === 'place' ? 2 : 3;
  const blocked = preview && preview.conflicts.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Restore from a backup" description={`Brings a backup into a new data folder. ${brand.name} keeps using the one it has now.`} className="max-w-xl" data-testid="restore-dialog">
        <p className="-mt-2 mb-3 text-xs text-muted" aria-live="polite">Step {at + 1} of {steps.length}: {steps[at]}</p>
        <div className="max-h-[min(60dvh,28rem)] space-y-3 overflow-y-auto pr-1">
          {stage === 'backup' && (
            <>
              <p className="text-sm leading-6">Choose the folder an export made. It is checked first, and nothing is changed.</p>
              {from && <p className="break-all font-mono text-xs text-muted">{from}</p>}
            </>
          )}
          {stage === 'preview' && preview && (
            <>
              <p className="text-sm leading-6">Exported {new Date(preview.createdAt).toLocaleString()}: {count(preview.counts.projects, 'project')}, {count(preview.counts.threads, 'conversation')}, {count(preview.counts.documents, 'document')}. Every file matches.</p>
              <p className="text-sm leading-6">It comes in as you would add it. Credentials, permissions, schedules and running work do not come back.</p>
              <details className="text-xs leading-5 text-muted">
                <summary className="cursor-pointer text-ui font-medium text-fg">What comes in and what does not</summary>
                <div className="mt-2 space-y-2">
                  <p data-testid="restore-from" className="break-all font-mono">{preview.from}</p>
                  <Comes preview={preview} />
                  <Stays />
                </div>
              </details>
              {preview.skipped.length > 0 && <p className="text-xs leading-5 text-muted">Left out: {preview.skipped.join(' ')}</p>}
              {blocked && <p role="alert" className="text-sm text-danger">{preview.conflicts.join(' ')}</p>}
            </>
          )}
          {stage === 'place' && (
            <>
              <p className="text-sm leading-6">It goes into a new, empty data folder, made when you press Restore.</p>
              <p data-testid="restore-place" className="break-all font-mono text-xs text-muted">{place ? place.folder : busy ?? 'No place yet'}</p>
              <p className="break-all text-xs leading-5 text-muted">{brand.name} keeps using {view.currentFolder} until you open the new one.</p>
            </>
          )}
          {stage === 'job' && job?.state === 'running' && <Progress job={job} />}
          {stage === 'job' && job?.state === 'done' && <Finished job={job} />}
          {stage === 'job' && (job?.state === 'refused' || job?.state === 'unknown') && <Failed job={job} />}
          {stage === 'job' && !job && <p className="text-sm text-muted">There is no restore to show.</p>}
          {busy && <p role="status" className="flex items-center gap-1.5 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" aria-hidden />{busy}</p>}
          {problem && <p role="alert" data-testid="restore-problem" className="text-sm text-danger">{problem}</p>}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {stage === 'backup' && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button disabled={!!busy} onClick={() => void choose()}>Choose backup folder…</Button>
            </>
          )}
          {stage === 'preview' && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button variant="outline" onClick={() => void choose()}>Choose another backup…</Button>
              <Button disabled={!!blocked || !!busy} autoFocus onClick={() => void toPlace()}>Choose where it goes</Button>
            </>
          )}
          {stage === 'place' && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button variant="outline" onClick={() => setStage('preview')}>Back</Button>
              <Button variant="outline" disabled={!!busy} onClick={() => void suggest(() => restore.choosePlace())}>Choose another place…</Button>
              <Button disabled={!place || !!busy} onClick={() => void go()}>Restore</Button>
            </>
          )}
          {stage === 'job' && job?.state === 'running' && <Button variant="outline" autoFocus onClick={() => onOpenChange(false)}>Close</Button>}
          {stage === 'job' && job && job.state !== 'running' && (
            <>
              {job.state !== 'done' && <Button variant="outline" onClick={() => void again()}>Start again</Button>}
              <Button autoFocus onClick={() => void finish()}>{job.state === 'done' ? 'Done' : 'Close'}</Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
