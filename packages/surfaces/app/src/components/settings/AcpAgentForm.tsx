import { ACP_CLAUDE_PRESET, ACP_PROCESS_VISIBILITY_WARNING, type AcpAgentDraft, type AcpPrepared, type ModelSettings } from '@backbone-next/platform';
import * as React from 'react';
import { call } from '../../lib/api';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/input';
import { SettingsRow } from './SettingsRow';

export function AcpAgentForm({ onChange, machineClient }: { onChange: (settings: ModelSettings) => void; machineClient?: ModelSettings['machineClient'] }) {
  const [preset, setPreset] = React.useState('claude');
  const [agent, setAgent] = React.useState<string>(ACP_CLAUDE_PRESET.agent);
  const [command, setCommand] = React.useState<string>(ACP_CLAUDE_PRESET.command);
  const [args, setArgs] = React.useState('[]');
  const [variables, setVariables] = React.useState('');
  const [environment, setEnvironment] = React.useState<'restricted-writes' | 'person-rights'>('person-rights');
  const [accepted, setAccepted] = React.useState(false);
  const [personAccepted, setPersonAccepted] = React.useState(false);
  const [prepared, setPrepared] = React.useState<AcpPrepared>();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  const [refreshing, setRefreshing] = React.useState(false);
  async function refresh() {
    setRefreshing(true); setError(undefined);
    try {
      const result = await call('settings.model.put', { change: { route: 'agent-refresh' } });
      if (!result.ok) { setError(result.detail); return; }
      onChange(result.value);
    } catch { setError('Could not refresh engine sign-in. Try again.'); }
    finally { setRefreshing(false); }
  }
  const id = React.useId();
  function invalidate() { setAccepted(false); setPersonAccepted(false); setPrepared(undefined); setMessage(undefined); }
  function draft(): AcpAgentDraft {
    const parsed: unknown = JSON.parse(args);
    if (!Array.isArray(parsed) || parsed.some(arg => typeof arg !== 'string')) throw new Error('Arguments must be a JSON list of strings.');
    return { ...(preset === 'claude' ? { machineClient: 'claude' as const } : {}), agent: agent.trim(), command: command.trim(), args: parsed, environment, environmentVariables: variables.split(/[\s,]+/).filter(Boolean) };
  }
  async function resolve() {
    invalidate(); setBusy(true); setError(undefined);
    try {
      const result = await call('settings.model.put', { change: { route: 'agent-resolve', configuration: draft() } });
      if (!result.ok) { setError(result.detail); return; }
      if (!result.value.acpPrepared) throw new Error('No executable identity');
      setCommand(result.value.acpPrepared.configuration.command);
      setPrepared(result.value.acpPrepared);
    } catch { setError('Could not resolve a trusted installed executable. Check the path, file permissions and JSON arguments.'); }
    finally { setBusy(false); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !accepted || !prepared || (environment === 'person-rights' && !personAccepted)) return;
    setBusy(true); setError(undefined); setMessage(undefined);
    try {
      const result = await call('settings.model.put', { change: { route: 'agent', configuration: {
        ...prepared.configuration, acceptance: prepared.acceptance, acceptsProcessVisibility: true,
        ...(personAccepted ? { acceptsPersonRights: true as const } : {}),
      } } });
      if (!result.ok) { setError(result.detail); return; }
      onChange(result.value);
      setMessage('Saved for the next launch. Restart the app or daemon to use this agent. BACKBONE_HARNESS overrides this choice.');
    } catch (cause) {
      setError(cause instanceof SyntaxError ? 'Arguments must be a JSON list of strings.' : cause instanceof Error && cause.message === 'Arguments must be a JSON list of strings.' ? cause.message : 'Could not confirm the save. Reopen Settings before trying again.');
    } finally { setBusy(false); }
  }
  return <form aria-label="ACP agent" onSubmit={save} className="mt-6" aria-busy={busy}>
    <fieldset disabled={busy} className="min-w-0">
      <legend className="text-sm font-semibold">Claude or your own agent</legend>
      <p className="mt-1 text-xs text-muted">Experimental ACP engine. The agent chooses its model and manages its own sign-in and billing. API keys configured above are not passed to it. Only documents written through the host tools receive host receipts; native activity does not.</p>
      <SettingsRow title={<label htmlFor={`${id}-preset`}>Agent setup</label>}>
        <Select id={`${id}-preset`} value={preset} onChange={event => {
          setPreset(event.target.value); invalidate(); setVariables('');
          setEnvironment(event.target.value === 'claude' ? 'person-rights' : 'restricted-writes');
          if (event.target.value === 'claude') { setAgent(ACP_CLAUDE_PRESET.agent); setCommand(ACP_CLAUDE_PRESET.command); setArgs('[]'); }
        }}><option value="claude">Claude Agent ACP</option><option value="custom">Your own ACP agent</option></Select>
      </SettingsRow>
      {preset === 'claude' && <p className="text-xs text-muted">Install {ACP_CLAUDE_PRESET.package}@{ACP_CLAUDE_PRESET.version} separately ({ACP_CLAUDE_PRESET.license}). This is the maintained successor to Zed’s claude-code-acp. Set the executable path below if it is not on PATH. Uses the machine’s own Claude Code sign-in: run claude auth login in your terminal first. The host passes no API key or token. The client can reach its own machine configuration, credential services, files, native tools and network with your own rights. It can also access this app’s data folder and other same-user sessions. Its status is checked before startup. Stop does not clear the client’s machine history or sign-in.</p>}
      {machineClient === 'claude' && <Button type="button" variant="outline" disabled={busy || refreshing} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh engine sign-in'}</Button>}
      <SettingsRow title={<label htmlFor={`${id}-name`}>Agent name</label>}><Input id={`${id}-name`} value={agent} onChange={event => { invalidate(); setAgent(event.target.value); }} required /></SettingsRow>
      <SettingsRow title={<label htmlFor={`${id}-command`}>Executable</label>} about="Resolve an installed command or absolute path before accepting it. No shell expansion."><Input id={`${id}-command`} value={command} onChange={event => { invalidate(); setCommand(event.target.value); }} required autoComplete="off" spellCheck={false} /></SettingsRow>
      <SettingsRow title={<label htmlFor={`${id}-args`}>Arguments</label>} about={'A JSON list, for example ["--stdio"]. No credentials.'}><Input id={`${id}-args`} value={args} onChange={event => { invalidate(); setArgs(event.target.value); }} autoComplete="off" spellCheck={false} /></SettingsRow>
      <SettingsRow title={<label htmlFor={`${id}-variables`}>Environment variable names</label>} about="Comma-separated names resolved when the host opens. Values stay out of settings. Credential and home-path variables are refused."><Input id={`${id}-variables`} value={variables} onChange={event => { invalidate(); setVariables(event.target.value); }} autoComplete="off" spellCheck={false} /></SettingsRow>
      <SettingsRow title={<label htmlFor={`${id}-environment`}>Agent rights</label>}>
        <Select id={`${id}-environment`} disabled={preset === 'claude'} value={environment} onChange={event => { invalidate(); setEnvironment(event.target.value as typeof environment); }}><option value="restricted-writes">Restricted writes (macOS)</option><option value="person-rights">Your own rights (OS restrictions off)</option></Select>
      </SettingsRow>
      <Button type="button" variant="outline" disabled={busy} onClick={() => void resolve()}>Resolve executable</Button>
      {prepared && <div className="mt-2 break-all text-xs text-muted">
        <output aria-label="Resolved executable">{prepared.acceptance.executable.path}</output>
        <p>SHA-256: {prepared.acceptance.executable.sha256}</p>
        {prepared.acceptance.machineExecutable && <p>Claude CLI: <output aria-label="Resolved Claude CLI">{prepared.acceptance.machineExecutable.path}</output><br />SHA-256: {prepared.acceptance.machineExecutable.sha256}</p>}
      </div>}
      <p id={`${id}-risk`} className="my-3 text-xs text-draft">{ACP_PROCESS_VISIBILITY_WARNING}</p>
      <label className="flex gap-2 text-sm"><input type="checkbox" disabled={!prepared} checked={accepted} onChange={event => setAccepted(event.target.checked)} aria-describedby={`${id}-risk`} />I accept the ACP process visibility and network risk for this executable and arguments</label>
      {environment === 'person-rights' && <label className="mt-2 flex gap-2 text-sm"><input type="checkbox" disabled={!prepared} checked={personAccepted} onChange={event => setPersonAccepted(event.target.checked)} />I accept that this agent can read and write this app’s data folder, including settings.json, and access machine credentials with my own rights</label>}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      {message && <p role="status" aria-label="Agent save result" className="mt-2 text-xs text-muted">{message}</p>}
      <div className="mt-3 flex justify-end"><Button type="submit" disabled={!accepted || !prepared || (environment === 'person-rights' && !personAccepted) || busy}>{busy ? 'Saving…' : 'Save ACP agent'}</Button></div>
    </fieldset>
  </form>;
}
