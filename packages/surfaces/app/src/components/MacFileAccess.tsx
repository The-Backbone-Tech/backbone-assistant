import * as React from 'react';
import type { Turn } from '@backbone-next/platform';
import { brand } from '../brand';
import { Button } from './ui/button';
import { SettingsRow } from './settings/SettingsRow';

type Folder = 'Desktop' | 'Documents' | 'Downloads';
type Folders = Record<string, 'allowed' | 'denied' | 'unavailable' | 'unknown'>;
const names: Folder[] = ['Desktop', 'Documents', 'Downloads'];
const decision = 'mac-file-access-decision';
const mac = () => window.backbone?.platform === 'darwin';
const scope = () => `Allowing a folder lets ${brand.name} and the engines and tools it starts read that folder.`;

export function AccessButton({ folder, onResult }: { folder: Folder; onResult?: (folders: Folders) => void }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [denied, setDenied] = React.useState(false);
  return <><Button size="sm" disabled={busy} onClick={() => {
    setBusy(true); setError(false); localStorage.setItem(decision, 'yes');
    void window.backbone?.macFileAccess?.(folder).then(value => { setDenied(value[folder] === 'denied'); onResult?.(value); }, () => setError(true)).finally(() => setBusy(false));
  }}>Allow {folder}</Button>{denied && <Button size="sm" variant="outline" onClick={() => void window.backbone?.macFilesAndFolders?.().catch(() => setError(true))}>Open Files and Folders settings</Button>}{error && <span role="alert">Could not check access.</span>}</>;
}

export function MacFileBanner() {
  const [show, setShow] = React.useState(() => mac() && !localStorage.getItem(decision));
  if (!show) return null;
  return <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-sm">
    <span className="w-full">{scope()}</span>
    {names.map(folder => <AccessButton key={folder} folder={folder} onResult={states => { if (states[folder] === 'allowed') setShow(false); }} />)}
    <Button size="sm" variant="ghost" onClick={() => { localStorage.setItem(decision, 'later'); setShow(false); }}>Not now</Button>
  </div>;
}

export function MacSettings() {
  const [folders, setFolders] = React.useState<Folders>();
  const [login, setLogin] = React.useState<boolean | null>(null);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    if (mac()) void window.backbone?.macPresence?.().then(value => { setFolders(value.folders); setLogin(value.login); }, () => setError('Could not read Mac settings.'));
  }, []);
  if (!mac()) return null;
  return <>
    <SettingsRow title="Files on this Mac" about={scope()}>
      {names.map(folder => <div key={folder} className="flex items-center gap-2"><span>{folder}: {folders?.[folder] ?? 'unknown'}</span><AccessButton folder={folder} onResult={setFolders} /></div>)}
      <Button size="sm" variant="outline" onClick={() => void window.backbone?.macFilesAndFolders?.().catch(() => setError('Could not open settings.'))}>Open Files and Folders settings</Button>
      <Button size="sm" variant="outline" onClick={() => void window.backbone?.macFullDiskAccess?.().catch(() => setError('Could not open settings.'))}>Open Full Disk Access settings (everything on this Mac)</Button>
    </SettingsRow>
    {login !== null && <SettingsRow title="Open at login" about="Keep scheduled work available when you sign in.">
      <input type="checkbox" aria-label="Open at login" checked={login} onChange={event => void window.backbone?.macLoginItem?.(event.target.checked).then(() => window.backbone?.macPresence?.()).then(value => { if (value) setLogin(value.login); }, () => setError('Could not change login setting.'))} />
    </SettingsRow>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </>;
}

export function FileAccessHint({ turn }: { turn: Pick<Turn, 'work' | 'answer'> }) {
  const folder = turn.work.steps.find(step => step.denied?.kind === 'macos-protected-folder')?.denied?.folder;
  if (!mac() || !folder) return null;
  return <div className="flex flex-wrap items-center gap-2 text-xs">macOS denied access to {folder}. <AccessButton folder={folder} /></div>;
}
