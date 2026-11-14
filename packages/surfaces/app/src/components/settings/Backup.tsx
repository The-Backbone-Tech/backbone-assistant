// Backup: the whole home exported in plain files, and an export checked file for file. Restoring
// writes a home, so it is done with the app closed (`backbone restore`); this section says how.
import type { HomeExport } from '@backbone-next/platform';
import * as React from 'react';
import { call, chooseExportFolder } from '../../lib/api';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { SettingsRow } from './SettingsRow';

const quoted = (path: string) => `"${path.replace(/(["\\$`])/g, '\\$1')}"`;

function Counts({ made }: { made: HomeExport }) {
  const c = made.counts;
  return (
    <p className="text-xs leading-5 text-muted">
      {c.projects} projects, {c.threads} chats, {c.documents} documents ({c.versions} versions), {c.memoryFiles} memory files, {c.skills} skills; {c.receipts} receipts in a report to read, {c.unresolved} unresolved. {made.files} files; {made.scrubbed} credential values cut out.
    </p>
  );
}

export function BackupSection() {
  const [chosen, setChosen] = React.useState<{ ticket: string; folder: string } | null>(null);
  const [from, setFrom] = React.useState('');
  const [busy, setBusy] = React.useState<'export' | 'check'>();
  const [made, setMade] = React.useState<HomeExport>();
  const [checked, setChecked] = React.useState<HomeExport>();
  const [problem, setProblem] = React.useState<string>();

  const exportNow = async () => {
    setBusy('export'); setProblem(undefined); setMade(undefined);
    try {
      // The ticket is good once: whatever comes of it, the next export needs a new pick.
      const ticket = chosen?.ticket ?? '';
      setChosen(null);
      const r = await call('backup.export', { ticket });
      if (r.ok) { setMade(r.value); setFrom(r.value.folder); } else setProblem(r.detail);
    } catch (error) { setProblem((error as Error).message); } finally { setBusy(undefined); }
  };
  const check = async () => {
    setBusy('check'); setProblem(undefined); setChecked(undefined);
    try {
      const r = await call('backup.inspect', { from: from.trim() });
      if (r.ok) setChecked(r.value); else setProblem(r.detail);
    } catch (error) { setProblem((error as Error).message); } finally { setBusy(undefined); }
  };

  return (
    <div data-testid="backup">
      <SettingsRow title="What an export holds" about="Your work as plain files you can read: projects with every version of each document, chats as history, memory and skills, and a report of every receipt, where an unknown outcome or held action is marked unresolved. No database or authority is in it, and every credential the app holds is cut out of what the app wrote and of plain text. Files you attached go out byte for byte, as you attached them, and what you typed yourself as you wrote it." />
      <SettingsRow title="Export this data folder" about="Into a new folder inside one you choose. A chat that is working finishes first.">
        <span data-testid="export-folder" className="min-w-0 truncate font-mono text-xs text-muted">{chosen ? chosen.folder : 'No folder chosen'}</span>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void chooseExportFolder().then(setChosen, (error: Error) => setProblem(error.message))}>
          Choose folder…
        </Button>
        <Button size="sm" disabled={!chosen || !!busy} onClick={() => void exportNow()}>
          {busy === 'export' ? 'Exporting…' : 'Export'}
        </Button>
      </SettingsRow>
      {made && (
        <div role="status" data-testid="backup-made" className="space-y-1 border-b border-border py-3">
          <p className="text-ui font-medium">Exported to {made.folder}</p>
          <Counts made={made} />
          <p className="text-xs leading-5 text-muted">Never in it:</p>
          <ul className="list-disc pl-5 text-xs leading-5 text-muted">
            {made.excluded.map((e) => <li key={e.what}><span className="font-mono">{e.what}</span>: {e.why}</li>)}
          </ul>
        </div>
      )}
      <SettingsRow title="Check a backup" about="Every file is compared with the digest it was exported with. Nothing is changed.">
        <Input aria-label="Backup folder" placeholder="An export folder" value={from} onChange={(e) => setFrom(e.target.value)} className="min-w-64" />
        <Button size="sm" variant="outline" disabled={!from.trim() || !!busy} onClick={() => void check()}>
          {busy === 'check' ? 'Checking…' : 'Check'}
        </Button>
      </SettingsRow>
      {checked && (
        <div role="status" data-testid="backup-checked" className="space-y-1 border-b border-border py-3">
          <p className="text-ui font-medium">Every file matches. Exported {new Date(checked.createdAt).toLocaleString()}.</p>
          <Counts made={checked} />
          <p className="text-xs leading-5 text-muted">Bring it into a new, empty data folder with the app closed, first as a dry run that changes nothing:</p>
          <pre className="overflow-x-auto rounded-md bg-sunken px-2.5 py-1.5 font-mono text-xs">{`backbone restore ${quoted(checked.folder)} --home <new-data-folder> --dry-run`}</pre>
          <p className="text-xs leading-5 text-muted">Your work comes in as you would add it; chats and receipts come in as documents to read. Nothing in it gives permission or runs by itself, and the data folder it came from is not touched.</p>
        </div>
      )}
      {problem && <p role="alert" className="py-2 text-xs text-danger">{problem}</p>}
    </div>
  );
}
