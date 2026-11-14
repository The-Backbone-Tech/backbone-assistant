import type { AgentRole } from '@backbone-next/platform';
import * as React from 'react';
import { call } from '../../lib/api';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

const TEMPLATE = '---\nname: researcher\ndescription: Finds evidence in project files\nmodel: inherit\ntools: [Read, Glob]\n---\nRead carefully and cite the evidence for each finding.\n';

export function AgentRolesSection() {
  const [truncated, setTruncated] = React.useState(false);
  const [manualReview, setManualReview] = React.useState(false);
  const [roles, setRoles] = React.useState<AgentRole[]>([]);
  const [selected, setSelected] = React.useState<AgentRole>();
  const [name, setName] = React.useState('researcher');
  const [markdown, setMarkdown] = React.useState(TEMPLATE);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const load = React.useCallback(async () => {
    try {
      const result = await call('agents.list', {});
      if (!result.ok) { setError(result.detail); return; }
      setRoles(result.value.roles); setTruncated(result.value.truncated); setManualReview(result.value.manualReview);
    }
    catch { setError('Could not load agent roles. Try again.'); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  const choose = (role?: AgentRole) => {
    setSelected(role); setName(role?.name ?? 'researcher'); setMarkdown(role?.markdown ?? TEMPLATE); setError(''); setNotice('');
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const result = await call('agents.save', { name, markdown, base: selected?.digest ?? null });
      if (!result.ok) setError(result.detail);
      else { setSelected(result.value); setNotice('Role saved. Ask a chat to use own/' + result.value.name + ' for a helper.'); await load(); }
    } catch { setError('Could not save this role. Your edits are still here.'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!selected) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await call('agents.delete', { name: selected.name, base: selected.digest });
      if (!result.ok) setError(result.detail);
      else { choose(); setNotice('Role deleted. Existing helpers keep their saved role.'); await load(); }
    } catch { setError('Could not delete this role. Try again.'); }
    finally { setBusy(false); }
  };
  return <div className="space-y-4 py-3 text-sm">
    <p>Save instructions once, then ask a chat to use the named role for a helper. Existing helpers keep the role they started with.</p>
    <p className="text-xs text-muted">Use Claude Code subagent Markdown: name, description, model and tools above the instructions. Model inherit uses the chat’s model. Another model must be served by your current connection. Tools narrow what the helper can use; they give no permission.</p>
    <p className="text-xs text-muted">Legacy files sharing a skill folder need ownership review. Save a definition here only when it is your own role; skill references must stay with the skill.</p>
    <p className="text-xs text-muted">Supported tools: Read, Glob, Write, Bash (offline workspace), memory_search, propose_memory, connectors (enabled tools only). Omit tools to inherit; [] allows none. Tool lists require an API engine.</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => choose()}>New role</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void load()}>Reload roles</Button>
      {roles.map(role => <Button key={role.name} variant="outline" size="sm" disabled={busy} onClick={() => choose(role)}>{role.name}</Button>)}
    </div>
    {truncated && <p role="status">Role discovery stopped at 64 directory entries. More roles may exist; use their own/name in a chat or inspect the roles folder.</p>}
    {manualReview && <p role="status">The skills/agents folder needs manual review. Its cleanup is pending; other skills continue normally. Save only your own roles here and keep source-derived references with their skill.</p>}
    <form aria-label="Agent role" onSubmit={save} className="space-y-3" aria-busy={busy}>
      <label className="block">Role name<Input aria-label="Role name" value={name} disabled={busy || !!selected} onChange={event => setName(event.target.value)} /></label>
      <label className="block">Definition<textarea aria-label="Agent role definition" className="mt-1 min-h-64 w-full rounded-md border border-strong-border bg-surface p-2 font-mono text-xs" value={markdown} disabled={busy} onChange={event => setMarkdown(event.target.value)} /></label>
      <div className="flex gap-2"><Button type="submit" disabled={busy}>Save role</Button>{selected && <Button type="button" variant="outline" disabled={busy} onClick={() => void remove()}>Delete role</Button>}</div>
    </form>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
